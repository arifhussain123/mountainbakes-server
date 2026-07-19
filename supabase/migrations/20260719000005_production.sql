-- 05: the production module — branch demands, approval balances, returns, and
-- the central (branch-agnostic) stock pool.

-- ---------------------------------------------------------------------------
-- production_orders — a branch's demand submission, reviewed by Production.
--
-- The review is an atomic check-and-set: it must reject if status is already
-- something other than 'pending', which is what prevents a double approval from
-- applying the balance maths twice. In Postgres:
--   update production_orders set status = ... where id = ? and status = 'pending'
-- and treat a zero row count as the 409 the old transaction raised.
-- ---------------------------------------------------------------------------
create table production_orders (
  id                uuid primary key default gen_random_uuid(),
  legacy_id         text unique,
  branch_id         uuid not null references branches (id) on delete restrict,
  branch_name       text,
  business_date     date not null,
  submitted_time    text,                -- free-form clock time as captured by the branch
  status            branch_production_order_status not null default 'pending',
  created_by        uuid references users (id) on delete set null,
  created_by_name   text,
  submitted_at      timestamptz not null default now(),
  approved_by       uuid references users (id) on delete set null,
  approved_by_name  text,
  approved_at       timestamptz,
  -- Set when Production altered the requested quantities during review.
  was_changed       boolean not null default false,
  change_reason     text,
  printed           boolean not null default false,
  printed_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index production_orders_branch_date_idx on production_orders (branch_id, business_date desc);
create index production_orders_date_idx        on production_orders (business_date desc);
create index production_orders_status_idx      on production_orders (status, business_date desc);

create trigger production_orders_touch before update on production_orders
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- production_order_items — was the embedded items[] array.
--
-- IMPORTANT: this array had TWO SHAPES in Firestore. On submission each item was
-- {productId, productName, qty, remarks}. On approval the whole array was
-- REWRITTEN to {productId, productName, qty, previousBalanceQty,
-- totalRequiredQty, approvedQty, remainingBalanceQty}. Rather than model two
-- tables, the review-only columns are nullable and populated at approval time.
-- A row with approved_qty IS NULL has not been reviewed.
-- ---------------------------------------------------------------------------
create table production_order_items (
  id                    uuid primary key default gen_random_uuid(),
  production_order_id   uuid not null references production_orders (id) on delete cascade,
  product_id            uuid references products (id) on delete set null,
  product_name          text not null,
  qty                   numeric(14,3) not null,   -- as requested by the branch
  remarks               text,
  -- Populated only on approval:
  previous_balance_qty  numeric(14,3),
  total_required_qty    numeric(14,3),
  approved_qty          numeric(14,3),
  remaining_balance_qty numeric(14,3),
  line_no               integer not null
);

create index production_order_items_order_idx on production_order_items (production_order_id, line_no);

-- ---------------------------------------------------------------------------
-- production_balances — outstanding unmet demand per (branch, product).
-- Was Firestore doc id `{branchId}_{productId}`.
--
-- CRITICAL SEMANTIC: this value is SET (overwritten), never incremented. The
-- review computes total_required = previous_balance + new_demand and then stores
-- remaining = max(0, total_required - approved). Porting this as
-- `balance = balance + delta` DOUBLE-COUNTS the prior balance, because it is
-- already folded into total_required. Use an upsert that assigns, not adds.
--
-- Rejecting a demand deliberately leaves balances untouched so the outstanding
-- demand carries forward to the next submission.
-- ---------------------------------------------------------------------------
create table production_balances (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches (id) on delete cascade,
  branch_name  text,
  product_id   uuid not null references products (id) on delete restrict,
  product_name text,
  pending_qty  numeric(14,3) not null default 0,
  updated_at   timestamptz not null default now(),
  constraint production_balances_branch_product_key unique (branch_id, product_id),
  constraint production_balances_non_negative check (pending_qty >= 0)
);

create index production_balances_branch_idx on production_balances (branch_id);
-- The daily closing scans all non-zero balances; keep that off the full table.
create index production_balances_outstanding_idx on production_balances (product_id)
  where pending_qty > 0;

create trigger production_balances_touch before update on production_balances
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- production_returns — stock sent back from a branch into the central pool.
--
-- Two entry paths: Production records one directly (status 'pending', awaiting
-- review), or a branch initiates one via the stock page (inserted already
-- 'accepted', with source = 'branch'). The review is another atomic
-- check-and-set guarded on status = 'pending'.
--
-- NOTE a pre-existing weakness carried over from Firestore: the review commits
-- in one transaction and the resulting stock movements happen in a SEPARATE one
-- afterwards. Retry safety depends entirely on the stock_history idempotency
-- key. The port MAY legitimately fold both into a single transaction, which
-- would be a strict improvement — but do it deliberately, not by accident.
-- ---------------------------------------------------------------------------
create table production_returns (
  id                uuid primary key default gen_random_uuid(),
  legacy_id         text unique,
  branch_id         uuid not null references branches (id) on delete restrict,
  branch_name       text,
  product_id        uuid not null references products (id) on delete restrict,
  product_name      text not null,
  qty               numeric(14,3) not null,
  reason            text,
  status            production_return_status not null default 'pending',
  -- 'branch' marks the branch-initiated path; NULL means Production-recorded.
  source            text,
  business_date     date not null,
  created_by        uuid references users (id) on delete set null,
  created_by_name   text,
  created_at        timestamptz not null default now(),
  reviewed_by       uuid references users (id) on delete set null,
  reviewed_by_name  text,
  reviewed_at       timestamptz,
  constraint production_returns_qty_positive check (qty > 0)
);

create index production_returns_date_idx   on production_returns (business_date desc);
create index production_returns_branch_idx on production_returns (branch_id, business_date desc);
create index production_returns_status_idx on production_returns (status) where status = 'pending';

-- ---------------------------------------------------------------------------
-- production_stock — the central pool. Branch-agnostic: one row per product,
-- so product_id is the natural primary key (Firestore used it as the doc id).
-- Negative balances are permitted, as before.
-- ---------------------------------------------------------------------------
create table production_stock (
  product_id   uuid primary key references products (id) on delete restrict,
  product_name text,
  balance      numeric(14,3) not null default 0,
  updated_at   timestamptz not null default now()
);

create trigger production_stock_touch before update on production_stock
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- production_stock_history — ledger for the central pool.
-- Same idempotency contract as stock_history: the unique constraint IS the
-- retry-safety mechanism. See the header of migration 04.
-- ---------------------------------------------------------------------------
create table production_stock_history (
  id            uuid primary key default gen_random_uuid(),
  legacy_id     text unique,
  product_id    uuid not null references products (id) on delete restrict,
  product_name  text not null,
  type          production_stock_movement_type not null,
  delta         numeric(14,3) not null,
  balance_after numeric(14,3) not null,
  ref_id        text not null,
  business_date date not null,
  created_at    timestamptz not null default now(),
  constraint production_stock_history_idempotency_key unique (ref_id, product_id, type)
);

create index production_stock_history_date_idx on production_stock_history (business_date, product_id);
create index production_stock_history_ref_idx  on production_stock_history (ref_id);
