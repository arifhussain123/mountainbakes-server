-- 04: branch stock balances, movement history, and the blocked-sale audit log.
--
-- THIS IS THE MOST SAFETY-CRITICAL FILE IN THE SCHEMA. Two invariants from the
-- legacy implementation must survive, and both are enforced here by
-- constraints rather than by application code:
--
--   1. IDEMPOTENCY. The legacy system keyed stock_history records by the composite ID
--      `{refId}_{productId}_{type}` and did an existence check inside the
--      transaction: if the doc existed, the whole movement was a no-op. That
--      composite ID becomes the UNIQUE constraint below. It is NOT merely an
--      index — it is the retry-safety mechanism. The port must use
--      `insert ... on conflict (ref_id, product_id, type) do nothing` and apply
--      the balance delta ONLY when the insert actually affected a row.
--
--   2. NO LOST UPDATES on the running balance. Two cashiers selling the last
--      unit concurrently must not both succeed. The legacy system's optimistic
--      transaction retry covered this; in Postgres the sale path must take
--      `select ... for update` on the stock rows, ordered deterministically by
--      product_id, before validating. The deterministic order is what prevents
--      deadlocks when two multi-line orders overlap.

-- ---------------------------------------------------------------------------
-- stock — one running balance per (branch, product).
-- Keyed by (branch_id, product_id).
--
-- Balances are deliberately allowed to go NEGATIVE. applyStockMovement never
-- validated; only the branch-return path (commitBranchReturn) and the sale path
-- reject overdrawing. Adding a `check (balance >= 0)` here would break legitimate
-- adjustment flows — do not add one.
-- ---------------------------------------------------------------------------
create table stock (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches (id) on delete cascade,
  product_id   uuid not null references products (id) on delete restrict,
  product_name text,                    -- cache; the snapshot lives in stock_history
  balance      numeric(14,3) not null default 0,
  updated_at   timestamptz not null default now(),
  constraint stock_branch_product_key unique (branch_id, product_id)
);

create index stock_branch_idx on stock (branch_id);

create trigger stock_touch before update on stock
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- stock_history — the append-only movement ledger.
--
-- ref_id is the ID of whatever caused the movement (an order id, a return id, a
-- production batch id). Together with product_id and type it forms the
-- idempotency key described above.
--
-- balance_after is the materialised running balance at the time of the movement.
-- It is what the stock report reads, so it must be written inside the same
-- transaction as the stock.balance update or the ledger and the balance diverge.
-- ---------------------------------------------------------------------------
create table stock_history (
  id            uuid primary key default gen_random_uuid(),
  legacy_id     text unique,
  branch_id     uuid not null references branches (id) on delete cascade,
  product_id    uuid not null references products (id) on delete restrict,
  product_name  text not null,          -- snapshot, not a cache
  type          stock_movement_type not null,
  delta         numeric(14,3) not null,
  balance_after numeric(14,3) not null,
  ref_id        text not null,
  business_date date not null,
  created_at    timestamptz not null default now(),
  constraint stock_history_idempotency_key unique (ref_id, product_id, type)
);

-- computeStockRows previously fetched a branch's ENTIRE history and filtered by
-- date in memory. This index turns that into a real indexed predicate — the
-- single biggest read win in the migration.
create index stock_history_branch_date_idx on stock_history (branch_id, business_date, product_id);
create index stock_history_ref_idx         on stock_history (ref_id);

-- ---------------------------------------------------------------------------
-- stock_audit_log — records sale attempts blocked by insufficient stock.
-- Best-effort and non-blocking: written outside the failed sale transaction
-- (the sale rolls back, this must not). Keep it in its own transaction.
-- ---------------------------------------------------------------------------
create table stock_audit_log (
  id             uuid primary key default gen_random_uuid(),
  legacy_id      text unique,
  branch_id      uuid not null references branches (id) on delete cascade,
  branch_name    text,
  user_id        uuid references users (id) on delete set null,
  user_name      text,
  product_id     uuid references products (id) on delete set null,
  product_name   text not null,
  requested_qty  numeric(14,3) not null,
  available_qty  numeric(14,3) not null,
  reason         text,
  business_date  date not null,
  created_at     timestamptz not null default now()
);

create index stock_audit_log_branch_idx on stock_audit_log (branch_id, created_at desc);
