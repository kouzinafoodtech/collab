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
    bindparam,
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
    is_private = Column(Integer, nullable=False, default=0)  # 1 = sender+recipient only
    parent_id = Column(Integer, nullable=True, index=True)   # reply threading
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


class ProgramRow(Base):
    __tablename__ = "programs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    objective = Column(Text, nullable=True)
    description = Column(Text, nullable=True)
    owner_email = Column(String(255), nullable=True)
    owner_name = Column(String(255), nullable=True)
    eta = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(20), nullable=False, default="not_started")
    active = Column(Integer, nullable=False, default=1)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ProgramUpdateRow(Base):
    __tablename__ = "program_updates"
    id = Column(Integer, primary_key=True, autoincrement=True)
    program_id = Column(Integer, nullable=False, index=True)
    author_email = Column(String(255), nullable=False)
    author_name = Column(String(255), nullable=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class FeedbackRow(Base):
    __tablename__ = "feedback"
    # Deliberately NO author column — feedback is anonymous by design.
    id = Column(Integer, primary_key=True, autoincrement=True)
    body = Column(Text, nullable=False)
    action_item = Column(Text, nullable=True)
    action_by = Column(String(255), nullable=True)
    action_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(16), nullable=False, default="open")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class LiveLoginRow(Base):
    __tablename__ = "live_logins"
    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String(255), nullable=False, index=True)
    name = Column(String(255), nullable=True)
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
        for ddl in (
            "ALTER TABLE messages ADD COLUMN is_private TINYINT(1) NOT NULL DEFAULT 0",
            "ALTER TABLE messages ADD COLUMN parent_id INT NULL",
            "ALTER TABLE programs ADD COLUMN objective TEXT NULL",
            "ALTER TABLE programs ADD COLUMN description TEXT NULL",
        ):
            try:
                conn.execute(text(ddl))
            except Exception:
                pass  # already added


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
SUPERADMIN_EMAIL = os.environ.get("SUPERADMIN_EMAIL", "admin@kftpl.com")

# System/bot accounts hidden from people lists and not messageable.
EXCLUDED_ADMIN_EMAILS = {"cocoadmin@kftpl.com", "swiggy-review@kftpl.com"}


def _excluded(email: Optional[str]) -> bool:
    return (email or "").lower() in EXCLUDED_ADMIN_EMAILS


def resolve_names(emails: set[str]) -> dict[str, str]:
    """email -> display name, for the emails that belong to admins."""
    if not emails:
        return {}
    if IS_MYSQL:
        with engine.connect() as conn:
            pairs = conn.execute(
                text("SELECT email, name FROM pkdb.admins WHERE email IN :emails")
                .bindparams(bindparam("emails", expanding=True)),
                {"emails": sorted(emails)},
            ).all()
        return {em: n for em, n in pairs if n}
    return {a["email"]: a["name"] for a in list_active_admins()}


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
            return [dict(r) for r in rows if not _excluded(r["email"])]
    return [
        {"name": "Dev Admin", "email": os.environ.get("DEV_ADMIN_EMAIL", "dev@local")},
        {"name": "Alice Admin", "email": "alice@local"},
    ]


def is_active_admin(email: str) -> bool:
    if _excluded(email):
        return False
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
# Same person doing the same action within this window collapses to one card.
GROUP_WINDOW = timedelta(minutes=15)

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
        "name": "financedb.admin_audit_log",
        "portal": "FIN",
        "sql": (
            "SELECT id, COALESCE(performed_by, 'Unknown') AS actor, action, "
            "entity_type, entity_id, details, created_at "
            "FROM financedb.admin_audit_log WHERE id > :wm ORDER BY id LIMIT :lim"
        ),
        "init": _init_sql("financedb.admin_audit_log"),
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
# that were removed from the registry (idempotent, runs at boot). "LIVE" is
# this app's own portal (programs, feedback) — never clean it up.
_ACTIVE_PORTALS = sorted({s["portal"] for s in SOURCES} | {"LIVE"})
with SessionLocal() as _db:
    _db.query(FeedEventRow).filter(
        ~FeedEventRow.portal.in_(_ACTIVE_PORTALS)
    ).delete(synchronize_session=False)
    _db.query(IngestStateRow).filter(
        ~IngestStateRow.source.in_([s["name"] for s in SOURCES])
    ).delete(synchronize_session=False)
    _db.commit()

