-- Demand Record: start fresh from 1 Oct 2026, at the owner's request
-- (2026-10-24). Cash deposits were not recorded in the app before then, so the
-- balances carried from July–September are not money owed; every branch's
-- balance before 1 Oct counts as zero.
--
-- This moves finance_settings.account_ledger_start to 2026-10-01, which is what
-- Finance → Demand Record's start date does (setLedgerStart), and writes the
-- same audit entry. Only a start earlier than 1 Oct is moved, so running it
-- again — or on a database already started later — changes nothing. Every
-- October demand already has its % frozen (by the go-live), so no snapshot is
-- written; the September snapshots stay and are simply outside the record.
--
-- Recovery: set account_ledger_start back to the previous date in the audit
-- entry; nothing else changed.

do $$
declare
  v_prev date;
begin
  select account_ledger_start into v_prev from public.finance_settings limit 1 for update;
  if v_prev is null or v_prev >= date '2026-10-01' then
    return;
  end if;

  update public.finance_settings set account_ledger_start = date '2026-10-01';

  insert into public.finance_audit_logs (entity, entity_ref, action, actor_name, previous_values, new_values)
  values (
    'branch_account', 'go-live date', 'updated', 'system',
    jsonb_build_object('startDate', to_char(v_prev, 'YYYY-MM-DD')),
    jsonb_build_object(
      'startDate', '2026-10-01',
      'note', 'Start fresh from 1 Oct 2026 at the owner''s request: balances before it count as zero'
    )
  );
end $$;
