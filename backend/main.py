"""
Internal messaging — admin-only, private 1:1 direct messages.

Auth:
    Admins log in with their pkdb.admins email + password (bcrypt). On success
    they get a signed JWT (HS256, signed with APP_SECRET) used as a Bearer token.

Messaging:
    Messages are private between two admins. You only ever see conversations you
    are part of, and you can only message active admins (no external parties).

Storage:
    Messages live in this app's database (DATABASE_URL / MYSQL_* — see below).
    Admins are read from pkdb.admins on the SAME MySQL server via a cross-database
    query, so no separate connection is needed.
"""

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, FastAPI, HTTPException, Query
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
    create_engine,
    func,
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


Base.metadata.create_all(engine)

# Existing deployments created sender/recipient as VARCHAR(50); emails need more.
if IS_MYSQL:
    with engine.begin() as conn:
        for col in ("sender", "recipient"):
            try:
                conn.execute(text(f"ALTER TABLE messages MODIFY {col} VARCHAR(255) NOT NULL"))
            except Exception:
                pass  # already widened


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


def _serialize(r: MessageRow) -> Message:
    return Message(
        id=r.id,
        sender=r.sender,
        recipient=r.recipient,
        body=r.body,
        created_at=r.created_at.isoformat() if r.created_at else "",
    )


# ---- App -------------------------------------------------------------------

app = FastAPI(title="Internal Messaging")
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
    return [_serialize(r) for r in rows]


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
        return _serialize(row)


app.mount("/api", api)

# ---- Static frontend (production) ------------------------------------------
FRONTEND_DIR = Path(os.environ.get("FRONTEND_DIR", Path(__file__).parent / "static"))
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
