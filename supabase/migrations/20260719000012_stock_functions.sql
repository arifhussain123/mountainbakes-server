-- 12: stock movement transaction functions.
--
-- These implement the two invariants migration 04 spells out. Read that file's
-- header first — it is the authority; this file is its execution.
--
--   1. IDEMPOTENCY. stock_history has a UNIQUE (ref_id, product_id, type). Every
--      movement inserts with `on conflict do nothing` and applies the balance
--      delta ONLY when the insert actually affected a row. A retry that reuses
--      the same ref_id is therefore a true no-op, exactly as the Firestore
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
-- the Firestore transaction existed to close. Same reasoning as migration 11.
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
-- product, matching the Firestore idempotency scheme.
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
