"""
Internal messaging system — backend.

Anyone can register, anyone can message anyone, and every message is stored in
the database. The whole feed is public: everyone can see every message sent
between everyone.

Storage:
    Set DATABASE_URL to a SQLAlchemy URL. For Azure Database for MySQL:
        mysql+pymysql://USER:PASSWORD@HOST:3306/DBNAME
    Azure MySQL requires TLS; this is enabled automatically for mysql URLs.
    If DATABASE_URL is unset, falls back to a local SQLite file (handy for dev).

Serving:
    In production this app also serves the built React frontend (the contents
    of the directory named by FRONTEND_DIR, default ./static) at "/", with the
    API mounted under "/api".
"""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
)
from sqlalchemy.orm import declarative_base, sessionmaker

# ---- Database --------------------------------------------------------------


def _build_db_url():
    """Pick where to store data.

    Prefer discrete MYSQL_* env vars: SQLAlchemy's URL.create() escapes the
    password for us, so any special characters (@, :, /, #, …) just work — no
    manual URL-encoding needed. Fall back to a full DATABASE_URL string, then to
    a local SQLite file for development.
    """
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

# MySQL on Azure requires TLS. Enable it for any mysql URL. If a CA bundle path
# is provided we verify against it; otherwise we still use TLS (Azure terminates
# with a trusted cert, so unverified TLS keeps the connection encrypted).
connect_args = {}
if _backend.startswith("mysql"):
    ca = os.environ.get("MYSQL_SSL_CA")
    connect_args = {"ssl": {"ca": ca} if ca else {"ssl": True}}
elif _backend.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
Base = declarative_base()


class UserRow(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(50), unique=True, nullable=False)


class MessageRow(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, autoincrement=True)
    sender = Column(String(50), nullable=False)
    recipient = Column(String(50), nullable=False)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


Base.metadata.create_all(engine)


# ---- App -------------------------------------------------------------------

app = FastAPI(title="Internal Messaging")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Schemas ---------------------------------------------------------------

class UserIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)


class User(BaseModel):
    id: int
    name: str


class MessageIn(BaseModel):
    sender: str = Field(..., min_length=1, max_length=50)
    recipient: str = Field(..., min_length=1, max_length=50)
    body: str = Field(..., min_length=1, max_length=2000)


class Message(BaseModel):
    id: int
    sender: str
    recipient: str
    body: str
    created_at: str


# ---- API -------------------------------------------------------------------

api = FastAPI()  # sub-app so everything below lives under /api

api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@api.get("/health")
def health():
    return {"status": "ok"}


@api.get("/users", response_model=list[User])
def list_users():
    with SessionLocal() as db:
        rows = db.query(UserRow).order_by(UserRow.name).all()
    return [User(id=r.id, name=r.name) for r in rows]


@api.post("/users", response_model=User, status_code=201)
def create_user(user: UserIn):
    name = user.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    with SessionLocal() as db:
        existing = db.query(UserRow).filter(UserRow.name == name).one_or_none()
        if existing:
            return User(id=existing.id, name=existing.name)
        row = UserRow(name=name)
        db.add(row)
        db.commit()
        return User(id=row.id, name=row.name)


@api.get("/messages", response_model=list[Message])
def list_messages():
    """The whole public feed — every message between everyone."""
    with SessionLocal() as db:
        rows = db.query(MessageRow).order_by(MessageRow.id.asc()).all()
    return [
        Message(
            id=r.id,
            sender=r.sender,
            recipient=r.recipient,
            body=r.body,
            created_at=r.created_at.isoformat() if r.created_at else "",
        )
        for r in rows
    ]


@api.post("/messages", response_model=Message, status_code=201)
def send_message(msg: MessageIn):
    sender = msg.sender.strip()
    recipient = msg.recipient.strip()
    body = msg.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Message body cannot be empty")

    with SessionLocal() as db:
        # Auto-register sender and recipient so messaging "just works".
        for name in (sender, recipient):
            if not db.query(UserRow).filter(UserRow.name == name).one_or_none():
                db.add(UserRow(name=name))
        row = MessageRow(sender=sender, recipient=recipient, body=body)
        db.add(row)
        db.commit()
        return Message(
            id=row.id,
            sender=row.sender,
            recipient=row.recipient,
            body=row.body,
            created_at=row.created_at.isoformat() if row.created_at else "",
        )


app.mount("/api", api)

# ---- Static frontend (production) ------------------------------------------
# Serve the built React app at "/" if it has been built into FRONTEND_DIR.
# Mounted last so it doesn't shadow /api.
FRONTEND_DIR = Path(os.environ.get("FRONTEND_DIR", Path(__file__).parent / "static"))
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
