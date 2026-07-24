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
