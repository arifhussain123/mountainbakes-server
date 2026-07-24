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