STATUS_LABELS = {
    "not_started": "Not Started",
    "in_progress": "In Progress",
    "complete": "Complete",
}


def emit_live_event(actor: str, action: str, summary: str, details: Optional[dict] = None):
    """Publish an in-app event (programs, feedback) to the feed as portal LIVE."""
    with SessionLocal() as db:
        for _ in range(3):  # retry on the rare source_id race between replicas
            try:
                next_id = (
                    db.query(func.max(FeedEventRow.source_id))
                    .filter(FeedEventRow.source == "live")
                    .scalar()
                    or 0
                ) + 1
                db.add(
                    FeedEventRow(
                        portal="LIVE",
                        source="live",
                        source_id=next_id,
                        actor=actor,
                        action=action,
                        summary=summary,
                        details=json.dumps(details) if details else None,
                        happened_at=datetime.now(timezone.utc).replace(tzinfo=None),
                    )
                )
                db.commit()
                return
            except Exception:
                db.rollback()


# Seed the first programs once (idempotent: only when the table is empty).
with SessionLocal() as _db:
    if _db.query(ProgramRow).count() == 0:
        _eta = datetime(2026, 7, 31)
        _db.add(
            ProgramRow(
                name="Use of retort instead of frozen food",
                eta=_eta,
                status="not_started",
                created_by="system",
            )
        )
        _db.add(
            ProgramRow(
                name="V2 UP Menu",
                owner_email="pawan.kumar@kftpl.com",
                owner_name="Pawan",
                eta=_eta,
                status="not_started",
                created_by="system",
            )
        )
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
        # A burst by the same actor — exercises grouping in dev.
        ("Flame & Feast", "stock_deducted", "stock deducted · Manchurian Sauce (98 → 93)"),
        ("Flame & Feast", "stock_deducted", "stock deducted · Coated Paneer (27 → 25)"),
        ("Flame & Feast", "stock_deducted", "stock deducted · Butter Chicken Gravy (206 → 196)"),
        ("Flame & Feast", "stock_deducted", "stock deducted · Egg Corn Fried Rice (743 → 733)"),
        # Different action, same person, same window — exercises mixed grouping.
        ("Flame & Feast", "order_status_changed", "order status changed order #38010"),
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
                    # One query to find already-ingested rows instead of one
                    # SELECT per row — matters now that PK logs busily.
                    ids = [r["id"] for r in rows]
                    existing = set()
                    if ids:
                        existing = {
                            sid
                            for (sid,) in db.query(FeedEventRow.source_id).filter(
                                FeedEventRow.source == source["name"],
                                FeedEventRow.source_id.in_(ids),
                            )
                        }
                    for r in rows:
                        watermark = r["id"]
                        if r["action"] in EXCLUDED_ACTIONS or r["id"] in existing:
                            continue
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
    try:  # usage tracking for the adoption dashboard; never blocks login
        with SessionLocal() as db:
            db.add(LiveLoginRow(email=admin["email"], name=admin.get("name")))
            db.commit()
    except Exception:
        pass
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


@api.get("/leaderboard")
def leaderboard(admin: dict = Depends(current_admin)):
    """Most active people in the last 12 hours, by number of feed events.
    Each entry resolves to an admin email when the actor name matches an
    active admin — that's what makes them messageable."""
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=12)
    with SessionLocal() as db:
        rows = (
            db.query(FeedEventRow.actor, func.count())
            .filter(FeedEventRow.happened_at >= since)
            .group_by(FeedEventRow.actor)
            .order_by(func.count().desc())
            .limit(15)
            .all()
        )
    entries = [{"actor": a, "count": c, "email": None} for a, c in rows]
    names = [e["actor"] for e in entries]
    if names:
        if IS_MYSQL:
            with engine.connect() as conn:
                pairs = conn.execute(
                    text(
                        "SELECT name, email FROM pkdb.admins "
                        "WHERE active = 1 AND name IN :names"
                    ).bindparams(bindparam("names", expanding=True)),
                    {"names": names},
                ).all()
            by_name = {n: em for n, em in pairs}
        else:
            by_name = {a["name"]: a["email"] for a in list_active_admins()}
        for e in entries:
            em = by_name.get(e["actor"])
            e["email"] = None if _excluded(em) else em
    return entries


