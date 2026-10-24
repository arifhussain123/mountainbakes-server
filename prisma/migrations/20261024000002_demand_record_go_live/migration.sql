-- Demand Record accounting restructure: switch the Demand Record on from the
-- start of the web (docs/demand-record-accounting-migration.md).
--
-- The owner chose "from the start of the web" as the Demand Record's go-live
-- day (2026-10-24). This does what Finance → Demand Record → "Switch on" does
-- (services/branch-account.service.ts setLedgerStart), once, and only when no
-- go-live day has been set yet:
--
--   1. finance_settings.account_ledger_start = the first day the system holds
--      anything a branch account counts — the earlier of the first branch
--      created and the first demand, as a Karachi business date. Nothing
--      financial is older, so every branch opens at 0 (Previous Balance of its
--      first demand) unless Finance enters an opening balance.
--   2. Freezes the company share % of every delivered demand from that day, at
--      the % that applies today (branch override, else Finance Settings). There
--      is no record of past % changes, so this is the only % available; see the
--      audit document's limitations.
--   3. Writes the Finance audit entry the switch writes.
--
-- Additive only: no existing row is changed or removed apart from that one
-- settings value going from NULL to a date. Payments are not moved — the
-- Demand Record reads Payment Received from the approved cash transfers where
-- each one already lives once. Running it again is a no-op.

do $$
declare
  v_start date;
  v_frozen integer;
begin
  if (select account_ledger_start from public.finance_settings limit 1 for update) is not null then
    return;
  end if;

  select least(
           (select min((created_at at time zone 'Asia/Karachi')::date) from public.branches),
           (select min(business_date) from public.production_orders)
         )
    into v_start;
  if v_start is null then
    return; -- an empty system: nothing to switch on yet
  end if;

  update public.finance_settings set account_ledger_start = v_start;

  insert into public.production_order_share_snapshots (production_order_id, company_share_pct, source)
  select o.id, app.resolve_company_share_pct(o.branch_id), 'go_live'
    from public.production_orders o
   where o.status::text in ('awaiting_verification', 'verified', 'approved')
     and o.business_date >= v_start
  on conflict (production_order_id) do nothing;
  get diagnostics v_frozen = row_count;

  insert into public.finance_audit_logs (entity, entity_ref, action, actor_name, previous_values, new_values)
  values (
    'branch_account', 'go-live date', 'updated', 'system',
    jsonb_build_object('startDate', null),
    jsonb_build_object(
      'startDate', to_char(v_start, 'YYYY-MM-DD'),
      'sharePctFrozenForDemands', v_frozen,
      'note', 'Demand Record accounting restructure: switched on from the start of the web at the owner''s request'
    )
  );
end $$;
