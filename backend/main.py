"""
Internal messaging system — backend.

Anyone can register, anyone can message anyone, and every message is stored in
SQLite. The whole feed is public: everyone can see every message sent between
everyone.

Run:
    pip install -r requirements.txt
    uvicorn main:app --reload
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB_PATH = Path(__file__).parent / "messages.db"

app = FastAPI(title="Internal Messaging")

# Allow the React dev server (and anything else, since this is an internal demo)
# to talk to the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                sender     TEXT NOT NULL,
                recipient  TEXT NOT NULL,
                body       TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )


init_db()


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


# ---- Users -----------------------------------------------------------------

@app.get("/users", response_model=list[User])
def list_users():
    with get_db() as conn:
        rows = conn.execute("SELECT id, name FROM users ORDER BY name").fetchall()
    return [dict(r) for r in rows]


@app.post("/users", response_model=User, status_code=201)
def create_user(user: UserIn):
    name = user.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id, name FROM users WHERE name = ?", (name,)
        ).fetchone()
        if existing:
            # Registering an existing name is idempotent — just return them.
            return dict(existing)
        cur = conn.execute("INSERT INTO users (name) VALUES (?)", (name,))
        return {"id": cur.lastrowid, "name": name}


# ---- Messages --------------------------------------------------------------

@app.get("/messages", response_model=list[Message])
def list_messages():
    """The whole public feed — every message between everyone."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, sender, recipient, body, created_at "
            "FROM messages ORDER BY id ASC"
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/messages", response_model=Message, status_code=201)
def send_message(msg: MessageIn):
    sender = msg.sender.strip()
    recipient = msg.recipient.strip()
    body = msg.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Message body cannot be empty")

    created_at = datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        # Auto-register sender and recipient so messaging "just works".
        for name in (sender, recipient):
            conn.execute("INSERT OR IGNORE INTO users (name) VALUES (?)", (name,))
        cur = conn.execute(
            "INSERT INTO messages (sender, recipient, body, created_at) "
            "VALUES (?, ?, ?, ?)",
            (sender, recipient, body, created_at),
        )
        return {
            "id": cur.lastrowid,
            "sender": sender,
            "recipient": recipient,
            "body": body,
            "created_at": created_at,
        }