# ---- Message wall (visible to all admins, Twitter-mentions style) -----------

@api.get("/wall/{email}")
def get_wall(email: str, admin: dict = Depends(current_admin)):
    """Recent PUBLIC messages sent TO this person — shown to all admins."""
    with SessionLocal() as db:
        rows = (
            db.query(MessageRow)
            .filter(MessageRow.recipient == email, MessageRow.is_private == 0)
            .order_by(MessageRow.id.desc())
            .limit(30)
            .all()
        )
    names = resolve_names({r.sender for r in rows})
    return [
        {
            "id": r.id,
            "sender": r.sender,
            "sender_name": names.get(r.sender) or r.sender.split("@")[0],
            "body": r.body,
            "created_at": _iso_utc(r.created_at),
        }
        for r in rows
    ]


@api.get("/person/{actor}")
def person(actor: str, admin: dict = Depends(current_admin)):
    """Resolve a feed actor: 12h activity count + admin email if messageable."""
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=12)
    with SessionLocal() as db:
        count = (
            db.query(FeedEventRow)
            .filter(FeedEventRow.actor == actor, FeedEventRow.happened_at >= since)
            .count()
        )
    email = None
    if IS_MYSQL:
        with engine.connect() as conn:
            r = conn.execute(
                text("SELECT email FROM pkdb.admins WHERE name = :n AND active = 1 LIMIT 1"),
                {"n": actor},
            ).first()
        email = r[0] if r else None
    else:
        email = next(
            (a["email"] for a in list_active_admins() if a["name"] == actor), None
        )
    if _excluded(email):
        email = None
    owner_conds = [ProgramRow.owner_name == actor]
    if email:
        owner_conds.append(ProgramRow.owner_email == email)
    with SessionLocal() as db:
        prog_rows = (
            db.query(ProgramRow)
            .filter(ProgramRow.active == 1, or_(*owner_conds))
            .order_by(ProgramRow.eta.asc())
            .all()
        )
    return {
        "actor": actor,
        "count": count,
        "email": email,
        "programs": [
            {
                "id": p.id,
                "name": p.name,
                "status": p.status,
                "eta": p.eta.date().isoformat() if p.eta else None,
            }
            for p in prog_rows
        ],
    }


# ---- Messages hub (public tree + private) ------------------------------------

def _serialize_msgs(rows) -> list[dict]:
    emails = {r.sender for r in rows} | {r.recipient for r in rows}
    names = resolve_names(emails)
    return [
        {
            "id": r.id,
            "parent_id": r.parent_id,
            "sender": r.sender,
            "sender_name": names.get(r.sender) or r.sender.split("@")[0],
            "recipient": r.recipient,
            "recipient_name": names.get(r.recipient) or r.recipient.split("@")[0],
            "is_private": bool(r.is_private),
            "body": r.body,
            "created_at": _iso_utc(r.created_at),
        }
        for r in rows
    ]


@api.get("/messages/public")
def messages_public(admin: dict = Depends(current_admin)):
    """Everyone's public messages (roots + replies), visible to all admins."""
    with SessionLocal() as db:
        rows = (
            db.query(MessageRow)
            .filter(MessageRow.is_private == 0)
            .order_by(MessageRow.id.desc())
            .limit(150)
            .all()
        )
    return _serialize_msgs(rows)


