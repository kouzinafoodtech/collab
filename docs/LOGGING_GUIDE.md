# Kouzina Live Updates — logging guide for portal teams

The Live Updates feed (https://live.kftpl.com) shows admins what is happening
across our systems. It reads **existing audit tables** — no API integration
needed. If your portal writes a row, it appears in the feed within ~30 seconds.

## The golden rule

> **Log business events, not CRUD.** Before adding a log call, ask: *"would
> another admin stop scrolling for this?"*

Every event should answer: **who** did **what**, to **which thing** (name, not
just an id), **how much** (₹ / quantity), **where** (kitchen), and **old → new**
for changes.

## Where to write

Two patterns already exist — use whichever your codebase has:

| Style | Table | Columns that matter |
| --- | --- | --- |
| PK-style | `pkdb.admin_audit_log` (also `coco_audit_log`, `inventory_audit_log`) | `action`, `entity_type`, `entity_id`, `performed_by`, `details` (JSON), `created_at` |
| OS-style | `wodb.audit_log`, `kouzinaos.audit_log` | `user_email`, `action`, `target` (`"order:123"`), `result`, `meta` (JSON), `created_at` |
| Finance | `financedb.bill_activity_log` | already perfect — `action` enum CREATED→VERIFIED→…→PAID, `old_status`/`new_status`, `performed_by`, `performed_at` |

Rules:

- Write the row **in the same transaction** as the business change.
- Timestamps in **UTC** (the feed converts to each viewer's local time).
- Put human-relevant data in the `details`/`meta` JSON. The feed renders these
  keys automatically:
  - `item_name` / `name` → shown instead of "#id"
  - any `{"from": X, "to": Y}` pair → shown as "X → Y"
  - example: `{"item_name": "Coated Paneer", "price": {"from": 210, "to": 235}}`
    renders as **"price changed · Coated Paneer (price: 210 → 235)"**
- Do **not** log logins/logouts/tenant switches (the feed filters them) and do
  **not** log per-Swiggy/Zomato order (use a daily digest event instead).

## PK (PartnerKart) — extend the existing `log_audit(...)` calls

The plumbing exists; add calls at these points, highest value first:

| Event (`action`) | details to include | Feed card it produces |
| --- | --- | --- |
| `order_placed` / `order_dispatched` / `order_cancelled` | partner name, amount, kitchen | "Rohan dispatched order #1204 · Hotel Empire (₹48,500)" |
| `grn_completed` | invoice no, amount | "ali completed GRN · SEDNA-0231 (₹1.2L)" |
| `expense_added` / `expense_approved` / `expense_rejected` | amount, category, kitchen, bucket | "Priya approved expense · AREKERE (₹4,500, Maintenance)" |
| `price_changed` | item_name, `price: {from, to}` | "ali price changed · Coated Paneer (210 → 235)" |
| `invoice_generated` | sedna number, IRN, amount | "Rohan generated invoice · SEDNA-0232 (₹92,300)" |
| `vendor_added` / `credit_deduction` | vendor name, amount | "Priya added vendor · Sri Balaji Traders" |
| `admin_created` / `permissions_changed` | name, modules | "Chanakya gave Rohan access to Expenses" |

Also: `pkdb.inventory_audit_log` (stock quantity changes with item names) has
been **quiet since 15 May** — if stock flows still run, the writer may have
been dropped in a refactor. Re-enabling it instantly enriches the feed.

## KFC (warehouse / kitchen ops) — start writing `wodb.audit_log`

The table exists with the right shape but is barely used. Highest-value events:

1. **Item stock-out toggles** on UrbanPiper — `action: item_toggled`,
   `meta: {"item_name": ..., "kitchen": ..., "active": {"from": true, "to": false}}`.
   This is the single most useful ops signal.
2. **GRN / procurement receipts** — qty, value, vendor
   ("received 200kg paneer · Hyperpure (₹56,000)").
3. **Wastage / stock adjustments** — qty + reason.
4. **Stock transfers** between kitchens — from → to, item count.
5. **Daily kitchen digest** — ONE event per kitchen per day:
   `meta: {"orders": 152, "gmv": 183000}` → "AREKERE crossed 150 orders (₹1.8L)".
6. **Kitchen audit submitted** — auditor + score.

## KAC — make `kouzinaos.audit_log` business-relevant

Today it only logs user management and logins. Worth adding: report exports,
file uploads, tenant configuration changes, data syncs — whatever a KAC admin
does that others should know about.

> Note: KAC and KFC are currently **not shown** in the feed (scoped to PK+FIN
> by request). Re-enabling either is a one-entry change in the app's source
> registry once their logs are worth watching.

## FIN (finance) — nothing to design, just start writing

`financedb.bill_activity_log` is already wired into the feed and empty. The
moment the finance app writes bill transitions (CREATED → VERIFIED → APPROVED →
PAID), they appear as "Admin #12 approved bill #88 (status: SUBMITTED →
APPROVED)".
