import { useCallback, useEffect, useMemo, useState } from "react";

const API = "/api";
const SUPERADMIN = "admin@kftpl.com";

function formatWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

function fmtDate(d) {
  if (!d) return "";
  // date-only strings ("2026-07-08") — parse as parts to avoid tz day-shift
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  const dt = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Absolute date + time, e.g. "21 Jul 2026, 4:30 PM" — for update attribution.
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return `${d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function etaLabel(eta) {
  if (!eta) return "no ETA";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(eta));
  const dt = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(eta);
  if (isNaN(dt)) return "no ETA";
  const today = new Date(new Date().toDateString());
  const d = Math.round((dt - today) / 86400000);
  if (d > 1) return `ETA in ${d}d`;
  if (d === 1) return "ETA tomorrow";
  if (d === 0) return "ETA today";
  return `${-d}d past ETA`;
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}

function hue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

const actorColor = (n) => `hsl(${hue(n)}, 62%, 46%)`;
const actorTint = (n) => `hsl(${hue(n)}, 70%, 95%)`;

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function actionKind(action) {
  if (/fail|error|reject|cancel/.test(action)) return "alert";
  if (/feedback/.test(action)) return "feedback";
  if (/program/.test(action)) return "program";
  if (/stock|inventory|quantity|csv/.test(action)) return "stock";
  if (/order|grn|dispatch|deliver|load/.test(action)) return "order";
  if (/expense|bill|invoice|paid|payment|payout|credit/.test(action)) return "money";
  if (/admin|user|permission|role/.test(action)) return "people";
  if (/price/.test(action)) return "price";
  return "other";
}

function LogoMark({ size = 26 }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className="logo-mark" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#lg)" />
      <text
        x="31"
        y="46"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fontSize="38"
        fontWeight="800"
        fill="#fff"
        textAnchor="middle"
      >
        K
      </text>
      <circle cx="50" cy="15" r="7.5" fill="#ef4444" stroke="#fff" strokeWidth="3" />
    </svg>
  );
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
    // FormData bodies must set their own multipart boundary — no JSON header.
    const isForm = opts.body instanceof FormData;
    return fetch(`${API}${path}`, {
      ...opts,
      headers: {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
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
    localStorage.setItem(
      "me",
      JSON.stringify({ email: data.email, name: data.name, is_super: !!data.is_super })
    );
    setToken(data.token);
    setMe({ email: data.email, name: data.name, is_super: !!data.is_super });
  }

  // Keep identity fresh: renames / department changes show without re-login.
  useEffect(() => {
    if (!token) return;
    authFetch("/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.email) {
          const next = {
            email: d.email,
            name: d.name || d.email,
            is_super: !!d.is_super,
            department: d.department || null,
            function: d.function || null,
            owns: d.owns || [],
            pk_tasks_enabled: !!d.pk_tasks_enabled,
          };
          setMe(next);
          localStorage.setItem("me", JSON.stringify(next));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("me");
    setToken("");
    setMe(null);
  }

  if (!token || !me) return <Login onLoggedIn={onLoggedIn} />;
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
          <LogoMark size={34} />
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
  const isSuper = me.is_super || (me.email || "").toLowerCase() === SUPERADMIN;
  const [view, setView] = useState("live"); // live | messages | dash
  const [person, setPerson] = useState(null); // {actor, email, count}
  const [msgFocus, setMsgFocus] = useState(null); // {email, name} open a thread
  const [showPw, setShowPw] = useState(false); // change-my-password modal
  const [deptView, setDeptView] = useState(null); // department page
  const [tasksReturn, setTasksReturn] = useState("live");
  const [deptReturn, setDeptReturn] = useState("live"); // where ← goes back to
  const [peopleOpen, setPeopleOpen] = useState(false); // mobile people drawer
  const [menuOpen, setMenuOpen] = useState(false); // mobile nav menu
  const [board, setBoard] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [team, setTeam] = useState([]); // my department's members
  const [orgRows, setOrgRows] = useState([]); // departments for the mobile menu
  const [redflags, setRedflags] = useState({ total: 0, rules: [] });
  const [overview, setOverview] = useState({
    program_owners: [],
    awaiting_response: [],
    awaiting_response_total: 0,
    messages_waiting: [],
    messages_waiting_total: 0,
    feedback_open: 0,
  });

  const loadBoard = useCallback(() => {
    authFetch("/leaderboard")
      .then((r) => r.json())
      .then(setBoard)
      .catch(() => {});
    authFetch("/redflags")
      .then((r) => r.json())
      .then(setRedflags)
      .catch(() => {});
    authFetch("/overview")
      .then((r) => r.json())
      .then(setOverview)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // My department's members power the "My team · 12h" rail.
  useEffect(() => {
    if (!me.department) {
      setTeam([]);
      return;
    }
    authFetch(`/org/team?department=${encodeURIComponent(me.department)}`)
      .then((r) => r.json())
      .then((d) => setTeam(d.members || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.department]);

  useEffect(() => {
    authFetch("/org/structure")
      .then((r) => r.json())
      .then((d) => setOrgRows(d.rows || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadBoard();
    authFetch("/admins")
      .then((r) => r.json())
      .then(setAdmins)
      .catch(() => {});
    const t = setInterval(loadBoard, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadBoard]);

  function openPerson(p) {
    setPerson(p);
    setView("live");
  }

  function openTasks() {
    if (view !== "tasks") setTasksReturn(view);
    setView("tasks");
    setPeopleOpen(false);
    setMenuOpen(false);
  }

  function openDept(d) {
    if (view !== "dept") setDeptReturn(view); // remember where we came from
    setDeptView(d);
    setView("dept");
    setPeopleOpen(false);
    setMenuOpen(false);
  }

  // Open the Messages tab; with a person, jump straight into their thread.
  function openMessages(personObj) {
    setMsgFocus(personObj && personObj.email ? personObj : null);
    setView("messages");
    setPeopleOpen(false);
  }

  async function openActor(actor) {
    try {
      const res = await authFetch(`/person/${encodeURIComponent(actor)}`);
      openPerson(await res.json());
    } catch {
      openPerson({ actor, email: null, count: 0 });
    }
  }

  function goHome() {
    setPerson(null);
    setView("live");
  }

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand brand-btn" onClick={goHome} title="Go to the live feed">
          <LogoMark />
          Kouzina <span className="brand-live">Live</span>
        </button>
        <nav className="tabs tabs-mobile">
          <button
            className={`tab ${view === "live" ? "active" : ""}`}
            onClick={goHome}
          >
            Live
          </button>
          <button
            className={`tab ${view === "redflags" ? "active" : ""}`}
            onClick={() => setView("redflags")}
          >
            🚩{redflags.total > 0 && <span className="tab-badge">{redflags.total}</span>}
          </button>
        </nav>
        <nav className="tabs tabs-desktop">
          <button
            className={`tab ${view === "live" ? "active" : ""}`}
            onClick={goHome}
          >
            Live
          </button>
          <button
            className={`tab ${view === "redflags" ? "active" : ""}`}
            onClick={() => setView("redflags")}
          >
            🚩 Flags
            {redflags.total > 0 && <span className="tab-badge">{redflags.total}</span>}
          </button>
          <button
            className={`tab ${view === "tasks" ? "active" : ""}`}
            onClick={openTasks}
          >
            Tasks
            {overview.my_tasks_overdue > 0 && (
              <span className="tab-badge">{overview.my_tasks_overdue}</span>
            )}
          </button>
          <button
            className={`tab ${view === "programs" ? "active" : ""}`}
            onClick={() => setView("programs")}
          >
            Programs
          </button>
          <button
            className={`tab ${view === "feedback" ? "active" : ""}`}
            onClick={() => setView("feedback")}
          >
            Feedback
          </button>
          <button
            className={`tab ${view === "messages" ? "active" : ""}`}
            onClick={() => setView("messages")}
          >
            Messages
            {overview.messages_waiting_total > 0 && (
              <span className="tab-badge">{overview.messages_waiting_total}</span>
            )}
          </button>
          {isSuper && (
            <button
              className={`tab ${view === "dash" ? "active" : ""}`}
              onClick={() => setView("dash")}
            >
              Dashboard
            </button>
          )}
          {isSuper && (
            <button
              className={`tab ${view === "users" ? "active" : ""}`}
              onClick={() => setView("users")}
            >
              Users
            </button>
          )}
        </nav>
        <nav className="portal-links">
          {PORTALS.map((p) => (
            <a key={p.label} href={p.href} target="_blank" rel="noreferrer">
              {p.label} <span className="ext">↗</span>
            </a>
          ))}
        </nav>
        <div className="topbar-me">
          <span className="me-name">{me.name}</span>
          {me.department && (
            <button
              className="me-dept"
              onClick={() => openDept(me.department)}
              title={`Open the ${me.department} department page`}
            >
              ({me.department})
            </button>
          )}
          <button className="link" onClick={() => setShowPw(true)} title="Change my password">
            🔑
          </button>
          <button className="link" onClick={logout}>
            sign out
          </button>
        </div>
        <button
          className="menu-btn"
          aria-label="Menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? "✕" : "☰"}
        </button>
      </header>
      {menuOpen && (
        <nav className="mobile-menu">
          {[
            ["live", "🔴 Live"],
            ["tasks", `📋 Tasks${overview.my_tasks_overdue ? ` (${overview.my_tasks_overdue}!)` : ""}`],
            ["redflags", `🚩 Flags${redflags.total ? ` (${redflags.total})` : ""}`],
            ["programs", "📌 Programs"],
            ["feedback", "🎭 Feedback"],
            ["messages", "💬 Messages"],
            ...(isSuper ? [["dash", "📊 Dashboard"], ["users", "👥 Users"]] : []),
          ].map(([v, label]) => (
            <button
              key={v}
              className={`mm-item ${view === v ? "active" : ""}`}
              onClick={() => {
                if (v === "live") goHome();
                else if (v === "tasks") openTasks();
                else setView(v);
                setMenuOpen(false);
              }}
            >
              {label}
            </button>
          ))}
          <div className="mm-divider" />
          <div className="mm-label">Departments</div>
          {orgRows
            .slice()
            .sort(
              (a, b) =>
                (b.programs || 0) - (a.programs || 0) ||
                a.department.localeCompare(b.department)
            )
            .map((r) => (
              <button
                key={r.department}
                className="mm-item mm-dept"
                onClick={() => openDept(r.department)}
              >
                🏛 {r.department} ({r.programs || 0})
              </button>
            ))}
          <div className="mm-divider" />
          {PORTALS.map((p) => (
            <a
              key={p.label}
              className="mm-item"
              href={p.href}
              target="_blank"
              rel="noreferrer"
            >
              {p.label} ↗
            </a>
          ))}
          <div className="mm-divider" />
          {me.department && (
            <button
              className="mm-item"
              onClick={() => openDept(me.department)}
            >
              👥 My team ({me.department})
            </button>
          )}
          <button
            className="mm-item"
            onClick={() => {
              setShowPw(true);
              setMenuOpen(false);
            }}
          >
            🔑 Change password
          </button>
          <button className="mm-item" onClick={logout}>
            Sign out ({me.name})
          </button>
        </nav>
      )}

      {view === "live" && (
        <div className="layout layout-dash">
          <DashRail
            overview={overview}
            open={peopleOpen}
            onOpenMessages={openMessages}
            onOpenTasks={openTasks}
            onOpenPrograms={() => {
              setView("programs");
              setPeopleOpen(false);
            }}
            onOpenFeedback={() => {
              setView("feedback");
              setPeopleOpen(false);
            }}
          />
          <div className="feed-col">
            {person && (
              <PersonPanel
                key={`panel-${person.actor}`}
                person={person}
                me={me}
                authFetch={authFetch}
                onClose={() => setPerson(null)}
              />
            )}
            <Feed
              key={person ? `feed-${person.actor}` : "feed-all"}
              authFetch={authFetch}
              actor={person ? person.actor : null}
              onActor={openActor}
            />
          </div>
          <Sidebar
            board={board}
            admins={admins}
            team={team}
            teamName={me.department}
            overview={overview}
            selected={person?.actor}
            open={peopleOpen}
            onCloseDrawer={() => setPeopleOpen(false)}
            onSelect={(p) => {
              openActor(p.actor); // full fetch: brings email + owned programs
              setPeopleOpen(false);
            }}
            onClear={() => {
              setPerson(null);
              setPeopleOpen(false);
            }}
          />
          {!peopleOpen && (
            <button className="people-fab" onClick={() => setPeopleOpen(true)}>
              📊 Dashboard
            </button>
          )}
        </div>
      )}
      {view === "redflags" && (
        <RedFlags data={redflags} admins={admins} authFetch={authFetch} me={me} onReload={loadBoard} />
      )}
      {view === "programs" && (
        <Programs me={me} admins={admins} authFetch={authFetch} onOpenDept={openDept} />
      )}
      {view === "feedback" && <Feedback authFetch={authFetch} />}
      {view === "messages" &&
        (msgFocus && msgFocus.email ? (
          <ConversationView
            me={me}
            person={msgFocus}
            admins={admins}
            authFetch={authFetch}
            onBack={() => setMsgFocus(null)}
            onActor={openActor}
          />
        ) : (
          <MessagesHub
            me={me}
            admins={admins}
            authFetch={authFetch}
            onActor={openActor}
            onOpenPerson={openMessages}
          />
        ))}
      {view === "dash" && <Dashboard authFetch={authFetch} />}
      {view === "users" && isSuper && (
        <UsersAdmin authFetch={authFetch} me={me} onOpenDept={openDept} />
      )}
      {view === "tasks" && (
        <TasksView
          me={me}
          admins={admins}
          authFetch={authFetch}
          onBack={() => setView(tasksReturn)}
        />
      )}
      {view === "dept" && deptView && (
        <DeptView
          department={deptView}
          me={me}
          admins={admins}
          authFetch={authFetch}
          onActor={openActor}
          onMessage={openMessages}
          onBack={() => setView(deptReturn)}
        />
      )}
      {showPw && <ChangePassword authFetch={authFetch} onClose={() => setShowPw(false)} />}

    </div>
  );
}

// ---- Sidebar: leadership + all admins ----------------------------------------

function PersonRow({ entry, selected, onClick, rank }) {
  return (
    <button className={`lb-item ${selected ? "active" : ""}`} onClick={onClick}>
      {rank != null && <span className="lb-rank">{rank}</span>}
      <span className="avatar sm" style={{ background: actorColor(entry.actor) }}>
        {initials(entry.actor)}
      </span>
      <span className="lb-name">{entry.actor}</span>
      {entry.count > 0 && <span className="lb-count">{entry.count}</span>}
    </button>
  );
}

// Left rail: my work (tasks + programs) + who owes replies + open feedback.
function DashRail({ overview, open, onOpenMessages, onOpenTasks, onOpenPrograms, onOpenFeedback }) {
  const awaiting = overview.awaiting_response || [];
  const waiting = overview.messages_waiting || [];
  const myTasks = (overview.my_tasks || []).filter((t) => t.status !== "completed");
  const myProgs = overview.my_programs || [];
  return (
    <aside className={`dash-rail ${open ? "open" : ""}`}>
      <div className="lb-section">
        <div className="lb-title">
          📋 My work
          {overview.my_tasks_overdue > 0 && (
            <span className="lb-title-badge">{overview.my_tasks_overdue}</span>
          )}
        </div>
        <div className="lb-list">
          {myTasks.slice(0, 5).map((t) => (
            <button key={`t-${t.id}`} className="mywork-item" onClick={onOpenTasks}>
              <span className={`mywork-dot ${t.overdue ? "over" : ""}`} />
              <span className="mywork-title">{t.title}</span>
              {t.cutoff_date && (
                <span className={`mywork-due ${t.overdue ? "over" : ""}`}>
                  {fmtDate(t.cutoff_date)}
                </span>
              )}
            </button>
          ))}
          {myProgs.slice(0, 3).map((p) => (
            <button key={`p-${p.id}`} className="mywork-item" onClick={onOpenPrograms}>
              <span className="mywork-dot prog" />
              <span className="mywork-title">📌 {p.name}</span>
              {p.eta && <span className="mywork-due">{fmtDate(p.eta)}</span>}
            </button>
          ))}
          {myTasks.length === 0 && myProgs.length === 0 && (
            <div className="empty">Nothing assigned to you 🎉</div>
          )}
        </div>
        <button className="link lb-more" onClick={onOpenTasks}>
          Open my tasks →
        </button>
      </div>
      <div className="lb-section">
        <div className="lb-title">
          Not responded
          {awaiting.length > 0 && (
            <span className="lb-title-badge">{awaiting.length}</span>
          )}
        </div>
        <div className="lb-list">
          {awaiting.map((p) => (
            <button
              key={p.email}
              className="lb-item"
              onClick={() => onOpenMessages({ email: p.email, name: p.name })}
            >
              <span className="avatar sm" style={{ background: actorColor(p.name) }}>
                {initials(p.name)}
              </span>
              <span className="lb-name">{p.name}</span>
              <span className="lb-count wait" title={`${p.count} waiting on a reply`}>
                {p.count}
              </span>
            </button>
          ))}
          {awaiting.length === 0 && (
            <div className="empty">Everyone's responded 🎉</div>
          )}
        </div>
      </div>

      <div className="lb-section">
        <div className="lb-title">
          Waiting on you
          {overview.messages_waiting_total > 0 && (
            <span className="lb-title-badge">{overview.messages_waiting_total}</span>
          )}
        </div>
        <div className="lb-list">
          {waiting.map((w) => (
            <button
              key={w.email}
              className="lb-item"
              onClick={() => onOpenMessages({ email: w.email, name: w.name })}
            >
              <span className="avatar sm" style={{ background: actorColor(w.name) }}>
                {initials(w.name)}
              </span>
              <span className="lb-name">{w.name}</span>
              <span className="lb-count wait">{w.count}</span>
            </button>
          ))}
          {waiting.length === 0 && (
            <div className="empty">You're all caught up 🎉</div>
          )}
        </div>
        <button className="link lb-more" onClick={() => onOpenMessages()}>
          Open messages →
        </button>
      </div>

      <div className="lb-section">
        <div className="lb-title">Feedback</div>
        <button className="dash-stat" onClick={onOpenFeedback}>
          <span className="dash-stat-num">{overview.feedback_open}</span>
          <span className="dash-stat-lbl">
            open item{overview.feedback_open === 1 ? "" : "s"}
          </span>
        </button>
      </div>
    </aside>
  );
}

function Sidebar({
  board,
  admins,
  team,
  teamName,
  overview,
  selected,
  open,
  onCloseDrawer,
  onSelect,
  onClear,
}) {
  const [moreOwners, setMoreOwners] = useState(false);
  const [moreLead, setMoreLead] = useState(false);

  // Program owners: those with active programs (with counts) first; "More"
  // reveals every other admin at 0 so anyone can be picked.
  const owners = overview.program_owners || [];
  const ownerEmails = new Set(owners.map((o) => o.email));
  const zeroOwners = admins
    .filter((a) => !ownerEmails.has(a.email))
    .map((a) => ({ email: a.email, name: a.name || a.email, count: 0 }))
    .sort((x, y) => x.name.localeCompare(y.name));
  const shownOwners = moreOwners ? [...owners, ...zeroOwners] : owners;

  const counts = Object.fromEntries(board.map((b) => [b.actor, b.count]));

  // My team with 12h activity counts — how the people around you are doing.
  // Falls back to the all-admins leadership list when no department is mapped.
  const teamEntries = (team || [])
    .map((m) => ({ actor: m.name, email: m.email, count: counts[m.name] || 0 }))
    .sort((x, y) => y.count - x.count || x.actor.localeCompare(y.actor));
  const leaders = admins
    .map((a) => ({ actor: a.name || a.email, email: a.email, count: counts[a.name] || 0 }))
    .sort((x, y) => y.count - x.count || x.actor.localeCompare(y.actor));
  const showTeam = teamEntries.length > 0;
  const shownLeaders = moreLead ? leaders : leaders.slice(0, 12);

  return (
    <aside className={`leaderboard ${open ? "open" : ""}`}>
      <div className="lb-drawer-head">
        <span>Dashboard</span>
        <button className="link" onClick={onCloseDrawer}>
          ✕ close
        </button>
      </div>

      <div className="lb-section">
        <div className="lb-title">Program owners</div>
        <div className="lb-list">
          {shownOwners.map((o) => (
            <PersonRow
              key={o.email}
              entry={{ actor: o.name, count: o.count }}
              selected={selected === o.name}
              onClick={() =>
                selected === o.name ? onClear() : onSelect({ actor: o.name })
              }
            />
          ))}
          {owners.length === 0 && !moreOwners && (
            <div className="empty">No program owners yet.</div>
          )}
        </div>
        {zeroOwners.length > 0 && (
          <button className="link lb-more" onClick={() => setMoreOwners(!moreOwners)}>
            {moreOwners ? "show less" : `show all admins (${zeroOwners.length} more)`}
          </button>
        )}
      </div>

      <div className="lb-section">
        <div className="lb-title">
          {showTeam ? `My team · 12h` : "Leadership · 12h"}
        </div>
        <div className="lb-list">
          {(showTeam ? teamEntries : shownLeaders).map((p, i) => (
            <PersonRow
              key={p.email}
              entry={p}
              rank={i + 1}
              selected={selected === p.actor}
              onClick={() => (selected === p.actor ? onClear() : onSelect(p))}
            />
          ))}
          {!showTeam && leaders.length === 0 && <div className="empty">No admins.</div>}
        </div>
        {!showTeam && leaders.length > 12 && (
          <button className="link lb-more" onClick={() => setMoreLead(!moreLead)}>
            {moreLead ? "show less" : `show all ${leaders.length}`}
          </button>
        )}
      </div>
    </aside>
  );
}

// ---- Person panel + wall -------------------------------------------------------

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
            {person.count || 0} actions in the last 12h
            {person.email ? ` · ${person.email}` : ""}
          </span>
        </div>
        <button className="link" onClick={onClose}>
          ✕ close
        </button>
      </div>
      {person.programs?.length > 0 && (
        <div className="person-programs">
          {person.programs.map((p) => (
            <span key={p.id} className={`prog-chip st-${p.status}`}>
              📌 {p.name}
              {p.eta ? ` · ETA ${p.eta}` : ""}
            </span>
          ))}
        </div>
      )}
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

// ---- Red flags -----------------------------------------------------------------

function RedFlags({ data, admins, authFetch, me, onReload }) {
  const [open, setOpen] = useState(null); // expanded rule key
  const [flagging, setFlagging] = useState(null); // "rulekey-ref" per-item flag
  const [openKitchens, setOpenKitchens] = useState({}); // "rulekey::entity" -> bool
  const [openItems, setOpenItems] = useState({}); // "rulekey-ref" -> bool (drill-down)
  const [templates, setTemplates] = useState({});
  const [composing, setComposing] = useState(null); // rule being emailed
  // Optimistic overlay so the clicker sees the done state instantly; the real
  // (shared) state arrives on the next poll / onReload.
  const [localDone, setLocalDone] = useState({}); // fid -> {by, at, note} or false
  const [marking, setMarking] = useState(null); // "rulekey-ref" being marked (remark open)
  const [markNote, setMarkNote] = useState("");

  const toggleKitchen = (id) =>
    setOpenKitchens((cur) => ({ ...cur, [id]: !cur[id] }));
  const toggleItems = (id) =>
    setOpenItems((cur) => ({ ...cur, [id]: !cur[id] }));

  async function setLaunchDone(ruleKey, f, done, note) {
    const fid = `${ruleKey}-${f.ref}`;
    setLocalDone((cur) => ({
      ...cur,
      [fid]: done
        ? { by: (me && me.name) || "you", at: new Date().toISOString(), note: note || null }
        : false,
    }));
    setMarking(null);
    setMarkNote("");
    await authFetch("/redflags/launch/done", {
      method: "POST",
      body: JSON.stringify({
        rule_key: ruleKey, ref: f.ref, ident: f.ident, done, note: note || null,
      }),
    }).catch(() => {});
    if (onReload) setTimeout(onReload, 500); // pull the real, shared state
  }

  useEffect(() => {
    authFetch("/redflags/templates")
      .then((r) => r.json())
      .then((list) =>
        setTemplates(Object.fromEntries(list.map((t) => [t.rule_key, t])))
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="hub">
      <div className="rf-banner">
        🚩 SLA breaches, checked live from PK every minute.
        {data.generated_at && (
          <span className="muted"> Last checked {timeAgo(data.generated_at)} ago.</span>
        )}
        {data.email_enabled === false && (
          <span className="muted"> · email not configured — flagging is in-app only.</span>
        )}
      </div>
      {data.rules.map((rule) => {
        const isOpen = open === rule.key;
        const renderItem = (f, showEntity) => {
          const fid = `${rule.key}-${f.ref}`;
          const ids = [];
          if (f.order_id) ids.push(`#${f.order_id}`);
          if (f.po_number) ids.push(`PO ${f.po_number}`);
          if (f.so_id) ids.push(`SO ${f.so_id}`);
          if (f.ident) ids.push(f.ident);
          const itemsOpen = openItems[fid];
          // done state merges server truth with the optimistic overlay
          const ov = localDone[fid];
          const done = ov === false ? false : ov || (f.done ? { by: f.done_by, at: f.done_at, note: f.done_note } : null);
          const soft = f.red === false; // shown for context, not a red flag
          return (
            <div key={fid} className={`rf-item ${done ? "rf-item-done" : soft ? "rf-item-soft" : ""}`}>
              <div className="rf-row">
                {showEntity && <strong className="rf-entity">{f.entity}</strong>}
                <span className="rf-ids">
                  {ids.length ? ids.join(" · ") : `${rule.ref_label} #${f.ref}`}
                </span>
                {f.vendor && <span className="chip chip-vendor">{f.vendor}</span>}
                {f.state && <span className="chip chip-other">{f.state}</span>}
                {f.amount != null && (
                  <span className="rf-amount">₹{Math.round(f.amount).toLocaleString("en-IN")}</span>
                )}
                {soft ? (
                  <span className="rf-eta-soft">{etaLabel(f.eta)}</span>
                ) : (
                  <span className="rf-over">
                    {f.eta ? `${f.days_overdue}d past ETA` : `${f.days_overdue}d`}
                  </span>
                )}
              </div>
              <div className="rf-sub muted">
                {soft && f.eta ? `ETA ${fmtDate(f.eta)}` : null}
                {f.items?.length > 0 && (
                  <button className="link rf-items-link" onClick={() => toggleItems(fid)}>
                    {itemsOpen ? "▾" : "▸"} {f.items.length} item
                    {f.items.length === 1 ? "" : "s"}
                  </button>
                )}
                {f.bill_url && (
                  <a
                    className="link rf-bill-link"
                    href={f.bill_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    🧾 bill
                  </a>
                )}
                <button
                  className="link rf-flag-link"
                  onClick={() => setFlagging(flagging === fid ? null : fid)}
                >
                  🚩 flag to…
                </button>
                {f.can_mark_done && !done && (
                  <button
                    className="rf-done-link"
                    onClick={() => {
                      setMarking(marking === fid ? null : fid);
                      setMarkNote("");
                    }}
                    title="Mark this launch as done (with an optional remark)"
                  >
                    ✓ mark done
                  </button>
                )}
                {f.can_mark_done && done && (
                  <button
                    className="link rf-undo-link"
                    onClick={() => setLaunchDone(rule.key, f, false)}
                    title="Undo — bring it back to the flag"
                  >
                    undo
                  </button>
                )}
              </div>
              {done && (
                <div className="rf-done-note">
                  ✓ done by <strong>{done.by || "—"}</strong>
                  {done.at && ` · ${fmtDateTime(done.at)}`}
                  {done.note && <span className="rf-remark"> · “{done.note}”</span>}
                </div>
              )}
              {marking === fid && !done && (
                <form
                  className="rf-mark-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setLaunchDone(rule.key, f, true, markNote.trim() || null);
                  }}
                >
                  <input
                    className="grow"
                    autoFocus
                    placeholder="Optional remark (e.g. partially done)…"
                    value={markNote}
                    onChange={(e) => setMarkNote(e.target.value)}
                  />
                  <button type="submit" className="rf-done-confirm">✓ done</button>
                  <button type="button" className="link" onClick={() => setMarking(null)}>
                    cancel
                  </button>
                </form>
              )}
              {itemsOpen && f.items?.length > 0 && (
                <div className="rf-items">
                  {f.items.map((it, i) => (
                    <div key={i} className="rf-item-row">
                      <span className="rf-item-name">{it.name}</span>
                      <span className="rf-item-qty">
                        {it.received != null && it.received !== it.ordered
                          ? `${it.received}/${it.ordered}`
                          : it.ordered}
                      </span>
                      {it.amount ? (
                        <span className="rf-item-amt">
                          ₹{Math.round(it.amount).toLocaleString("en-IN")}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              {flagging === fid && (
                <FlagForm
                  admins={admins}
                  authFetch={authFetch}
                  payload={{
                    ref: f.ref,
                    entity: f.entity,
                    label: rule.ref_label,
                    state: f.state,
                    days_overdue: f.days_overdue,
                  }}
                  onDone={() => setFlagging(null)}
                />
              )}
            </div>
          );
        };
        return (
          <section key={rule.key} className="card rf-group">
            <div className="rf-group-head-row">
              <button
                className="rf-group-head"
                onClick={() => setOpen(isOpen ? null : rule.key)}
              >
                <span className={`rf-caret ${isOpen ? "down" : ""}`}>▸</span>
                <span className="rf-group-label">{rule.label}</span>
                <span className={`rf-count ${rule.count === 0 ? "zero" : ""}`}>
                  {rule.count}
                </span>
              </button>
              {rule.count > 0 && (
                <button
                  className="rf-send-btn"
                  onClick={() => setComposing(rule.key)}
                  title="Compose and send a reminder"
                >
                  ✉️ Send reminder
                </button>
              )}
            </div>
            {isOpen && (
              <div className="rf-group-body">
                <div className="muted rf-note">
                  {rule.note || `Last ${rule.window_days} days.`}
                  {rule.red_only && rule.pending != null && (
                    <> · <strong>{rule.count}</strong> red of {rule.pending} pending</>
                  )}
                </div>
                {rule.grouped
                  ? (rule.subgroups || []).map((g) => {
                      const kid = `${rule.key}::${g.entity}`;
                      const kOpen = !!openKitchens[kid];
                      return (
                        <div key={`sg-${g.entity}`} className="rf-tree-node">
                          <button
                            className="rf-tree-head"
                            onClick={() => toggleKitchen(kid)}
                          >
                            <span className={`rf-caret ${kOpen ? "down" : ""}`}>▸</span>
                            <span className="rf-tree-icon">🏢</span>
                            <strong className="rf-entity">{g.entity}</strong>
                            {rule.red_only ? (
                              g.red > 0 ? (
                                <>
                                  <span className="rf-count">{g.red}</span>
                                  {g.count > g.red && (
                                    <span className="rf-sg-total">of {g.count}</span>
                                  )}
                                </>
                              ) : (
                                <span className="rf-sg-total">{g.count} pending</span>
                              )
                            ) : (
                              <span className="rf-count">{g.count}</span>
                            )}
                            {g.email && (
                              <span className="muted rf-sg-email">{g.email}</span>
                            )}
                          </button>
                          {kOpen && (
                            <div className="rf-tree-children">
                              {g.flags.map((f) => renderItem(f, false))}
                            </div>
                          )}
                        </div>
                      );
                    })
                  : rule.flags.map((f) => renderItem(f, true))}
                {rule.count === 0 && (
                  <div className="empty">No breaches — all clear ✅</div>
                )}
              </div>
            )}
          </section>
        );
      })}
      {data.rules.length === 0 && (
        <div className="empty big">Checking for SLA breaches…</div>
      )}
      {composing && (
        <ReminderModal
          rule={data.rules.find((r) => r.key === composing)}
          template={templates[composing]}
          admins={admins}
          authFetch={authFetch}
          emailEnabled={data.email_enabled}
          onClose={() => setComposing(null)}
        />
      )}
    </main>
  );
}

function ReminderModal({ rule, template, admins, authFetch, emailEnabled, onClose }) {
  const [subject, setSubject] = useState(template?.subject || "");
  const [body, setBody] = useState(template?.body || "");
  const [due, setDue] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  });
  const [picked, setPicked] = useState([]);
  const [extra, setExtra] = useState("");
  const [pickedParties, setPickedParties] = useState([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");

  const parties = rule.parties || [];
  const emailableParties = parties.filter((p) => p.email);

  function toggleParty(email) {
    setPickedParties((cur) =>
      cur.includes(email) ? cur.filter((e) => e !== email) : [...cur, email]
    );
  }
  function toggleAllParties() {
    const all = emailableParties.map((p) => p.email);
    setPickedParties((cur) => (cur.length === all.length ? [] : all));
  }

  function toggle(email) {
    setPicked((cur) =>
      cur.includes(email) ? cur.filter((e) => e !== email) : [...cur, email]
    );
  }

  const dueLabel = new Date(due).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const reminderFlags = rule.red_only
    ? rule.flags.filter((f) => f.red)
    : rule.flags;
  const ordersPreview = reminderFlags
    .slice(0, 5)
    .map((f) => {
      const ids = [];
      if (f.order_id) ids.push(`Order #${f.order_id}`);
      if (f.po_number) ids.push(`PO ${f.po_number}`);
      if (f.so_id) ids.push(`SO ${f.so_id}`);
      if (f.ident) ids.push(f.ident);
      const idS = ids.join(" · ") || `${rule.ref_label} #${f.ref}`;
      const vend = f.vendor ? ` [${f.vendor}]` : "";
      const st = f.state ? ` — ${f.state}` : "";
      const eta = f.eta ? ` — ETA ${fmtDate(f.eta)}` : "";
      return `• ${f.entity} — ${idS}${vend}${st}${eta} — ${f.days_overdue}d`;
    })
    .join("\n");
  const preview = body
    .replace("{orders}", ordersPreview + (rule.count > 5 ? `\n…and ${rule.count - 5} more` : ""))
    .replace("{count}", rule.count)
    .replace("{category}", rule.label)
    .replace("{due_date}", dueLabel);

  async function submit(saveOnly) {
    const recipients = [
      ...picked,
      ...extra.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.includes("@")),
    ];
    if (saveOnly) {
      setStatus("saving");
      const res = await authFetch(`/redflags/templates/${rule.key}`, {
        method: "PUT",
        body: JSON.stringify({ subject, body }),
      }).catch(() => null);
      setStatus(res && res.ok ? "Template saved ✓" : "Save failed");
      return;
    }
    if (recipients.length === 0 && pickedParties.length === 0) {
      setStatus(`Select recipients or ${rule.party_label?.toLowerCase() || "parties"}`);
      return;
    }
    setStatus("sending");
    const res = await authFetch("/redflags/send-group", {
      method: "POST",
      body: JSON.stringify({
        rule_key: rule.key,
        subject,
        body,
        due_date: due,
        recipients,
        party_emails: pickedParties,
        save_template: true,
      }),
    }).catch(() => null);
    if (res && res.ok) {
      const d = await res.json();
      setStatus(
        d.emailed
          ? `Sent ${d.emailed} email${d.emailed > 1 ? "s" : ""}` +
              (d.party_emails ? ` (${d.party_emails} to ${rule.party_label?.toLowerCase()}s)` : "")
          : "Saved — but email is not configured"
      );
      setTimeout(onClose, 1600);
    } else {
      setStatus("Failed — try again");
    }
  }

  const list = admins.filter((a) =>
    (a.name || a.email).toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Send reminder — {rule.ref_label}s</strong>
          <button className="link" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {emailEnabled === false && (
            <div className="rf-banner">
              ⚠️ Email isn’t configured yet — you can edit and save the template,
              but sending won’t deliver mail.
            </div>
          )}
          <label className="fld">
            <span>Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="fld">
            <span>
              Body <span className="muted">(placeholders: {"{orders} {due_date} {count} {sla_days}"})</span>
            </span>
            <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <label className="fld">
            <span>Complete-by date (fills {"{due_date}"})</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>

          <div className="fld">
            <span>Recipients</span>
            <input
              placeholder="Search admins…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="flag-people">
              {list.map((a) => (
                <label key={a.email} className="flag-person">
                  <input
                    type="checkbox"
                    checked={picked.includes(a.email)}
                    onChange={() => toggle(a.email)}
                  />
                  {a.name || a.email}
                </label>
              ))}
            </div>
            <input
              placeholder="Add other emails (comma-separated)…"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />
          </div>

          <div className="fld">
            <span>
              Email {rule.party_label?.toLowerCase()}s individually
              <span className="muted"> — each gets only their own orders</span>
            </span>
            {emailableParties.length > 0 ? (
              <>
                <label className="flag-person party-all">
                  <input
                    type="checkbox"
                    checked={
                      pickedParties.length === emailableParties.length &&
                      emailableParties.length > 0
                    }
                    onChange={toggleAllParties}
                  />
                  <strong>Select all {emailableParties.length} {rule.party_label?.toLowerCase()}s</strong>
                </label>
                <div className="flag-people">
                  {parties.map((p) => (
                    <label
                      key={p.entity}
                      className={`flag-person ${p.email ? "" : "no-email"}`}
                    >
                      <input
                        type="checkbox"
                        disabled={!p.email}
                        checked={pickedParties.includes(p.email)}
                        onChange={() => p.email && toggleParty(p.email)}
                      />
                      <span className="party-name">{p.entity}</span>
                      <span className="party-meta muted">
                        {p.email ? `${p.email} · ${p.count}` : "no email on file"}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <div className="muted">No {rule.party_label?.toLowerCase()} emails on file.</div>
            )}
          </div>

          <div className="preview">
            <div className="muted preview-label">Preview</div>
            <div className="preview-subject">{subject}</div>
            <pre className="preview-body">{preview}</pre>
          </div>
        </div>
        <div className="modal-foot">
          <span className="muted flag-status">{status}</span>
          <button className="ghost" onClick={() => submit(true)}>
            Save template
          </button>
          <button onClick={() => submit(false)} disabled={status === "sending"}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function FlagForm({ admins, authFetch, payload, onDone }) {
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");

  function toggle(email) {
    setPicked((cur) =>
      cur.includes(email) ? cur.filter((e) => e !== email) : [...cur, email]
    );
  }

  async function send() {
    if (picked.length === 0) return;
    setStatus("sending");
    const res = await authFetch("/redflags/flag", {
      method: "POST",
      body: JSON.stringify({ ...payload, recipients: picked, note: note.trim() || null }),
    }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      setStatus(
        `Flagged to ${data.messaged} admin${data.messaged > 1 ? "s" : ""}` +
          (data.emailed ? " · emailed" : "")
      );
      setTimeout(onDone, 1200);
    } else {
      setStatus("Failed — try again");
    }
  }

  const list = admins.filter((a) =>
    (a.name || a.email).toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="flag-form">
      <input
        className="grow"
        placeholder="Search admins…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flag-people">
        {list.map((a) => (
          <label key={a.email} className="flag-person">
            <input
              type="checkbox"
              checked={picked.includes(a.email)}
              onChange={() => toggle(a.email)}
            />
            {a.name || a.email}
          </label>
        ))}
      </div>
      <input
        className="grow"
        placeholder="Add a note (optional)…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flag-actions">
        <span className="muted flag-status">{status}</span>
        <button onClick={send} disabled={picked.length === 0 || status === "sending"}>
          {picked.length ? `Flag to ${picked.length}` : "Flag"}
        </button>
      </div>
    </div>
  );
}

// ---- Programs -----------------------------------------------------------------

const STATUS_OPTS = [
  ["not_started", "Not Started"],
  ["in_progress", "In Progress"],
  ["blocked", "Blocked"],
  ["complete", "Complete"],
];

// Order sections put the things that need attention first.
const STATUS_ORDER = ["blocked", "in_progress", "not_started", "complete"];
const STATUS_LABEL = Object.fromEntries(STATUS_OPTS);

const PROG_PAGE = 10;

// ETA as a health signal: relative label + a colour bucket.
function etaInfo(p) {
  if (p.status === "complete") return { label: p.eta ? `ETA ${p.eta}` : "done", cls: "muted" };
  if (!p.eta) return { label: "no ETA", cls: "muted" };
  const today = new Date(new Date().toDateString());
  const days = Math.round((new Date(p.eta) - today) / 86400000);
  if (days < 0) return { label: `${-days}d overdue`, cls: "eta-over" };
  if (days === 0) return { label: "due today", cls: "eta-soon" };
  if (days <= 2) return { label: `due in ${days}d`, cls: "eta-soon" };
  return { label: `in ${days}d`, cls: "eta-ok" };
}

// Nudge for in-progress programs that have gone quiet.
function staleDays(p) {
  if (p.status !== "in_progress") return 0;
  const ref = (p.last_update && p.last_update.created_at) || p.created_at;
  if (!ref) return 0;
  const days = Math.floor((Date.now() - new Date(ref).getTime()) / 86400000);
  return days >= 7 ? days : 0;
}

function Programs({ me, admins, authFetch, onOpenDept }) {
  const [items, setItems] = useState([]);
  const [deptRows, setDeptRows] = useState([]);
  const [recent, setRecent] = useState([]); // latest update per program
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [groupBy, setGroupBy] = useState("none"); // none | status | owner
  const [form, setForm] = useState({
    name: "",
    objective: "",
    description: "",
    owner_email: "",
    eta: "",
  });

  const load = useCallback((count) => {
    // (Re)load the first `count` programs — used for initial load and after
    // any mutation so the visible window stays fresh.
    authFetch(`/programs?limit=${Math.min(Math.max(count, PROG_PAGE), 50)}`)
      .then((r) => r.json())
      .then((data) => {
        setItems(data.programs);
        setTotal(data.total);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => load(PROG_PAGE), [load]);

  useEffect(() => {
    authFetch("/org/structure")
      .then((r) => r.json())
      .then((d) => setDeptRows(d.rows || []))
      .catch(() => {});
    authFetch("/programs/recent-updates")
      .then((r) => r.json())
      .then((d) => setRecent(d.updates || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await authFetch(`/programs?limit=${PROG_PAGE}&offset=${items.length}`);
      const data = await res.json();
      setItems((cur) => [...cur, ...data.programs]);
      setTotal(data.total);
    } catch {
      /* ignore */
    } finally {
      setLoadingMore(false);
    }
  }

  async function create(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const res = await authFetch("/programs", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.trim(),
        objective: form.objective || null,
        description: form.description || null,
        owner_email: form.owner_email || null,
        eta: form.eta || null,
      }),
    }).catch(() => null);
    if (res && res.ok) {
      setForm({ name: "", objective: "", description: "", owner_email: "", eta: "" });
      setShowNew(false);
      load(items.length + 1);
    }
  }

  async function patch(id, body) {
    const res = await authFetch(`/programs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res && res.ok) load(items.length);
  }

  const visible = items.filter((p) => showInactive || p.active);

  // Group the loaded window for the chosen view. Items keep their global
  // ETA-urgency order inside each section.
  const groups = useMemo(() => {
    if (groupBy === "none") return [{ key: "all", label: null, items: visible }];
    if (groupBy === "status") {
      return STATUS_ORDER.map((s) => ({
        key: s,
        label: STATUS_LABEL[s],
        items: visible.filter((p) => p.status === s),
      })).filter((g) => g.items.length);
    }
    const by = {};
    for (const p of visible) {
      const k =
        groupBy === "department"
          ? p.department || "No department"
          : p.owner_name || "Unassigned";
      (by[k] = by[k] || []).push(p);
    }
    return Object.entries(by)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, its]) => ({ key: label, label, items: its }));
  }, [visible, groupBy]);

  const railRows = deptRows
    .slice()
    .sort(
      (a, b) =>
        (b.programs || 0) - (a.programs || 0) ||
        a.department.localeCompare(b.department)
    );

  return (
    <div className="prog-layout">
    <aside className="prog-updates-rail">
      <div className="lb-title">Recent updates</div>
      {recent.map((u) => (
        <div key={`${u.program_id}-${u.created_at}`} className="pu-item">
          <div className="pu-prog">{u.program_name}</div>
          <div className="pu-meta">
            <span className="pu-author" style={{ color: actorColor(u.author_name) }}>
              {u.author_name}
            </span>
            <span className="pu-time" title={fmtDateTime(u.created_at)}>
              {fmtDateTime(u.created_at)}
            </span>
          </div>
          {u.line && <div className="pu-line">“{u.line}”</div>}
          <div className="pu-people">
            {u.owner_name && <span>👤 {u.owner_name}</span>}
            {u.assignee_name && <span>→ {u.assignee_name}</span>}
          </div>
        </div>
      ))}
      {recent.length === 0 && <div className="empty">No updates yet.</div>}
    </aside>
    <main className="hub">
      <div className="hub-head">
        <button onClick={() => setShowNew(!showNew)}>
          {showNew ? "Cancel" : "+ New program"}
        </button>
        <div className="prog-view">
          <span className="prog-view-lbl">Group</span>
          {[
            ["none", "Urgency"],
            ["status", "Status"],
            ["owner", "Owner"],
            ["department", "Department"],
          ].map(([v, l]) => (
            <button
              key={v}
              className={`chip-toggle ${groupBy === v ? "on" : ""}`}
              onClick={() => setGroupBy(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="priv-toggle inactive-toggle">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          show deactivated
        </label>
      </div>
      {showNew && (
        <form className="card prog-form" onSubmit={create}>
          <input
            autoFocus
            placeholder="Program name…"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            placeholder="Objective — what does success look like?"
            value={form.objective}
            onChange={(e) => setForm({ ...form, objective: e.target.value })}
          />
          <textarea
            rows={3}
            placeholder="Description — context, scope, links…"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <div className="prog-form-row">
            <select
              value={form.owner_email}
              onChange={(e) => setForm({ ...form, owner_email: e.target.value })}
            >
              <option value="">Owner…</option>
              {admins.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.name || a.email}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={form.eta}
              onChange={(e) => setForm({ ...form, eta: e.target.value })}
            />
            <button type="submit">Create</button>
          </div>
        </form>
      )}
      {groups.map((g) => (
        <div key={g.key} className="prog-group">
          {g.label && (
            <div className="prog-group-head">
              {g.label} <span className="prog-group-count">{g.items.length}</span>
            </div>
          )}
          {g.items.map((p) => (
            <ProgramCard
              key={p.id}
              p={p}
              me={me}
              admins={admins}
              onPatch={patch}
              onReload={() => load(items.length)}
              authFetch={authFetch}
            />
          ))}
        </div>
      ))}
      {visible.length === 0 && (
        <div className="empty big">No programs yet — create the first one.</div>
      )}
      {items.length < total && (
        <button className="load-older" onClick={loadMore} disabled={loadingMore}>
          {loadingMore
            ? "Loading…"
            : `Load more programs (${total - items.length} more)`}
        </button>
      )}
    </main>
    <aside className="prog-rail">
      <div className="lb-title">Departments</div>
      {railRows.map((r) => (
        <button
          key={r.department}
          className="prog-rail-item"
          onClick={() => onOpenDept && onOpenDept(r.department)}
          title={`Open the ${r.department} page`}
        >
          <span className="prog-rail-name">{r.department}</span>
          <span className="prog-rail-count">({r.programs || 0})</span>
        </button>
      ))}
      {railRows.length === 0 && <div className="empty">No departments yet.</div>}
    </aside>
    </div>
  );
}

function ProgramCard({ p, me, admins, onPatch, onReload, authFetch }) {
  const canAssign =
    !!me &&
    (me.is_super ||
      (p.owner_email || "").toLowerCase() === (me.email || "").toLowerCase());
  const [editing, setEditing] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [expandDesc, setExpandDesc] = useState(false);
  const [edit, setEdit] = useState({
    name: p.name,
    objective: p.objective || "",
    description: p.description || "",
    owner_email: p.owner_email || "",
    assignee_email: p.assignee_email || "",
    eta: p.eta || "",
  });
  const eta = etaInfo(p);
  const stale = staleDays(p);

  function saveEdit(e) {
    e.preventDefault();
    onPatch(p.id, {
      name: edit.name.trim(),
      objective: edit.objective,
      description: edit.description,
      owner_email: edit.owner_email,
      ...(canAssign ? { assignee_email: edit.assignee_email } : {}),
      eta: edit.eta || null,
    });
    setEditing(false);
  }

  return (
    <article className={`card prog-card ${p.active ? "" : "prog-inactive"}`}>
      <div className="prog-head">
        <div className="prog-head-main">
          <select
            className={`status-select st-${p.status}`}
            value={p.status}
            onChange={(e) => onPatch(p.id, { status: e.target.value })}
            disabled={!p.active}
          >
            {STATUS_OPTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <strong className="prog-name">{p.name}</strong>
        </div>
        <span className={`prog-eta ${eta.cls}`}>{eta.label}</span>
      </div>
      {p.objective && <div className="prog-objective">🎯 {p.objective}</div>}

      {/* Latest progress update, surfaced inline so tracking needs no clicks. */}
      {p.last_update ? (
        <button
          className="prog-last"
          onClick={() => setShowUpdates(!showUpdates)}
          title="See all updates"
        >
          <span className="prog-last-dot" />
          <span className="prog-last-body">“{p.last_update.body}”</span>
          <span className="prog-last-meta">
            {p.last_update.author_name} · {fmtDateTime(p.last_update.created_at)}
          </span>
        </button>
      ) : (
        <div className="prog-last empty-update">No updates yet</div>
      )}
      {stale > 0 && <div className="prog-stale">⚠ no update in {stale}d</div>}

      {p.description && (
        <div className={`prog-desc ${expandDesc ? "" : "clamp"}`}>{p.description}</div>
      )}

      <div className="prog-meta">
        {p.owner_name ? (
          <span className="prog-owner">
            <span className="avatar sm" style={{ background: actorColor(p.owner_name) }}>
              {initials(p.owner_name)}
            </span>
            {p.owner_name}
          </span>
        ) : (
          <span className="muted">no owner</span>
        )}
        {p.assignee_name && (
          <span className="prog-assignee" title={`Assigned to ${p.assignee_name}`}>
            → {p.assignee_name}
          </span>
        )}
        {p.department && <span className="chip chip-order">{p.department}</span>}
        <span className="prog-actions">
          <button
            className="link prog-add-update"
            onClick={() => setShowUpdates(!showUpdates)}
          >
            ＋ update ({p.updates_count})
          </button>
          {p.description && (
            <button className="link" onClick={() => setExpandDesc(!expandDesc)}>
              {expandDesc ? "less" : "details"}
            </button>
          )}
          <button className="link" onClick={() => setEditing(!editing)}>
            edit
          </button>
          <button
            className="link"
            onClick={() => onPatch(p.id, { active: !p.active })}
          >
            {p.active ? "deactivate" : "reactivate"}
          </button>
        </span>
      </div>
      {editing && (
        <form className="prog-form prog-edit" onSubmit={saveEdit}>
          <input
            value={edit.name}
            placeholder="Program name…"
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          />
          <input
            value={edit.objective}
            placeholder="Objective…"
            onChange={(e) => setEdit({ ...edit, objective: e.target.value })}
          />
          <textarea
            rows={3}
            value={edit.description}
            placeholder="Description…"
            onChange={(e) => setEdit({ ...edit, description: e.target.value })}
          />
          <div className="prog-form-row">
            <select
              value={edit.owner_email}
              onChange={(e) => setEdit({ ...edit, owner_email: e.target.value })}
            >
              <option value="">Owner…</option>
              {admins.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.name || a.email}
                </option>
              ))}
            </select>
            {canAssign && (
              <select
                value={edit.assignee_email}
                onChange={(e) => setEdit({ ...edit, assignee_email: e.target.value })}
              >
                <option value="">Assign to… (optional)</option>
                {admins.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.name || a.email}
                  </option>
                ))}
              </select>
            )}
            <input
              type="date"
              value={edit.eta}
              onChange={(e) => setEdit({ ...edit, eta: e.target.value })}
            />
            <button type="submit">Save</button>
          </div>
        </form>
      )}
      {showUpdates && (
        <ProgramUpdates
          programId={p.id}
          authFetch={authFetch}
          onPosted={onReload}
          admins={admins}
        />
      )}
    </article>
  );
}

function ProgramUpdates({ programId, authFetch, onPosted, admins = [] }) {
  const [updates, setUpdates] = useState([]);
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState([]); // emails picked via @

  const load = useCallback(() => {
    authFetch(`/programs/${programId}/updates`)
      .then((r) => r.json())
      .then(setUpdates)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId]);

  useEffect(load, [load]);

  // @mention autocomplete on the token being typed at the end of the input.
  const tokenMatch = body.match(/@([\w.]*)$/);
  const suggestions = tokenMatch
    ? admins
        .filter((a) =>
          (a.name || a.email).toLowerCase().includes(tokenMatch[1].toLowerCase())
        )
        .slice(0, 5)
    : [];

  function pickMention(a) {
    const first = (a.name || a.email).split(" ")[0];
    setBody(body.replace(/@([\w.]*)$/, `@${first} `));
    setMentions((cur) => [...new Set([...cur, a.email])]);
  }

  async function post(e) {
    e.preventDefault();
    if (!body.trim()) return;
    const res = await authFetch(`/programs/${programId}/updates`, {
      method: "POST",
      body: JSON.stringify({ body: body.trim(), mentions }),
    }).catch(() => null);
    if (res && res.ok) {
      setBody("");
      setMentions([]);
      load();
      if (onPosted) onPosted();
    }
  }

  return (
    <div className="comments">
      <form onSubmit={post} className="comment-form">
        <input
          className="grow"
          placeholder="Add a progress update… (@name to tag someone)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="submit">Post</button>
      </form>
      {suggestions.length > 0 && (
        <div className="mention-sugg">
          {suggestions.map((a) => (
            <button
              key={a.email}
              type="button"
              className="mention-item"
              onClick={() => pickMention(a)}
            >
              <span className="avatar sm" style={{ background: actorColor(a.name || a.email) }}>
                {initials(a.name || a.email)}
              </span>
              {a.name || a.email}
            </button>
          ))}
        </div>
      )}
      {updates.map((u) => (
        <div key={u.id} className="comment">
          <strong style={{ color: actorColor(u.author_name) }}>{u.author_name}</strong>
          <span>{u.body}</span>
          <span className="comment-time" title={fmtDateTime(u.created_at)}>
            {fmtDateTime(u.created_at)}
          </span>
        </div>
      ))}
      {updates.length === 0 && <div className="empty">No updates yet.</div>}
    </div>
  );
}

// ---- Anonymous feedback ---------------------------------------------------------

function Feedback({ authFetch }) {
  const [items, setItems] = useState([]);
  const [body, setBody] = useState("");
  const [actionFor, setActionFor] = useState(null);
  const [actionText, setActionText] = useState("");
  const [sent, setSent] = useState(false);

  const load = useCallback(() => {
    authFetch("/feedback")
      .then((r) => r.json())
      .then(setItems)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  async function post(e) {
    e.preventDefault();
    if (!body.trim()) return;
    const res = await authFetch("/feedback", {
      method: "POST",
      body: JSON.stringify({ body: body.trim() }),
    }).catch(() => null);
    if (res && res.ok) {
      setBody("");
      setSent(true);
      setTimeout(() => setSent(false), 3000);
      load();
    }
  }

  async function saveAction(id) {
    if (!actionText.trim()) return;
    const res = await authFetch(`/feedback/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action_item: actionText.trim() }),
    }).catch(() => null);
    if (res && res.ok) {
      setActionFor(null);
      setActionText("");
      load();
    }
  }

  return (
    <main className="hub">
      <div className="fb-banner">
        🎭 Feedback is <strong>anonymous</strong> — your name is never stored, anywhere.
      </div>
      <form className="card composer-card" onSubmit={post}>
        <input
          className="grow"
          placeholder="Share feedback anonymously…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="submit">{sent ? "Sent ✓" : "Send"}</button>
      </form>
      {items.map((f) => (
        <article key={f.id} className="card fb-card">
          <div className="fb-head">
            <span className={`st-pill st-fb-${f.status}`}>
              {f.status === "actioned" ? "Actioned" : "Open"}
            </span>
            <span className="event-time">{formatWhen(f.created_at)}</span>
          </div>
          <div className="fb-body">{f.body}</div>
          {f.action_item ? (
            <div className="fb-action">
              ✅ <strong>{f.action_by}</strong>: {f.action_item}
            </div>
          ) : actionFor === f.id ? (
            <form
              className="comment-form"
              onSubmit={(e) => {
                e.preventDefault();
                saveAction(f.id);
              }}
            >
              <input
                className="grow"
                autoFocus
                placeholder="Action item…"
                value={actionText}
                onChange={(e) => setActionText(e.target.value)}
              />
              <button type="submit">Save</button>
            </form>
          ) : (
            <button className="link reply-link" onClick={() => setActionFor(f.id)}>
              + add action item
            </button>
          )}
        </article>
      ))}
      {items.length === 0 && (
        <div className="empty big">No feedback yet — be the first (anonymously).</div>
      )}
    </main>
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
      const res = await authFetch(`/messages/send`, {
        method: "POST",
        body: JSON.stringify({ recipient: email, body: body.trim(), private: false }),
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

  async function toggleLike(id) {
    setMessages((cur) =>
      cur.map((m) =>
        m.id === id
          ? {
              ...m,
              liked_by_me: !m.liked_by_me,
              like_count: (m.like_count || 0) + (m.liked_by_me ? -1 : 1),
            }
          : m
      )
    );
    try {
      const res = await authFetch(`/messages/${id}/like`, { method: "POST" });
      const d = await res.json();
      setMessages((cur) =>
        cur.map((m) =>
          m.id === id ? { ...m, liked_by_me: d.liked, like_count: d.like_count } : m
        )
      );
    } catch {
      /* ignore */
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
            <button
              className={`react xs ${m.liked_by_me ? "liked" : ""}`}
              onClick={() => toggleLike(m.id)}
            >
              {m.liked_by_me ? "♥" : "♡"} {m.like_count || ""}
            </button>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="empty">No messages for {name} yet — be the first 👋</div>
        )}
      </div>
    </div>
  );
}

// ---- Messages hub ---------------------------------------------------------------

const MSG_PAGE = 15;

// A real 1:1 conversation (inbox thread): their unanswered messages up top,
// then the public thread, then the private thread — with a reply box.
function ConversationView({ me, person, admins = [], authFetch, onBack, onActor }) {
  const [data, setData] = useState({ messages: [], owe_me: 0, owe_them: 0 });
  const [body, setBody] = useState("");
  const [priv, setPriv] = useState(false);
  const [error, setError] = useState("");
  const [replyId, setReplyId] = useState(null); // message being replied to inline
  const [replyText, setReplyText] = useState("");
  const [mentions, setMentions] = useState([]); // extra people tagged (emails)

  // @mention autocomplete: match the @token at the caret-end of a given text.
  const suggFor = (text) => {
    const t = (text || "").match(/@([\w.]*)$/);
    if (!t) return [];
    return admins
      .filter(
        (a) =>
          (a.email || "").toLowerCase() !== (person.email || "").toLowerCase() &&
          (a.email || "").toLowerCase() !== (me.email || "").toLowerCase() &&
          (a.name || a.email).toLowerCase().includes(t[1].toLowerCase())
      )
      .slice(0, 5);
  };
  const pickMention = (a, text, setText) => {
    const first = (a.name || a.email).split(" ")[0];
    setText(text.replace(/@([\w.]*)$/, `@${first} `));
    setMentions((cur) => [...new Set([...cur, a.email])]);
  };
  const MentionRow = ({ text, setText }) => {
    const s = suggFor(text);
    if (!s.length) return null;
    return (
      <div className="mention-sugg">
        {s.map((a) => (
          <button
            key={a.email}
            type="button"
            className="mention-item"
            onClick={() => pickMention(a, text, setText)}
          >
            <span className="avatar sm" style={{ background: actorColor(a.name || a.email) }}>
              {initials(a.name || a.email)}
            </span>
            {a.name || a.email}
          </button>
        ))}
      </div>
    );
  };

  const load = useCallback(() => {
    authFetch(`/messages/conversation?email=${encodeURIComponent(person.email)}`)
      .then((r) => r.json())
      .then((d) => setData(d && d.messages ? d : { messages: [], owe_me: 0, owe_them: 0 }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.email]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function send(e) {
    e.preventDefault();
    setError("");
    if (!body.trim()) return;
    const res = await authFetch("/messages/send", {
      method: "POST",
      body: JSON.stringify({
        recipient: person.email,
        body: body.trim(),
        private: priv,
        mentions,
      }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setError("Failed to send");
      return;
    }
    setBody("");
    setMentions([]);
    load();
  }

  async function toggleLike(id) {
    await authFetch(`/messages/${id}/like`, { method: "POST" }).catch(() => {});
    load();
  }

  // Dismiss the thread from "waiting on your reply" without sending anything —
  // for closers like "noted, thanks". Reappears if they message again.
  async function markHandled() {
    await authFetch("/messages/ack", {
      method: "POST",
      body: JSON.stringify({ email: person.email, up_to_id: data.owe_latest_id || null }),
    }).catch(() => {});
    load();
  }

  // Reply in-thread: goes to the message's OTHER party (its sender when they
  // wrote it — vital on your own page, where person.email is yourself).
  async function sendReply(m) {
    if (!replyText.trim()) return;
    const to =
      (m.sender || "").toLowerCase() === (me.email || "").toLowerCase()
        ? m.recipient
        : m.sender;
    const res = await authFetch("/messages/send", {
      method: "POST",
      body: JSON.stringify({
        recipient: to,
        body: replyText.trim(),
        private: !!m.is_private,
        parent_id: m.id,
        mentions,
      }),
    }).catch(() => null);
    if (res && res.ok) {
      setReplyText("");
      setReplyId(null);
      setMentions([]);
      load();
    } else {
      const d = res ? await res.json().catch(() => ({})) : {};
      setError(errText(d, "Reply failed"));
    }
  }

  const msgs = data.messages || [];
  const oweMe = msgs.filter((m) => m.owe_me); // they wrote, I owe a reply
  const oweThem = msgs.filter((m) => m.owe_them); // someone wrote, they owe a reply
  const rest = msgs.filter((m) => !m.owe_me && !m.owe_them);

  const line = (m, sec) => (
    <div
      key={`${sec}-${m.id}`}
      className={`conv-msg ${m.sender === me.email ? "mine" : "theirs"} ${
        sec === "them" ? "is-owed" : sec === "me" ? "is-waiting" : ""
      }`}
    >
      <div className="conv-msg-head">
        <strong style={{ color: actorColor(m.sender_name) }}>
          {m.sender === me.email ? "You" : m.sender_name}
        </strong>
        <span className="conv-arrow">→ {m.recipient === me.email ? "you" : m.recipient_name}</span>
        {m.is_private && <span className="lock">🔒</span>}
        <span className="wall-time">{timeAgo(m.created_at)}</span>
        <button
          className={`react xs ${m.liked_by_me ? "liked" : ""}`}
          onClick={() => toggleLike(m.id)}
        >
          {m.liked_by_me ? "♥" : "♡"} {m.like_count || ""}
        </button>
      </div>
      <div className="conv-body">{m.body}</div>
      {replyId === m.id ? (
        <>
          <form
            className="conv-reply-form"
            onSubmit={(e) => {
              e.preventDefault();
              sendReply(m);
            }}
          >
            <input
              className="grow"
              autoFocus
              placeholder={`Reply to ${
                (m.sender || "").toLowerCase() === (me.email || "").toLowerCase()
                  ? m.recipient_name
                  : m.sender_name
              }… (@name to tag others)${m.is_private ? " 🔒" : ""}`}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
            />
            <button type="submit">Reply</button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setReplyId(null);
                setReplyText("");
                setMentions([]);
              }}
            >
              cancel
            </button>
          </form>
          <MentionRow text={replyText} setText={setReplyText} />
          {mentions.length > 0 && (
            <div className="mention-tags">
              Also emailing:{" "}
              {mentions
                .map((em) => {
                  const a = admins.find((x) => x.email === em);
                  return a ? a.name || a.email : em;
                })
                .join(", ")}
              <button className="link" onClick={() => setMentions([])}>clear</button>
            </div>
          )}
        </>
      ) : (
        <button
          className="link conv-reply-link"
          onClick={() => {
            setReplyId(m.id);
            setReplyText("");
          }}
        >
          ↳ reply
        </button>
      )}
    </div>
  );

  return (
    <main className="hub conv">
      <div className="conv-head">
        <button className="link conv-back" onClick={onBack}>
          ← Inbox
        </button>
        <span className="avatar sm" style={{ background: actorColor(person.name) }}>
          {initials(person.name)}
        </span>
        <button className="conv-name" onClick={() => onActor(person.name)}>
          {person.name}
        </button>
        {data.owe_them > 0 && (
          <span className="conv-wait-count">{data.owe_them} not responded</span>
        )}
        {data.owe_me > 0 && (
          <span className="conv-wait-count you">{data.owe_me} for you</span>
        )}
      </div>

      {(person.email || "").toLowerCase() !== (me.email || "").toLowerCase() && (
        <>
          <form className="card composer-card" onSubmit={send}>
            <input
              className="grow"
              autoFocus
              placeholder={`Message ${person.name}… (@name to also loop in others)`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <label className="priv-toggle" title="Send privately">
              <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
              🔒
            </label>
            <button type="submit">Send</button>
          </form>
          <MentionRow text={body} setText={setBody} />
          {mentions.length > 0 && (
            <div className="mention-tags">
              Also emailing:{" "}
              {mentions
                .map((em) => {
                  const a = admins.find((x) => x.email === em);
                  return a ? a.name || a.email : em;
                })
                .join(", ")}
              <button className="link" onClick={() => setMentions([])}>clear</button>
            </div>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}

      {oweThem.length > 0 && (
        <div className="conv-section conv-owed">
          <div className="conv-section-title">
            🕓 {person.name} hasn’t responded ({oweThem.length})
          </div>
          {oweThem.map((m) => line(m, "them"))}
        </div>
      )}

      {oweMe.length > 0 && (
        <div className="conv-section conv-waiting">
          <div className="conv-section-title">
            ⏳ Waiting on your reply
            <button
              className="conv-handled-btn"
              onClick={markHandled}
              title="Clear this from your pending list without replying — it comes back if they message again"
            >
              ✓ Mark handled
            </button>
          </div>
          {oweMe.map((m) => line(m, "me"))}
        </div>
      )}

      {rest.length > 0 && (
        <div className="conv-section">
          <div className="conv-section-title">Conversation</div>
          {rest.map((m) => line(m, "rest"))}
        </div>
      )}

      {msgs.length === 0 && (
        <div className="empty big">
          Nothing visible with {person.name} — any pending replies of theirs are
          on private threads you’re not part of.
        </div>
      )}
    </main>
  );
}

function MessagesHub({ me, admins, authFetch, onActor, onOpenPerson }) {
  const [sub, setSub] = useState("all"); // all | private
  const [msgs, setMsgs] = useState([]);
  const [recipient, setRecipient] = useState("");
  const [body, setBody] = useState("");
  const [priv, setPriv] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [openThreads, setOpenThreads] = useState({}); // rootId -> bool
  const [shown, setShown] = useState(MSG_PAGE);
  const [mentions, setMentions] = useState([]); // extra people tagged

  // @mention autocomplete on the @token at the end of a text box.
  const suggFor = (text) => {
    const t = (text || "").match(/@([\w.]*)$/);
    if (!t) return [];
    return admins
      .filter(
        (a) =>
          (a.email || "").toLowerCase() !== (me.email || "").toLowerCase() &&
          (a.name || a.email).toLowerCase().includes(t[1].toLowerCase())
      )
      .slice(0, 5);
  };
  const pickMention = (a, text, setText) => {
    const first = (a.name || a.email).split(" ")[0];
    setText(text.replace(/@([\w.]*)$/, `@${first} `));
    setMentions((cur) => [...new Set([...cur, a.email])]);
  };
  const MentionRow = ({ text, setText }) => {
    const s = suggFor(text);
    if (!s.length) return null;
    return (
      <div className="mention-sugg">
        {s.map((a) => (
          <button
            key={a.email}
            type="button"
            className="mention-item"
            onClick={() => pickMention(a, text, setText)}
          >
            <span className="avatar sm" style={{ background: actorColor(a.name || a.email) }}>
              {initials(a.name || a.email)}
            </span>
            {a.name || a.email}
          </button>
        ))}
      </div>
    );
  };

  // Reset paging whenever the visible set changes.
  useEffect(() => setShown(MSG_PAGE), [sub, query, mineOnly]);

  const load = useCallback(() => {
    authFetch(sub === "all" ? "/messages/public" : "/messages/private")
      .then((r) => r.json())
      .then(setMsgs)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function send(e) {
    e.preventDefault();
    setError("");
    if (!recipient || !body.trim()) return;
    const res = await authFetch("/messages/send", {
      method: "POST",
      body: JSON.stringify({
        recipient,
        body: body.trim(),
        private: sub === "private" ? true : priv,
        mentions,
      }),
    }).catch(() => null);
    if (!res || !res.ok) {
      const data = res ? await res.json().catch(() => ({})) : {};
      setError(data.detail || "Failed to send");
      return;
    }
    setBody("");
    setMentions([]);
    load();
  }

  async function sendReply(rootId) {
    if (!replyBody.trim()) return;
    const res = await authFetch("/messages/send", {
      method: "POST",
      body: JSON.stringify({ parent_id: rootId, body: replyBody.trim(), mentions }),
    }).catch(() => null);
    if (res && res.ok) {
      setReplyBody("");
      setReplyTo(null);
      setMentions([]);
      load();
    }
  }

  async function toggleLike(id) {
    setMsgs((cur) =>
      cur.map((m) =>
        m.id === id
          ? {
              ...m,
              liked_by_me: !m.liked_by_me,
              like_count: (m.like_count || 0) + (m.liked_by_me ? -1 : 1),
            }
          : m
      )
    );
    try {
      const res = await authFetch(`/messages/${id}/like`, { method: "POST" });
      const d = await res.json();
      setMsgs((cur) =>
        cur.map((m) =>
          m.id === id ? { ...m, liked_by_me: d.liked, like_count: d.like_count } : m
        )
      );
    } catch {
      /* poll reconciles */
    }
  }

  const kids = {};
  for (const m of msgs) {
    if (m.parent_id) (kids[m.parent_id] ||= []).push(m);
  }
  Object.values(kids).forEach((list) => list.sort((a, b) => a.id - b.id));

  const q = query.trim().toLowerCase();
  const involvesMe = (m) => m.sender === me.email || m.recipient === me.email;
  const matchesQuery = (m) =>
    !q ||
    (m.sender_name || "").toLowerCase().includes(q) ||
    (m.recipient_name || "").toLowerCase().includes(q) ||
    (m.body || "").toLowerCase().includes(q);

  const roots = msgs
    .filter((m) => !m.parent_id)
    .filter((m) => {
      const thread = [m, ...(kids[m.id] || [])];
      if (mineOnly && !thread.some(involvesMe)) return false;
      if (q && !thread.some(matchesQuery)) return false;
      return true;
    });

  const NameLink = ({ name, email }) => (
    <button
      className="msg-name-link"
      style={{ color: actorColor(name) }}
      onClick={() =>
        email && email !== me.email && onOpenPerson
          ? onOpenPerson({ email, name })
          : onActor(name)
      }
      title={`Open conversation with ${name}`}
    >
      {name}
    </button>
  );

  return (
    <main className="hub">
      <div className="hub-tabs">
        <button
          className={`tab ${sub === "all" ? "active" : ""}`}
          onClick={() => setSub("all")}
        >
          All (public)
        </button>
        <button
          className={`tab ${sub === "private" ? "active" : ""}`}
          onClick={() => setSub("private")}
        >
          🔒 Private
        </button>
      </div>

      <div className="msg-filter">
        <input
          className="grow"
          placeholder="Search messages or people…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={`chip-toggle ${mineOnly ? "on" : ""}`}
          onClick={() => setMineOnly(!mineOnly)}
        >
          Involving me
        </button>
      </div>

      <form className="card composer-card" onSubmit={send}>
        <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
          <option value="">To…</option>
          {admins
            .filter((a) => a.email !== me.email)
            .map((a) => (
              <option key={a.email} value={a.email}>
                {a.name || a.email}
              </option>
            ))}
        </select>
        <input
          className="grow"
          placeholder={
            sub === "private"
              ? "Private message… (@name to loop in others)"
              : "Message… (visible to all admins)"
          }
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {sub === "all" && (
          <label className="priv-toggle">
            <input
              type="checkbox"
              checked={priv}
              onChange={(e) => setPriv(e.target.checked)}
            />
            🔒
          </label>
        )}
        <button type="submit">Send</button>
      </form>
      <MentionRow text={body} setText={setBody} />
      {mentions.length > 0 && (
        <div className="mention-tags">
          Also emailing:{" "}
          {mentions
            .map((em) => {
              const a = admins.find((x) => x.email === em);
              return a ? a.name || a.email : em;
            })
            .join(", ")}
          <button className="link" onClick={() => setMentions([])}>clear</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <div className="thread-list">
        {roots.slice(0, shown).map((m) => {
          const replies = kids[m.id] || [];
          const showReplies = openThreads[m.id] || Boolean(q);
          return (
            <div key={m.id} className="msg-card card">
              <div
                className="wall-msg root"
                style={{
                  background: actorTint(m.sender_name),
                  borderLeftColor: actorColor(m.sender_name),
                }}
              >
                <NameLink name={m.sender_name} email={m.sender} />
                <span className="to-chip">
                  → <NameLink name={m.recipient_name} email={m.recipient} />
                </span>
                {m.is_private && <span className="lock">🔒</span>}
                <span className="wall-body">{m.body}</span>
                <span className="wall-time">{timeAgo(m.created_at)}</span>
                <button
                  className={`react xs ${m.liked_by_me ? "liked" : ""}`}
                  onClick={() => toggleLike(m.id)}
                >
                  {m.liked_by_me ? "♥" : "♡"} {m.like_count || ""}
                </button>
              </div>

              {replies.length > 0 && (
                <button
                  className="link thread-toggle"
                  onClick={() =>
                    setOpenThreads((o) => ({ ...o, [m.id]: !showReplies }))
                  }
                >
                  💬 {replies.length} {replies.length > 1 ? "replies" : "reply"}{" "}
                  {showReplies ? "▲" : "▼"}
                </button>
              )}
              {showReplies &&
                replies.map((c) => (
                  <div
                    key={c.id}
                    className="wall-msg reply"
                    style={{ borderLeftColor: actorColor(c.sender_name) }}
                  >
                    <NameLink name={c.sender_name} email={c.sender} />
                    <span className="wall-body">{c.body}</span>
                    <span className="wall-time">{timeAgo(c.created_at)}</span>
                    <button
                      className={`react xs ${c.liked_by_me ? "liked" : ""}`}
                      onClick={() => toggleLike(c.id)}
                    >
                      {c.liked_by_me ? "♥" : "♡"} {c.like_count || ""}
                    </button>
                  </div>
                ))}

              {replyTo === m.id ? (
                <>
                  <form
                    className="reply-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      sendReply(m.id);
                    }}
                  >
                    <input
                      className="grow"
                      autoFocus
                      placeholder="Reply… (@name to tag others)"
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                    />
                    <button type="submit">Reply</button>
                  </form>
                  <MentionRow text={replyBody} setText={setReplyBody} />
                  {mentions.length > 0 && (
                    <div className="mention-tags">
                      Also emailing:{" "}
                      {mentions
                        .map((em) => {
                          const a = admins.find((x) => x.email === em);
                          return a ? a.name || a.email : em;
                        })
                        .join(", ")}
                      <button className="link" onClick={() => setMentions([])}>clear</button>
                    </div>
                  )}
                </>
              ) : (
                <button className="link reply-link" onClick={() => setReplyTo(m.id)}>
                  ↳ reply
                </button>
              )}
            </div>
          );
        })}
        {roots.length === 0 && (
          <div className="empty big">
            {q || mineOnly
              ? "No messages match."
              : sub === "private"
              ? "No private messages yet."
              : "No messages yet — start one above."}
          </div>
        )}
        {roots.length > shown && (
          <button
            className="load-older"
            onClick={() => setShown((s) => s + MSG_PAGE)}
          >
            Load more ({roots.length - shown} older)
          </button>
        )}
      </div>
    </main>
  );
}

// ---- Tasks: my list + department sheet (owner manages) ---------------------------

const TASK_STATUS_OPTS = [
  ["pending", "Pending"],
  ["in_progress", "In Progress"],
  ["completed", "Completed"],
  ["on_hold", "On Hold"],
];

function TaskLine({ t, me, canManage, onPatch, showAssignee }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(t.challenges || "");
  const mine = (t.assignee_email || "").toLowerCase() === (me.email || "").toLowerCase();
  const done = t.status === "completed";
  return (
    <div className={`task-row ${done ? "task-done" : ""} ${t.overdue ? "task-over" : ""}`}>
      <div className="task-main">
        {showAssignee && (
          <span className="avatar sm" style={{ background: actorColor(t.assignee_name || t.assignee_email) }}>
            {initials(t.assignee_name || t.assignee_email)}
          </span>
        )}
        <div className="task-id">
          <span className="task-title">
            {t.title}
            {t.one_time && <span className="chip chip-other">one-time</span>}
            {t.company && <span className="muted task-co"> · {t.company}</span>}
          </span>
          <span className="muted task-sub">
            {showAssignee && `${t.assignee_name || t.assignee_email} · `}
            {t.frequency ? `${t.frequency.replace("_", " ")} · ` : ""}
            {t.cutoff_date
              ? (t.overdue ? `⚠ due ${fmtDate(t.cutoff_date)}` : `due ${fmtDate(t.cutoff_date)}`)
              : "no cutoff"}
            {done && t.days_taken != null && ` · ${t.days_taken > 0 ? `+${t.days_taken}d late` : t.days_taken === 0 ? "on time" : `${-t.days_taken}d early`}`}
            {t.challenges && ` · 📝 ${t.challenges}`}
          </span>
        </div>
        <span className="task-actions">
          {(mine || canManage) && !done && (
            <>
              {t.status !== "in_progress" && (
                <button className="link" onClick={() => onPatch(t.id, { status: "in_progress" })}>
                  start
                </button>
              )}
              <button className="task-complete" onClick={() => onPatch(t.id, { status: "completed" })}>
                ✓ done
              </button>
              <button className="link" onClick={() => setNoting(!noting)}>📝</button>
            </>
          )}
          {(mine || canManage) && done && (
            <button className="link" onClick={() => onPatch(t.id, { status: "pending" })}>
              reopen
            </button>
          )}
        </span>
      </div>
      {noting && (
        <form
          className="conv-reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            onPatch(t.id, { challenges: note });
            setNoting(false);
          }}
        >
          <input
            className="grow" autoFocus placeholder="Challenges / notes…"
            value={note} onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit">Save</button>
        </form>
      )}
    </div>
  );
}

function TasksView({ me, admins, authFetch, onBack }) {
  const [box, setBox] = useState("inbox"); // inbox | done | sent | team
  const [my, setMy] = useState({ tasks: [], overdue: 0, open: 0 });
  const [sent, setSent] = useState([]);
  const [team, setTeam] = useState(null);
  const [teamDept, setTeamDept] = useState("");
  const [teamPerson, setTeamPerson] = useState("");
  const [period, setPeriod] = useState("");
  const [depts, setDepts] = useState([]);
  const [compose, setCompose] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [status, setStatus] = useState("");
  // Hema's exception: assign tasks to PartnerKart kitchen managers.
  const [pkWorkers, setPkWorkers] = useState([]);
  const [pkTasks, setPkTasks] = useState({ tasks: [], counts: {} });
  const [pkSel, setPkSel] = useState([]); // selected manager ids (compose)
  const [pkForm, setPkForm] = useState({ title: "", details: "", due_date: "" });
  const [pkFilter, setPkFilter] = useState(""); // manager filter in compose picker
  const [pkCompose, setPkCompose] = useState(false); // assign modal open
  const [pkPerson, setPkPerson] = useState(""); // stats filter: manager name or ""
  const [pkFile, setPkFile] = useState(null); // {url, filename}
  const [pkUploading, setPkUploading] = useState(false);

  const canTeam = me.is_super || (me.owns || []).length > 0;
  const canPk = !!me.pk_tasks_enabled;

  const loadPk = useCallback(() => {
    if (!canPk) return;
    authFetch("/pk-tasks/workers")
      .then((r) => (r.ok ? r.json() : { workers: [] }))
      .then((d) => setPkWorkers(d.workers || []))
      .catch(() => {});
    authFetch("/pk-tasks")
      .then((r) => (r.ok ? r.json() : { tasks: [], counts: {} }))
      .then((d) => setPkTasks(d.tasks ? d : { tasks: [], counts: {} }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPk]);

  useEffect(() => {
    if (box === "kitchen") loadPk();
  }, [box, loadPk]);

  async function pkUpload(fileObj) {
    if (!fileObj) return;
    setPkUploading(true);
    const fd = new FormData();
    fd.append("file", fileObj);
    try {
      const res = await authFetch("/pk-tasks/upload", { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (res.ok) setPkFile({ url: d.url, filename: d.filename });
      else setStatus(errText(d, "Upload failed"));
    } finally {
      setPkUploading(false);
    }
  }

  async function pkAssign(e) {
    e.preventDefault();
    if (!pkSel.length || !pkForm.title.trim()) {
      setStatus("Pick at least one manager and enter a task");
      return;
    }
    const res = await authFetch("/pk-tasks/assign", {
      method: "POST",
      body: JSON.stringify({
        worker_ids: pkSel,
        title: pkForm.title.trim(),
        details: pkForm.details || null,
        due_date: pkForm.due_date || null,
        attachment_url: pkFile?.url || null,
      }),
    }).catch(() => null);
    if (res && res.ok) {
      const d = await res.json();
      setStatus(`Assigned to ${d.assigned} manager${d.assigned === 1 ? "" : "s"} ✓`);
      setPkSel([]);
      setPkForm({ title: "", details: "", due_date: "" });
      setPkFile(null);
      setPkCompose(false);
      loadPk();
    } else {
      const d = res ? await res.json().catch(() => ({})) : {};
      setStatus(errText(d, "Could not assign"));
    }
  }

  async function pkCancel(id) {
    if (!window.confirm("Cancel this task?")) return;
    await authFetch(`/pk-tasks/${id}`, { method: "PATCH" }).catch(() => {});
    loadPk();
  }

  // Per-manager rollup for the stats view.
  const pkRollup = (() => {
    const by = {};
    for (const t of pkTasks.tasks || []) {
      const k = t.manager;
      by[k] = by[k] || { manager: k, kitchen: t.kitchen, pending: 0, done: 0, cancelled: 0, total: 0 };
      by[k].total += 1;
      by[k][t.status] = (by[k][t.status] || 0) + 1;
    }
    return Object.values(by).sort((a, b) => b.pending - a.pending || b.total - a.total);
  })();
  const pkShown = (pkTasks.tasks || []).filter((t) => !pkPerson || t.manager === pkPerson);
  const teamDepts = me.is_super ? depts : (me.owns || []);

  const load = useCallback(() => {
    authFetch("/tasks/my").then((r) => r.json()).then(setMy).catch(() => {});
    authFetch("/tasks/sent")
      .then((r) => r.json())
      .then((d) => setSent(d.tasks || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    authFetch("/org/structure")
      .then((r) => r.json())
      .then((d) => setDepts(d.departments || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTeam = useCallback(() => {
    if (!canTeam) return;
    const qs = new URLSearchParams();
    if (teamDept) qs.set("department", teamDept);
    if (period) qs.set("period", period);
    authFetch(`/tasks/team?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setTeam(d && d.tasks ? d : null);
        if (d?.department && !teamDept) setTeamDept(d.department);
      })
      .catch(() => setTeam(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamDept, period, canTeam]);

  useEffect(() => {
    if (box === "team") loadTeam();
  }, [box, loadTeam]);

  const loadTemplates = useCallback(() => {
    const d = teamDept || team?.department;
    if (!d) return;
    authFetch(`/tasks/templates?department=${encodeURIComponent(d)}`)
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((x) => setTemplates(x.templates || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamDept, team?.department]);

  useEffect(() => {
    if (showTemplates) loadTemplates();
  }, [showTemplates, loadTemplates]);

  async function patchTask(id, body) {
    const res = await authFetch(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res && res.ok) {
      load();
      if (box === "team") loadTeam();
    } else {
      const d = res ? await res.json().catch(() => ({})) : {};
      setStatus(errText(d, "Update failed"));
    }
  }

  const openT = my.tasks.filter((t) => t.status !== "completed");
  const overdueT = openT.filter((t) => t.overdue);
  const upcomingT = openT.filter((t) => !t.overdue);
  const doneT = my.tasks.filter((t) => t.status === "completed");

  const teamTasks = (team?.tasks || []).filter(
    (t) => !teamPerson || t.assignee_email === teamPerson
  );
  const teamPeople = {};
  for (const t of team?.tasks || []) {
    const k = t.assignee_email;
    teamPeople[k] = teamPeople[k] || { name: t.assignee_name, open: 0, total: 0 };
    teamPeople[k].total += 1;
    if (t.status !== "completed") teamPeople[k].open += 1;
  }

  const NavItem = ({ id, icon, label, count }) => (
    <button
      className={`tasks-nav-item ${box === id ? "active" : ""}`}
      onClick={() => setBox(id)}
    >
      <span className="tasks-nav-icon">{icon}</span>
      <span className="tasks-nav-label">{label}</span>
      {count > 0 && <span className="tasks-nav-count">{count}</span>}
    </button>
  );

  return (
    <div className="tasks-layout">
      <aside className="tasks-side">
        <button className="tasks-compose" onClick={() => setCompose(true)}>
          ✏️ <span className="tasks-compose-lbl">Create task</span>
        </button>
        <NavItem id="inbox" icon="📥" label="Inbox" count={openT.length} />
        <NavItem id="done" icon="✅" label="Done" count={0} />
        <NavItem id="sent" icon="📤" label="Sent" count={0} />
        {canTeam && <NavItem id="team" icon="👥" label="Team" count={0} />}
        {canPk && (
          <NavItem
            id="kitchen"
            icon="🍳"
            label="Kitchen managers"
            count={pkTasks.counts?.pending || 0}
          />
        )}
      </aside>

      <main className="hub tasks-hub">
        <div className="conv-head">
          <button className="link conv-back" onClick={onBack}>← Back</button>
          <strong className="dept-title">
            {box === "inbox" && "📥 My tasks"}
            {box === "done" && "✅ Done"}
            {box === "sent" && "📤 Sent by me"}
            {box === "team" && `👥 ${team?.department || "Team"}`}
            {box === "kitchen" && "🍳 Kitchen manager tasks"}
          </strong>
          {box === "inbox" && my.overdue > 0 && (
            <span className="conv-wait-count">{my.overdue} overdue</span>
          )}
        </div>
        {status && <div className="users-status">{status}</div>}

        {box === "inbox" && (
          <>
            {overdueT.length > 0 && (
              <div className="conv-section conv-waiting">
                <div className="conv-section-title">⚠ Overdue</div>
                {overdueT.map((t) => (
                  <TaskLine key={t.id} t={t} me={me} canManage={false} onPatch={patchTask} />
                ))}
              </div>
            )}
            <div className="conv-section">
              {upcomingT.map((t) => (
                <TaskLine key={t.id} t={t} me={me} canManage={false} onPatch={patchTask} />
              ))}
              {openT.length === 0 && <div className="empty big">Inbox zero 🎉</div>}
            </div>
          </>
        )}

        {box === "done" && (
          <div className="conv-section">
            {doneT.map((t) => (
              <TaskLine key={t.id} t={t} me={me} canManage={false} onPatch={patchTask} />
            ))}
            {doneT.length === 0 && <div className="empty big">Nothing completed this month yet.</div>}
          </div>
        )}

        {box === "sent" && (
          <div className="conv-section">
            {sent.map((t) => (
              <TaskLine
                key={t.id} t={t} me={me} canManage={false}
                onPatch={patchTask} showAssignee
              />
            ))}
            {sent.length === 0 && (
              <div className="empty big">You haven't assigned any tasks yet.</div>
            )}
          </div>
        )}

        {box === "team" && canTeam && (
          <>
            <div className="tasks-team-tools">
              <select
                value={teamDept || team?.department || ""}
                onChange={(e) => {
                  setTeamDept(e.target.value);
                  setTeamPerson("");
                }}
              >
                {teamDepts.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <input
                type="month"
                value={period || team?.period || ""}
                onChange={(e) => setPeriod(e.target.value)}
              />
              <button className="chip-toggle" onClick={() => setShowTemplates(!showTemplates)}>
                🔁 Recurring
              </button>
            </div>
            {team && (
              <div className="feed-portals">
                <button
                  className={`chip-toggle ${!teamPerson ? "on" : ""}`}
                  onClick={() => setTeamPerson("")}
                >
                  Everyone
                </button>
                {Object.entries(teamPeople).map(([email, p]) => (
                  <button
                    key={email}
                    className={`chip-toggle ${teamPerson === email ? "on" : ""}`}
                    onClick={() => setTeamPerson(email)}
                  >
                    {p.name} · {p.open}/{p.total}
                  </button>
                ))}
              </div>
            )}
            {showTemplates && (
              <div className="card org-card">
                <strong>🔁 Recurring tasks</strong>
                <div className="org-rows">
                  {templates.map((tp) => (
                    <div key={tp.id} className="org-row">
                      <span className="org-dept">{tp.title}</span>
                      <span className="muted">{tp.assignee_name}</span>
                      <span className="muted">{(tp.frequency || "").replace("_", " ")}</span>
                      <span className="muted">{tp.cutoff_day ? `day ${tp.cutoff_day}` : "—"}</span>
                      <span className="org-actions">
                        <button
                          className="link"
                          onClick={async () => {
                            if (!window.confirm("Stop this recurring task?")) return;
                            await authFetch(`/tasks/templates/${tp.id}`, { method: "DELETE" }).catch(() => {});
                            loadTemplates();
                            loadTeam();
                          }}
                        >
                          stop
                        </button>
                      </span>
                    </div>
                  ))}
                  {templates.length === 0 && <div className="empty">No recurring tasks.</div>}
                </div>
              </div>
            )}
            <div className="conv-section">
              {teamTasks.map((t) => (
                <TaskLine
                  key={t.id} t={t} me={me} canManage={!!team?.can_manage}
                  onPatch={patchTask} showAssignee={!teamPerson}
                />
              ))}
              {team && teamTasks.length === 0 && (
                <div className="empty big">No tasks here this month.</div>
              )}
              {!team && <div className="empty big">Pick a department you own.</div>}
            </div>
          </>
        )}

        {box === "kitchen" && canPk && (
          <>
            <div className="pk-topbar">
              <button className="pk-assign-btn" onClick={() => setPkCompose(true)}>
                ✏️ Assign task
              </button>
              {(() => {
                const p = pkTasks.counts?.pending || 0;
                const d = pkTasks.counts?.done || 0;
                const rate = p + d ? Math.round((d / (p + d)) * 100) : 0;
                return (
                  <div className="pk-stat-row">
                    <div className="pk-stat"><b>{p}</b><span>pending</span></div>
                    <div className="pk-stat"><b>{d}</b><span>done</span></div>
                    <div className="pk-stat"><b>{rate}%</b><span>completion</span></div>
                  </div>
                );
              })()}
            </div>

            <div className="pk-filter-row">
              <span className="compose-lbl">Manager</span>
              <select value={pkPerson} onChange={(e) => setPkPerson(e.target.value)}>
                <option value="">All managers</option>
                {pkRollup.map((r) => (
                  <option key={r.manager} value={r.manager}>
                    {r.manager} — {r.pending} pending / {r.done} done
                  </option>
                ))}
              </select>
              {pkPerson && (
                <button className="link" onClick={() => setPkPerson("")}>clear</button>
              )}
            </div>

            {!pkPerson && (
              <div className="card pk-rollup">
                <div className="pk-rollup-head">
                  <span>Manager</span><span>Kitchen</span>
                  <span>Pending</span><span>Done</span><span>Rate</span>
                </div>
                {pkRollup.map((r) => {
                  const rate = r.pending + r.done
                    ? Math.round((r.done / (r.pending + r.done)) * 100) : 0;
                  return (
                    <button
                      key={r.manager}
                      className="pk-rollup-row"
                      onClick={() => setPkPerson(r.manager)}
                      title={`See ${r.manager}'s tasks`}
                    >
                      <span className="pk-rollup-name">{r.manager}</span>
                      <span className="muted pk-rollup-kit">{r.kitchen}</span>
                      <span className={r.pending ? "pk-num-pending" : "muted"}>{r.pending}</span>
                      <span className="muted">{r.done}</span>
                      <span className={`pk-rate ${rate >= 80 ? "hi" : rate >= 40 ? "mid" : "lo"}`}>
                        {rate}%
                      </span>
                    </button>
                  );
                })}
                {pkRollup.length === 0 && (
                  <div className="empty">No manager tasks assigned yet.</div>
                )}
              </div>
            )}

            <div className="conv-section">
              <div className="conv-section-title">
                {pkPerson ? `${pkPerson}'s tasks · ${pkShown.length}` : `All tasks · ${pkShown.length}`}
              </div>
              {pkShown.map((t) => (
                <div key={t.id} className={`task-row ${t.status === "done" ? "task-done" : ""} ${t.status === "cancelled" ? "task-cancelled" : ""}`}>
                  <div className="task-main">
                    <div className="task-id">
                      <span className="task-title">
                        {t.title}
                        <span className={`chip ${t.status === "done" ? "chip-order" : t.status === "cancelled" ? "chip-vendor" : "chip-other"}`}>
                          {t.status}
                        </span>
                      </span>
                      <span className="muted task-sub">
                        {t.manager} · {t.kitchen}
                        {t.assigned_by && ` · by ${t.assigned_by}`}
                        {t.due_date && ` · due ${fmtDate(t.due_date)}`}
                        {t.completed_at && ` · done ${timeAgo(t.completed_at)} ago`}
                      </span>
                      {t.details && <span className="muted pk-task-details">{t.details}</span>}
                      <span className="pk-task-links">
                        {t.attachment_url && (
                          <a className="link" href={t.attachment_url} target="_blank" rel="noreferrer">
                            📎 attachment
                          </a>
                        )}
                        {t.completion_note && <span className="muted">📝 {t.completion_note}</span>}
                      </span>
                    </div>
                    {t.status === "pending" && (
                      <button className="link" onClick={() => pkCancel(t.id)}>
                        cancel
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {pkShown.length === 0 && (
                <div className="empty big">No tasks{pkPerson ? " for this manager" : ""} yet.</div>
              )}
            </div>
          </>
        )}
      </main>

      <button className="tasks-fab" onClick={() => setCompose(true)} aria-label="Create task">
        ✏️
      </button>

      {compose && (
        <ComposeTask
          me={me}
          admins={admins}
          depts={depts}
          authFetch={authFetch}
          onClose={() => setCompose(false)}
          onSent={() => {
            setCompose(false);
            setStatus("Task sent — they've been notified ✓");
            load();
            setBox("sent");
          }}
        />
      )}

      {pkCompose && (
        <div className="modal-backdrop" onClick={() => setPkCompose(false)}>
          <div className="modal compose-modal pk-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>🍳 Assign task to kitchen managers</strong>
              <button className="link" onClick={() => setPkCompose(false)}>✕</button>
            </div>
            <form className="compose-form" onSubmit={pkAssign}>
              <input
                autoFocus
                placeholder="Task — what should they do?"
                value={pkForm.title}
                onChange={(e) => setPkForm({ ...pkForm, title: e.target.value })}
              />
              <textarea
                rows={2}
                placeholder="Details (optional)"
                value={pkForm.details}
                onChange={(e) => setPkForm({ ...pkForm, details: e.target.value })}
              />
              <div className="compose-grid">
                <label className="compose-field">
                  <span className="compose-lbl">Due date</span>
                  <input
                    type="date"
                    value={pkForm.due_date}
                    onChange={(e) => setPkForm({ ...pkForm, due_date: e.target.value })}
                  />
                </label>
                <label className="compose-field">
                  <span className="compose-lbl">Attachment (PDF / image)</span>
                  {pkFile ? (
                    <span className="pk-file-chip">
                      📎 {pkFile.filename || "file"}
                      <button type="button" className="link" onClick={() => setPkFile(null)}>
                        remove
                      </button>
                    </span>
                  ) : (
                    <label className="pk-file-btn">
                      {pkUploading ? "Uploading…" : "Choose file"}
                      <input
                        type="file"
                        hidden
                        accept="application/pdf,image/*"
                        onChange={(e) => pkUpload(e.target.files?.[0])}
                      />
                    </label>
                  )}
                </label>
              </div>

              <div className="pk-worker-head">
                <input
                  className="pk-worker-filter"
                  placeholder="Filter managers / kitchens…"
                  value={pkFilter}
                  onChange={(e) => setPkFilter(e.target.value)}
                />
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    setPkSel(
                      pkSel.length === pkWorkers.length ? [] : pkWorkers.map((w) => w.id)
                    )
                  }
                >
                  {pkSel.length === pkWorkers.length ? "clear all" : "select all"}
                </button>
              </div>
              <div className="pk-workers">
                {pkWorkers
                  .filter((w) => {
                    const q = pkFilter.toLowerCase();
                    return (
                      !q ||
                      (w.name || "").toLowerCase().includes(q) ||
                      (w.kitchens || "").toLowerCase().includes(q)
                    );
                  })
                  .map((w) => (
                    <label key={w.id} className="pk-worker">
                      <input
                        type="checkbox"
                        checked={pkSel.includes(w.id)}
                        onChange={(e) =>
                          setPkSel((cur) =>
                            e.target.checked
                              ? [...cur, w.id]
                              : cur.filter((x) => x !== w.id)
                          )
                        }
                      />
                      <span className="pk-worker-name">{w.name}</span>
                      <span className="muted pk-worker-kit">{w.kitchens}</span>
                    </label>
                  ))}
                {pkWorkers.length === 0 && (
                  <div className="empty">No managers available.</div>
                )}
              </div>
              <button type="submit" disabled={pkUploading}>
                Assign to {pkSel.length || "…"} manager{pkSel.length === 1 ? "" : "s"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// Compose (gmail-style): department → person → subject/details/due, and for
// department owners a repeat option that creates a recurring task.
function ComposeTask({ me, admins, depts, authFetch, onClose, onSent }) {
  const [dept, setDept] = useState(me.department || "");
  const [members, setMembers] = useState([]);
  const [f, setF] = useState({
    assignee_email: "", title: "", notes: "", cutoff_date: "", repeat: "once",
  });
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);

  const canRecur = me.is_super || (me.owns || []).includes(dept);

  useEffect(() => {
    if (!dept) {
      setMembers([]);
      return;
    }
    authFetch(`/org/team?department=${encodeURIComponent(dept)}`)
      .then((r) => r.json())
      .then((d) => setMembers((d.members || []).filter((m) => m.email)))
      .catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dept]);

  async function send(e) {
    e.preventDefault();
    setErr("");
    if (!f.assignee_email) return setErr("Pick who the task is for");
    if (!f.title.trim()) return setErr("Give the task a subject");
    setSending(true);
    let res;
    if (f.repeat === "once") {
      res = await authFetch("/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: f.title.trim(),
          assignee_email: f.assignee_email,
          cutoff_date: f.cutoff_date || null,
          notes: f.notes || null,
          department: dept || null,
        }),
      }).catch(() => null);
    } else {
      const due = f.cutoff_date ? new Date(f.cutoff_date) : null;
      const step = { quarterly: 3, half_yearly: 6, yearly: 12 }[f.repeat];
      const due_months =
        step && due
          ? Array.from({ length: 12 / step }, (_, k) =>
              ((due.getMonth() + k * step) % 12) + 1
            ).join(",")
          : null;
      res = await authFetch("/tasks/templates", {
        method: "POST",
        body: JSON.stringify({
          title: f.title.trim(),
          assignee_email: f.assignee_email,
          department: dept || null,
          frequency: f.repeat,
          cutoff_day: due ? due.getDate() : null,
          due_months,
          notes: f.notes || null,
        }),
      }).catch(() => null);
    }
    setSending(false);
    if (res && res.ok) onSent();
    else {
      const d = res ? await res.json().catch(() => ({})) : {};
      setErr(errText(d, "Could not send the task"));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compose-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>✏️ New task</strong>
          <button className="link" onClick={onClose}>✕</button>
        </div>
        <form className="compose-form" onSubmit={send}>
          <div className="compose-grid">
            <label className="compose-field">
              <span className="compose-lbl">Department</span>
              <select
                value={dept}
                onChange={(e) => {
                  setDept(e.target.value);
                  setF({ ...f, assignee_email: "" });
                }}
              >
                <option value="">Choose…</option>
                {depts.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
            <label className="compose-field">
              <span className="compose-lbl">To</span>
              <select
                value={f.assignee_email}
                onChange={(e) => setF({ ...f, assignee_email: e.target.value })}
              >
                <option value="">Choose…</option>
                {members.map((m) => (
                  <option key={m.email} value={m.email}>{m.name}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="compose-field">
            <span className="compose-lbl">Subject</span>
            <input
              autoFocus
              placeholder="What needs to be done…"
              value={f.title}
              onChange={(e) => setF({ ...f, title: e.target.value })}
            />
          </label>
          <label className="compose-field">
            <span className="compose-lbl">Details <em>(optional)</em></span>
            <textarea
              rows={3}
              placeholder="Context, links, expectations…"
              value={f.notes}
              onChange={(e) => setF({ ...f, notes: e.target.value })}
            />
          </label>
          <div className="compose-grid">
            <label className="compose-field">
              <span className="compose-lbl">Due date</span>
              <input
                type="date"
                value={f.cutoff_date}
                onChange={(e) => setF({ ...f, cutoff_date: e.target.value })}
              />
            </label>
            <label className="compose-field">
              <span className="compose-lbl">Repeat</span>
              <select
                value={f.repeat}
                onChange={(e) => setF({ ...f, repeat: e.target.value })}
                disabled={!canRecur && f.repeat === "once"}
              >
                <option value="once">One-time</option>
                {canRecur && (
                  <>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="half_yearly">Half-yearly</option>
                    <option value="yearly">Yearly</option>
                  </>
                )}
              </select>
            </label>
          </div>
          {f.repeat !== "once" && (
            <div className="muted compose-hint">
              {["daily", "weekly"].includes(f.repeat)
                ? `🔁 A ${f.repeat} routine — it appears as ONE monthly checklist item in their inbox (like the finance tracker), not one task per ${f.repeat === "daily" ? "day" : "week"}.`
                : `🔁 A new task lands in their inbox every ${
                    { monthly: "month", quarterly: "quarter", half_yearly: "half-year", yearly: "year" }[f.repeat]
                  }${f.cutoff_date ? `, due on day ${new Date(f.cutoff_date).getDate()}` : " — pick a due date to set which day it's due"}.`}
            </div>
          )}
          <button type="submit" disabled={sending}>
            {sending ? "Sending…" : f.repeat === "once" ? "Send task" : "Create recurring task"}
          </button>
          {err && <p className="error">{err}</p>}
          <div className="muted compose-hint">
            {f.assignee_email
              ? "They'll get a message and email right away."
              : "The assignee is notified by message and email."}
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Users (superadmin): CRUD, import, org structure ------------------------------

// FastAPI validation errors (422) put an array in `detail` — flatten to text.
function errText(d, fallback) {
  const det = d && d.detail;
  if (typeof det === "string") return det;
  if (Array.isArray(det)) {
    return det
      .map((e) => `${(e.loc || []).slice(1).join(".")}: ${e.msg}`)
      .join(" · ") || fallback;
  }
  return fallback;
}

function ChangePassword({ authFetch, onClose }) {
  const [current, setCurrent] = useState("");
  const [nw, setNw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (nw.length < 6) return setStatus("New password must be at least 6 characters");
    if (nw !== confirm) return setStatus("Passwords don't match");
    setStatus("saving…");
    const res = await authFetch("/me/password", {
      method: "POST",
      body: JSON.stringify({ current, new: nw }),
    }).catch(() => null);
    if (res && res.ok) {
      setStatus("Password changed ✓");
      setTimeout(onClose, 900);
    } else {
      const d = res ? await res.json().catch(() => ({})) : {};
      setStatus(errText(d, "Failed to change password"));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal pw-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>🔑 Change my password</strong>
          <button className="link" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit} className="pw-form">
          <input
            type="password" autoFocus placeholder="Current password"
            value={current} onChange={(e) => setCurrent(e.target.value)}
          />
          <input
            type="password" placeholder="New password (min 6 chars)"
            value={nw} onChange={(e) => setNw(e.target.value)}
          />
          <input
            type="password" placeholder="Repeat new password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)}
          />
          <button type="submit">Change password</button>
          {status && <div className="muted pw-status">{status}</div>}
        </form>
      </div>
    </div>
  );
}

// Department page: the team + the department's programs (its goals).
function DeptView({ department, me, admins, authFetch, onActor, onMessage, onBack }) {
  const [team, setTeam] = useState({ owner: null, members: [] });
  const [meta, setMeta] = useState(null);
  const [progs, setProgs] = useState([]);
  const [total, setTotal] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [showAllProgs, setShowAllProgs] = useState(false);
  const [form, setForm] = useState({ name: "", objective: "", owner_email: "", eta: "" });

  useEffect(() => setShowAllProgs(false), [department]);

  const load = useCallback(() => {
    authFetch(`/org/team?department=${encodeURIComponent(department)}`)
      .then((r) => r.json())
      .then((d) => setTeam(d && d.members ? d : { owner: null, members: [] }))
      .catch(() => {});
    authFetch(`/programs?limit=50&department=${encodeURIComponent(department)}`)
      .then((r) => r.json())
      .then((d) => {
        setProgs(d.programs || []);
        setTotal(d.total || 0);
      })
      .catch(() => {});
    authFetch("/org/structure")
      .then((r) => r.json())
      .then((d) => setMeta((d.rows || []).find((r) => r.department === department) || null))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department]);

  useEffect(load, [load]);

  async function patch(id, body) {
    const res = await authFetch(`/programs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res && res.ok) load();
  }

  async function create(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const res = await authFetch("/programs", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.trim(),
        objective: form.objective || null,
        owner_email: form.owner_email || null,
        eta: form.eta || null,
        department,
      }),
    }).catch(() => null);
    if (res && res.ok) {
      setForm({ name: "", objective: "", owner_email: "", eta: "" });
      setShowNew(false);
      load();
    }
  }

  return (
    <main className="hub dept-hub">
      <div className="conv-head">
        <button className="link conv-back" onClick={onBack}>
          ← Back
        </button>
        <strong className="dept-title">🏛 {department}</strong>
        {meta?.function && <span className="chip chip-people">{meta.function}</span>}
      </div>
      <div className="muted dept-meta">
        {meta?.leader ? `Lead: ${meta.leader} · ` : ""}
        Owner: {team.owner || meta?.owner || "—"} · {team.members.length} member
        {team.members.length === 1 ? "" : "s"}
      </div>

      <div className="card dept-team">
        {team.members.map((m) => (
          <div key={m.email || m.name} className="team-row">
            <span className="avatar sm" style={{ background: actorColor(m.name) }}>
              {initials(m.name)}
            </span>
            {m.email ? (
              <button className="team-name" onClick={() => onActor(m.name)}>
                {m.name}
                {m.email.toLowerCase() === (me.email || "").toLowerCase() && " (you)"}
              </button>
            ) : (
              <span className="team-name">{m.name}</span>
            )}
            {m.is_owner && <span className="feed-roster-owner"> (owner)</span>}
            {m.sub_department && <span className="muted team-sub">{m.sub_department}</span>}
            {m.email && m.email.toLowerCase() !== (me.email || "").toLowerCase() && (
              <button
                className="link team-msg"
                title={`Message ${m.name}`}
                onClick={() => onMessage({ email: m.email, name: m.name })}
              >
                ✉
              </button>
            )}
          </div>
        ))}
        {team.members.length === 0 && (
          <div className="empty">No members mapped yet.</div>
        )}
      </div>

      <div className="hub-head">
        <strong>📌 Programs &amp; goals · {total}</strong>
        <button onClick={() => setShowNew(!showNew)}>
          {showNew ? "Cancel" : "+ New program"}
        </button>
      </div>
      {showNew && (
        <form className="card prog-form" onSubmit={create}>
          <input
            autoFocus
            placeholder={`Program / goal for ${department}…`}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            placeholder="Objective — what does success look like?"
            value={form.objective}
            onChange={(e) => setForm({ ...form, objective: e.target.value })}
          />
          <div className="prog-form-row">
            <select
              value={form.owner_email}
              onChange={(e) => setForm({ ...form, owner_email: e.target.value })}
            >
              <option value="">Owner…</option>
              {admins.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.name || a.email}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={form.eta}
              onChange={(e) => setForm({ ...form, eta: e.target.value })}
            />
            <button type="submit">Create</button>
          </div>
        </form>
      )}
      {progs
        .filter((p) => p.active)
        .slice(0, showAllProgs ? undefined : 5)
        .map((p) => (
          <ProgramCard
            key={p.id}
            p={p}
            me={me}
            admins={admins}
            onPatch={patch}
            onReload={load}
            authFetch={authFetch}
          />
        ))}
      {!showAllProgs && progs.filter((p) => p.active).length > 5 && (
        <button className="load-older" onClick={() => setShowAllProgs(true)}>
          Show all {progs.filter((p) => p.active).length} programs
        </button>
      )}
      {progs.filter((p) => p.active).length === 0 && (
        <div className="empty">No programs for this department yet — add the first goal.</div>
      )}
    </main>
  );
}

function UsersAdmin({ authFetch, me, onOpenDept }) {
  const [users, setUsers] = useState([]);
  const [defaultPw, setDefaultPw] = useState("Welcome@123");
  const [structure, setStructure] = useState({ rows: [], functions: [], departments: [] });
  const [q, setQ] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null); // email being edited
  const [status, setStatus] = useState("");
  const [showOrg, setShowOrg] = useState(false);

  const load = useCallback(() => {
    authFetch("/org/users")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setUsers(d.users || []);
        if (d.default_password) setDefaultPw(d.default_password);
      })
      .catch(() => setStatus("Couldn't load users"));
    authFetch("/org/structure")
      .then((r) => r.json())
      .then(setStructure)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  async function patchUser(email, body) {
    setStatus("saving…");
    const res = await authFetch(`/org/users?email=${encodeURIComponent(email)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res && res.ok) {
      setStatus("");
      load();
      return true;
    }
    const d = res ? await res.json().catch(() => ({})) : {};
    setStatus(errText(d, "Save failed"));
    return false;
  }

  async function resetPassword(email) {
    if (!window.confirm(`Reset ${email} to the default password (${defaultPw})?`)) return;
    const res = await authFetch("/org/users/password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) : {};
    setStatus(res && res.ok ? `Password for ${email} reset to ${defaultPw} ✓` : errText(d, "Reset failed"));
  }

  const ql = q.trim().toLowerCase();
  const visible = users.filter((u) => {
    if (deptFilter && u.department !== deptFilter) return false;
    if (!ql) return true;
    return [
      u.name, u.email, u.function, u.department, u.sub_department, u.owner,
      ...(u.owned_departments || []),
    ].some((v) => (v || "").toLowerCase().includes(ql));
  });

  return (
    <main className="hub users-hub">
      <div className="hub-head">
        <button onClick={() => setShowNew(!showNew)}>
          {showNew ? "Cancel" : "+ New user"}
        </button>
        <button className="chip-toggle" onClick={() => setShowOrg(!showOrg)}>
          🏛 Departments ({structure.rows.length})
        </button>
      </div>

      {status && <div className="users-status">{status}</div>}

      {showOrg && (
        <OrgStructure
          structure={structure}
          authFetch={authFetch}
          onChanged={load}
          onPickDept={(d) => (onOpenDept ? onOpenDept(d) : setDeptFilter(d))}
        />
      )}

      {showNew && (
        <NewUserForm
          structure={structure}
          defaultPw={defaultPw}
          authFetch={authFetch}
          onDone={() => {
            setShowNew(false);
            load();
          }}
        />
      )}

      <div className="msg-filter">
        <input
          className="grow"
          placeholder="Search people, departments…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
          <option value="">All departments</option>
          {structure.departments.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      <div className="users-list">
        {visible.map((u) =>
          editing === u.email ? (
            <EditUserForm
              key={u.email}
              user={u}
              structure={structure}
              onSave={async (body) => {
                if (await patchUser(u.email, body)) setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div key={u.email} className={`card user-row ${u.active ? "" : "user-inactive"}`}>
              <span className="avatar sm" style={{ background: actorColor(u.name || u.email) }}>
                {initials(u.name || u.email)}
              </span>
              <div className="user-id">
                <strong>{u.name || u.email}</strong>
                <span className="muted user-email">{u.email}</span>
              </div>
              <div className="user-tags">
                {u.department && <span className="chip chip-order">{u.department}</span>}
                {(u.owned_departments || []).map((d) => (
                  <span key={d} className="chip chip-money" title="Owns this department">
                    👑 {d}
                  </span>
                ))}
                {u.function && <span className="chip chip-people">{u.function}</span>}
                {u.is_super_admin && <span className="chip chip-money">super</span>}
                <span className={`chip ${u.kpk_access ? "chip-stock" : "chip-other"}`}>
                  {u.kpk_access ? "KPK" : "KLU only"}
                </span>
                {!u.active && <span className="chip chip-other">inactive</span>}
              </div>
              <span className="user-actions">
                <button className="link" onClick={() => setEditing(u.email)}>edit</button>
                <button className="link" onClick={() => resetPassword(u.email)}>reset pw</button>
                {u.email.toLowerCase() !== (me.email || "").toLowerCase() && (
                  <button
                    className="link"
                    onClick={() => patchUser(u.email, { active: !u.active })}
                  >
                    {u.active ? "deactivate" : "reactivate"}
                  </button>
                )}
              </span>
            </div>
          )
        )}
        {visible.length === 0 && <div className="empty big">No users match.</div>}
      </div>
    </main>
  );
}

function NewUserForm({ structure, defaultPw, authFetch, onDone }) {
  const [f, setF] = useState({ name: "", email: "", function: "", department: "", sub_department: "" });
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    setErr("");
    const res = await authFetch("/org/users", {
      method: "POST",
      body: JSON.stringify({
        name: f.name.trim(),
        email: f.email.trim(),
        function: f.function || null,
        department: f.department || null,
        sub_department: f.sub_department || null,
      }),
    }).catch(() => null);
    if (res && res.ok) onDone();
    else {
      const d = res ? await res.json().catch(() => ({})) : {};
      setErr(errText(d, "Failed to create user"));
    }
  }

  return (
    <form className="card prog-form" onSubmit={submit}>
      <div className="prog-form-row">
        <input
          autoFocus placeholder="Full name…" value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
        <input
          placeholder="email@kftpl.com" value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
        />
      </div>
      <div className="prog-form-row">
        <select value={f.function} onChange={(e) => setF({ ...f, function: e.target.value })}>
          <option value="">Function…</option>
          {structure.functions.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>
          <option value="">Department…</option>
          {structure.departments.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <input
          placeholder="Sub-department (optional)" value={f.sub_department}
          onChange={(e) => setF({ ...f, sub_department: e.target.value })}
        />
        <button type="submit">Create</button>
      </div>
      <div className="muted">
        Signs in with the company default password · no KPK modules · active immediately.
      </div>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

function EditUserForm({ user, structure, onSave, onCancel }) {
  const [f, setF] = useState({
    name: user.name || "",
    function: user.function || "",
    department: user.department || "",
    sub_department: user.sub_department || "",
  });
  return (
    <form
      className="card prog-form prog-edit"
      onSubmit={(e) => {
        e.preventDefault();
        // Empty strings clear a field (backend maps "" → NULL); name stays
        // untouched when blank so we never wipe the KPK display name.
        onSave({
          name: f.name.trim() || undefined,
          function: f.function,
          department: f.department,
          sub_department: f.sub_department,
        });
      }}
    >
      <div className="prog-form-row">
        <input value={f.name} placeholder="Name" onChange={(e) => setF({ ...f, name: e.target.value })} />
        <span className="muted">{user.email}</span>
        {(user.owned_departments || []).length > 0 && (
          <span className="muted">👑 owns: {user.owned_departments.join(", ")}</span>
        )}
      </div>
      <div className="prog-form-row">
        <select value={f.function} onChange={(e) => setF({ ...f, function: e.target.value })}>
          <option value="">Function…</option>
          {structure.functions.map((x) => <option key={x} value={x}>{x}</option>)}
          {f.function && !structure.functions.includes(f.function) && (
            <option value={f.function}>{f.function}</option>
          )}
        </select>
        <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>
          <option value="">Department…</option>
          {structure.departments.map((x) => <option key={x} value={x}>{x}</option>)}
          {f.department && !structure.departments.includes(f.department) && (
            <option value={f.department}>{f.department}</option>
          )}
        </select>
        <input
          value={f.sub_department} placeholder="Sub-department"
          onChange={(e) => setF({ ...f, sub_department: e.target.value })}
        />
        <button type="submit">Save</button>
        <button type="button" className="link" onClick={onCancel}>cancel</button>
      </div>
    </form>
  );
}

function OrgStructure({ structure, authFetch, onChanged, onPickDept }) {
  const [f, setF] = useState({ function: "", department: "", leader: "", owner: "" });
  const [editKey, setEditKey] = useState(null); // row id or "new:<dept>"
  const [edit, setEdit] = useState({});

  async function add(e) {
    e.preventDefault();
    if (!f.function.trim() || !f.department.trim()) return;
    const res = await authFetch("/org/structure", {
      method: "POST",
      body: JSON.stringify(f),
    }).catch(() => null);
    if (res && res.ok) {
      setF({ function: "", department: "", leader: "", owner: "" });
      onChanged();
    }
  }

  // Rows straight from the people sheet have no structure record yet (id null)
  // — saving one creates it.
  async function save(row) {
    const body = {
      function: (edit.function || "").trim() || "—",
      department: (edit.department || "").trim(),
      leader: edit.leader || null,
      owner: edit.owner || null,
    };
    if (!body.department) return;
    const res = await authFetch(
      row.id ? `/org/structure/${row.id}` : "/org/structure",
      { method: row.id ? "PATCH" : "POST", body: JSON.stringify(body) }
    ).catch(() => null);
    if (res && res.ok) {
      setEditKey(null);
      onChanged();
    }
  }

  async function remove(id) {
    if (!window.confirm("Remove this department row?")) return;
    await authFetch(`/org/structure/${id}`, { method: "DELETE" }).catch(() => {});
    onChanged();
  }

  const keyOf = (r) => r.id || `new:${r.department}`;

  return (
    <div className="card org-card">
      <strong>🏛 Functions & Departments</strong>
      <form className="prog-form-row org-add" onSubmit={add}>
        <input placeholder="Department" value={f.department}
          onChange={(e) => setF({ ...f, department: e.target.value })} />
        <input placeholder="Function" value={f.function}
          onChange={(e) => setF({ ...f, function: e.target.value })} />
        <input placeholder="Leader" value={f.leader}
          onChange={(e) => setF({ ...f, leader: e.target.value })} />
        <input placeholder="Owner" value={f.owner}
          onChange={(e) => setF({ ...f, owner: e.target.value })} />
        <button type="submit">Add</button>
      </form>
      <div className="org-rows">
        {structure.rows.map((r) =>
          editKey === keyOf(r) ? (
            <div key={keyOf(r)} className="org-row">
              <input value={edit.department} placeholder="Department" onChange={(e) => setEdit({ ...edit, department: e.target.value })} />
              <input value={edit.function || ""} placeholder="Function" onChange={(e) => setEdit({ ...edit, function: e.target.value })} />
              <input value={edit.leader || ""} placeholder="Leader" onChange={(e) => setEdit({ ...edit, leader: e.target.value })} />
              <input value={edit.owner || ""} placeholder="Owner" onChange={(e) => setEdit({ ...edit, owner: e.target.value })} />
              <button onClick={() => save(r)}>Save</button>
              <button className="link" onClick={() => setEditKey(null)}>cancel</button>
            </div>
          ) : (
            <div key={keyOf(r)} className="org-row">
              <button
                className="org-dept-btn"
                title={`Show ${r.department} members`}
                onClick={() => onPickDept(r.department)}
              >
                {r.department}
              </button>
              <span className="muted org-fn-lbl">{r.function || "—"}</span>
              <span className="muted">lead: {r.leader || "—"}</span>
              <span className="muted">owner: {r.owner || "—"}</span>
              <span className="org-members" title="Team members (incl. owner)">
                👥 {r.members}
              </span>
              <span className="org-actions">
                <button className="link" onClick={() => { setEditKey(keyOf(r)); setEdit(r); }}>edit</button>
                {r.id && (
                  <button className="link" onClick={() => remove(r.id)}>remove</button>
                )}
              </span>
            </div>
          )
        )}
        {structure.rows.length === 0 && (
          <div className="empty">No departments yet — add above.</div>
        )}
      </div>
    </div>
  );
}

// ---- Superadmin dashboard --------------------------------------------------------

function BarList({ items }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="barlist">
      {items.map((i) => (
        <div key={i.actor} className="bar-row" title={`${i.actor}: ${i.count}`}>
          <span className="bar-label">{i.actor}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(i.count / max) * 100}%` }} />
          </span>
          <span className="bar-value">{i.count}</span>
        </div>
      ))}
      {items.length === 0 && <div className="empty">No data.</div>}
    </div>
  );
}

function DayBars({ title, data }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="card chart-card">
      <div className="chart-title">{title}</div>
      <div className="daybars">
        {data.map((d) => (
          <div
            key={d.date}
            className="daybar"
            title={`${d.date}: ${d.count}`}
            style={{ height: `${Math.max(6, (d.count / max) * 100)}%` }}
          />
        ))}
        {data.length === 0 && <div className="empty">No data.</div>}
      </div>
      {data.length > 0 && (
        <div className="chart-x">
          <span>{data[0].date.slice(5)}</span>
          <span>{data[data.length - 1].date.slice(5)}</span>
        </div>
      )}
    </div>
  );
}

function Dashboard({ authFetch }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    authFetch("/dashboard")
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          setError(d.detail || "Not allowed");
          return;
        }
        setData(await r.json());
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div className="empty big">{error}</div>;
  if (!data) return <div className="empty big">Loading dashboard…</div>;

  const tiles = [
    { label: "Events · 7d", value: data.totals.events_7d },
    { label: "Active people · 7d", value: data.totals.people_7d },
    { label: "Messages · 7d", value: data.totals.messages_7d },
    { label: "Reactions · 7d", value: data.totals.reactions_7d },
  ];

  return (
    <main className="dash">
      <div className="tiles">
        {tiles.map((t) => (
          <div key={t.label} className="card tile">
            <div className="tile-value">{t.value}</div>
            <div className="tile-label">{t.label}</div>
          </div>
        ))}
      </div>
      <div className="card chart-card">
        <div className="chart-title">Who did what · actions in the last 7 days</div>
        <BarList items={data.by_person} />
      </div>
      <div className="dash-grid">
        <DayBars title="Feed events per day · 14d" data={data.feed_by_day} />
        <DayBars title="PK logins per day · 14d" data={data.pk_usage} />
        <DayBars title="KFC logins per day · 14d" data={data.kfc_usage} />
      </div>
      {data.adoption && <Adoption adoption={data.adoption} />}
    </main>
  );
}

function Adoption({ adoption }) {
  return (
    <div className="card chart-card">
      <div className="chart-title">Kouzina Live adoption · last 30 days</div>
      <div className="tiles adoption-tiles">
        <div className="tile">
          <div className="tile-value">{adoption.logins_7d}</div>
          <div className="tile-label">Sign-ins · 7d</div>
        </div>
        <div className="tile">
          <div className="tile-value">{adoption.users_7d}</div>
          <div className="tile-label">People · 7d</div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="usage-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Sign-ins</th>
              <th>Messages</th>
              <th>Likes</th>
              <th>Comments</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {adoption.users.map((u) => (
              <tr key={u.email}>
                <td className="usage-name">
                  <span
                    className="avatar sm"
                    style={{ background: actorColor(u.name) }}
                  >
                    {initials(u.name)}
                  </span>
                  {u.name}
                </td>
                <td>{u.logins}</td>
                <td>{u.messages}</td>
                <td>{u.likes}</td>
                <td>{u.comments}</td>
                <td className="muted">
                  {u.last_login ? formatWhen(u.last_login) : "—"}
                </td>
              </tr>
            ))}
            {adoption.users.length === 0 && (
              <tr>
                <td colSpan="6" className="muted">
                  Sign-in tracking starts with this release — data appears as
                  people log in.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {adoption.never.length > 0 && (
        <div className="never-block">
          <div className="chart-title">Not signed in yet · give them a nudge 👇</div>
          <div className="never-list">
            {adoption.never.map((n) => (
              <span key={n} className="never-chip">
                {n}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Live Updates feed ------------------------------------------------------

const PAGE_FIRST = 10;
const PAGE_MORE = 20;

// Source filter for the feed. null = the curated all-sources view.
const PORTAL_TABS = [
  [null, "All"],
  ["PK", "PK"],
  ["KAC", "KAC"],
  ["FIN", "Finance"],
  ["LAUNCH", "Launch"],
  ["LIVE", "Live"],
];

// Lean roster for the picked department: comma-separated linked names,
// owner tagged — so everyone knows who belongs where.
function DeptRoster({ team, onActor }) {
  const members = team.members || [];
  return (
    <div className="feed-roster">
      👥{" "}
      {members.map((m, i) => (
        <span key={m.email || m.name}>
          {m.email ? (
            <button className="feed-roster-name" onClick={() => onActor(m.name)}>
              {m.name}
            </button>
          ) : (
            <span>{m.name}</span>
          )}
          {m.is_owner && <span className="feed-roster-owner"> (owner)</span>}
          {i < members.length - 1 && ", "}
        </span>
      ))}
      {members.length === 0 && <span>no members mapped yet</span>}
    </div>
  );
}

function Feed({ authFetch, actor, onActor }) {
  const [top, setTop] = useState([]);
  const [older, setOlder] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [openComments, setOpenComments] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [portal, setPortal] = useState(null); // null = all sources
  const [dept, setDept] = useState(""); // department filter
  const [depts, setDepts] = useState([]);
  const [deptTeam, setDeptTeam] = useState(null); // {owner, members} of the picked dept

  const actorQS = actor ? `&actor=${encodeURIComponent(actor)}` : "";
  const portalQS = portal ? `&portal=${portal}` : "";
  const deptQS = dept ? `&department=${encodeURIComponent(dept)}` : "";

  useEffect(() => {
    authFetch("/org/structure")
      .then((r) => r.json())
      .then((d) => setDepts(d.departments || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetPaging() {
    setOlder([]);
    setCursor(null);
    setHasMore(false);
  }

  function changePortal(p) {
    if (p === portal) return;
    setPortal(p);
    resetPaging();
  }

  function changeDept(d) {
    setDept(d);
    resetPaging();
  }

  // Who's in the picked department (owner tagged) — shown under the feed bar.
  useEffect(() => {
    if (!dept) {
      setDeptTeam(null);
      return;
    }
    authFetch(`/org/team?department=${encodeURIComponent(dept)}`)
      .then((r) => r.json())
      .then((d) => setDeptTeam(d && d.members ? d : null))
      .catch(() => setDeptTeam(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dept]);

  const load = useCallback(
    (manual = false) => {
      if (manual) setRefreshing(true);
      authFetch(`/feed?limit=${PAGE_FIRST}${actorQS}${portalQS}${deptQS}`)
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
    [actorQS, portalQS, deptQS]
  );

  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await authFetch(
        `/feed?limit=${PAGE_MORE}&cursor_ts=${encodeURIComponent(
          cursor.ts
        )}&cursor_id=${cursor.id}${actorQS}${portalQS}${deptQS}`
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

  const topIds = new Set(top.map((e) => e.id));
  const events = [...top, ...older.filter((e) => !topIds.has(e.id))];

  async function toggleLike(ev) {
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
      <div className="feed-portals">
        {PORTAL_TABS.map(([val, label]) => (
          <button
            key={label}
            className={`chip-toggle ${portal === val ? "on" : ""}`}
            onClick={() => changePortal(val)}
          >
            {label}
          </button>
        ))}
        {depts.length > 0 && (
          <select
            className={`feed-dept ${dept ? "on" : ""}`}
            value={dept}
            onChange={(e) => changeDept(e.target.value)}
            title="Filter by department"
          >
            <option value="">🏛 All departments</option>
            {depts.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}
      </div>
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
      {dept && deptTeam && (
        <DeptRoster team={deptTeam} onActor={onActor} />
      )}
      {events.map((ev) => {
        const kind =
          (ev.actions || [ev.action]).map(actionKind).find((k) => k === "alert") ||
          actionKind(ev.action);
        const uniform = ev.uniform !== false;
        return (
        <article key={ev.id} className={`event card kind-${kind}`}>
          <div className="event-row">
            <span className="avatar" style={{ background: actorColor(ev.actor) }}>
              {initials(ev.actor)}
            </span>
            <div className="event-main">
              <div className="event-head">
                <button className="actor-link" onClick={() => onActor(ev.actor)}>
                  {ev.actor}
                </button>
                <span className={`badge badge-${ev.portal.toLowerCase()}`}>
                  {ev.portal}
                </span>
                {uniform ? (
                  <span className={`chip chip-${actionKind(ev.action)}`}>
                    {ev.action.replace(/_/g, " ")}
                  </span>
                ) : (
                  <span className={`chip chip-${kind}`}>
                    {ev.actions.length} actions
                  </span>
                )}
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
                      : `show ${ev.count - 1} more`}
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
        );
      })}
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
