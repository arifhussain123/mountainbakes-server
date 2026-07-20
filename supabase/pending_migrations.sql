-- Mountain Bakes — PENDING migrations 11-16 only.
--
-- Migrations 01-10 are ALREADY APPLIED to the live project; schema_bundle.sql
-- re-creates them and would abort on "relation already exists". Run THIS file
-- instead, in the Supabase Studio SQL editor.
--
-- Wrapped in one transaction: if any statement fails, nothing is applied.
-- Every function is `create or replace` and the enum add uses `if not exists`,
-- so re-running this file is safe.

begin;


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
--
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
-- 
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


-- ==========================================================================
-- 20260721000017_business_day_closure_claim.sql
-- ==========================================================================
-- Atomic claim for the daily-closing distributed lock (business_day_closures,
-- table created in migration 07). Reproduces the once-per-day read-check-write
-- in one row-locked block, since PostgREST gives each call its own transaction.
-- Returns 'claimed' | 'already_closed' | 'in_progress'.

create or replace function claim_business_day_closure(
  p_business_date      date,
  p_trigger            closure_trigger,
  p_closed_by          text,
  p_auto_stock_closing boolean,
  p_stale_ms           integer
) returns text
  language plpgsql
  as $$
  declare
    existing business_day_closures%rowtype;
  begin
    select * into existing
      from business_day_closures
      where business_date = p_business_date
      for update;

    if found then
      if existing.status = 'success' then
        return 'already_closed';
      end if;
      if existing.status = 'running'
         and existing.started_at > now() - make_interval(secs => p_stale_ms / 1000.0) then
        return 'in_progress';
      end if;
    end if;

    insert into business_day_closures (
      business_date, status, trigger, closed_by, auto_stock_closing, started_at
    ) values (
      p_business_date, 'running', p_trigger, p_closed_by, p_auto_stock_closing, now()
    )
    on conflict (business_date) do update set
      status                     = 'running',
      trigger                    = excluded.trigger,
      closed_by                  = excluded.closed_by,
      auto_stock_closing         = excluded.auto_stock_closing,
      started_at                 = now(),
      sales_summary              = null,
      expense_summary            = null,
      production_expense_summary = null,
      production_summary         = null,
      stock_snapshot             = null,
      error                      = null,
      closed_at                  = null,
      duration_ms                = null;

    return 'claimed';
  end;
  $$;

revoke all on function public.claim_business_day_closure(date, closure_trigger, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.claim_business_day_closure(date, closure_trigger, text, boolean, integer) to service_role;


commit;
