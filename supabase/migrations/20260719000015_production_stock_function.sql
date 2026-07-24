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
