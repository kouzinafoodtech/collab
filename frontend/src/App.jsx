import { useCallback, useEffect, useRef, useState } from "react";

const API = "/api";

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [me, setMe] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("me") || "null");
    } catch {
      return null;
    }
  });

  function authFetch(path, opts = {}) {
    return fetch(`${API}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(opts.headers || {}),
      },
    }).then((r) => {
      if (r.status === 401) {
        // Session expired — drop creds and bounce to login.
        localStorage.removeItem("token");
        localStorage.removeItem("me");
        setToken("");
        setMe(null);
        throw new Error("unauthorized");
      }
      return r;
    });
  }

  function onLoggedIn(data) {
    localStorage.setItem("token", data.token);
    localStorage.setItem("me", JSON.stringify({ email: data.email, name: data.name }));
    setToken(data.token);
    setMe({ email: data.email, name: data.name });
  }

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("me");
    setToken("");
    setMe(null);
  }

  if (!token || !me) {
    return <Login onLoggedIn={onLoggedIn} />;
  }
  return <Messenger me={me} authFetch={authFetch} logout={logout} />;
}

function Login({ onLoggedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`${API}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail || "Login failed");
        return;
      }
      onLoggedIn(await res.json());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app center">
      <form onSubmit={submit} className="card login">
        <h1>Internal Messaging</h1>
        <p className="subtitle">Admins only. Sign in with your work email.</p>
        <input
          type="email"
          autoFocus
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Messenger({ me, authFetch, logout }) {
  const [admins, setAdmins] = useState([]);
  const [selected, setSelected] = useState(null); // recipient email
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const scrollRef = useRef(null);

  // Load the people you can message once.
  useEffect(() => {
    authFetch("/admins")
      .then((r) => r.json())
      .then(setAdmins)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadThread = useCallback(() => {
    if (!selected) return;
    authFetch(`/messages?with_email=${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then(setMessages)
      .catch(() => {});
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the open thread so new messages appear.
  useEffect(() => {
    setMessages([]);
    if (!selected) return;
    loadThread();
    const t = setInterval(loadThread, 2000);
    return () => clearInterval(t);
  }, [selected, loadThread]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    setError("");
    if (!selected || !body.trim()) return;
    try {
      const res = await authFetch("/messages", {
        method: "POST",
        body: JSON.stringify({ recipient: selected, body: body.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail || "Failed to send");
        return;
      }
      setBody("");
      loadThread();
    } catch {
      /* handled by authFetch */
    }
  }

  const selectedAdmin = admins.find((a) => a.email === selected);

  return (
    <div className="messenger">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div>
            <div className="me-name">{me.name}</div>
            <div className="me-email">{me.email}</div>
          </div>
          <button className="link" onClick={logout}>
            sign out
          </button>
        </div>
        <div className="people">
          {admins.map((a) => (
            <button
              key={a.email}
              className={`person ${a.email === selected ? "active" : ""}`}
              onClick={() => setSelected(a.email)}
            >
              <span className="person-name">{a.name || a.email}</span>
              <span className="person-email">{a.email}</span>
            </button>
          ))}
          {admins.length === 0 && <div className="empty">No other admins.</div>}
        </div>
      </aside>

      <main className="chat">
        {!selected ? (
          <div className="empty big">Pick an admin to start a conversation.</div>
        ) : (
          <>
            <header className="chat-head">
              <strong>{selectedAdmin?.name || selected}</strong>
              <span className="chat-email">{selected}</span>
            </header>
            <div className="thread" ref={scrollRef}>
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`bubble ${m.sender === me.email ? "mine" : "theirs"}`}
                >
                  <div className="bubble-body">{m.body}</div>
                  <div className="bubble-time">{timeAgo(m.created_at)}</div>
                </div>
              ))}
              {messages.length === 0 && (
                <div className="empty">No messages yet. Say hi 👋</div>
              )}
            </div>
            {error && <p className="error chat-error">{error}</p>}
            <form className="composer" onSubmit={send}>
              <input
                className="grow"
                placeholder={`Message ${selectedAdmin?.name || selected}…`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <button type="submit">Send</button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
