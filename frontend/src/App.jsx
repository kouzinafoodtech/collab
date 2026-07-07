import { useCallback, useEffect, useState } from "react";

const API = "/api";

function formatWhen(iso) {
  // Absolute local date + time, e.g. "10:49 AM" today or "6 Jul, 10:49 AM".
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}

function actorColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 62%, 46%)`;
}

function actorTint(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 95%)`;
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function actionKind(action) {
  if (/stock|inventory|quantity|csv/.test(action)) return "stock";
  if (/order|grn|dispatch|deliver/.test(action)) return "order";
  if (/expense|bill|invoice|paid|payment|payout|credit/.test(action)) return "money";
  if (/admin|user|permission|role/.test(action)) return "people";
  if (/price/.test(action)) return "price";
  return "other";
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
        <div className="brand login-brand">
          <span className="live-dot" />
          Kouzina <span className="brand-live">Live</span>
        </div>
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

const PORTALS = [
  { label: "KPK", href: "https://partner.kftpl.com" },
  { label: "KFC", href: "https://finance.kftpl.com" },
  { label: "KAC", href: "https://admin.kftpl.com" },
];

function Shell({ me, authFetch, logout }) {
  const [person, setPerson] = useState(null); // {actor, email, count}
  const [board, setBoard] = useState([]);

  const loadBoard = useCallback(() => {
    authFetch("/leaderboard")
      .then((r) => r.json())
      .then(setBoard)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadBoard();
    const t = setInterval(loadBoard, 60000);
    return () => clearInterval(t);
  }, [loadBoard]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="live-dot" />
          Kouzina <span className="brand-live">Live</span>
        </div>
        <nav className="portal-links">
          {PORTALS.map((p) => (
            <a key={p.label} href={p.href} target="_blank" rel="noreferrer">
              {p.label} <span className="ext">↗</span>
            </a>
          ))}
        </nav>
        <div className="topbar-me">
          <span className="me-name">{me.name}</span>
          <button className="link" onClick={logout}>
            sign out
          </button>
        </div>
      </header>

      <div className="layout">
        <div className="feed-col">
          {person && (
            <PersonPanel
              key={person.actor}
              person={person}
              me={me}
              authFetch={authFetch}
              onClose={() => setPerson(null)}
            />
          )}
          <Feed
            key={person ? person.actor : "__all__"}
            authFetch={authFetch}
            actor={person ? person.actor : null}
          />
        </div>
        <Leaderboard board={board} selected={person?.actor} onSelect={setPerson} />
      </div>
    </div>
  );
}

function Leaderboard({ board, selected, onSelect }) {
  return (
    <aside className="leaderboard">
      <div className="lb-title">Most active · 12h</div>
      <div className="lb-list">
        {board.map((p, i) => (
          <button
            key={p.actor}
            className={`lb-item ${selected === p.actor ? "active" : ""}`}
            onClick={() => onSelect(selected === p.actor ? null : p)}
          >
            <span className="lb-rank">{i + 1}</span>
            <span className="avatar sm" style={{ background: actorColor(p.actor) }}>
              {initials(p.actor)}
            </span>
            <span className="lb-name">{p.actor}</span>
            <span className="lb-count">{p.count}</span>
          </button>
        ))}
        {board.length === 0 && <div className="empty">Quiet last 12 hours.</div>}
      </div>
    </aside>
  );
}

function PersonPanel({ person, me, authFetch, onClose }) {
  return (
    <section className="person-panel card">
      <div className="person-head">
        <span className="avatar" style={{ background: actorColor(person.actor) }}>
          {initials(person.actor)}
        </span>
        <div className="person-id">
          <strong>{person.actor}</strong>
          <span className="person-sub">
            {person.count} actions in the last 12h
            {person.email ? ` · ${person.email}` : ""}
          </span>
        </div>
        <button className="link" onClick={onClose}>
          ✕ close
        </button>
      </div>
      {person.email && person.email !== me.email ? (
        <Wall email={person.email} name={person.actor} authFetch={authFetch} />
      ) : person.email === me.email ? (
        <Wall email={person.email} name="you" authFetch={authFetch} readOnly />
      ) : (
        <p className="person-sub muted">
          Not a messageable admin — showing their activity below.
        </p>
      )}
    </section>
  );
}

function Wall({ email, name, authFetch, readOnly = false }) {
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    authFetch(`/wall/${encodeURIComponent(email)}`)
      .then((r) => r.json())
      .then(setMessages)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function send(e) {
    e.preventDefault();
    setError("");
    if (!body.trim()) return;
    try {
      const res = await authFetch(`/wall/${encodeURIComponent(email)}`, {
        method: "POST",
        body: JSON.stringify({ body: body.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail || "Failed to send");
        return;
      }
      setBody("");
      load();
    } catch {
      /* handled */
    }
  }

  return (
    <div className="wall">
      {!readOnly && (
        <form className="wall-form" onSubmit={send}>
          <input
            className="grow"
            placeholder={`Message ${name}… (visible to all admins)`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button type="submit">Send</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      <div className="wall-list">
        {messages.map((m) => (
          <div
            key={m.id}
            className="wall-msg"
            style={{
              background: actorTint(m.sender_name),
              borderLeftColor: actorColor(m.sender_name),
            }}
          >
            <span className="wall-sender" style={{ color: actorColor(m.sender_name) }}>
              {m.sender_name}
            </span>
            <span className="wall-body">{m.body}</span>
            <span className="wall-time">{timeAgo(m.created_at)}</span>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="empty">No messages for {name} yet — be the first 👋</div>
        )}
      </div>
    </div>
  );
}

// ---- Live Updates feed ------------------------------------------------------

const PAGE_FIRST = 10; // small first page = instant paint
const PAGE_MORE = 20;

function Feed({ authFetch, actor }) {
  const [top, setTop] = useState([]); // freshest page, replaced by each poll
  const [older, setOlder] = useState([]); // paged history, appended
  const [cursor, setCursor] = useState(null); // {ts, id} for the next older page
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [openComments, setOpenComments] = useState(null); // event id
  const [expanded, setExpanded] = useState(null); // group id with extras open
  const [loadingOlder, setLoadingOlder] = useState(false);

  const actorQS = actor ? `&actor=${encodeURIComponent(actor)}` : "";

  const load = useCallback(
    (manual = false) => {
      if (manual) setRefreshing(true);
      authFetch(`/feed?limit=${PAGE_FIRST}${actorQS}`)
        .then((r) => r.json())
        .then((data) => {
          setTop(data.events);
          setUpdatedAt(new Date());
          setLoaded(true);
          setOlder((cur) => {
            if (cur.length === 0) {
              setCursor(
                data.next_cursor_id
                  ? { ts: data.next_cursor_ts, id: data.next_cursor_id }
                  : null
              );
              setHasMore(data.has_more);
            }
            return cur;
          });
        })
        .catch(() => {})
        .finally(() => setRefreshing(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actorQS]
  );

  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await authFetch(
        `/feed?limit=${PAGE_MORE}&cursor_ts=${encodeURIComponent(
          cursor.ts
        )}&cursor_id=${cursor.id}${actorQS}`
      );
      const data = await res.json();
      setOlder((cur) => [...cur, ...data.events]);
      setCursor(
        data.next_cursor_id
          ? { ts: data.next_cursor_ts, id: data.next_cursor_id }
          : null
      );
      setHasMore(data.has_more);
    } catch {
      /* ignore */
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => load(false), 10000);
    return () => clearInterval(t);
  }, [load]);

  // Top page wins on overlap with paged history.
  const topIds = new Set(top.map((e) => e.id));
  const events = [...top, ...older.filter((e) => !topIds.has(e.id))];

  async function toggleLike(ev) {
    // Optimistic flip; server response reconciles.
    const patch = (list) =>
      list.map((e) =>
        e.id === ev.id
          ? {
              ...e,
              liked_by_me: !e.liked_by_me,
              like_count: e.like_count + (e.liked_by_me ? -1 : 1),
            }
          : e
      );
    setTop(patch);
    setOlder(patch);
    try {
      const res = await authFetch(`/feed/${ev.id}/like`, { method: "POST" });
      const data = await res.json();
      const settle = (list) =>
        list.map((e) =>
          e.id === ev.id
            ? { ...e, liked_by_me: data.liked, like_count: data.like_count }
            : e
        );
      setTop(settle);
      setOlder(settle);
    } catch {
      /* poll will reconcile */
    }
  }

  return (
    <main className="feed">
      <div className="feed-bar">
        <span className="feed-updated">
          {updatedAt
            ? `Updated ${updatedAt.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}`
            : "Loading…"}
        </span>
        <button
          className={`refresh ${refreshing ? "spinning" : ""}`}
          onClick={() => load(true)}
          disabled={refreshing}
        >
          <span className="refresh-icon">⟳</span> Refresh
        </button>
      </div>
      {events.map((ev) => (
        <article key={ev.id} className={`event card kind-${actionKind(ev.action)}`}>
          <div className="event-row">
            <span className="avatar" style={{ background: actorColor(ev.actor) }}>
              {initials(ev.actor)}
            </span>
            <div className="event-main">
              <div className="event-head">
                <strong className="event-actor">{ev.actor}</strong>
                <span className={`badge badge-${ev.portal.toLowerCase()}`}>
                  {ev.portal}
                </span>
                <span className={`chip chip-${actionKind(ev.action)}`}>
                  {ev.action.replace(/_/g, " ")}
                </span>
                {ev.count > 1 && <span className="count-pill">×{ev.count}</span>}
                <span
                  className="event-time"
                  title={new Date(ev.happened_at).toLocaleString()}
                >
                  {formatWhen(ev.happened_at)}
                </span>
              </div>
              <div className="event-summary">{ev.summary}</div>
              {ev.count > 1 && (
                <>
                  <button
                    className="link expand"
                    onClick={() => setExpanded(expanded === ev.id ? null : ev.id)}
                  >
                    {expanded === ev.id
                      ? "hide"
                      : `show ${ev.count - 1} more like this`}
                  </button>
                  {expanded === ev.id && (
                    <ul className="extras">
                      {ev.extras.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                      {ev.count - 1 > ev.extras.length && (
                        <li className="muted">
                          …and {ev.count - 1 - ev.extras.length} more
                        </li>
                      )}
                    </ul>
                  )}
                </>
              )}
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
                <Comments
                  eventId={ev.id}
                  authFetch={authFetch}
                  onPosted={() => load(false)}
                />
              )}
            </div>
          </div>
        </article>
      ))}
      {events.length === 0 && (
        <div className="empty big">
          {loaded
            ? actor
              ? `No recent activity from ${actor}.`
              : "No updates yet — actions on the portals will appear here."
            : "Loading updates…"}
        </div>
      )}
      {events.length > 0 && hasMore && (
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
          <strong style={{ color: actorColor(c.admin_name) }}>{c.admin_name}</strong>
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
