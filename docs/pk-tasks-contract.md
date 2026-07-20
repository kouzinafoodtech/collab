# PartnerKart ↔ Kouzina Live: worker tasks (`pkdb.pk_tasks`)

This is the integration contract for the **kitchen-manager task** feature (an
exception requested by **Hema Kumar**). Kouzina Live (KLU) lets Hema assign
tasks to PartnerKart **`local_users`** (kitchen workers who log in with
phone + PIN). The tasks live in a shared table, **`pkdb.pk_tasks`**. KLU owns
task creation and Hema's status view; **PartnerKart owns the worker inbox** —
showing pending tasks and letting the worker mark them done.

Nothing on the KLU side needs the PartnerKart app to change to keep working;
the tasks simply won't reach workers until PartnerKart implements the two
steps in **"What PartnerKart needs to build"** below.

## The table

KLU creates this on startup if it has the grant; if not, run it once yourself
(you own `pkdb`). It is safe to run repeatedly.

```sql
CREATE TABLE IF NOT EXISTS pkdb.pk_tasks (
  id                INT PRIMARY KEY AUTO_INCREMENT,
  local_user_id     INT NOT NULL,          -- assignee: pkdb.local_users.id
  kitchen_id        INT NULL,              -- convenience copy of the worker's kitchen
  title             VARCHAR(500) NOT NULL, -- what to do (short)
  details           TEXT NULL,             -- optional longer description
  status            VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending | done | cancelled
  due_date          DATE NULL,
  assigned_by_email VARCHAR(255) NULL,     -- Hema's KLU email
  assigned_by_name  VARCHAR(255) NULL,     -- "Hema Kumar"
  completion_note   TEXT NULL,             -- optional note/photo URL the worker adds
  attachment_url    VARCHAR(500) NULL,     -- KLU-hosted PDF/image for the manager to open
  completed_at      DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pk_tasks_user (local_user_id, status),
  INDEX idx_pk_tasks_by (assigned_by_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Who does what

| Field / action        | Written by | Notes                                             |
| --------------------- | ---------- | ------------------------------------------------- |
| Insert a task         | **KLU**    | one row per worker when Hema assigns              |
| `status='pending'`    | KLU        | initial state                                     |
| `status='cancelled'`  | KLU        | Hema cancels a still-pending task                 |
| `status='done'`, `completed_at` | **PartnerKart** | when the worker taps Done in the inbox |
| `completion_note`     | PartnerKart (optional) | worker's note / photo URL             |

Rule of thumb: **KLU never flips a task to `done`; PartnerKart never inserts or
cancels.** That keeps ownership clean and avoids write races.

## What PartnerKart needs to build

Both live inside the existing worker session (already authenticated as a
`local_users` row via phone + PIN — call that `:local_user_id`).

1. **Show the inbox.** In the worker's local-orders screen, list their open
   tasks:

   ```sql
   SELECT id, title, details, due_date, created_at, assigned_by_name
   FROM pkdb.pk_tasks
   WHERE local_user_id = :local_user_id
     AND status = 'pending'
   ORDER BY (due_date IS NULL), due_date, id;
   ```

   Suggested label: "Tasks from office" / "Tasks from {assigned_by_name}".

   If `attachment_url` is set, show it as a link/thumbnail — it's an absolute
   path on KLU (`/api/pk-tasks/file/{token}`); prefix with `https://live.kftpl.com`.
   The file (PDF or image) is served publicly, no auth needed.

2. **Mark done.** When the worker completes a task:

   ```sql
   UPDATE pkdb.pk_tasks
   SET status = 'done',
       completed_at = NOW(),
       completion_note = :note   -- optional; NULL if none
   WHERE id = :task_id
     AND local_user_id = :local_user_id   -- guard: only their own task
     AND status = 'pending';
   ```

   (Optionally show recently-done tasks for a day so it doesn't feel like they
   vanish.)

That's the whole surface. As soon as those two are live, Hema's assignments
appear for workers and their completions show up in Hema's KLU view in real
time (KLU reads `status` / `completed_at` directly).

## KLU side (already built, for reference)

- `GET  /api/pk-tasks/workers` — active `local_users` + their kitchens (picker)
- `POST /api/pk-tasks/assign`  — `{worker_ids[], title, details?, due_date?}` →
  one `pk_tasks` row per worker
- `GET  /api/pk-tasks`         — Hema's list with live status + counts
- `PATCH /api/pk-tasks/{id}`   — cancel a pending task

Access (assign + review all tasks) is gated to Hema (`hemakumar.s@kftpl.com`), Shashank S (`shashank.s@kftpl.com`), and superadmins.

## Notes / open questions for PartnerKart

- **`local_users.pin` is plaintext** (`1234` for these workers). Out of scope
  here, but worth hardening on your side.
- One KLU `local_users` row (phone `9133331015`, labelled "Hema KLP") is named
  **Pawan** with `can_access_pi = 0`. Confirm that's the intended worker before
  Hema assigns to them.
