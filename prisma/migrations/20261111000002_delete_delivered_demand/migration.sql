-- Super Admin can delete a delivered demand again (Support Center → Delete demand).
--
-- Before: the Demand Record (20261024000001) freezes each demand's company
-- share % in production_order_share_snapshots the moment it leaves pending.
-- That row holds its demand ON DELETE RESTRICT and is append-only, so
-- delete_production_order failed on every demand that had ever been delivered:
-- the RESTRICT check raised SQLSTATE 23001, which the route did not recognise,
-- and the admin saw "Internal server error". Only never-delivered demands
-- (pending, rejected before delivery) could still be deleted.
--
-- Now delete_production_order removes the demand's snapshot itself, right
-- before the demand, after copying it into the audit_logs row it already
-- writes. A deleted demand is gone from the Demand Record anyway (the balance
-- is derived from the demands that exist), so its frozen % has nothing left to
-- protect.
--
-- The snapshot stays append-only to everything else: its guard lets a DELETE
-- through only for the one demand delete_production_order has named in the
-- transaction-local setting app.deleting_production_order. Updates are still
-- refused outright. The FK stays RESTRICT, so no other path can drop a demand
-- out from under its snapshot. branch_account_adjustments keeps the shared
-- app.share_snapshots_append_only guard, unchanged.

create function app.share_snapshot_guard() returns trigger
  language plpgsql as $$
  begin
    if tg_op = 'DELETE'
       and current_setting('app.deleting_production_order', true) = old.production_order_id::text then
      return old;
    end if;
    raise exception '% rows are append-only', tg_table_name;
  end;
  $$;

drop trigger production_order_share_snapshots_append_only on public.production_order_share_snapshots;
create trigger production_order_share_snapshots_append_only
  before update or delete on public.production_order_share_snapshots
  for each row execute function app.share_snapshot_guard();

CREATE OR REPLACE FUNCTION public.delete_production_order(p_order_id uuid, p_reason text, p_ref_id text, p_actor_id uuid, p_actor_name text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_demand_number text;
  v_branch_id     uuid;
  v_branch_name   text;
  v_status        branch_production_order_status;
  v_business_date date;
  v_order         jsonb;
  v_items         jsonb;
  v_packing       jsonb;
  v_share         jsonb;
  v_branch_rev    jsonb;
  v_pool_rev      jsonb;
  v_today         date;
  r               record;
begin
  -- Lock the order for the whole operation: a concurrent verification would
  -- otherwise credit stock between the sum below and the delete, and that credit
  -- would survive with nothing left to attribute it to.
  select demand_number, branch_id, branch_name, status, business_date
    into v_demand_number, v_branch_id, v_branch_name, v_status, v_business_date
    from production_orders
   where id = p_order_id
     for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The business date drives the reversal's ledger row. Deliberately TODAY, not
  -- the demand's own date: the correction happens now, and back-dating it into a
  -- business day that may already be closed and snapshotted would change a figure
  -- that has been reported.
  v_today := (timezone('Asia/Karachi', now()))::date;

  -- ── Snapshot before anything is destroyed ─────────────────────────────────
  select to_jsonb(po) into v_order from production_orders po where po.id = p_order_id;

  select coalesce(jsonb_agg(to_jsonb(i) order by i.line_no), '[]'::jsonb)
    into v_items
    from production_order_items i
   where i.production_order_id = p_order_id;

  select coalesce(jsonb_agg(to_jsonb(pk) order by pk.line_no), '[]'::jsonb)
    into v_packing
    from production_order_packing_items pk
   where pk.production_order_id = p_order_id;

  -- The Demand Record's frozen company share % (null for a demand never delivered).
  select to_jsonb(s) into v_share
    from production_order_share_snapshots s
   where s.production_order_id = p_order_id;

  -- ── Reverse the branch ledger ─────────────────────────────────────────────
  -- Net across the whole ref family (see header). A product whose net is already
  -- zero is skipped rather than written as a 0-delta row: a zero movement conveys
  -- nothing and would still consume the (ref_id, product_id, type) key.
  select coalesce(jsonb_agg(jsonb_build_object(
           'productId', t.product_id, 'productName', t.product_name, 'delta', -t.net
         )), '[]'::jsonb)
    into v_branch_rev
    from (
      select product_id,
             max(product_name) as product_name,
             sum(delta)        as net
        from stock_history
       where (ref_id = p_order_id::text or ref_id like p_order_id::text || ':%')
         and branch_id = v_branch_id
       group by product_id
      having sum(delta) <> 0
    ) t;

  for r in select (e->>'productId')::uuid as product_id,
                  e->>'productName'       as product_name,
                  (e->>'delta')::numeric  as delta
             from jsonb_array_elements(v_branch_rev) e
  loop
    perform public.apply_stock_movement(
      v_branch_id, r.product_id, r.product_name, r.delta,
      'adjustment'::stock_movement_type, p_ref_id, v_today
    );
  end loop;

  -- ── Reverse the production pool ───────────────────────────────────────────
  select coalesce(jsonb_agg(jsonb_build_object(
           'productId', t.product_id, 'productName', t.product_name, 'delta', -t.net
         )), '[]'::jsonb)
    into v_pool_rev
    from (
      select product_id,
             max(product_name) as product_name,
             sum(delta)        as net
        from production_stock_history
       where (ref_id = p_order_id::text or ref_id like p_order_id::text || ':%')
       group by product_id
      having sum(delta) <> 0
    ) t;

  for r in select (e->>'productId')::uuid as product_id,
                  e->>'productName'       as product_name,
                  (e->>'delta')::numeric  as delta
             from jsonb_array_elements(v_pool_rev) e
  loop
    perform public.apply_production_stock_movement(
      r.product_id, r.product_name, r.delta,
      'adjustment'::production_stock_movement_type, p_ref_id, v_today
    );
  end loop;

  -- ── Record what is about to be destroyed ──────────────────────────────────
  -- Written before the delete so a failure anywhere below rolls this back with
  -- it: an audit row describing a demand that still exists would be worse than
  -- none at all.
  insert into audit_logs (action, admin_id, admin_name, details)
  values (
    'production_order_deleted',
    p_actor_id,
    p_actor_name,
    jsonb_build_object(
      'orderId',       p_order_id,
      'demandNumber',  v_demand_number,
      'branchId',      v_branch_id,
      'branchName',    v_branch_name,
      'status',        v_status::text,
      'businessDate',  v_business_date,
      'reason',        p_reason,
      'reversalRefId', p_ref_id,
      'reversedOn',    v_today,
      'order',         v_order,
      'items',         v_items,
      'packingItems',  v_packing,
      'shareSnapshot', v_share,
      'branchReversals', v_branch_rev,
      'poolReversals',   v_pool_rev
    )
  );

  -- The share snapshot holds its demand ON DELETE RESTRICT and is append-only;
  -- its guard lets this one row go because this transaction names it here.
  perform set_config('app.deleting_production_order', p_order_id::text, true);
  delete from production_order_share_snapshots where production_order_id = p_order_id;

  -- Cascades production_order_items and production_order_packing_items.
  delete from production_orders where id = p_order_id;

  perform set_config('app.deleting_production_order', '', true);

  return jsonb_build_object(
    'status',          'deleted',
    'demandNumber',    v_demand_number,
    'branchId',        v_branch_id,
    'branchName',      v_branch_name,
    'orderStatus',     v_status::text,
    'stockMoved',      jsonb_array_length(v_branch_rev) > 0 or jsonb_array_length(v_pool_rev) > 0,
    'branchReversals', v_branch_rev,
    'poolReversals',   v_pool_rev
  );
end;
$$;
