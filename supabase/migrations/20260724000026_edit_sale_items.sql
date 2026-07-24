-- 26: edit_sale_items — apply an admin correction to a sale's line items from the
-- Support Center, atomically, and keep stock + order totals + customer spend in sync.
--
-- The Help Desk lets branches raise a query against a sale (MB-######). When the
-- admin corrects the sale's items (change a product, its qty, or its unit price;
-- add or remove a line), three things must move together or not at all:
--
--   1. order_items      — replaced wholesale with the new line set.
--   2. orders totals     — subtotal / discount_total / tax_amount / grand_total
--                          recomputed exactly as the POS path does (migration 03):
--                          line_total = unit_price*qty - discount, subtotal = Σ line_total,
--                          tax_amount = round(subtotal*tax_rate,2),
--                          grand_total = subtotal + delivery_charges + tax_amount.
--   3. stock            — the ORIGINAL 'sale' ledger row is left untouched (the ledger
--                          is append-only, migration 04). Instead we append one
--                          'adjustment' movement per affected product with
--                          delta = old_qty - new_qty (positive restores stock, negative
--                          takes more), under a ref unique to this correction so the
--                          idempotency key (ref_id, product_id, type) never collides.
--
-- Overdraw is REJECTED, exactly like commit_sale: if raising a qty would drive a
-- branch balance below zero, nothing is written and the shortfalls are returned.
--
-- Locking mirrors commit_sale (migration 12): the order row is locked FOR UPDATE so
-- concurrent edits serialise, and stock rows are locked in product_id order — the
-- same deadlock guard commit_sale relies on. Because a single supabase-js/PostgREST
-- call is one transaction, this validate-then-write must live in one DB function.
--
-- p_items is a jsonb array of line objects (same camelCase keys commit_sale reads):
--   { productId, productName, categoryId, categoryName, unitPrice, qty, discount }
-- Lines with a null productId (e.g. a historical line whose product was deleted) are
-- preserved in order_items but excluded from stock math — there is no product to move.
--
-- Returns jsonb:
--   {"status":"ok","orderId":uuid,"subtotal":N,"grandTotal":N,"balances":{<pid>:{...}}}
--   {"status":"insufficient","shortfalls":[{productId,productName,requested,available}]}
--   {"status":"not_found"}
--
-- SECURITY: locked to service_role at the bottom, like every other write function.

create or replace function public.edit_sale_items(
  p_order_id      uuid,
  p_items         jsonb,
  p_business_date date
)
returns jsonb
language plpgsql
as $$
declare
  v_branch_id    uuid;
  v_customer_id  uuid;
  v_tax_rate     numeric;
  v_delivery     numeric;
  v_old_grand    numeric;
  v_subtotal     numeric := 0;
  v_discount     numeric := 0;
  v_tax_amount   numeric;
  v_grand_total  numeric;
  v_shortfalls   jsonb := '[]'::jsonb;
  v_balances     jsonb := '{}'::jsonb;
  v_edit_ref     text;
  v_before       numeric;
  v_after        numeric;
  v_delta        numeric;
  r              record;
