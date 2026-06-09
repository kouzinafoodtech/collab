import { useEffect, useState, useCallback } from "react";

const API = "/api";

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

export default function App() {
  const [me, setMe] = useState(localStorage.getItem("me") || "");
  const [nameInput, setNameInput] = useState("");
  const [recipient, setRecipient] = useState("");
  const [body, setBody] = useState("");
  const [messages, setMessages] = useState([]);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [m, u] = await Promise.all([
        fetch(`${API}/messages`).then((r) => r.json()),
        fetch(`${API}/users`).then((r) => r.json()),
      ]);
      setMessages(m);
      setUsers(u);
    } catch {
      setError("Could not reach the backend. Is it running on :8000?");
    }
  }, []);

  // Poll the public feed so everyone sees new messages without refreshing.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  async function signIn(e) {
    e.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    await fetch(`${API}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    localStorage.setItem("me", name);
    setMe(name);
    setNameInput("");
    refresh();
  }

  function signOut() {
    localStorage.removeItem("me");
    setMe("");
  }

  async function send(e) {
    e.preventDefault();
    setError("");
    if (!recipient.trim() || !body.trim()) return;
    const res = await fetch(`${API}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: me, recipient: recipient.trim(), body: body.trim() }),
    });
    if (!res.ok) {
      setError("Failed to send message.");
      return;
    }
    setBody("");
    refresh();
  }

  if (!me) {
    return (
      <div className="app">
        <h1>Internal Messaging</h1>
        <p className="subtitle">Pick a name to start. Everyone can see every message.</p>
        <form onSubmit={signIn} className="card signin">
          <input
            autoFocus
            placeholder="Your name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
          />
          <button type="submit">Enter</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Internal Messaging</h1>
        <div className="me">
          <span>
            You are <strong>{me}</strong>
          </span>
          <button className="link" onClick={signOut}>
            switch
          </button>
        </div>
      </header>

      <form onSubmit={send} className="card composer">
        <input
          list="users"
          placeholder="To (anyone)"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />
        <datalist id="users">
          {users.map((u) => (
            <option key={u.id} value={u.name} />
          ))}
        </datalist>
        <input
          className="grow"
          placeholder="Type a message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="submit">Send</button>
      </form>

      {error && <p className="error">{error}</p>}

      <h2 className="feed-title">Public feed · {messages.length} messages</h2>
      <ul className="feed">
        {messages
          .slice()
          .reverse()
          .map((m) => (
            <li key={m.id} className="msg">
              <div className="msg-head">
                <span className="from">{m.sender}</span>
                <span className="arrow">→</span>
                <span className="to">{m.recipient}</span>
                <span className="time">{timeAgo(m.created_at)}</span>
              </div>
              <div className="msg-body">{m.body}</div>
            </li>
          ))}
        {messages.length === 0 && <li className="empty">No messages yet. Say hi 👋</li>}
      </ul>
    </div>
  );
}
