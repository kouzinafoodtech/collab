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
  return <Shell me={me} authFetch={authFetch} logout={logout} />;
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
        <h1>Kouzina Live Updates</h1>
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

function Shell({ me, authFetch, logout }) {
  const [tab, setTab] = useState("feed");
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Kouzina</div>
        <nav className="tabs">
          <button
            className={`tab ${tab === "feed" ? "active" : ""}`}
            onClick={() => setTab("feed")}
          >
            Live Updates
          </button>
          <button
            className={`tab ${tab === "dms" ? "active" : ""}`}
            onClick={() => setTab("dms")}
          >
            Messages
          </button>
        </nav>
        <div className="topbar-me">
          <span className="me-name">{me.name}</span>
          <button className="link" onClick={logout}>
            sign out
          </button>
        </div>
      </header>
      {tab === "feed" ? (
        <Feed me={me} authFetch={authFetch} />
      ) : (
        <Messenger me={me} authFetch={authFetch} />
      )}
    </div>
  );
}

// ---- Live Updates feed ------------------------------------------------------

const PAGE_FIRST = 10; // small first page = instant paint
const PAGE_MORE = 30;

function mergeEvents(current, incoming) {
  // Union by id, ordered by when the event happened (newest first) — polls
  // update the top of the feed while "Load older" appends history.
  const byId = new Map();
  for (const e of [...current, ...incoming]) byId.set(e.id, e);
  return [...byId.values()].sort(
    (a, b) =>
      (b.happened_at || "").localeCompare(a.happened_at || "") || b.id - a.id
  );
}

function Feed({ me, authFetch }) {
  const [events, setEvents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [openComments, setOpenComments] = useState(null); // event id
  const [reachedEnd, setReachedEnd] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const load = useCallback(() => {
    authFetch(`/feed?limit=${PAGE_FIRST}`)
      .then((r) => r.json())
      .then((data) => {
        setEvents((cur) => mergeEvents(cur, data.events));
        if (data.events.length < PAGE_FIRST) setReachedEnd(true);
        setLoaded(true);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadOlder() {
    if (!events.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const oldest = events[events.length - 1];
      const res = await authFetch(
        `/feed?limit=${PAGE_MORE}&cursor_ts=${encodeURIComponent(
          oldest.happened_at
        )}&cursor_id=${oldest.id}`
      );
      const data = await res.json();
      setEvents((cur) => mergeEvents(cur, data.events));
      if (data.events.length < PAGE_MORE) setReachedEnd(true);
    } catch {
      /* ignore */
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function toggleLike(ev) {
    // Optimistic flip; server response reconciles.
    setEvents((cur) =>
      cur.map((e) =>
        e.id === ev.id
          ? {
              ...e,
              liked_by_me: !e.liked_by_me,
              like_count: e.like_count + (e.liked_by_me ? -1 : 1),
            }
          : e
      )
    );
    try {
      const res = await authFetch(`/feed/${ev.id}/like`, { method: "POST" });
      const data = await res.json();
      setEvents((cur) =>
        cur.map((e) =>
          e.id === ev.id
            ? { ...e, liked_by_me: data.liked, like_count: data.like_count }
            : e
        )
      );
    } catch {
      /* poll will reconcile */
    }
  }

  return (
    <main className="feed">
      {events.map((ev) => (
        <article key={ev.id} className="event card">
          <div className="event-head">
            <span className={`badge badge-${ev.portal.toLowerCase()}`}>{ev.portal}</span>
            <strong className="event-actor">{ev.actor}</strong>
            <span className="event-summary">{ev.summary}</span>
            <span className="event-time">{timeAgo(ev.happened_at)}</span>
          </div>
          <div className="event-actions">
            <button
              className={`react ${ev.liked_by_me ? "liked" : ""}`}
              onClick={() => toggleLike(ev)}
            >
              {ev.liked_by_me ? "♥" : "♡"} {ev.like_count || ""}
            </button>
            <button
              className="react"
              onClick={() =>
                setOpenComments(openComments === ev.id ? null : ev.id)
              }
            >
              💬 {ev.comment_count || ""}
            </button>
          </div>
          {openComments === ev.id && (
            <Comments eventId={ev.id} authFetch={authFetch} onPosted={load} />
          )}
        </article>
      ))}
      {events.length === 0 && (
        <div className="empty big">
          {loaded
            ? "No updates yet — actions on the portals will appear here."
            : "Loading updates…"}
        </div>
      )}
      {events.length > 0 && !reachedEnd && (
        <button className="load-older" onClick={loadOlder} disabled={loadingOlder}>
          {loadingOlder ? "Loading…" : "Load older updates"}
        </button>
      )}
    </main>
  );
}

function Comments({ eventId, authFetch, onPosted }) {
  const [comments, setComments] = useState([]);
  const [body, setBody] = useState("");

  const load = useCallback(() => {
    authFetch(`/feed/${eventId}/comments`)
      .then((r) => r.json())
      .then(setComments)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(load, [load]);

  async function post(e) {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await authFetch(`/feed/${eventId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: body.trim() }),
      });
      setBody("");
      load();
      onPosted();
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="comments">
      {comments.map((c) => (
        <div key={c.id} className="comment">
          <strong>{c.admin_name}</strong>
          <span>{c.body}</span>
          <span className="comment-time">{timeAgo(c.created_at)}</span>
        </div>
      ))}
      <form onSubmit={post} className="comment-form">
        <input
          className="grow"
          placeholder="Add a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="submit">Post</button>
      </form>
    </div>
  );
}

// ---- Direct messages ----------------------------------------------------------

function Messenger({ me, authFetch }) {
  const [admins, setAdmins] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const scrollRef = useRef(null);

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
