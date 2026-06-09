# Internal Messaging

A tiny internal messaging system. Anyone can register, anyone can message
anyone, every message is stored in a database, and the **whole feed is public** —
everyone can see every message sent between everyone.

- **Backend:** Python · FastAPI · SQLite (`backend/`)
- **Frontend:** React · Vite (`frontend/`)

## Run it

### 1. Backend (port 8000)

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

This creates a local `messages.db` SQLite file on first run.

### 2. Frontend (port 5173)

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend
on port 8000, so no CORS setup is needed.

Open it in two browser tabs, pick a different name in each, and message back and
forth — the public feed updates every couple of seconds.

## API

| Method | Path        | Description                              |
| ------ | ----------- | ---------------------------------------- |
| GET    | `/users`    | List everyone who has registered         |
| POST   | `/users`    | Register a name (idempotent)             |
| GET    | `/messages` | The public feed — every message          |
| POST   | `/messages` | Send a message (auto-registers names)    |

Example:

```bash
curl -X POST localhost:8000/messages \
  -H 'Content-Type: application/json' \
  -d '{"sender":"Alice","recipient":"Bob","body":"hey bob, lunch?"}'
```