@api.get("/messages/private")
def messages_private(admin: dict = Depends(current_admin)):
    """My private messages only — sender or recipient is me."""
    me_email = admin["email"]
    with SessionLocal() as db:
        rows = (
            db.query(MessageRow)
            .filter(
                MessageRow.is_private == 1,
                or_(MessageRow.sender == me_email, MessageRow.recipient == me_email),
            )
            .order_by(MessageRow.id.desc())
            .limit(150)
            .all()
        )
    return _serialize_msgs(rows)


class SendIn(BaseModel):
    recipient: Optional[str] = Field(default=None, max_length=255)
    body: str = Field(..., min_length=1, max_length=2000)
    private: bool = False
    parent_id: Optional[int] = None


@api.post("/messages/send", status_code=201)
def messages_send(payload: SendIn, admin: dict = Depends(current_admin)):
    text_body = payload.body.strip()
    if not text_body:
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    with SessionLocal() as db:
        if payload.parent_id:
            root = db.get(MessageRow, payload.parent_id)
            if not root:
                raise HTTPException(status_code=404, detail="Thread not found")
            if root.is_private and admin["email"] not in (root.sender, root.recipient):
                raise HTTPException(status_code=403, detail="Not your thread")
            row = MessageRow(
                sender=admin["email"],
                recipient=root.recipient,
                body=text_body,
                is_private=root.is_private,
                parent_id=root.parent_id or root.id,  # keep threads one level deep
            )
        else:
            recipient = (payload.recipient or "").strip()
            if not recipient:
                raise HTTPException(status_code=400, detail="Recipient required")
            if recipient == admin["email"]:
                raise HTTPException(status_code=400, detail="You can't message yourself")
            if not is_active_admin(recipient):
                raise HTTPException(
                    status_code=400, detail="Recipient must be an active admin"
                )
            row = MessageRow(
                sender=admin["email"],
                recipient=recipient,
                body=text_body,
                is_private=1 if payload.private else 0,
            )
        db.add(row)
        db.commit()
    return {"ok": True}


# ---- Superadmin dashboard -----------------------------------------------------