begin
  -- Lock the order; capture the components we keep (tax_rate, delivery) and the
  -- values we reconcile afterward (customer, old grand total).
  select branch_id, customer_id, tax_rate, delivery_charges, grand_total
    into v_branch_id, v_customer_id, v_tax_rate, v_delivery, v_old_grand
    from orders
   where id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- ── Pass 1: lock each affected product's stock row (product_id order) and
  -- validate that no line increase would overdraw the branch balance. ─────────
  for r in
    with old_q as (
      select product_id, min(product_name) as product_name, sum(qty) as qty
        from order_items
       where order_id = p_order_id and product_id is not null
       group by product_id
    ),
    new_q as (
      select (i->>'productId')::uuid as product_id,
             min(i->>'productName')  as product_name,
             sum((i->>'qty')::numeric) as qty
        from jsonb_array_elements(p_items) as i
       where nullif(i->>'productId', '') is not null
       group by 1
    )
    select coalesce(o.product_id, n.product_id)     as product_id,
           coalesce(n.product_name, o.product_name) as product_name,
           coalesce(o.qty, 0)                       as old_qty,
           coalesce(n.qty, 0)                       as new_qty
      from old_q o
      full outer join new_q n on o.product_id = n.product_id
     order by 1
  loop
    select balance into v_before from stock
     where branch_id = v_branch_id and product_id = r.product_id
     for update;
    if not found then v_before := 0; end if;

    -- Net change applied to balance = old_qty - new_qty. If that drives the
    -- balance negative, the correction is trying to "sell" more than exists.
    if v_before + (r.old_qty - r.new_qty) < 0 then
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'productId',   r.product_id,
        'productName', r.product_name,
        'requested',   r.new_qty,
        'available',   v_before + r.old_qty   -- what would be sellable after un-selling the old line
      );
    end if;
  end loop;

  if jsonb_array_length(v_shortfalls) > 0 then
    return jsonb_build_object('status', 'insufficient', 'shortfalls', v_shortfalls);
  end if;

  -- ── Apply stock deltas + append the compensating ledger rows ────────────────
  -- Runs BEFORE order_items is replaced, so old_qty still reads the current lines.
  v_edit_ref := p_order_id::text || ':edit:' || gen_random_uuid()::text;

  for r in
    with old_q as (
      select product_id, min(product_name) as product_name, sum(qty) as qty
        from order_items
       where order_id = p_order_id and product_id is not null
       group by product_id
    ),
    new_q as (
      select (i->>'productId')::uuid as product_id,
             min(i->>'productName')  as product_name,
             sum((i->>'qty')::numeric) as qty
        from jsonb_array_elements(p_items) as i
       where nullif(i->>'productId', '') is not null
       group by 1
    )
    select coalesce(o.product_id, n.product_id)     as product_id,
           coalesce(n.product_name, o.product_name) as product_name,
           coalesce(o.qty, 0)                       as old_qty,
           coalesce(n.qty, 0)                       as new_qty
      from old_q o
      full outer join new_q n on o.product_id = n.product_id
     order by 1
  loop
    v_delta := r.old_qty - r.new_qty;   -- +restores stock, -takes more
    continue when v_delta = 0;

    insert into stock (branch_id, product_id, product_name, balance)
    values (v_branch_id, r.product_id, r.product_name, v_delta)
    on conflict (branch_id, product_id) do update
       set balance = stock.balance + v_delta,
           product_name = coalesce(excluded.product_name, stock.product_name)
    returning balance into v_after;

    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
    values (v_branch_id, r.product_id, r.product_name, 'adjustment', v_delta, v_after, v_edit_ref, p_business_date);

    v_balances := v_balances || jsonb_build_object(
      r.product_id::text,
      jsonb_build_object('productName', r.product_name, 'delta', v_delta, 'after', v_after)
    );
  end loop;

  -- ── Replace the line items ──────────────────────────────────────────────────
  delete from order_items where order_id = p_order_id;

  insert into order_items (
    order_id, product_id, product_name, category_id, category_name,
    unit_price, qty, discount, line_total, line_no
  )
  select
    p_order_id,
    nullif(i.value->>'productId', '')::uuid,
    i.value->>'productName',
    nullif(i.value->>'categoryId', '')::uuid,
    i.value->>'categoryName',
    (i.value->>'unitPrice')::numeric,
    (i.value->>'qty')::numeric,
    coalesce((i.value->>'discount')::numeric, 0),
    (i.value->>'unitPrice')::numeric * (i.value->>'qty')::numeric - coalesce((i.value->>'discount')::numeric, 0),
    i.ordinality::integer
  from jsonb_array_elements(p_items) with ordinality as i;

  -- ── Recompute order totals from the new lines (mirrors migration 03) ─────────
  select coalesce(sum(line_total), 0), coalesce(sum(discount), 0)
    into v_subtotal, v_discount
    from order_items where order_id = p_order_id;

  v_tax_amount  := round(v_subtotal * coalesce(v_tax_rate, 0), 2);
  v_grand_total := v_subtotal + coalesce(v_delivery, 0) + v_tax_amount;

  update orders
     set subtotal       = v_subtotal,
         discount_total = v_discount,
         tax_amount     = v_tax_amount,
         grand_total    = v_grand_total,
         updated_at     = now()
   where id = p_order_id;

  -- Keep the customer's lifetime spend consistent (order count is unchanged — this
  -- is a correction, not a new order). Walk-in sales have no customer row.
  if v_customer_id is not null then
    update customers
       set total_spent = total_spent + (v_grand_total - v_old_grand)
     where id = v_customer_id;
  end if;

  return jsonb_build_object(
    'status',     'ok',
    'orderId',    p_order_id,
    'subtotal',   v_subtotal,
    'grandTotal', v_grand_total,
    'balances',   v_balances
  );
end;
$$;

-- Lock down: never callable by anon/authenticated via the Data API.
revoke all on function public.edit_sale_items(uuid, jsonb, date) from public, anon, authenticated;
grant execute on function public.edit_sale_items(uuid, jsonb, date) to service_role;
