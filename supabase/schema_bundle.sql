-- Mountain Bakes — full schema bundle
-- Generated from supabase/migrations/*.sql in filename order.
-- Paste into the Supabase Studio SQL editor and Run.
-- Wrapped in a transaction: if any statement fails, NOTHING is applied,
-- so a partial schema can never be left behind. Safe to re-run after a fix.

begin;

-- ==========================================================================
-- 20260719000001_enums_and_helpers.sql
-- ==========================================================================
-- Mountain Bakes — Postgres schema
-- 01: enum types, shared helper functions, common column conventions.
--
-- Conventions used throughout this schema:
--   * snake_case columns (the app layer maps to/from its camelCase TS types).
--   * All instants are `timestamptz`. The legacy system stored these inconsistently —
--     seed.ts wrote native timestamp objects while every route wrote ISO-8601
--     strings into the same field. The ETL normalises both into timestamptz.
--   * Business dates ('YYYY-MM-DD', Asia/Karachi, 2 AM rollover) are `date`.
--     Do NOT use now()::date for these — the business day boundary is 02:00
--     Karachi, so the app must keep computing them via shared/utils/timezone.ts
--     and pass them in explicitly.
--   * Money is `numeric(14,2)`, never float. The legacy system stored these as JS
--     numbers; customers.total_spent in particular was accumulating float drift.
--   * Quantities are `numeric(14,3)` and are allowed to go negative where the
--     old code allowed it (see comments on the individual stock tables).
--   * Every table carries `legacy_id text unique` — the original external
--     record ID. This is what lets the ETL rebuild relationships across
--     collections. It is intentionally kept after cutover so historical
--     references and support queries still resolve; drop it only once the
--     legacy system is decommissioned.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums. Values mirror the string unions in src/shared/types/*.ts exactly.
-- Keep both in sync — the Zod schemas validate against the TS unions, and a
-- drift here surfaces as a runtime 22P02 (invalid_text_representation).
-- ---------------------------------------------------------------------------

create type user_role         as enum ('super_admin', 'branch_manager', 'production_user');
create type user_status       as enum ('active', 'inactive', 'suspended');

create type order_status      as enum ('pending', 'preparing', 'ready', 'delivered', 'cancelled');
create type payment_method    as enum ('cash', 'easypaisa', 'foodpanda', 'bank_account');

-- Shop expenses accept a narrower set than orders do.
create type expense_payment_method            as enum ('cash', 'easypaisa');
create type production_expense_payment_method as enum ('cash', 'easypaisa', 'bank_account');

create type branch_production_order_status as enum ('pending', 'approved', 'rejected');
create type production_return_status       as enum ('pending', 'accepted', 'rejected');

create type stock_movement_type            as enum ('sale', 'production', 'return', 'adjustment');
create type production_stock_movement_type as enum ('prepare', 'transfer_out', 'return_in');

create type price_change_status as enum ('scheduled', 'active', 'superseded');
create type price_change_source as enum ('manual', 'import');

create type closure_status  as enum ('running', 'success', 'failed');
create type closure_trigger as enum ('scheduler', 'manual');

create type notification_type as enum (
  'order_created', 'order_ready', 'order_cancelled', 'low_stock',
  'new_user', 'branch_added', 'price_changed',
  'production_demand', 'production_reviewed', 'production_return'
);

create type chat_type       as enum ('dm', 'group');
create type group_chat_type as enum ('admin_only', 'production_team', 'all_branch_managers', 'custom');
create type message_type    as enum ('text', 'image', 'file', 'system');
create type presence_status as enum ('online', 'offline', 'away');

create type app_theme as enum ('light', 'dark');

-- ---------------------------------------------------------------------------
-- JWT claim accessors, used by the RLS policies in migration 09.
--
-- Role and branch live in the Supabase user's app_metadata (server-controlled,
-- embedded in the access token) — mirroring the old system's custom claims.
-- These are STABLE, not IMMUTABLE: they read per-statement request state.
-- ---------------------------------------------------------------------------

create schema if not exists app;

create or replace function app.jwt_role() returns user_role
  language sql stable
  as $$
    select nullif(
      current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role',
      ''
    )::user_role
  $$;

create or replace function app.jwt_branch_id() returns uuid
  language sql stable
  as $$
    select nullif(
      current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'branchId',
      ''
    )::uuid
  $$;

create or replace function app.is_super_admin() returns boolean
  language sql stable
  as $$ select app.jwt_role() = 'super_admin' $$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance. The legacy system had the app write updated_at by hand on
-- every mutation, which was easy to forget; a trigger makes it unconditional.
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at() returns trigger
  language plpgsql
  as $$
  begin
    new.updated_at := now();
    return new;
  end;
  $$;


-- ==========================================================================
-- 20260719000002_core.sql
-- ==========================================================================
-- 02: core reference entities — branches, categories, products, customers, users.
--
-- On denormalised *_name columns (branch_name, product_name, category_name):
-- The legacy system copied these onto nearly every row. They are PRESERVED here rather
-- than normalised away, because in several places they are genuine point-in-time
-- snapshots (an order must keep the product name as sold, even if the product is
-- later renamed). Where a column is a cache rather than a snapshot it is called
-- out in a comment. Do not "clean these up" without checking which kind it is.

-- ---------------------------------------------------------------------------
-- branches
-- ---------------------------------------------------------------------------
create table branches (
  id             uuid primary key default gen_random_uuid(),
  legacy_id      text unique,
  name           text not null,
  slug           text not null unique,
  location       text,
  phone          text,
  address        text,
  city           text,
  manager_id     uuid,          -- FK added in 02b below (circular with users)
  manager_name   text,          -- cache of users.display_name
  is_active      boolean not null default true,
  daily_budget   numeric(14,2),
  weekly_budget  numeric(14,2),
  monthly_budget numeric(14,2),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Delete is a soft-delete (is_active = false) in the app; this partial index
-- backs the very common `where is_active` listing.
create index branches_active_idx on branches (name) where is_active;

create trigger branches_touch before update on branches
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- users
--
-- PK is the Supabase Auth user id — the same deterministic external ID strategy
-- the legacy system used (record id = auth uid). The FK to auth.users with ON DELETE
-- CASCADE means deleting the auth user reaps the profile row, which the old
-- code had to do by hand in two steps.
--
-- role/branch_id are ALSO mirrored into app_metadata (and therefore the JWT).
-- This table is the source of truth; app_metadata is the read-optimised copy
-- that RLS and the API read. Any write to role/branch_id here must be paired
-- with a supabaseAdmin.auth.admin.updateUserById() call, or they drift.
-- ---------------------------------------------------------------------------
create table users (
  id                       uuid primary key references auth.users (id) on delete cascade,
  email                    text not null unique,
  display_name             text,
  phone                    text,
  username                 text unique,
  role                     user_role not null,
  branch_id                uuid references branches (id) on delete set null,
  branch_name              text,        -- cache of branches.name
  status                   user_status not null default 'active',
  last_login_at            timestamptz,
  must_change_password     boolean not null default false,
  last_password_reset      timestamptz,
  password_reset_by        uuid references users (id) on delete set null,
  password_reset_by_name   text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Backs the users listing: optional status + optional role filter, newest first.
create index users_created_idx     on users (created_at desc);
create index users_role_status_idx on users (role, status, created_at desc);
create index users_branch_idx      on users (branch_id) where branch_id is not null;

create trigger users_touch before update on users
  for each row execute function app.touch_updated_at();

alter table branches
  add constraint branches_manager_fk
  foreign key (manager_id) references users (id) on delete set null;

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
create table categories (
  id         uuid primary key default gen_random_uuid(),
  legacy_id  text unique,
  name       text not null,
  slug       text not null unique,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index categories_active_idx on categories (sort_order, name) where is_active;

create trigger categories_touch before update on categories
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- products
--
-- `price` is the CURRENT active price. It is mutated only by price.service.ts,
-- either directly on an immediate change or by the activation job — always
-- inside the same transaction that appends the product_price_history row.
-- Nothing else may write it; see migration 06.
-- ---------------------------------------------------------------------------
create table products (
  id            uuid primary key default gen_random_uuid(),
  legacy_id     text unique,
  name          text not null,
  category_id   uuid references categories (id) on delete restrict,
  category_name text,                 -- cache of categories.name
  sku           text,
  price         numeric(14,2) not null default 0,
  cost_price    numeric(14,2),
  description   text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- SKU is the natural key used by the price-import path (price.service.ts). It
-- was NOT unique in the legacy system, so the ETL may surface duplicates. This unique
-- index is deliberately partial (ignores NULLs and inactive rows) so the import
-- lookup is unambiguous without breaking legacy rows that never had a SKU.
create unique index products_sku_key on products (sku) where sku is not null and is_active;

create index products_category_active_idx on products (category_id) where is_active;
create index products_active_name_idx     on products (name) where is_active;

create trigger products_touch before update on products
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- customers
--
-- total_orders / total_spent are running aggregates. The legacy system updated them
-- with FieldValue.increment AFTER the order write and outside its transaction,
-- so an order could exist without its customer stats moving. The port should
-- fold this into the sale transaction (see migration 03) — numeric(14,2) also
-- removes the float accumulation drift the old float column had.
-- ---------------------------------------------------------------------------
create table customers (
  id           uuid primary key default gen_random_uuid(),
  legacy_id    text unique,
  name         text not null,
  phone        text,
  email        text,
  address      text,
  branch_id    uuid references branches (id) on delete set null,
  branch_name  text,                  -- cache of branches.name
  total_orders integer not null default 0,
  total_spent  numeric(14,2) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index customers_branch_idx on customers (branch_id, name);
create index customers_phone_idx  on customers (phone) where phone is not null;

create trigger customers_touch before update on customers
  for each row execute function app.touch_updated_at();


-- ==========================================================================
-- 20260719000003_orders_expenses.sql
-- ==========================================================================
-- 03: orders, order line items, the order-number counter, and expenses.

-- ---------------------------------------------------------------------------
-- Order numbers.
--
-- The legacy system used a `counters/orders` record incremented inside the sale
-- transaction, producing gapless MB-000125 numbers seeded at 124.
--
-- A Postgres SEQUENCE is deliberately NOT used: sequences are non-transactional
-- and leave gaps on rollback. The business treats order numbers as gapless, so
-- this keeps the counter-row semantics. The row lock serialises order creation,
-- which is acceptable here (one dyno, modest order rate) and is exactly what
-- the legacy system was already doing.
-- ---------------------------------------------------------------------------
create table counters (
  id    text primary key,
  count bigint not null
);

insert into counters (id, count) values ('orders', 124);

create or replace function next_order_number() returns text
  language plpgsql
  as $$
  declare
    next_count bigint;
  begin
    update counters set count = count + 1
      where id = 'orders'
      returning count into next_count;

    if not found then
      raise exception 'counters row "orders" is missing';
    end if;

    return 'MB-' || lpad(next_count::text, 6, '0');
  end;
  $$;

-- ---------------------------------------------------------------------------
-- orders
--
-- created_at is the business-relevant instant AND the reporting axis. The legacy system
-- filtered on it with inclusive bounds (>= from AND <= to) derived from
-- businessDayBounds(). Keep the bounds INCLUSIVE when porting: switching to a
-- half-open `< to` silently drops the final millisecond of a business day.
--
-- business_date is denormalised from created_at at insert time so day-scoped
-- reporting is a plain indexed equality instead of a range over a computed
-- Karachi offset. The app must populate it via businessDateStr() — it cannot be
-- a generated column, because the 02:00 rollover is app policy, not a timezone.
-- ---------------------------------------------------------------------------
create table orders (
  id                uuid primary key default gen_random_uuid(),
  legacy_id         text unique,
  order_number      text not null unique,
  branch_id         uuid not null references branches (id) on delete restrict,
  branch_name       text,
  customer_id       uuid references customers (id) on delete set null,
  customer_name     text,
  customer_phone    text,
  customer_address  text,
  subtotal          numeric(14,2) not null,
  discount_total    numeric(14,2) not null default 0,
  delivery_charges  numeric(14,2) not null default 0,
  tax_rate          numeric(6,3)  not null default 0,
  tax_amount        numeric(14,2) not null default 0,
  grand_total       numeric(14,2) not null,
  payment_method    payment_method not null,
  status            order_status not null default 'pending',
  notes             text,
  -- Only present on the POS/cash path.
  received_cash     numeric(14,2),
  cash_returned     numeric(14,2),
  created_by        uuid references users (id) on delete set null,
  created_by_name   text,
  business_date     date not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Branch order queues: `where branch_id = ? and status in (...)` newest-first.
create index orders_branch_status_idx on orders (branch_id, status, created_at desc);
-- Reporting: date-range scans, optionally narrowed by branch.
create index orders_created_idx        on orders (created_at);
create index orders_branch_created_idx on orders (branch_id, created_at desc);
create index orders_business_date_idx  on orders (business_date, branch_id);
-- Production queue reads pending/preparing/ready oldest-first across branches.
create index orders_status_created_idx on orders (status, created_at) ;
create index orders_customer_idx       on orders (customer_id) where customer_id is not null;

create trigger orders_touch before update on orders
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- order_items — was the embedded orders.items[] array in the legacy system.
--
-- Every column here is a POINT-IN-TIME SNAPSHOT of the product as sold. It must
-- never be resolved through to products at read time, or historical receipts
-- and reports change retroactively when a product is renamed or repriced.
-- product_id is therefore ON DELETE SET NULL, not CASCADE — deleting a product
-- must not erase sales history.
-- ---------------------------------------------------------------------------
create table order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders (id) on delete cascade,
  product_id    uuid references products (id) on delete set null,
  product_name  text not null,
  category_id   uuid references categories (id) on delete set null,
  category_name text,
  unit_price    numeric(14,2) not null,
  qty           numeric(14,3) not null,
  discount      numeric(14,2) not null default 0,
  line_total    numeric(14,2) not null,
  line_no       integer not null,
  constraint order_items_qty_positive check (qty > 0)
);

create index order_items_order_idx   on order_items (order_id, line_no);
create index order_items_product_idx on order_items (product_id) where product_id is not null;

-- ---------------------------------------------------------------------------
-- expenses (shop-level)
-- ---------------------------------------------------------------------------
create table expenses (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  branch_id       uuid not null references branches (id) on delete restrict,
  branch_name     text,
  business_date   date not null,       -- was the 'date' string field
  description     text not null,
  payment_method  expense_payment_method not null,
  amount          numeric(14,2) not null,
  remarks         text,
  created_by      uuid references users (id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now()
);

create index expenses_branch_date_idx on expenses (branch_id, business_date desc);
create index expenses_created_idx     on expenses (created_at);
create index expenses_date_idx        on expenses (business_date);

-- ---------------------------------------------------------------------------
-- production_expenses (central kitchen, not branch-scoped)
-- ---------------------------------------------------------------------------
create table production_expenses (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  category        text not null,
  description     text,
  amount          numeric(14,2) not null,
  payment_method  production_expense_payment_method not null,
  supplier        text,
  notes           text,
  business_date   date not null,
  created_by      uuid references users (id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now()
);

create index production_expenses_date_idx    on production_expenses (business_date desc);
create index production_expenses_created_idx on production_expenses (created_at);


-- ==========================================================================
-- 20260719000004_stock.sql
-- ==========================================================================
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


-- ==========================================================================
-- 20260719000005_production.sql
-- ==========================================================================
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
-- IMPORTANT: this array had TWO SHAPES in the legacy system. On submission each item was
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
-- Keyed by (branch_id, product_id).
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
-- NOTE a pre-existing weakness carried over from the legacy system: the review commits
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
-- so product_id is the natural primary key (the legacy system used it as the record id).
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


-- ==========================================================================
-- 20260719000006_pricing.sql
-- ==========================================================================
-- 06: price change history and the activation job's lock table.

-- ---------------------------------------------------------------------------
-- product_price_history — an append-only, versioned audit trail of price changes.
--
-- Invariants carried over from price.service.ts, now constraint-enforced:
--
--   1. version_number is gapless and unique PER PRODUCT. The legacy system derived it
--      with `where productId = ? order by versionNumber desc limit 1` inside a
--      transaction. In Postgres, take `select ... for update` on the products
--      row first — that row lock is what serialises concurrent price changes for
--      the same product. The unique constraint below is the backstop.
--
--   2. AT MOST ONE 'scheduled' row may survive per product. Applying a new change
--      supersedes any existing scheduled rows for that product in the same
--      transaction. Enforced by the partial unique index below, so a bug in the
--      supersede step fails loudly instead of silently queuing two futures.
--
--   3. old_price is back-filled from the product row read INSIDE the activation
--      transaction, not from whatever was captured when the change was scheduled.
--      This keeps the audit trail truthful when several changes stack up.
--
-- effective_date is a business date. The activation job selects
-- `status = 'scheduled' and effective_date <= today` — equality plus range,
-- which the composite index below serves directly.
-- ---------------------------------------------------------------------------
create table product_price_history (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  product_id      uuid not null references products (id) on delete cascade,
  product_code    text,                  -- SKU snapshot at change time
  product_name    text not null,         -- snapshot
  category_name   text,                  -- snapshot
  old_price       numeric(14,2),
  new_price       numeric(14,2) not null,
  effective_date  date not null,
  reason          text,
  source          price_change_source not null,
  status          price_change_status not null,
  version_number  integer not null,
  changed_by      uuid references users (id) on delete set null,
  changed_by_name text,
  changed_on      timestamptz not null default now(),
  activated_on    timestamptz,
  -- Groups rows created by a single spreadsheet import. Minted client-side; was
  -- an unwritten client-minted record id, now just gen_random_uuid() in app code.
  batch_id        uuid,
  constraint product_price_history_version_key unique (product_id, version_number),
  constraint product_price_history_version_positive check (version_number > 0)
);

-- Invariant 2: at most one scheduled change per product.
create unique index product_price_history_one_scheduled_key
  on product_price_history (product_id) where status = 'scheduled';

-- The activation job's driving query.
create index product_price_history_activation_idx
  on product_price_history (effective_date) where status = 'scheduled';

-- The history panel: newest-first, optionally filtered to one product.
create index product_price_history_changed_idx on product_price_history (changed_on desc);
create index product_price_history_product_idx on product_price_history (product_id, version_number desc);
create index product_price_history_batch_idx   on product_price_history (batch_id) where batch_id is not null;

-- ---------------------------------------------------------------------------
-- Distributed job locks.
--
-- Both the price-activation job and the daily closing used the same legacy
-- pattern: a doc keyed by business date holding running/success/failed, where a
-- 'running' lock older than 10 minutes is DELIBERATELY STEALABLE so a crashed
-- dyno cannot wedge the job forever.
--
-- price_activation_locks keeps that shape verbatim. business_day_closures
-- (migration 07) doubles as both the lock and the archive, exactly as before.
--
-- The claim is an upsert:
--   insert into price_activation_locks (...) values (...)
--   on conflict (business_date) do update set ...
--   where price_activation_locks.status <> 'success'
--     and (price_activation_locks.status <> 'running'
--          or price_activation_locks.started_at < now() - interval '10 minutes')
-- A zero row count means someone else holds it — skip, do not error.
--
-- These locks assume a SINGLE dyno (web=1), same as the legacy version.
-- Scaling out needs a real advisory lock, not just this row.
-- ---------------------------------------------------------------------------
create table price_activation_locks (
  business_date date primary key,
  status        closure_status not null,
  trigger       closure_trigger not null,
  started_at    timestamptz not null default now(),
  activated     integer,               -- count of products repriced
  closed_at     timestamptz,
  error         text
);

create index price_activation_locks_stale_idx on price_activation_locks (started_at)
  where status = 'running';


-- ==========================================================================
-- 20260719000007_system.sql
-- ==========================================================================
-- 07: settings, audit log, notifications, web-push subscriptions, and the
-- business-day closure archive.

-- ---------------------------------------------------------------------------
-- settings — a singleton. The legacy system used a fixed record id 'app'; the check
-- constraint below enforces that there can only ever be one row.
-- ---------------------------------------------------------------------------
create table settings (
  id                   boolean primary key default true,
  company_name         text,
  logo_url             text,
  logo_path            text,
  currency             text not null default 'PKR',
  currency_symbol      text not null default 'Rs',
  gst_rate             numeric(6,3) not null default 0,
  gst_enabled          boolean not null default false,
  receipt_footer       text,
  theme                app_theme not null default 'light',
  -- Clock times as 'HH:MM' strings. NOT timestamps: the order window is allowed
  -- to wrap past midnight, and these are compared by isWithinOrderWindow(), not
  -- by Postgres. Keep them text so the wrap logic stays in one place.
  business_start_time  text,
  business_closing_time text,
  order_start_time     text,
  order_end_time       text,
  auto_close_business  boolean not null default true,
  auto_stock_closing   boolean not null default true,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references users (id) on delete set null,
  constraint settings_singleton check (id)
);

create trigger settings_touch before update on settings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs — admin actions against users. Append-only.
-- ---------------------------------------------------------------------------
create table audit_logs (
  id                uuid primary key default gen_random_uuid(),
  legacy_id         text unique,
  action            text not null,
  admin_id          uuid references users (id) on delete set null,
  admin_name        text,
  target_user_id    uuid references users (id) on delete set null,
  target_user_name  text,
  target_user_role  user_role,
  details           jsonb,
  created_at        timestamptz not null default now()
);

create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_target_idx  on audit_logs (target_user_id) where target_user_id is not null;

-- ---------------------------------------------------------------------------
-- notifications — the durable in-app feed.
--
-- Targeting is either a specific user OR a role (optionally narrowed to a
-- branch). Exactly one of target_user_id / target_role must be set; the check
-- makes the old convention explicit.
--
-- This is the table the client subscribes to via Supabase Realtime, replacing
-- the legacy realtime listener. Realtime respects RLS, so the policies in
-- migration 09 are what scope each user's feed.
-- ---------------------------------------------------------------------------
create table notifications (
  id             uuid primary key default gen_random_uuid(),
  legacy_id      text unique,
  type           notification_type not null,
  title          text not null,
  message        text not null,
  is_read        boolean not null default false,
  target_user_id uuid references users (id) on delete cascade,
  target_role    user_role,
  branch_id      uuid references branches (id) on delete cascade,
  related_id     uuid,
  created_at     timestamptz not null default now(),
  constraint notifications_target_present
    check (target_user_id is not null or target_role is not null)
);

create index notifications_user_idx   on notifications (target_user_id, created_at desc)
  where target_user_id is not null;
create index notifications_role_idx   on notifications (target_role, branch_id, created_at desc)
  where target_role is not null;
create index notifications_unread_idx on notifications (target_user_id) where not is_read;

-- ---------------------------------------------------------------------------
-- push_subscriptions — REPLACES the legacy device-token collection.
--
-- The legacy push provider has no Supabase equivalent, so push moves to the Web
-- Push protocol (VAPID). The shape changes accordingly: the old provider identified a device
-- by a single opaque token string, whereas Web Push needs the full subscription
-- triple — endpoint URL plus the p256dh and auth keys used to encrypt the
-- payload. Existing device tokens CANNOT be converted; every client must re-subscribe
-- after the switch, so expect this table to start empty regardless of ETL.
--
-- endpoint is the natural unique key (one row per browser install).
--
-- Two behaviours from push.service.ts must be preserved in the port:
--   * Payloads stay DATA-ONLY. The service worker renders the notification
--     itself; including a display payload produces duplicate notifications.
--   * Dead subscriptions self-heal. The old provider pruned tokens on specific error codes;
--     Web Push signals the same with HTTP 404/410 from the push service, at
--     which point the row must be deleted.
-- ---------------------------------------------------------------------------
create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  role        user_role not null,      -- denormalised for role-fan-out queries
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

create index push_subscriptions_user_idx on push_subscriptions (user_id);
create index push_subscriptions_role_idx on push_subscriptions (role);

-- ---------------------------------------------------------------------------
-- business_day_closures — one row per closed business day. Doubles as the
-- distributed lock for the 02:00 closing job (see the lock notes in migration 06).
--
-- The four summary aggregates stay JSONB rather than being normalised into child
-- tables. This is deliberate: they are immutable archival snapshots, never
-- queried by their internal fields, and their shape (SalesSummary,
-- ExpenseSummary, ProductionSummary, StockSnapshotBranch[]) is already defined
-- and validated in src/shared/types/business-day.types.ts. Normalising them
-- would duplicate that contract in SQL for no read benefit.
-- ---------------------------------------------------------------------------
create table business_day_closures (
  business_date               date primary key,
  status                      closure_status not null,
  trigger                     closure_trigger not null,
  closed_by                   text,        -- 'System Scheduler' or an admin email
  auto_stock_closing          boolean not null default false,
  sales_summary               jsonb,
  expense_summary             jsonb,
  production_expense_summary  jsonb,
  production_summary          jsonb,
  stock_snapshot              jsonb,
  error                       text,
  started_at                  timestamptz not null default now(),
  closed_at                   timestamptz,
  duration_ms                 integer
);

-- The closure list previously loaded every document and filtered in memory.
create index business_day_closures_date_idx on business_day_closures (business_date desc);
create index business_day_closures_stale_idx on business_day_closures (started_at)
  where status = 'running';


-- ==========================================================================
-- 20260719000008_chat.sql
-- ==========================================================================
-- 08: chat and presence.
--
-- These collections (`chats`, `userPresence`) are NOT used by the Express API —
-- they were read and written directly from the browser via the legacy client
-- SDK, and are currently broken because that path needs a legacy auth session
-- the app no longer creates.
--
-- They are included here because the frontend must migrate onto Supabase
-- Realtime, and that needs tables plus RLS. Unlike every other table in this
-- schema, these are written by the CLIENT under RLS rather than by the API under
-- the secret key — so their policies in migration 09 are load-bearing security,
-- not defence in depth.

-- ---------------------------------------------------------------------------
-- chats — a DM or a group conversation.
-- ---------------------------------------------------------------------------
create table chats (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  type            chat_type not null,
  -- Only meaningful for type = 'group'.
  group_type      group_chat_type,
  name            text,
  branch_id       uuid references branches (id) on delete set null,
  created_by      uuid references users (id) on delete set null,
  last_message_at timestamptz,
  last_message    text,                  -- preview cache for the chat list
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chats_group_has_type check (type <> 'group' or group_type is not null)
);

create index chats_recent_idx on chats (last_message_at desc nulls last);

create trigger chats_touch before update on chats
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- chat_participants — membership. This table is what every chat RLS policy
-- pivots on, so keep the (chat_id, user_id) unique constraint.
-- ---------------------------------------------------------------------------
create table chat_participants (
  id           uuid primary key default gen_random_uuid(),
  chat_id      uuid not null references chats (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz,
  constraint chat_participants_key unique (chat_id, user_id)
);

create index chat_participants_user_idx on chat_participants (user_id);

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------
create table chat_messages (
  id           uuid primary key default gen_random_uuid(),
  legacy_id    text unique,
  chat_id      uuid not null references chats (id) on delete cascade,
  sender_id    uuid references users (id) on delete set null,
  sender_name  text,                    -- snapshot; survives user deletion
  type         message_type not null default 'text',
  body         text,
  -- Populated for type in ('image', 'file'); points at Supabase Storage.
  attachment_path text,
  attachment_name text,
  attachment_size integer,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  constraint chat_messages_text_has_body
    check (type <> 'text' or body is not null)
);

create index chat_messages_chat_idx on chat_messages (chat_id, created_at desc);

-- ---------------------------------------------------------------------------
-- user_presence — was the `userPresence` collection.
--
-- One row per user, heartbeat-updated. Consider driving the online/offline
-- indicator from Supabase Realtime Presence (which is ephemeral and needs no
-- table) instead of this table; it is modelled here so the existing behaviour
-- can be ported literally first, then simplified.
-- ---------------------------------------------------------------------------
create table user_presence (
  user_id   uuid primary key references users (id) on delete cascade,
  status    presence_status not null default 'offline',
  last_seen timestamptz not null default now()
);

create index user_presence_status_idx on user_presence (status) where status <> 'offline';


-- ==========================================================================
-- 20260719000009_rls.sql
-- ==========================================================================
-- 09: Row Level Security.
--
-- READ THIS BEFORE EDITING ANY POLICY BELOW.
--
-- There are two classes of table in this schema, and they need opposite levels
-- of paranoia:
--
--   A. API-OWNED tables (everything except chat/presence/notifications). The
--      Express API reaches these with the SECRET key, which BYPASSES RLS
--      entirely. Authorization for these is enforced in application code — e.g.
--      branch managers scoped to their own branch_id, production users limited
--      to active order statuses — exactly as it was under the legacy admin
--      SDK, which likewise bypassed database rules. The policies here are
--      DEFENCE IN DEPTH: they matter only if a publishable-key client ever
--      reaches these tables directly. Do not delete the application-level checks
--      on the strength of these policies.
--
--   B. CLIENT-OWNED tables (chats, chat_participants, chat_messages,
--      user_presence, notifications). The browser talks to these directly with
--      the user's JWT, and Realtime subscriptions are filtered by exactly these
--      policies. Here RLS is the ONLY thing standing between one user and
--      another's messages. Treat changes to these as security changes.
--
-- Every table gets RLS enabled. A table with RLS on and no policy denies all
-- access to non-secret-key callers, which is the correct default — so tables
-- that the client should never touch simply get no policy at all.

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. Default-deny.
-- ---------------------------------------------------------------------------
alter table branches                enable row level security;
alter table users                   enable row level security;
alter table categories              enable row level security;
alter table products                enable row level security;
alter table customers               enable row level security;
alter table counters                enable row level security;
alter table orders                  enable row level security;
alter table order_items             enable row level security;
alter table expenses                enable row level security;
alter table production_expenses     enable row level security;
alter table production_orders       enable row level security;
alter table production_order_items  enable row level security;
alter table production_balances     enable row level security;
alter table production_returns      enable row level security;
alter table production_stock        enable row level security;
alter table production_stock_history enable row level security;
alter table stock                   enable row level security;
alter table stock_history           enable row level security;
alter table stock_audit_log         enable row level security;
alter table product_price_history   enable row level security;
alter table price_activation_locks  enable row level security;
alter table settings                enable row level security;
alter table audit_logs              enable row level security;
alter table notifications           enable row level security;
alter table push_subscriptions      enable row level security;
alter table business_day_closures   enable row level security;
alter table chats                   enable row level security;
alter table chat_participants       enable row level security;
alter table chat_messages           enable row level security;
alter table user_presence           enable row level security;

-- No policies are defined for: counters, price_activation_locks,
-- business_day_closures, audit_logs, stock_audit_log, production_balances,
-- production_stock_history, stock_history, product_price_history.
-- These are API/job-internal and must never be reachable with a user JWT.

-- ---------------------------------------------------------------------------
-- Chat membership lookup.
--
-- This MUST be SECURITY DEFINER. Every chat policy needs to ask "is the caller a
-- participant of this chat?", which means reading chat_participants — but
-- chat_participants itself has a SELECT policy, so a plain subquery there causes
-- Postgres to re-evaluate that policy while it is already evaluating it:
--   ERROR: infinite recursion detected in policy for relation "chat_participants"
--
-- SECURITY DEFINER runs the lookup as the function owner, which bypasses RLS on
-- the inner read and breaks the cycle. search_path is pinned so the definer
-- rights cannot be hijacked by a caller-controlled search_path.
--
-- Do not "simplify" this back into an inline EXISTS on chat_participants.
-- ---------------------------------------------------------------------------
create or replace function app.is_chat_participant(target_chat_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from chat_participants
      where chat_id = target_chat_id and user_id = auth.uid()
    )
  $$;

revoke execute on function app.is_chat_participant(uuid) from public;
grant execute on function app.is_chat_participant(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Class B — client-owned. These are the load-bearing ones.
-- ---------------------------------------------------------------------------

-- Notifications: a user sees notifications addressed to them personally, or
-- broadcast to their role. Role broadcasts that carry a branch_id are further
-- narrowed to that branch, which is how a branch manager avoids seeing another
-- branch's traffic.
create policy notifications_select_own on notifications
  for select to authenticated
  using (
    target_user_id = auth.uid()
    or (
      target_role = app.jwt_role()
      and (branch_id is null or branch_id = app.jwt_branch_id())
    )
  );

-- Marking as read is the only field a client may change. Postgres has no
-- column-level restriction in a policy, so the WITH CHECK re-asserts the same
-- visibility predicate; the API should still be the only writer of anything else.
create policy notifications_update_own on notifications
  for update to authenticated
  using (target_user_id = auth.uid())
  with check (target_user_id = auth.uid());

-- Chats: visible only to participants.
create policy chats_select_participant on chats
  for select to authenticated
  using (app.is_chat_participant(chats.id));

create policy chats_insert_own on chats
  for insert to authenticated
  with check (created_by = auth.uid());

-- A participant row is visible if it is yours, or if it belongs to a chat you
-- are in. The second arm goes through the SECURITY DEFINER helper above — an
-- inline EXISTS on this same table would recurse.
create policy chat_participants_select on chat_participants
  for select to authenticated
  using (
    user_id = auth.uid()
    or app.is_chat_participant(chat_participants.chat_id)
  );

-- Updating last_read_at is the caller's own bookkeeping.
create policy chat_participants_update_own on chat_participants
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Messages: readable by participants, writable only as yourself.
create policy chat_messages_select on chat_messages
  for select to authenticated
  using (app.is_chat_participant(chat_messages.chat_id));

create policy chat_messages_insert on chat_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and app.is_chat_participant(chat_messages.chat_id)
  );

create policy chat_messages_update_own on chat_messages
  for update to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

-- Presence: everyone signed in can see who is online; you may only write your own.
create policy user_presence_select_all on user_presence
  for select to authenticated using (true);

create policy user_presence_upsert_own on user_presence
  for insert to authenticated with check (user_id = auth.uid());

create policy user_presence_update_own on user_presence
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Push subscriptions: a client registers and revokes its own.
create policy push_subscriptions_select_own on push_subscriptions
  for select to authenticated using (user_id = auth.uid());

create policy push_subscriptions_insert_own on push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());

create policy push_subscriptions_delete_own on push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Class A — defence in depth. Read-only, scoped, and intentionally narrow.
-- The API does not rely on these; they exist so a stray publishable-key read
-- cannot exfiltrate the catalogue or another branch's numbers.
-- ---------------------------------------------------------------------------

-- Own profile, always. Super admins see everyone.
create policy users_select_self on users
  for select to authenticated
  using (id = auth.uid() or app.is_super_admin());

-- Reference data is readable by any signed-in user; it is not sensitive and the
-- whole app renders from it.
create policy branches_select on branches
  for select to authenticated using (true);

create policy categories_select on categories
  for select to authenticated using (is_active or app.is_super_admin());

create policy products_select on products
  for select to authenticated using (is_active or app.is_super_admin());

create policy settings_select on settings
  for select to authenticated using (true);

-- Branch-scoped reads. Super admins are unrestricted; a branch manager is
-- confined to their own branch; production users get nothing here (their access
-- runs through the API).
create policy customers_select_branch on customers
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy orders_select_branch on orders
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy order_items_select_branch on order_items
  for select to authenticated
  using (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and (app.is_super_admin() or o.branch_id = app.jwt_branch_id())
    )
  );

create policy stock_select_branch on stock
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy expenses_select_branch on expenses
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy production_orders_select_branch on production_orders
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy production_returns_select_branch on production_returns
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());


-- ==========================================================================
-- 20260719000010_storage.sql
-- ==========================================================================
-- 10: Supabase Storage buckets, replacing the legacy object storage.
--
-- The legacy object storage was used in exactly one place: the company logo upload in
-- settings.routes.ts. It saved the file with a randomUUID() download token and
-- hand-built a permanent URL of the form
--   https://<legacy-storage-host>/v0/b/<bucket>/o/<path>?alt=media&token=<uuid>
--
-- That URL never expires and is persisted in settings.logo_url for anonymous
-- public reads (it renders on the login page and on printed receipts, where
-- there is no session).
--
-- The correct Supabase equivalent is therefore a PUBLIC bucket, NOT a signed
-- URL. Signed URLs expire, which would silently break every stored logo_url and
-- every previously printed receipt after the TTL elapsed.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding',
  'branding',
  true,
  2097152,  -- 2 MB, matching the existing multer limit
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;

-- Chat attachments are private: readable only by participants of the chat the
-- attachment belongs to. Path convention: chat-attachments/{chat_id}/{filename}
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-attachments', 'chat-attachments', false, 10485760)  -- 10 MB
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Branding bucket policies.
--
-- Public read is granted to `anon` as well as `authenticated` — the logo must
-- render pre-login. Writes are super-admin only and, in practice, go through the
-- API with the secret key.
-- ---------------------------------------------------------------------------
create policy branding_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'branding');

create policy branding_admin_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'branding' and app.is_super_admin());

create policy branding_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'branding' and app.is_super_admin());

create policy branding_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'branding' and app.is_super_admin());

-- ---------------------------------------------------------------------------
-- Chat attachment policies. The first path segment is the chat id, so
-- membership is checked against chat_participants.
-- ---------------------------------------------------------------------------
-- Goes through app.is_chat_participant (SECURITY DEFINER, see migration 09) for
-- the same reason the table policies do. The path segment is cast defensively:
-- a non-UUID first segment would otherwise raise 22P02 instead of denying.
create policy chat_attachments_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-attachments'
    and app.is_chat_participant(
      nullif((storage.foldername(name))[1], '')::uuid
    )
  );

create policy chat_attachments_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and app.is_chat_participant(
      nullif((storage.foldername(name))[1], '')::uuid
    )
  );

-- NOTE: the old code never deleted the previous logo on re-upload, so files
-- accumulated in the legacy object storage indefinitely. The port should delete the file
-- at settings.logo_path before writing the replacement. Carry the bug over
-- knowingly or fix it — but don't leave it unnoticed.


-- ==========================================================================
-- 20260719000011_pricing_functions.sql
-- ==========================================================================
-- 11: pricing transaction functions.
--
-- Why these exist as database functions rather than app code:
--
-- price.service.ts ran its price changes inside legacy transactions
-- (read product + latest version, then write history + product atomically).
-- supabase-js talks to PostgREST over HTTP, where every call is its own
-- implicit transaction — there is no way to hold `select ... for update`
-- across two client calls. Attempting the same read-then-write from Node
-- would let two concurrent price changes for one product read the same
-- version_number and race.
--
-- So the transactional core lives here, called via supabaseAdmin.rpc(). The
-- app keeps everything non-transactional: business-date arithmetic (Karachi,
-- 2 AM rollover — see shared/utils/timezone.ts), spreadsheet parsing, and
-- notifications.
--
-- `p_today` is always supplied by the caller for exactly that reason: the
-- business date is not "now()::date", it is the Karachi date shifted back by
-- the 2 AM business-day start. Keeping that definition in one place (TS) beats
-- reimplementing it in SQL and letting the two drift.
--
-- SECURITY: these are SECURITY INVOKER (the default) — they do NOT bypass RLS.
-- They are called with the service_role key, which already bypasses RLS on its
-- own. Postgres grants EXECUTE to PUBLIC on every new function, which would
-- make them callable by anon/authenticated through the Data API, so each one is
-- explicitly revoked and re-granted to service_role at the bottom of this file.

-- ---------------------------------------------------------------------------
-- apply_price_change — record one price change (manual, or one import row).
--
-- Returns exactly one row. status is 'active' (applied now), 'scheduled'
-- (future-dated), or 'skipped' (immediate change to the price it already has).
--
-- Invariant 1 (gapless version_number per product) is held by the `for update`
-- row lock on products: concurrent changes to the SAME product serialise behind
-- it, so the max(version_number) read cannot be stale. The unique constraint
-- product_price_history_version_key is the backstop if that ever regresses.
--
-- Invariant 2 (at most one scheduled row per product) is held by superseding
-- any existing scheduled row in the same statement sequence, inside this
-- function's transaction. The partial unique index makes a bug here fail loudly.
-- ---------------------------------------------------------------------------
create or replace function public.apply_price_change(
  p_product_id      uuid,
  p_new_price       numeric,
  p_effective_date  date,
  p_reason          text,
  p_source          price_change_source,
  p_changed_by      uuid,
  p_changed_by_name text,
  p_batch_id        uuid,
  p_today           date
)
returns table (
  status         text,
  skip_reason    text,
  history_id     uuid,
  version_number integer,
  product_name   text,
  old_price      numeric,
  new_price      numeric
)
language plpgsql
as $$
declare
  v_product      products%rowtype;
  v_immediate    boolean;
  v_next_version integer;
  v_history_id   uuid;
  v_now          timestamptz := now();
begin
  select * into v_product from products where id = p_product_id for update;
  if not found then
    -- Mapped to a 404 by the caller. P0002 = no_data_found.
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  v_immediate := p_effective_date <= p_today;

  -- No-op: an immediate change to the price it already holds.
  if v_immediate and coalesce(v_product.price, 0) = p_new_price then
    return query select
      'skipped'::text, 'unchanged'::text, null::uuid, null::integer,
      v_product.name, v_product.price, p_new_price;
    return;
  end if;

  select coalesce(max(h.version_number), 0) + 1
    into v_next_version
    from product_price_history h
   where h.product_id = p_product_id;

  -- The table MUST be aliased here. This function is `returns table (status ...)`,
  -- which puts `status` in scope as a PL/pgSQL variable, so an unqualified
  -- `status` in the WHERE is ambiguous and Postgres refuses it outright
  -- ("column reference \"status\" is ambiguous"). Qualifying via the alias
  -- resolves it to the column. The SET target stays unqualified — Postgres does
  -- not accept a table-qualified name on the left of SET.
  update product_price_history h
     set status = 'superseded'
   where h.product_id = p_product_id
     and h.status = 'scheduled';

  insert into product_price_history (
    product_id, product_code, product_name, category_name,
    old_price, new_price, effective_date, reason, source, status,
    version_number, changed_by, changed_by_name, changed_on, activated_on, batch_id
  ) values (
    p_product_id, v_product.sku, v_product.name, v_product.category_name,
    v_product.price, p_new_price, p_effective_date, p_reason, p_source,
    (case when v_immediate then 'active' else 'scheduled' end)::price_change_status,
    v_next_version, p_changed_by, p_changed_by_name, v_now,
    (case when v_immediate then v_now else null end), p_batch_id
  )
  returning id into v_history_id;

  -- updated_at is maintained by the products_touch trigger — do not set it here.
  if v_immediate then
    update products set price = p_new_price where id = p_product_id;
  end if;

  return query select
    (case when v_immediate then 'active' else 'scheduled' end)::text,
    null::text, v_history_id, v_next_version,
    v_product.name, v_product.price, p_new_price;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_price_activation — take the per-business-date job lock.
--
-- Returns true if this caller now holds the lock, NULL (falsy) if someone else
-- does. A 'running' lock older than 10 minutes is deliberately stealable so a
-- crashed dyno cannot wedge the job forever — same rule as the legacy
-- version and as daily-closing.
--
-- The WHERE on the DO UPDATE branch is what makes this atomic: a losing caller
-- updates zero rows and gets no RETURNING row back.
-- ---------------------------------------------------------------------------
create or replace function public.claim_price_activation(
  p_date    date,
  p_trigger closure_trigger
)
returns boolean
language sql
as $$
  insert into price_activation_locks (business_date, status, trigger, started_at, activated, closed_at, error)
  values (p_date, 'running', p_trigger, now(), 0, null, null)
  on conflict (business_date) do update
     set status     = 'running',
         trigger    = p_trigger,
         started_at = now(),
         activated  = 0,
         closed_at  = null,
         error      = null
   where price_activation_locks.status <> 'success'
     and (price_activation_locks.status <> 'running'
          or price_activation_locks.started_at < now() - interval '10 minutes')
  returning true;
$$;

-- ---------------------------------------------------------------------------
-- activate_due_prices — flip every scheduled price whose date has arrived.
--
-- Returns the number of products repriced.
--
-- The legacy version had to reconcile several due 'scheduled' rows per
-- product (highest version wins, the rest superseded) because nothing stopped
-- more than one from existing. Here the partial unique index
-- product_price_history_one_scheduled_key makes that impossible — at most one
-- scheduled row per product can exist at a time — so the winner/loser pass is
-- gone. That is a real simplification, not an omission.
--
-- Invariant 3: old_price is taken from the product row read inside this
-- transaction, NOT from whatever was captured when the change was scheduled, so
-- the audit trail stays truthful when changes stack up.
-- ---------------------------------------------------------------------------
create or replace function public.activate_due_prices(p_today date)
returns integer
language plpgsql
as $$
declare
  v_activated integer := 0;
  v_cur_price numeric;
  r           record;
begin
  for r in
    select h.id, h.product_id, h.new_price
      from product_price_history h
     where h.status = 'scheduled'
       and h.effective_date <= p_today
     order by h.product_id
  loop
    -- Lock the product for the same reason apply_price_change does: a manual
    -- change landing mid-job must not interleave with this read-then-write.
    select price into v_cur_price from products where id = r.product_id for update;

    if found then
      update products set price = r.new_price where id = r.product_id;
      update product_price_history
         set status = 'active', activated_on = now(), old_price = v_cur_price
       where id = r.id;
      v_activated := v_activated + 1;
    else
      -- Defensive only: product_id is FK ON DELETE CASCADE, so a missing
      -- product would have taken this history row with it.
      update product_price_history set status = 'superseded' where id = r.id;
    end if;
  end loop;

  return v_activated;
end;
$$;

-- ---------------------------------------------------------------------------
-- close_price_activation — record the job's outcome on the lock row.
-- ---------------------------------------------------------------------------
create or replace function public.close_price_activation(
  p_date      date,
  p_status    closure_status,
  p_activated integer,
  p_error     text
)
returns void
language sql
as $$
  update price_activation_locks
     set status    = p_status,
         activated = p_activated,
         closed_at = now(),
         error     = p_error
   where business_date = p_date;
$$;

-- ---------------------------------------------------------------------------
-- Lock these down. Postgres grants EXECUTE to PUBLIC by default, and anon /
-- authenticated inherit from PUBLIC — without this, every function above would
-- be a callable Data API endpoint. Only the API server (service_role) may run
-- them.
-- ---------------------------------------------------------------------------
revoke all on function public.apply_price_change(uuid, numeric, date, text, price_change_source, uuid, text, uuid, date) from public, anon, authenticated;
revoke all on function public.claim_price_activation(date, closure_trigger) from public, anon, authenticated;
revoke all on function public.activate_due_prices(date) from public, anon, authenticated;
revoke all on function public.close_price_activation(date, closure_status, integer, text) from public, anon, authenticated;

grant execute on function public.apply_price_change(uuid, numeric, date, text, price_change_source, uuid, text, uuid, date) to service_role;
grant execute on function public.claim_price_activation(date, closure_trigger) to service_role;
grant execute on function public.activate_due_prices(date) to service_role;
grant execute on function public.close_price_activation(date, closure_status, integer, text) to service_role;


-- ==========================================================================
-- 20260719000012_stock_functions.sql
-- ==========================================================================
-- 12: stock movement transaction functions.
--
-- These implement the two invariants migration 04 spells out. Read that file's
-- header first — it is the authority; this file is its execution.
--
--   1. IDEMPOTENCY. stock_history has a UNIQUE (ref_id, product_id, type). Every
--      movement inserts with `on conflict do nothing` and applies the balance
--      delta ONLY when the insert actually affected a row. A retry that reuses
--      the same ref_id is therefore a true no-op, exactly as the legacy
--      existence-check-inside-the-transaction was.
--
--   2. NO LOST UPDATES. The sale path takes `select ... for update` on the stock
--      rows BEFORE validating, ordered by product_id. The ordering is not
--      cosmetic: two overlapping multi-line orders that lock in different orders
--      deadlock. Every function here that touches more than one product locks in
--      product_id order.
--
-- Why these are database functions rather than app code: PostgREST gives each
-- supabase-js call its own transaction, so validate-then-write split across two
-- HTTP calls cannot hold a lock between them — precisely the multi-cashier race
-- the legacy transaction existed to close. Same reasoning as migration 11.
--
-- Balance writes use the RELATIVE form (`stock.balance - qty`) with RETURNING,
-- not a pre-computed absolute. The lock already serialises us, but the relative
-- form is also correct for a row that did not exist at validation time, and
-- RETURNING gives the true post-write balance to record as balance_after.
--
-- Negative balances remain legal (migration 04 is explicit: do NOT add a
-- check (balance >= 0)). Only the sale and branch-return paths reject
-- overdrawing; adjustments and corrections must be free to go negative.
--
-- SECURITY: SECURITY INVOKER (default), locked to service_role at the bottom.

-- ---------------------------------------------------------------------------
-- apply_stock_movement — one signed movement. The unvalidated path: used by
-- production intake and adjustments, which never reject.
--
-- Returns the post-movement balance, or the existing balance untouched if this
-- (ref_id, product_id, type) was already applied.
-- ---------------------------------------------------------------------------
create or replace function public.apply_stock_movement(
  p_branch_id     uuid,
  p_product_id    uuid,
  p_product_name  text,
  p_delta         numeric,
  p_type          stock_movement_type,
  p_ref_id        text,
  p_business_date date
)
returns numeric
language plpgsql
as $$
declare
  v_balance  numeric;
  v_inserted integer;
begin
  -- Reserve the idempotency key first. balance_after is backfilled below once
  -- the real post-write balance is known.
  insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
  values (p_branch_id, p_product_id, p_product_name, p_type, p_delta, 0, p_ref_id, p_business_date)
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already applied. Return the current balance without touching it.
    select balance into v_balance from stock
     where branch_id = p_branch_id and product_id = p_product_id;
    return coalesce(v_balance, 0);
  end if;

  insert into stock (branch_id, product_id, product_name, balance)
  values (p_branch_id, p_product_id, p_product_name, p_delta)
  on conflict (branch_id, product_id) do update
     set balance = stock.balance + p_delta,
         product_name = coalesce(excluded.product_name, stock.product_name)
  returning balance into v_balance;

  update stock_history
     set balance_after = v_balance
   where ref_id = p_ref_id and product_id = p_product_id and type = p_type;

  return v_balance;
end;
$$;

-- ---------------------------------------------------------------------------
-- commit_branch_return — validated decrement for a branch-initiated return.
--
-- Returns jsonb:
--   {"status":"ok","before":N,"after":N}
--   {"status":"insufficient","requested":N,"available":N}
--
-- The insufficient case returns NORMALLY rather than raising, so the caller
-- gets structured detail. Nothing has been written at that point, so committing
-- the (empty) transaction is a no-op — no rollback needed to stay safe.
-- ---------------------------------------------------------------------------
create or replace function public.commit_branch_return(
  p_branch_id     uuid,
  p_product_id    uuid,
  p_product_name  text,
  p_qty           numeric,
  p_ref_id        text,
  p_business_date date
)
returns jsonb
language plpgsql
as $$
declare
  v_before   numeric := 0;
  v_after    numeric;
  v_inserted integer;
begin
  select balance into v_before from stock
   where branch_id = p_branch_id and product_id = p_product_id
   for update;
  if not found then v_before := 0; end if;

  -- Idempotency: if this return was already applied, report the current balance
  -- unchanged rather than decrementing twice.
  if exists (
    select 1 from stock_history
     where ref_id = p_ref_id and product_id = p_product_id and type = 'return'
  ) then
    return jsonb_build_object('status', 'ok', 'before', v_before, 'after', v_before);
  end if;

  if p_qty > v_before then
    return jsonb_build_object('status', 'insufficient', 'requested', p_qty, 'available', v_before);
  end if;

  insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
  values (p_branch_id, p_product_id, p_product_name, 'return', -p_qty, 0, p_ref_id, p_business_date)
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    -- Lost a race with a concurrent identical return; treat as already applied.
    return jsonb_build_object('status', 'ok', 'before', v_before, 'after', v_before);
  end if;

  insert into stock (branch_id, product_id, product_name, balance)
  values (p_branch_id, p_product_id, p_product_name, -p_qty)
  on conflict (branch_id, product_id) do update
     set balance = stock.balance - p_qty,
         product_name = coalesce(excluded.product_name, stock.product_name)
  returning balance into v_after;

  update stock_history
     set balance_after = v_after
   where ref_id = p_ref_id and product_id = p_product_id and type = 'return';

  return jsonb_build_object('status', 'ok', 'before', v_before, 'after', v_after);
end;
$$;

-- ---------------------------------------------------------------------------
-- commit_sale — the POS sale. Validate stock, write the order and its items,
-- decrement balances, append the ledger — all or nothing.
--
-- p_order is the orders row as jsonb; p_items is a jsonb array of line objects
-- (productId, productName, categoryId, categoryName, unitPrice, qty, discount,
-- lineTotal). Duplicate product lines are preserved verbatim in order_items but
-- AGGREGATED for stock purposes — one balance write and one ledger row per
-- product, matching the legacy idempotency scheme.
--
-- Returns jsonb:
--   {"status":"ok","orderId":uuid,"balances":{<productId>:{productName,before,after}}}
--   {"status":"insufficient","shortfalls":[{productId,productName,requested,available}]}
--
-- The shortfall case returns before ANY write, so the caller sees a clean
-- rejection with nothing persisted.
-- ---------------------------------------------------------------------------
create or replace function public.commit_sale(
  p_order         jsonb,
  p_items         jsonb,
  p_branch_id     uuid,
  p_business_date date
)
returns jsonb
language plpgsql
as $$
declare
  v_order_id    uuid;
  v_before      numeric;
  v_after       numeric;
  v_befores     jsonb := '{}'::jsonb;
  v_shortfalls  jsonb := '[]'::jsonb;
  v_balances    jsonb := '{}'::jsonb;
  v_inserted    integer;
  r             record;
begin
  -- ── Pass 1: lock every product row in product_id order, then validate ──────
  -- The ORDER BY is the deadlock guard (migration 04, invariant 2). Locks taken
  -- here are held for the rest of this function's transaction.
  for r in
    select (i->>'productId')::uuid              as product_id,
           min(i->>'productName')               as product_name,
           sum((i->>'qty')::numeric)            as qty
      from jsonb_array_elements(p_items) as i
     group by 1
     order by 1
  loop
    select balance into v_before from stock
     where branch_id = p_branch_id and product_id = r.product_id
     for update;
    if not found then v_before := 0; end if;

    v_befores := v_befores || jsonb_build_object(r.product_id::text, v_before);

    if r.qty > v_before then
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'productId',   r.product_id,
        'productName', r.product_name,
        'requested',   r.qty,
        'available',   v_before
      );
    end if;
  end loop;

  if jsonb_array_length(v_shortfalls) > 0 then
    return jsonb_build_object('status', 'insufficient', 'shortfalls', v_shortfalls);
  end if;

  -- ── Writes ────────────────────────────────────────────────────────────────
  insert into orders (
    order_number, branch_id, branch_name, customer_id, customer_name,
    customer_phone, customer_address, subtotal, discount_total, delivery_charges,
    tax_rate, tax_amount, grand_total, payment_method, status, notes,
    received_cash, cash_returned, created_by, created_by_name, business_date
  )
  select
    p_order->>'orderNumber',
    p_branch_id,
    p_order->>'branchName',
    nullif(p_order->>'customerId', '')::uuid,
    p_order->>'customerName',
    p_order->>'customerPhone',
    p_order->>'customerAddress',
    (p_order->>'subtotal')::numeric,
    coalesce((p_order->>'discountTotal')::numeric, 0),
    coalesce((p_order->>'deliveryCharges')::numeric, 0),
    coalesce((p_order->>'taxRate')::numeric, 0),
    coalesce((p_order->>'taxAmount')::numeric, 0),
    (p_order->>'grandTotal')::numeric,
    (p_order->>'paymentMethod')::payment_method,
    coalesce((p_order->>'status')::order_status, 'pending'),
    p_order->>'notes',
    nullif(p_order->>'receivedCash', '')::numeric,
    nullif(p_order->>'cashReturned', '')::numeric,
    nullif(p_order->>'createdBy', '')::uuid,
    p_order->>'createdByName',
    p_business_date
  returning id into v_order_id;

  -- Line items keep their original rows (duplicates included) and ordering.
  insert into order_items (
    order_id, product_id, product_name, category_id, category_name,
    unit_price, qty, discount, line_total, line_no
  )
  select
    v_order_id,
    nullif(i.value->>'productId', '')::uuid,
    i.value->>'productName',
    nullif(i.value->>'categoryId', '')::uuid,
    i.value->>'categoryName',
    (i.value->>'unitPrice')::numeric,
    (i.value->>'qty')::numeric,
    coalesce((i.value->>'discount')::numeric, 0),
    (i.value->>'lineTotal')::numeric,
    i.ordinality::integer
  from jsonb_array_elements(p_items) with ordinality as i;

  -- ── Pass 2: apply the aggregated stock movements ──────────────────────────
  for r in
    select (i->>'productId')::uuid              as product_id,
           min(i->>'productName')               as product_name,
           sum((i->>'qty')::numeric)            as qty
      from jsonb_array_elements(p_items) as i
     group by 1
     order by 1
  loop
    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (p_branch_id, r.product_id, r.product_name, 'sale', -r.qty, 0, v_order_id::text, p_business_date)
    on conflict (ref_id, product_id, type) do nothing;

    get diagnostics v_inserted = row_count;

    -- v_order_id is freshly generated, so a conflict here is not reachable in
    -- practice. The guard is kept so this path obeys the same rule as every
    -- other movement: no ledger row inserted means no balance change.
    if v_inserted > 0 then
      insert into stock (branch_id, product_id, product_name, balance)
      values (p_branch_id, r.product_id, r.product_name, -r.qty)
      on conflict (branch_id, product_id) do update
         set balance = stock.balance - r.qty,
             product_name = coalesce(excluded.product_name, stock.product_name)
      returning balance into v_after;

      update stock_history
         set balance_after = v_after
       where ref_id = v_order_id::text and product_id = r.product_id and type = 'sale';

      v_balances := v_balances || jsonb_build_object(
        r.product_id::text,
        jsonb_build_object(
          'productName', r.product_name,
          'before',      (v_befores->>r.product_id::text)::numeric,
          'after',       v_after
        )
      );
    end if;
  end loop;

  return jsonb_build_object('status', 'ok', 'orderId', v_order_id, 'balances', v_balances);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down. Postgres grants EXECUTE to PUBLIC by default and anon/authenticated
-- inherit it — without this, commit_sale would be a callable Data API endpoint
-- able to write orders and move stock.
-- ---------------------------------------------------------------------------
revoke all on function public.apply_stock_movement(uuid, uuid, text, numeric, stock_movement_type, text, date) from public, anon, authenticated;
revoke all on function public.commit_branch_return(uuid, uuid, text, numeric, text, date) from public, anon, authenticated;
revoke all on function public.commit_sale(jsonb, jsonb, uuid, date) from public, anon, authenticated;

grant execute on function public.apply_stock_movement(uuid, uuid, text, numeric, stock_movement_type, text, date) to service_role;
grant execute on function public.commit_branch_return(uuid, uuid, text, numeric, text, date) to service_role;
grant execute on function public.commit_sale(jsonb, jsonb, uuid, date) to service_role;


-- ==========================================================================
-- 20260719000013_customer_stats.sql
-- ==========================================================================
-- 13: atomic customer order statistics.
--
-- The legacy system updated these with a server-side increment operator, atomic on the
-- server and immune to the read-modify-write race two concurrent orders for the
-- same customer would otherwise hit.
--
-- supabase-js has no equivalent: `.update({ total_orders: n + 1 })` requires
-- reading n first, and PostgREST gives that read its own transaction. Two orders
-- placed at once would both read the same n and both write n+1, losing one.
--
-- A single UPDATE with the increment expressed in SQL is atomic under Postgres
-- row locking — the same reasoning as next_order_number() in migration 03.
--
-- updated_at is maintained by the customers_touch trigger — not set here.

create or replace function public.increment_customer_stats(
  p_customer_id uuid,
  p_amount      numeric
)
returns void
language sql
as $$
  update customers
     set total_orders = total_orders + 1,
         total_spent  = total_spent + p_amount
   where id = p_customer_id;
$$;

revoke all on function public.increment_customer_stats(uuid, numeric) from public, anon, authenticated;
grant execute on function public.increment_customer_stats(uuid, numeric) to service_role;


-- ==========================================================================
-- 20260719000014_password_reset_notification.sql
-- ==========================================================================
-- 14: add 'password_reset' to notification_type.
--
-- users.routes.ts raises a notification when an admin resets someone's password
-- (notify({ type: 'password_reset', ... })), but that value was never in the
-- enum — migration 01 lists only the order/stock/production types. Under
-- In the legacy system `type` was a free-text string so this went unnoticed; in Postgres it
-- is a real enum and the insert fails with 22P02, taking the whole reset request
-- down with it.
--
-- ALTER rather than editing migration 01, because 01 is already applied to the
-- live database. On a fresh run of schema_bundle.sql this still works: adding a
-- value to an enum created earlier in the same transaction is permitted.
--
-- Note PG 12+ allows ADD VALUE inside a transaction block as long as the new
-- value is not USED in that same transaction — which it is not here.

alter type notification_type add value if not exists 'password_reset';


-- ==========================================================================
-- 20260719000015_production_stock_function.sql
-- ==========================================================================
-- 15: production-pool stock movements.
--
-- The central Production Stock pool is the branch-agnostic sibling of `stock`:
-- one running balance per product in `production_stock`, every movement appended
-- to `production_stock_history`.
--
-- Same two invariants as migration 12, enforced the same way:
--
--   1. IDEMPOTENCY — production_stock_history has a UNIQUE
--      (ref_id, product_id, type). Insert with `on conflict do nothing` and move
--      the balance ONLY when a row was actually inserted, so a retry that reuses
--      the same ref_id is a true no-op.
--
--   2. The balance write is RELATIVE (`balance + p_delta`) with RETURNING, which
--      is atomic on its own and yields the true post-write balance to record as
--      balance_after.
--
-- Negative balances are allowed here too — the pool is flagged in the UI, never
-- blocked (production-stock.service.ts is explicit about matching the
-- branch-stock philosophy).
--
-- Note production_stock is keyed by product_id directly (it is the PRIMARY KEY),
-- not by a surrogate id like `stock` — so the upsert conflicts on product_id.
--
-- updated_at is maintained by the production_stock_touch trigger.
--
-- SECURITY: SECURITY INVOKER (default), locked to service_role at the bottom.

create or replace function public.apply_production_stock_movement(
  p_product_id    uuid,
  p_product_name  text,
  p_delta         numeric,
  p_type          production_stock_movement_type,
  p_ref_id        text,
  p_business_date date
)
returns numeric
language plpgsql
as $$
declare
  v_balance  numeric;
  v_inserted integer;
begin
  -- Reserve the idempotency key first; balance_after is backfilled below.
  insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
  values (p_product_id, p_product_name, p_type, p_delta, 0, p_ref_id, p_business_date)
  on conflict (ref_id, product_id, type) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already applied. Return the current balance without touching it.
    select balance into v_balance from production_stock where product_id = p_product_id;
    return coalesce(v_balance, 0);
  end if;

  insert into production_stock (product_id, product_name, balance)
  values (p_product_id, p_product_name, p_delta)
  on conflict (product_id) do update
     set balance = production_stock.balance + p_delta,
         product_name = coalesce(excluded.product_name, production_stock.product_name)
  returning balance into v_balance;

  update production_stock_history
     set balance_after = v_balance
   where ref_id = p_ref_id and product_id = p_product_id and type = p_type;

  return v_balance;
end;
$$;

revoke all on function public.apply_production_stock_movement(uuid, text, numeric, production_stock_movement_type, text, date) from public, anon, authenticated;
grant execute on function public.apply_production_stock_movement(uuid, text, numeric, production_stock_movement_type, text, date) to service_role;


-- ==========================================================================
-- 20260719000016_review_production_order.sql
-- ==========================================================================
-- 16: production order review (approve / reject).
--
-- Migration 05's header specifies both hazards this implements. Read it first.
--
--   1. ATOMIC CHECK-AND-SET. The review must refuse an order that is no longer
--      'pending', or a double approval applies the balance maths twice. This is
--      `update ... where id = ? and status = 'pending'`; zero rows updated means
--      someone else already reviewed it, which the caller turns into a 409.
--
--   2. production_balances is ASSIGNED, NEVER INCREMENTED. The review computes
--      total_required = previous_balance + new_demand, then stores
--      remaining = max(0, total_required - approved). Writing
--      `pending_qty = pending_qty + delta` would double-count the prior balance,
--      because it is already folded into total_required. The upsert below
--      assigns `excluded.pending_qty`.
--
-- Rejection deliberately leaves balances untouched, so outstanding demand
-- carries forward to the branch's next submission.
--
-- Returns jsonb:
--   {"status":"not_found"}
--   {"status":"already_reviewed"}
--   {"status":"ok","branchId":uuid,"branchName":text,"items":[...]}
--
-- The not_found / already_reviewed cases return normally rather than raising, so
-- the caller gets a clean 404/409 with structured detail. Nothing is written on
-- those paths.
--
-- updated_at is maintained by the *_touch triggers.
--
-- SECURITY: SECURITY INVOKER (default), locked to service_role at the bottom.

create or replace function public.review_production_order(
  p_order_id         uuid,
  p_status           branch_production_order_status,
  p_overrides        jsonb,   -- [{"productId": uuid, "approvedQty": numeric}]
  p_reason           text,
  p_reviewed_by      uuid,
  p_reviewed_by_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_branch_id    uuid;
  v_branch_name  text;
  v_exists       boolean;
  v_was_changed  boolean := false;
  v_items        jsonb   := '[]'::jsonb;
  v_prev         numeric;
  v_total        numeric;
  v_approved     numeric;
  v_remaining    numeric;
  v_override     numeric;
  r              record;
begin
  -- Hazard 1: the WHERE on status is the check-and-set.
  update production_orders
     set status           = p_status,
         approved_by      = p_reviewed_by,
         approved_by_name = p_reviewed_by_name,
         approved_at      = now()
   where id = p_order_id
     and status = 'pending'
  returning branch_id, branch_name into v_branch_id, v_branch_name;

  if not found then
    select exists (select 1 from production_orders where id = p_order_id) into v_exists;
    if v_exists then
      return jsonb_build_object('status', 'already_reviewed');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Rejection: status flipped, balances untouched by design.
  if p_status <> 'approved' then
    return jsonb_build_object(
      'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name, 'items', '[]'::jsonb
    );
  end if;

  -- Ordered by product_id so concurrent reviews touching the same branch take
  -- the balance row locks in a consistent order.
  for r in
    select i.id, i.product_id, i.product_name, i.qty
      from production_order_items i
     where i.production_order_id = p_order_id
     order by i.product_id
  loop
    select pending_qty into v_prev
      from production_balances
     where branch_id = v_branch_id and product_id = r.product_id
     for update;
    if not found then v_prev := 0; end if;

    v_total := coalesce(v_prev, 0) + coalesce(r.qty, 0);

    -- An override of 0 is meaningful (approve nothing), so test for presence
    -- rather than truthiness.
    select (o->>'approvedQty')::numeric into v_override
      from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as o
     where (o->>'productId')::uuid = r.product_id
     limit 1;

    v_approved  := coalesce(v_override, v_total);
    v_remaining := greatest(0, v_total - v_approved);
    if v_approved <> v_total then v_was_changed := true; end if;

    update production_order_items
       set previous_balance_qty  = v_prev,
           total_required_qty    = v_total,
           approved_qty          = v_approved,
           remaining_balance_qty = v_remaining
     where id = r.id;

    -- Hazard 2: ASSIGN, do not add.
    insert into production_balances (branch_id, branch_name, product_id, product_name, pending_qty)
    values (v_branch_id, v_branch_name, r.product_id, r.product_name, v_remaining)
    on conflict (branch_id, product_id) do update
       set pending_qty  = excluded.pending_qty,
           branch_name  = coalesce(excluded.branch_name, production_balances.branch_name),
           product_name = coalesce(excluded.product_name, production_balances.product_name);

    v_items := v_items || jsonb_build_object(
      'productId',           r.product_id,
      'productName',         r.product_name,
      'qty',                 r.qty,
      'previousBalanceQty',  v_prev,
      'totalRequiredQty',    v_total,
      'approvedQty',         v_approved,
      'remainingBalanceQty', v_remaining
    );

    v_override := null;  -- reset; SELECT INTO leaves the old value when no row matches
  end loop;

  update production_orders
     set was_changed = v_was_changed,
         change_reason = p_reason
   where id = p_order_id;

  return jsonb_build_object(
    'status', 'ok', 'branchId', v_branch_id, 'branchName', v_branch_name, 'items', v_items
  );
end;
$$;

revoke all on function public.review_production_order(uuid, branch_production_order_status, jsonb, text, uuid, text) from public, anon, authenticated;
grant execute on function public.review_production_order(uuid, branch_production_order_status, jsonb, text, uuid, text) to service_role;


commit;