@api.get("/dashboard")
def dashboard(admin: dict = Depends(current_admin)):
    if admin["email"].lower() != SUPERADMIN_EMAIL.lower():
        raise HTTPException(status_code=403, detail="Superadmin only")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    d7, d14 = now - timedelta(days=7), now - timedelta(days=14)
    with SessionLocal() as db:
        totals = {
            "events_7d": db.query(FeedEventRow)
            .filter(FeedEventRow.happened_at >= d7)
            .count(),
            "people_7d": db.query(FeedEventRow.actor)
            .filter(FeedEventRow.happened_at >= d7)
            .distinct()
            .count(),
            "messages_7d": db.query(MessageRow)
            .filter(MessageRow.created_at >= d7)
            .count(),
            "reactions_7d": db.query(EventLikeRow)
            .filter(EventLikeRow.created_at >= d7)
            .count()
            + db.query(EventCommentRow)
            .filter(EventCommentRow.created_at >= d7)
            .count(),
        }
        by_person = [
            {"actor": a, "count": c}
            for a, c in db.query(FeedEventRow.actor, func.count())
            .filter(FeedEventRow.happened_at >= d7)
            .group_by(FeedEventRow.actor)
            .order_by(func.count().desc())
            .limit(12)
            .all()
        ]
        feed_by_day = [
            {"date": str(d), "count": c}
            for d, c in db.query(func.date(FeedEventRow.happened_at), func.count())
            .filter(FeedEventRow.happened_at >= d14)
            .group_by(func.date(FeedEventRow.happened_at))
            .order_by(func.date(FeedEventRow.happened_at))
            .all()
        ]

    def _logins_per_day(table: str) -> list[dict]:
        if not IS_MYSQL:
            return []
        try:
            with engine.connect() as conn:
                rows = conn.execute(
                    text(
                        f"SELECT DATE(created_at) AS d, COUNT(*) AS c FROM {table} "
                        "WHERE action = 'login' AND created_at >= :since "
                        "GROUP BY DATE(created_at) ORDER BY d"
                    ),
                    {"since": d14},
                ).all()
            return [{"date": str(d), "count": c} for d, c in rows]
        except Exception:
            return []

    # ---- Kouzina Live adoption: who signs in, how often, what they do ------
    d30 = now - timedelta(days=30)
    with SessionLocal() as db:
        adoption = {
            "logins_7d": db.query(LiveLoginRow)
            .filter(LiveLoginRow.created_at >= d7)
            .count(),
            "users_7d": db.query(LiveLoginRow.email)
            .filter(LiveLoginRow.created_at >= d7)
            .distinct()
            .count(),
        }
        users: dict[str, dict] = {}

        def _bucket(email):
            return users.setdefault(
                email,
                {
                    "email": email,
                    "logins": 0,
                    "last_login": None,
                    "messages": 0,
                    "likes": 0,
                    "comments": 0,
                },
            )

        for email, cnt, last in (
            db.query(LiveLoginRow.email, func.count(), func.max(LiveLoginRow.created_at))
            .filter(LiveLoginRow.created_at >= d30)
            .group_by(LiveLoginRow.email)
        ):
            u = _bucket(email)
            u["logins"] = cnt
            u["last_login"] = _iso_utc(last)
        for email, cnt in (
            db.query(MessageRow.sender, func.count())
            .filter(MessageRow.created_at >= d30)
            .group_by(MessageRow.sender)
        ):
            _bucket(email)["messages"] = cnt
        for email, cnt in (
            db.query(EventLikeRow.admin_email, func.count())
            .filter(EventLikeRow.created_at >= d30)
            .group_by(EventLikeRow.admin_email)
        ):
            _bucket(email)["likes"] = cnt
        for email, cnt in (
            db.query(EventCommentRow.admin_email, func.count())
            .filter(EventCommentRow.created_at >= d30)
            .group_by(EventCommentRow.admin_email)
        ):
            _bucket(email)["comments"] = cnt

    names = resolve_names(set(users.keys()))
    for email, u in users.items():
        u["name"] = names.get(email) or email.split("@")[0]
    adoption["users"] = sorted(
        users.values(),
        key=lambda u: (u["logins"], u["messages"] + u["likes"] + u["comments"]),
        reverse=True,
    )
    active_emails = {e for e, u in users.items() if u["logins"] > 0}
    adoption["never"] = sorted(
        a["name"] or a["email"]
        for a in list_active_admins()
        if a["email"] not in active_emails
    )

    return {
        "totals": totals,
        "by_person": by_person,
        "feed_by_day": feed_by_day,
        "pk_usage": _logins_per_day("pkdb.admin_audit_log"),
        "kfc_usage": _logins_per_day("financedb.kfc_access_log"),
        "adoption": adoption,
    }


@api.post("/wall/{email}", status_code=201)
def post_wall(email: str, body: CommentIn, admin: dict = Depends(current_admin)):
    text_body = body.body.strip()
    if not text_body:
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    if email == admin["email"]:
        raise HTTPException(status_code=400, detail="You can't message yourself")
    if not is_active_admin(email):
        raise HTTPException(status_code=400, detail="Recipient must be an active admin")
    with SessionLocal() as db:
        row = MessageRow(sender=admin["email"], recipient=email, body=text_body)
        db.add(row)
        db.commit()
    return {"ok": True}


# ---- Live Updates feed ------------------------------------------------------

