"""
Kouzina Live Updates — admin activity feed + private 1:1 direct messages.

Auth:
    Admins log in with their pkdb.admins email + password (bcrypt). On success
    they get a signed JWT (HS256, signed with APP_SECRET) used as a Bearer token.

Live Updates:
    A Twitter-style feed of actions performed on the portals. Events are pulled
    from existing audit tables (currently pkdb.admin_audit_log) into a
    normalized feed_events table. Ingestion happens on-read: when an admin opens
    the feed and the last ingest is older than INGEST_INTERVAL, the app pulls
    any new audit rows right then (guarded by a MySQL advisory lock so two
    replicas never double-ingest). Admins can like and comment on events.

Messaging:
    Messages are private between two admins. You only ever see conversations you
    are part of, and you can only message active admins (no external parties).

Storage:
    App data lives in the app's database (DATABASE_URL / MYSQL_*). Admins and
    audit logs are read from pkdb on the SAME MySQL server via cross-database
    queries, so no separate connection is needed.
"""

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import bcrypt
import jwt
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import (
    URL,
    Column,
    DateTime,
    Integer,
    String,
    Text,
    UniqueConstraint,
    and_,
    create_engine,
    func,
    or_,
    text,
)
from sqlalchemy.orm import declarative_base, sessionmaker

# ---- Database --------------------------------------------------------------


def _build_db_url():
    host = os.environ.get("MYSQL_HOST")
    if host:
        return URL.create(
            "mysql+pymysql",
            username=os.environ.get("MYSQL_USER"),
            password=os.environ.get("MYSQL_PASSWORD"),
            host=host,
            port=int(os.environ.get("MYSQL_PORT", "3306")),
            database=os.environ.get("MYSQL_DB"),
        )
    env_url = os.environ.get("DATABASE_URL")
    if env_url:
        return env_url
    return f"sqlite:///{Path(__file__).parent / 'messages.db'}"


DATABASE_URL = _build_db_url()
_backend = (
    DATABASE_URL.drivername
    if isinstance(DATABASE_URL, URL)
    else str(DATABASE_URL).split("://", 1)[0]
)
IS_MYSQL = _backend.startswith("mysql")

connect_args = {}
if IS_MYSQL:
    ca = os.environ.get("MYSQL_SSL_CA")
    connect_args = {"ssl": {"ca": ca} if ca else {"ssl": True}}
elif _backend.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
Base = declarative_base()


