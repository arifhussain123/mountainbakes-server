-- Only a deleted payslip or advance takes its voucher out of the Daily Ledger
-- (owner, 2026-11-11).
--
-- 20261111000003 made every document deleted through a Finance Query remove
-- (or, on a closed day, reverse) its RV- / PV-. The owner wants that for
-- payslips and advances only. An Income & Expense entry, a partner expense and
-- a branch share payment go back to the behaviour before it: the document is
-- deleted and its voucher stays in the book.
--
-- Same signature; only those three branches change.

create or replace function public.soft_delete_finance_record(p_reference_type text, p_reference_id uuid, p_reason text, p_actor_id uuid, p_actor_name text, p_query_id uuid, p_query_no text)
  returns jsonb
  language plpgsql security definer
  set search_path to 'public', 'app'
  as $$
  declare
    v_ref       text;
    v_recompute jsonb;
    v_ct_ledger jsonb;
    v_out       jsonb;
    v_reversed  text;
    v_entry     uuid;
    v_bonus     uuid;
    v_eid       uuid;
    v_removed   text[] := '{}';
    v_rev_list  text[] := '{}';
  begin
    if p_reference_id is null then
      return jsonb_build_object('deleted', false, 'reason', 'the query names no finance record');
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'a deletion must carry a reason';
    end if;

    case p_reference_type

      -- An RV / PV: removed on an open day, reversed today on a signed-off one.
      when 'ledger_entry' then
        v_out := app.remove_or_reverse_ledger_entry(
          p_reference_id, p_reason, p_actor_id, p_actor_name, p_query_id, p_query_no);
        case v_out ->> 'action'
          when 'deleted' then
            v_ref := v_out ->> 'voucherNo';
            v_recompute := v_out -> 'recompute';
          when 'reversed' then
            v_ref := v_out ->> 'voucherNo';
            v_reversed := (v_out ->> 'voucherNo') || ' → ' || (v_out ->> 'reversalVoucherNo');
          when 'kept' then
            return jsonb_build_object('deleted', false, 'reason',
              (v_out ->> 'voucherNo') || ' is already reversed on a closed day and stays as it is');
          else
            v_ref := null;
        end case;

      when 'income_approval' then
        update finance_income_approvals
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning reference_no into v_ref;

      when 'finance_transaction' then
        update finance_transactions
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning txn_no into v_ref;

      when 'salary_payment' then
        update salary_payments
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning salary_no, ledger_entry_id into v_ref, v_entry;

      when 'employee_advance' then
        update employee_advances
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning advance_no, ledger_entry_id into v_ref, v_entry;

      when 'partner_expense' then
        update partner_expenses
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning expense_no into v_ref;

      when 'branch_share_payment' then
        update branch_share_payments
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning payment_no into v_ref;

      -- The deposit is removed; each of its receipts is removed or reversed by
      -- the rule above (app.delete_cash_transfer_entries).
      when 'cash_transfer' then
        update cash_transfers
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning transfer_no into v_ref;

        if v_ref is not null then
          v_ct_ledger := app.delete_cash_transfer_entries(
            p_reference_id, p_reason, p_actor_id, p_actor_name, p_query_id, p_query_no
          );
          v_recompute := v_ct_ledger -> 'recompute';
          v_reversed := v_ct_ledger ->> 'reversed';
        end if;

      else
        raise exception 'unknown finance reference type "%"', p_reference_type;
    end case;

    if v_ref is null then
      return jsonb_build_object('deleted', false, 'reason', 'already deleted, or no longer present');
    end if;

    -- A payslip's or advance's voucher follows it out of the book by the same
    -- rule as a deleted RV / PV: removed on an open day, reversed today on a
    -- signed-off one. Skipped when Finance Admin has already reversed the
    -- voucher — its reversing entry already cancels it. Only those two set
    -- v_entry; every other document keeps its voucher (owner, 2026-11-11).
    if v_entry is not null or v_bonus is not null then
      for v_eid in
        select le.id from ledger_entries le
         where le.id in (v_entry, v_bonus)
           and le.deleted_at is null and le.status <> 'reversed'
         order by le.seq
      loop
        v_out := app.remove_or_reverse_ledger_entry(
          v_eid, p_reason, p_actor_id, p_actor_name, p_query_id, p_query_no);
        case v_out ->> 'action'
          when 'deleted' then
            v_removed := v_removed || (v_out ->> 'voucherNo');
            v_recompute := v_out -> 'recompute';
          when 'reversed' then
            v_rev_list := v_rev_list || ((v_out ->> 'voucherNo') || ' → ' || (v_out ->> 'reversalVoucherNo'));
          else
            null;
        end case;
      end loop;
      if cardinality(v_removed) > 0 then
        v_ct_ledger := jsonb_build_object('voucherNos', array_to_string(v_removed, ', '));
      end if;
      if cardinality(v_rev_list) > 0 then
        v_reversed := array_to_string(v_rev_list, ', ');
      end if;
    end if;

    return jsonb_build_object(
      'deleted',           true,
      'referenceType',     p_reference_type,
      'referenceNo',       v_ref,
      'ledgerRemoved',     v_ct_ledger ->> 'voucherNos',
      -- "RV-000239 → PV-000756": vouchers on a closed day, reversed today instead of removed.
      'ledgerReversed',    v_reversed,
      'balancesRewritten', coalesce((v_recompute -> 'updated')::int, 0),
      'closingBalance',    v_recompute -> 'closingAfter'
    );
  end;
  $$;