@api.get("/feed")
def get_feed(
    background_tasks: BackgroundTasks,
    limit: int = Query(default=10, le=100),
    cursor_ts: Optional[str] = Query(default=None),
    cursor_id: Optional[int] = Query(default=None),
    portal: Optional[str] = Query(default=None),
    actor: Optional[str] = Query(default=None),
    admin: dict = Depends(current_admin),
):
    """Latest activity first, GROUPED: consecutive events by the same person
    doing the same action within GROUP_WINDOW collapse into one card (so a
    burst of per-item stock deductions reads as a single update). The first
    page responds immediately from the local table; ingestion of new audit
    rows runs AFTER the response is sent. `limit` counts groups; page into the
    past with the returned next_cursor_ts / next_cursor_id."""
    if cursor_ts is None:
        background_tasks.add_task(maybe_ingest)
    with SessionLocal() as db:
        q = db.query(FeedEventRow)
        if portal:
            q = q.filter(FeedEventRow.portal == portal)
        if actor:
            q = q.filter(FeedEventRow.actor == actor)
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
        raw_fetch = min(limit * 12, 300)
        rows = (
            q.order_by(FeedEventRow.happened_at.desc(), FeedEventRow.id.desc())
            .limit(raw_fetch + 1)
            .all()
        )
        overflow = len(rows) > raw_fetch
        rows = rows[:raw_fetch]

        # Collapse consecutive events by the same person (any actions) within
        # GROUP_WINDOW into one card — a burst of PO generate/push pairs reads
        # as a single update.
        groups: list[dict] = []
        consumed = 0
        for r in rows:
            g = groups[-1] if groups else None
            r_ts = r.happened_at or datetime.min
            if (
                g is not None
                and g["portal"] == r.portal
                and g["actor"] == r.actor
                and (g["anchor"] - r_ts) <= GROUP_WINDOW
            ):
                g["members"].append(r)
                g["actions"].add(r.action)
                consumed += 1
                continue
            if len(groups) == limit:
                break
            groups.append(
                {
                    "portal": r.portal,
                    "actor": r.actor,
                    "anchor": r_ts,
                    "members": [r],
                    "actions": {r.action},
                }
            )
            consumed += 1

        has_more = overflow or consumed < len(rows)
        last = rows[consumed - 1] if consumed else None

        rep_ids = [g["members"][0].id for g in groups]
        like_counts: dict[int, int] = {}
        my_likes: set[int] = set()
        comment_counts: dict[int, int] = {}
        if rep_ids:
            for event_id, cnt in (
                db.query(EventLikeRow.event_id, func.count())
                .filter(EventLikeRow.event_id.in_(rep_ids))
                .group_by(EventLikeRow.event_id)
            ):
                like_counts[event_id] = cnt
            my_likes = {
                r[0]
                for r in db.query(EventLikeRow.event_id).filter(
                    EventLikeRow.event_id.in_(rep_ids),
                    EventLikeRow.admin_email == admin["email"],
                )
            }
            for event_id, cnt in (
                db.query(EventCommentRow.event_id, func.count())
                .filter(EventCommentRow.event_id.in_(rep_ids))
                .group_by(EventCommentRow.event_id)
            ):
                comment_counts[event_id] = cnt

    events = []
    for g in groups:
        rep = g["members"][0]  # newest member represents the group
        events.append(
            {
                "id": rep.id,
                "portal": rep.portal,
                "actor": rep.actor,
                "action": rep.action,
                "actions": sorted(g["actions"])[:6],
                "uniform": len(g["actions"]) == 1,
                "summary": _render_summary(rep.action, rep.summary, rep.details),
                "happened_at": _iso_utc(rep.happened_at),
                "count": len(g["members"]),
                "extras": [
                    _render_summary(m.action, m.summary, m.details)
                    for m in g["members"][1:6]
                ],
                "like_count": like_counts.get(rep.id, 0),
                "liked_by_me": rep.id in my_likes,
                "comment_count": comment_counts.get(rep.id, 0),
            }
        )
    return {
        "events": events,
        "has_more": has_more,
        "next_cursor_ts": _iso_utc(last.happened_at) if last else None,
        "next_cursor_id": last.id if last else None,
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


# ---- Programs -------------------------------------------------------------------

class ProgramIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=255)
    objective: Optional[str] = Field(default=None, max_length=2000)
    description: Optional[str] = Field(default=None, max_length=5000)
    owner_email: Optional[str] = None
    eta: Optional[str] = None  # YYYY-MM-DD


class ProgramPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=255)
    objective: Optional[str] = Field(default=None, max_length=2000)
    description: Optional[str] = Field(default=None, max_length=5000)
    owner_email: Optional[str] = None
    eta: Optional[str] = None
    status: Optional[str] = None
    active: Optional[bool] = None