class MessageRow(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, autoincrement=True)
    sender = Column(String(255), nullable=False)
    recipient = Column(String(255), nullable=False)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class FeedEventRow(Base):
    __tablename__ = "feed_events"
    __table_args__ = (UniqueConstraint("source", "source_id", name="uq_source_row"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    portal = Column(String(16), nullable=False)          # 'PK', 'KAC', 'KFC', ...
    source = Column(String(64), nullable=False)          # e.g. 'pkdb.admin_audit_log'
    source_id = Column(Integer, nullable=False)
    actor = Column(String(255), nullable=False)
    action = Column(String(64), nullable=False)
    summary = Column(String(512), nullable=False)
    details = Column(Text, nullable=True)
    happened_at = Column(DateTime(timezone=True), nullable=True, index=True)


class EventLikeRow(Base):
    __tablename__ = "event_likes"
    __table_args__ = (UniqueConstraint("event_id", "admin_email", name="uq_event_admin"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id = Column(Integer, nullable=False, index=True)
    admin_email = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class EventCommentRow(Base):
    __tablename__ = "event_comments"
    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id = Column(Integer, nullable=False, index=True)
    admin_email = Column(String(255), nullable=False)
    admin_name = Column(String(255), nullable=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class IngestStateRow(Base):
    __tablename__ = "ingest_state"
    source = Column(String(64), primary_key=True)
    last_id = Column(Integer, nullable=False, default=0)
    last_run = Column(DateTime(timezone=True), nullable=True)


Base.metadata.create_all(engine)

# Existing deployments created sender/recipient as VARCHAR(50); emails need more.
if IS_MYSQL:
    with engine.begin() as conn:
        for col in ("sender", "recipient"):
            try:
                conn.execute(text(f"ALTER TABLE messages MODIFY {col} VARCHAR(255) NOT NULL"))
            except Exception:
                pass  # already widened


def _iso_utc(dt) -> str:
    """Serialize a DB datetime as ISO-8601 with an explicit UTC offset. The
    databases store naive UTC; without the offset, browsers parse the string
    as LOCAL time and every timestamp shifts by the viewer's UTC offset."""
    if not dt:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


# ---- Auth helpers ----------------------------------------------------------

APP_SECRET = os.environ.get("APP_SECRET", "dev-only-insecure-secret-change-me")
JWT_ALG = "HS256"
TOKEN_TTL = timedelta(hours=12)


def _verify_password(password: str, password_hash: str) -> bool:
    # Laravel/PHP often emit "$2y$" bcrypt hashes; normalise to "$2b$".
    if password_hash.startswith("$2y$"):
        password_hash = "$2b$" + password_hash[4:]
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except Exception:
        return False


def fetch_admin_by_email(email: str) -> Optional[dict]:
    if IS_MYSQL:
        with engine.connect() as conn:
            row = conn.execute(
                text(
                    "SELECT name, email, password_hash, active "
                    "FROM pkdb.admins WHERE email = :e LIMIT 1"
                ),
                {"e": email},
            ).mappings().first()
            return dict(row) if row else None
    # Local dev fallback (no pkdb available).
    dev_email = os.environ.get("DEV_ADMIN_EMAIL", "dev@local")
    if email.lower() == dev_email.lower():
        pw = os.environ.get("DEV_ADMIN_PASSWORD", "dev")
        return {
            "name": "Dev Admin",
            "email": dev_email,
            "password_hash": bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode(),
            "active": 1,
        }
    return None


def list_active_admins() -> list[dict]:
    if IS_MYSQL:
        with engine.connect() as conn:
            rows = conn.execute(
                text("SELECT name, email FROM pkdb.admins WHERE active = 1 ORDER BY name")
            ).mappings().all()
            return [dict(r) for r in rows]
    return [
        {"name": "Dev Admin", "email": os.environ.get("DEV_ADMIN_EMAIL", "dev@local")},
        {"name": "Alice Admin", "email": "alice@local"},
    ]


def is_active_admin(email: str) -> bool:
    if IS_MYSQL:
        with engine.connect() as conn:
            return (
                conn.execute(
                    text("SELECT 1 FROM pkdb.admins WHERE email = :e AND active = 1 LIMIT 1"),
                    {"e": email},
                ).first()
                is not None
            )
    return any(a["email"] == email for a in list_active_admins())


def make_token(email: str, name: Optional[str]) -> str:
    payload = {
        "sub": email,
        "name": name or email,
        "exp": datetime.now(timezone.utc) + TOKEN_TTL,
    }
    return jwt.encode(payload, APP_SECRET, algorithm=JWT_ALG)


bearer = HTTPBearer(auto_error=False)


def current_admin(cred: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> dict:
    if cred is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(cred.credentials, APP_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return {"email": payload["sub"], "name": payload.get("name")}


# ---- Feed ingestion ---------------------------------------------------------

INGEST_INTERVAL = timedelta(seconds=30)
INGEST_BATCH = 500

# Routine events that would just be noise in the feed.
EXCLUDED_ACTIONS = {"login", "logout", "switch_tenant"}

# Friendlier phrasing for known actions; anything else falls back to
# "did <action with spaces>".
ACTION_LABELS = {
    "item_setting_changed": "changed settings on",
    "create": "created",
    "update": "updated",
    "delete": "deleted",
    "user_create": "created",
    "user_disable": "disabled",
}


def _summarize(action: str, entity_type: Optional[str], entity_id) -> str:
    verb = ACTION_LABELS.get(action, action.replace("_", " "))
    target = ""
    if entity_type:
        target = f" {entity_type}"
        if entity_id:
            target += f" #{entity_id}"
    return f"{verb}{target}".strip()


def _render_summary(action: str, summary: str, details: Optional[str]) -> str:
    """Enrich the stored summary from the audit row's details JSON at serve
    time — names beat ids, and before→after changes are what admins care about."""
    if not details:
        return summary
    try:
        d = json.loads(details)
    except (ValueError, TypeError):
        return summary
    if not isinstance(d, dict):
        return summary

    name = d.get("item_name") or d.get("name")
    module = d.get("module")  # which portal tab/section the action happened in

    # An item being switched on/off is a stock-availability signal — call it out.
    active = d.get("active")
    if action == "item_setting_changed" and isinstance(active, dict) and "to" in active:
        state = "ON" if active["to"] else "OFF"
        out = f"switched {state} · {name}" if name else f"switched {state} an item"
        return f"{out} · in {module}" if module else out

    changes = [
        f"{k}: {v['from']} → {v['to']}"
        for k, v in d.items()
        if isinstance(v, dict) and "from" in v and "to" in v and k != "module"
    ]
    out = summary
    if name:
        out = f"{out} · {name}"
    if changes:
        out = f"{out} ({', '.join(changes[:2])})"
    if module:
        out = f"{out} · in {module}"
    return out


def _init_sql(table: str, id_col: str = "id", time_col: str = "created_at") -> str:
    """Watermark for a source's first-ever ingest: backfill at most the newest
    100 rows AND nothing older than 14 days, so a dormant source starts empty
    instead of dumping stale history on top of the feed."""
    return (
        "SELECT GREATEST("
        f"COALESCE((SELECT MIN({id_col}) - 1 FROM "
        f"(SELECT {id_col} FROM {table} ORDER BY {id_col} DESC LIMIT 100) t), 0), "
        f"COALESCE((SELECT MAX({id_col}) FROM {table} "
        f"WHERE {time_col} < NOW() - INTERVAL 14 DAY), 0))"
    )


# Source registry. Each source's SQL must return the normalized columns
# (id, actor, action, entity_type, entity_id, details, created_at); a single
# generic puller does the rest. Add a portal by appending an entry here.
SOURCES = [
    {
        "name": "pkdb.admin_audit_log",
        "portal": "PK",
        "sql": (
            "SELECT id, COALESCE(performed_by, 'Unknown') AS actor, action, "
            "entity_type, entity_id, details, created_at "
            "FROM pkdb.admin_audit_log WHERE id > :wm ORDER BY id LIMIT :lim"
        ),
        "init": _init_sql("pkdb.admin_audit_log"),
    },
    {
        "name": "pkdb.coco_audit_log",
        "portal": "PK",
        "sql": (
            "SELECT id, COALESCE(performed_by, 'Unknown') AS actor, action, "
            "entity_type, entity_id, details, created_at "
            "FROM pkdb.coco_audit_log WHERE id > :wm ORDER BY id LIMIT :lim"
        ),
        "init": _init_sql("pkdb.coco_audit_log"),
    },
    {
        "name": "pkdb.inventory_audit_log",
        "portal": "PK",
        "sql": (
            "SELECT id, COALESCE(performed_by, 'Unknown') AS actor, action, "
            "'item' AS entity_type, item_id AS entity_id, "
            "JSON_OBJECT('item_name', item_name, "
            "'quantity', JSON_OBJECT('from', quantity_before, 'to', quantity_after)"
            ") AS details, created_at "
            "FROM pkdb.inventory_audit_log WHERE id > :wm ORDER BY id LIMIT :lim"
        ),
        "init": _init_sql("pkdb.inventory_audit_log"),
    },
    {
        "name": "financedb.bill_activity_log",
        "portal": "FIN",
        "sql": (
            "SELECT id, CONCAT('Admin #', COALESCE(performed_by, '?')) AS actor, "
            "LOWER(action) AS action, 'bill' AS entity_type, bill_id AS entity_id, "
            "JSON_OBJECT('status', JSON_OBJECT('from', old_status, 'to', new_status), "
            "'notes', notes) AS details, performed_at AS created_at "
            "FROM financedb.bill_activity_log WHERE id > :wm ORDER BY id LIMIT :lim"
        ),
        "init": _init_sql("financedb.bill_activity_log", time_col="performed_at"),
    },
]

# Keep the feed scoped to the registered portals: drop events from sources
# that were removed from the registry (idempotent, runs at boot).
_ACTIVE_PORTALS = sorted({s["portal"] for s in SOURCES})
with SessionLocal() as _db:
    _db.query(FeedEventRow).filter(
        ~FeedEventRow.portal.in_(_ACTIVE_PORTALS)
    ).delete(synchronize_session=False)
    _db.query(IngestStateRow).filter(
        ~IngestStateRow.source.in_([s["name"] for s in SOURCES])
    ).delete(synchronize_session=False)
    _db.commit()


def _seed_dev_events(db):
    """Local dev (SQLite): fabricate a few events so the UI is testable."""
    if db.query(FeedEventRow).count() > 0:
        return
    now = datetime.now(timezone.utc)
    samples = [
        ("Rohan", "item_setting_changed", "changed settings on item #231"),
        ("ali", "price_update", "price update item #88"),
        ("Priya", "user_create", "created user #14"),
        ("Rohan", "expense_added", "expense added expense #501"),
    ]
    details = json.dumps(
        {"item_name": "LACCHA PARATHA MAIDA", "active": {"from": True, "to": False}}
    )
    for i, (actor, action, summary) in enumerate(samples):
        db.add(
            FeedEventRow(
                portal="PK",
                source="dev",
                source_id=i + 1,
                actor=actor,
                action=action,
                summary=summary,
                details=details if action == "item_setting_changed" else None,
                happened_at=now - timedelta(minutes=7 * (len(samples) - i)),
            )
        )
    db.commit()


def maybe_ingest():
    """Ingest new audit rows if the last run is stale. Cheap no-op otherwise."""
    if not IS_MYSQL:
        with SessionLocal() as db:
            _seed_dev_events(db)
        return

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        states = {s.source: s for s in db.query(IngestStateRow).all()}
        freshest = max(
            (s.last_run for s in states.values() if s.last_run), default=None
        )
        if freshest and now - freshest.replace(tzinfo=timezone.utc) < INGEST_INTERVAL:
            return

    with engine.connect() as conn:
        # Advisory lock: if another replica is ingesting, skip — it'll be fresh.
        got = conn.execute(text("SELECT GET_LOCK('kouzina_feed_ingest', 0)")).scalar()
        if got != 1:
            return
        try:
            with SessionLocal() as db:
                for source in SOURCES:
                    state = db.get(IngestStateRow, source["name"])
                    if state is None:
                        start = conn.execute(text(source["init"])).scalar() or 0
                        state = IngestStateRow(source=source["name"], last_id=start)
                        db.add(state)
                    try:
                        rows = conn.execute(
                            text(source["sql"]),
                            {"wm": state.last_id or 0, "lim": INGEST_BATCH},
                        ).mappings().all()
                    except Exception:
                        # A source we can't read (missing grant, dropped table)
                        # must not take down the whole feed.
                        continue
                    watermark = state.last_id or 0
                    for r in rows:
                        watermark = r["id"]
                        if r["action"] in EXCLUDED_ACTIONS:
                            continue
                        exists = (
                            db.query(FeedEventRow.id)
                            .filter_by(source=source["name"], source_id=r["id"])
                            .first()
                        )
                        if not exists:
                            db.add(
                                FeedEventRow(
                                    portal=source["portal"],
                                    source=source["name"],
                                    source_id=r["id"],
                                    actor=r["actor"] or "Unknown",
                                    action=r["action"],
                                    summary=_summarize(
                                        r["action"], r["entity_type"], r["entity_id"]
                                    ),
                                    details=r["details"],
                                    happened_at=r["created_at"],
                                )
                            )
                    state.last_id = watermark
                    state.last_run = now
                db.commit()
        finally:
            conn.execute(text("SELECT RELEASE_LOCK('kouzina_feed_ingest')"))


# ---- Schemas ---------------------------------------------------------------

class LoginIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)
    password: str = Field(..., min_length=1, max_length=255)


class MessageIn(BaseModel):
    recipient: str = Field(..., min_length=3, max_length=255)
    body: str = Field(..., min_length=1, max_length=2000)


class Message(BaseModel):
    id: int
    sender: str
    recipient: str
    body: str
    created_at: str


class CommentIn(BaseModel):
    body: str = Field(..., min_length=1, max_length=1000)


def _serialize_message(r: MessageRow) -> Message:
    return Message(
        id=r.id,
        sender=r.sender,
        recipient=r.recipient,
        body=r.body,
        created_at=_iso_utc(r.created_at),
    )


# ---- App -------------------------------------------------------------------

app = FastAPI(title="Kouzina Live Updates")
api = FastAPI()

for sub in (app, api):
    sub.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )


@api.get("/health")
def health():
    return {"status": "ok"}


@api.post("/login")
def login(body: LoginIn):
    admin = fetch_admin_by_email(body.email.strip())
    if (
        not admin
        or not admin.get("active")
        or not _verify_password(body.password, admin["password_hash"])
    ):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {
        "token": make_token(admin["email"], admin.get("name")),
        "email": admin["email"],
        "name": admin.get("name") or admin["email"],
    }


@api.get("/me")
def me(admin: dict = Depends(current_admin)):
    return admin


@api.get("/admins")
def admins(admin: dict = Depends(current_admin)):
    """Active admins you can message (everyone but yourself)."""
    return [a for a in list_active_admins() if a["email"] != admin["email"]]


# ---- Live Updates feed ------------------------------------------------------

@api.get("/feed")
def get_feed(
    background_tasks: BackgroundTasks,
    limit: int = Query(default=10, le=100),
    cursor_ts: Optional[str] = Query(default=None),
    cursor_id: Optional[int] = Query(default=None),
    portal: Optional[str] = Query(default=None),
    admin: dict = Depends(current_admin),
):
    """Latest events first, ordered by when they actually happened. The first
    page responds immediately from the local table; ingestion of new audit rows
    runs AFTER the response is sent, so the feed is never blocked on the source
    databases. Page into the past with cursor_ts + cursor_id (the happened_at
    and id of the oldest event you have)."""
    if cursor_ts is None:
        background_tasks.add_task(maybe_ingest)
    with SessionLocal() as db:
        q = db.query(FeedEventRow)
        if portal:
            q = q.filter(FeedEventRow.portal == portal)
        if cursor_ts is not None and cursor_id is not None:
            try:
                ts = datetime.fromisoformat(cursor_ts)
            except ValueError:
                raise HTTPException(status_code=400, detail="Bad cursor")
            if ts.tzinfo is not None:
                # Columns hold naive UTC; compare like with like.
                ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
            q = q.filter(
                or_(
                    FeedEventRow.happened_at < ts,
                    and_(
                        FeedEventRow.happened_at == ts, FeedEventRow.id < cursor_id
                    ),
                )
            )
        rows = (
            q.order_by(FeedEventRow.happened_at.desc(), FeedEventRow.id.desc())
            .limit(limit)
            .all()
        )

        ids = [r.id for r in rows]
        like_counts: dict[int, int] = {}
        my_likes: set[int] = set()
        comment_counts: dict[int, int] = {}
        if ids:
            for event_id, cnt in (
                db.query(EventLikeRow.event_id, func.count())
                .filter(EventLikeRow.event_id.in_(ids))
                .group_by(EventLikeRow.event_id)
            ):
                like_counts[event_id] = cnt
            my_likes = {
                r[0]
                for r in db.query(EventLikeRow.event_id).filter(
                    EventLikeRow.event_id.in_(ids),
                    EventLikeRow.admin_email == admin["email"],
                )
            }
            for event_id, cnt in (
                db.query(EventCommentRow.event_id, func.count())
                .filter(EventCommentRow.event_id.in_(ids))
                .group_by(EventCommentRow.event_id)
            ):
                comment_counts[event_id] = cnt

    return {
        "events": [
            {
                "id": r.id,
                "portal": r.portal,
                "actor": r.actor,
                "action": r.action,
                "summary": _render_summary(r.action, r.summary, r.details),
                "happened_at": _iso_utc(r.happened_at),
                "like_count": like_counts.get(r.id, 0),
                "liked_by_me": r.id in my_likes,
                "comment_count": comment_counts.get(r.id, 0),
            }
            for r in rows
        ]
    }


@api.post("/feed/{event_id}/like")
def toggle_like(event_id: int, admin: dict = Depends(current_admin)):
    with SessionLocal() as db:
        if not db.get(FeedEventRow, event_id):
            raise HTTPException(status_code=404, detail="Event not found")
        existing = (
            db.query(EventLikeRow)
            .filter_by(event_id=event_id, admin_email=admin["email"])
            .first()
        )
        if existing:
            db.delete(existing)
            liked = False
        else:
            db.add(EventLikeRow(event_id=event_id, admin_email=admin["email"]))
            liked = True
        db.commit()
        count = db.query(EventLikeRow).filter_by(event_id=event_id).count()
    return {"liked": liked, "like_count": count}


@api.get("/feed/{event_id}/comments")
def get_comments(event_id: int, admin: dict = Depends(current_admin)):
    with SessionLocal() as db:
        rows = (
            db.query(EventCommentRow)
            .filter_by(event_id=event_id)
            .order_by(EventCommentRow.id.asc())
            .all()
        )
    return [
        {
            "id": r.id,
            "admin_email": r.admin_email,
            "admin_name": r.admin_name or r.admin_email,
            "body": r.body,
            "created_at": _iso_utc(r.created_at),
        }
        for r in rows
    ]


@api.post("/feed/{event_id}/comments", status_code=201)
def add_comment(event_id: int, body: CommentIn, admin: dict = Depends(current_admin)):
    comment_body = body.body.strip()
    if not comment_body:
        raise HTTPException(status_code=400, detail="Comment cannot be empty")
    with SessionLocal() as db:
        if not db.get(FeedEventRow, event_id):
            raise HTTPException(status_code=404, detail="Event not found")
        row = EventCommentRow(
            event_id=event_id,
            admin_email=admin["email"],
            admin_name=admin.get("name"),
            body=comment_body,
        )
        db.add(row)
        db.commit()
        return {
            "id": row.id,
            "admin_email": row.admin_email,
            "admin_name": row.admin_name or row.admin_email,
            "body": row.body,
            "created_at": _iso_utc(row.created_at),
        }


# ---- Direct messages --------------------------------------------------------

@api.get("/messages", response_model=list[Message])
def get_messages(
    with_email: Optional[str] = Query(default=None),
    admin: dict = Depends(current_admin),
):
    """Messages involving you. With ?with_email=X, just the thread with X."""
    me_email = admin["email"]
    with SessionLocal() as db:
        q = db.query(MessageRow)
        if with_email:
            q = q.filter(
                ((MessageRow.sender == me_email) & (MessageRow.recipient == with_email))
                | ((MessageRow.sender == with_email) & (MessageRow.recipient == me_email))
            )
        else:
            q = q.filter(
                (MessageRow.sender == me_email) | (MessageRow.recipient == me_email)
            )
        rows = q.order_by(MessageRow.id.asc()).all()
    return [_serialize_message(r) for r in rows]


@api.post("/messages", response_model=Message, status_code=201)
def send_message(body: MessageIn, admin: dict = Depends(current_admin)):
    recipient = body.recipient.strip()
    text_body = body.body.strip()
    if not text_body:
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    if recipient == admin["email"]:
        raise HTTPException(status_code=400, detail="You can't message yourself")
    if not is_active_admin(recipient):
        raise HTTPException(status_code=400, detail="Recipient must be an active admin")
    with SessionLocal() as db:
        row = MessageRow(sender=admin["email"], recipient=recipient, body=text_body)
        db.add(row)
        db.commit()
        return _serialize_message(row)


app.mount("/api", api)

# ---- Static frontend (production) ------------------------------------------
FRONTEND_DIR = Path(os.environ.get("FRONTEND_DIR", Path(__file__).parent / "static"))
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