def _parse_eta(eta: Optional[str]):
    if not eta:
        return None
    try:
        return datetime.fromisoformat(eta)
    except ValueError:
        raise HTTPException(status_code=400, detail="ETA must be YYYY-MM-DD")


def _owner_fields(owner_email: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    if not owner_email:
        return None, None
    names = resolve_names({owner_email})
    return owner_email, names.get(owner_email) or owner_email.split("@")[0]


def _serialize_program(p: ProgramRow, updates_count: int = 0) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "objective": p.objective,
        "description": p.description,
        "owner_email": p.owner_email,
        "owner_name": p.owner_name,
        "eta": p.eta.date().isoformat() if p.eta else None,
        "status": p.status,
        "active": bool(p.active),
        "updates_count": updates_count,
        "created_at": _iso_utc(p.created_at),
    }


@api.get("/programs")
def list_programs(
    limit: int = Query(default=10, le=50),
    offset: int = Query(default=0, ge=0),
    admin: dict = Depends(current_admin),
):
    with SessionLocal() as db:
        total = db.query(ProgramRow).count()
        rows = (
            db.query(ProgramRow)
            .order_by(ProgramRow.active.desc(), ProgramRow.eta.asc(), ProgramRow.id.asc())
            .offset(offset)
            .limit(limit)
            .all()
        )
        ids = [p.id for p in rows]
        counts = {}
        if ids:
            counts = dict(
                db.query(ProgramUpdateRow.program_id, func.count())
                .filter(ProgramUpdateRow.program_id.in_(ids))
                .group_by(ProgramUpdateRow.program_id)
            )
    return {
        "programs": [_serialize_program(p, counts.get(p.id, 0)) for p in rows],
        "total": total,
    }


@api.post("/programs", status_code=201)
def create_program(payload: ProgramIn, admin: dict = Depends(current_admin)):
    owner_email, owner_name = _owner_fields(payload.owner_email)
    with SessionLocal() as db:
        row = ProgramRow(
            name=payload.name.strip(),
            objective=(payload.objective or "").strip() or None,
            description=(payload.description or "").strip() or None,
            owner_email=owner_email,
            owner_name=owner_name,
            eta=_parse_eta(payload.eta),
            status="not_started",
            created_by=admin["email"],
        )
        db.add(row)
        db.commit()
        result = _serialize_program(row)
    emit_live_event(
        admin.get("name") or admin["email"],
        "program_created",
        "created program",
        {"name": result["name"], "module": "Programs", "eta": result["eta"], "owner": owner_name},
    )
    return result


@api.patch("/programs/{program_id}")
def patch_program(program_id: int, payload: ProgramPatch, admin: dict = Depends(current_admin)):
    actor = admin.get("name") or admin["email"]
    with SessionLocal() as db:
        row = db.get(ProgramRow, program_id)
        if not row:
            raise HTTPException(status_code=404, detail="Program not found")
        events = []
        if payload.status is not None and payload.status != row.status:
            if payload.status not in STATUS_LABELS:
                raise HTTPException(status_code=400, detail="Bad status")
            events.append(
                (
                    "program_status_changed",
                    "changed program status",
                    {
                        "name": row.name,
                        "module": "Programs",
                        "status": {
                            "from": STATUS_LABELS[row.status],
                            "to": STATUS_LABELS[payload.status],
                        },
                    },
                )
            )
            row.status = payload.status
        if payload.active is not None and bool(row.active) != payload.active:
            row.active = 1 if payload.active else 0
            verb = "reactivated program" if payload.active else "deactivated program"
            events.append(
                (
                    "program_deactivated" if not payload.active else "program_reactivated",
                    verb,
                    {"name": row.name, "module": "Programs"},
                )
            )
        edited = False
        if payload.name is not None and payload.name.strip() != row.name:
            row.name = payload.name.strip()
            edited = True
        if payload.objective is not None and payload.objective.strip() != (row.objective or ""):
            row.objective = payload.objective.strip() or None
            edited = True
        if payload.description is not None and payload.description.strip() != (row.description or ""):
            row.description = payload.description.strip() or None
            edited = True
        if payload.owner_email is not None:
            row.owner_email, row.owner_name = _owner_fields(payload.owner_email or None)
            edited = True
        if payload.eta is not None:
            row.eta = _parse_eta(payload.eta)
            edited = True
        if edited:
            events.append(
                (
                    "program_edited",
                    "edited program",
                    {"name": row.name, "module": "Programs", "owner": row.owner_name,
                     "eta": row.eta.date().isoformat() if row.eta else None},
                )
            )
        db.commit()
        result = _serialize_program(row)
    for action, summary, details in events:
        emit_live_event(actor, action, summary, details)
    return result


@api.get("/programs/{program_id}/updates")
def program_updates(program_id: int, admin: dict = Depends(current_admin)):
    with SessionLocal() as db:
        rows = (
            db.query(ProgramUpdateRow)
            .filter_by(program_id=program_id)
            .order_by(ProgramUpdateRow.id.desc())
            .limit(50)
            .all()
        )
    return [
        {
            "id": r.id,
            "author_name": r.author_name or r.author_email,
            "body": r.body,
            "created_at": _iso_utc(r.created_at),
        }
        for r in rows
    ]


@api.post("/programs/{program_id}/updates", status_code=201)
def add_program_update(
    program_id: int, payload: CommentIn, admin: dict = Depends(current_admin)
):
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Update cannot be empty")
    actor = admin.get("name") or admin["email"]
    with SessionLocal() as db:
        prog = db.get(ProgramRow, program_id)
        if not prog:
            raise HTTPException(status_code=404, detail="Program not found")
        db.add(
            ProgramUpdateRow(
                program_id=program_id,
                author_email=admin["email"],
                author_name=admin.get("name"),
                body=body,
            )
        )
        db.commit()
        prog_name = prog.name
    emit_live_event(
        actor,
        "program_update_posted",
        f"posted update · “{body[:70]}”",
        {"name": prog_name, "module": "Programs"},
    )
    return {"ok": True}


# ---- Anonymous feedback -----------------------------------------------------------

class ActionIn(BaseModel):
    action_item: str = Field(..., min_length=1, max_length=1000)


@api.get("/feedback")
def list_feedback(admin: dict = Depends(current_admin)):
    with SessionLocal() as db:
        rows = db.query(FeedbackRow).order_by(FeedbackRow.id.desc()).limit(100).all()
    return [
        {
            "id": r.id,
            "body": r.body,
            "status": r.status,
            "action_item": r.action_item,
            "action_by": r.action_by,
            "action_at": _iso_utc(r.action_at),
            "created_at": _iso_utc(r.created_at),
        }
        for r in rows
    ]


@api.post("/feedback", status_code=201)
def add_feedback(payload: CommentIn, admin: dict = Depends(current_admin)):
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Feedback cannot be empty")
    # The author is intentionally NOT stored anywhere.
    with SessionLocal() as db:
        db.add(FeedbackRow(body=body))
        db.commit()
    emit_live_event(
        "Anonymous",
        "feedback_received",
        f"shared feedback · “{body[:70]}”",
        {"module": "Feedback"},
    )
    return {"ok": True}


@api.post("/feedback/{feedback_id}/action")
def set_feedback_action(
    feedback_id: int, payload: ActionIn, admin: dict = Depends(current_admin)
):
    actor = admin.get("name") or admin["email"]
    item = payload.action_item.strip()
    with SessionLocal() as db:
        row = db.get(FeedbackRow, feedback_id)
        if not row:
            raise HTTPException(status_code=404, detail="Feedback not found")
        row.action_item = item
        row.action_by = actor
        row.action_at = datetime.now(timezone.utc).replace(tzinfo=None)
        row.status = "actioned"
        db.commit()
    emit_live_event(
        actor,
        "feedback_action_added",
        f"added action item · “{item[:70]}”",
        {"module": "Feedback"},
    )
    return {"ok": True}


app.mount("/api", api)

# ---- Static frontend (production) ------------------------------------------
FRONTEND_DIR = Path(os.environ.get("FRONTEND_DIR", Path(__file__).parent / "static"))
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
