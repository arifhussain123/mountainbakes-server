-- Deleting a voucher never changes a closed day, by the owner's order, 2026-11-06.
--
-- Before: deleting an RV or PV (a Help Desk query, the Support Center deleting
-- a cash deposit) soft-deleted it whatever its date and recomputed the running
-- balance, so a voucher on a day Finance had already closed silently changed
-- that signed-off day and every closing after it. The ledger's own Reverse
-- refused such a voucher outright ("Reopen the day first").
--
-- Now one rule, for every RV and PV, in app.remove_or_reverse_ledger_entry:
--
--   its day is open, and no later day is closed
--       → REMOVED, as before: hidden from the ledger, totals and balances,
--         kept for audit with who / why, its number never reused;
--
--   its day is closed, or a later day is (deleting it would move the balance
--   that day signed off)
--       → ADJUSTED: the voucher stays exactly where it is and a reversing entry
--         is posted TODAY — the other side of the book, same head, account and
--         branch, "Reversal of RV-…", source 'adjustment'. The original is
--         marked reversed. An RV's reversal is money out, so it takes a PV-
--         number, and a PV's takes an RV- number. This is the reversal shape
--         the ledger has always used (migration 52).
--
-- Applies to:
--   * soft_delete_finance_record — a Help Desk query deleting a voucher, and the
--     Help Desk / Support Center deleting a cash deposit (its receipts follow
--     this rule one by one, in app.delete_cash_transfer_entries);
--   * reverse_finance_ledger_entry without a corrected figure — Finance Admin's
--     Reverse on the ledger.
-- A correction of a figure on a closed day is still refused, as before.
-- ---------------------------------------------------------------------------

-- Would removing a voucher dated p_date change a day Finance has signed off?
create function app.ledger_date_is_signed_off(p_date date) returns boolean
  language sql stable as $$
    select exists (select 1 from public.finance_day_closings where business_date >= p_date)
  $$;

create function app.remove_or_reverse_ledger_entry(
  p_entry_id   uuid,
  p_reason     text,
  p_actor_id   uuid,
  p_actor_name text,
  p_query_id   uuid,
  p_query_no   text,
  p_today      date default null
) returns jsonb
  language plpgsql
  set search_path to 'public', 'app'
  as $$
  declare
    v_orig ledger_entries%rowtype;
    v_rev  ledger_entries%rowtype;
    v_today date := coalesce(p_today, app.karachi_business_date());
  begin
    select * into v_orig from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      return jsonb_build_object('action', null);
    end if;

    -- A live original on a signed-off day: adjust, never remove.
    if v_orig.status <> 'reversed' and v_orig.reverses_entry_id is null
       and app.ledger_date_is_signed_off(v_orig.entry_date) then
      select * into v_rev from post_finance_ledger_entry(
        p_entry_date        => v_today,
        p_ledger_head_id    => v_orig.ledger_head_id,
        p_description       => 'Reversal of ' || v_orig.voucher_no || ' — ' || btrim(p_reason),
        p_debit             => v_orig.credit,
        p_credit            => v_orig.debit,
        p_account           => v_orig.account,
        p_source_type       => 'adjustment',
        p_source_id         => v_orig.id,
        p_branch_id         => v_orig.branch_id,
        p_branch_name       => v_orig.branch_name,
        p_payment_method    => v_orig.payment_method,
        p_approved_by       => p_actor_id,
        p_approved_by_name  => p_actor_name,
        p_created_by        => p_actor_id,
        p_created_by_name   => p_actor_name,
        p_reverses_entry_id => v_orig.id
      );
      update ledger_entries
         set status = 'reversed', reversed_by_entry_id = v_rev.id
       where id = v_orig.id;
      return jsonb_build_object('action', 'reversed', 'voucherNo', v_orig.voucher_no, 'reversalVoucherNo', v_rev.voucher_no);
    end if;

    -- A reversal pair already on a signed-off day stays as it is.
    if app.ledger_date_is_signed_off(v_orig.entry_date) then
      return jsonb_build_object('action', 'kept', 'voucherNo', v_orig.voucher_no);
    end if;

    update ledger_entries
       set deleted_at       = now(),
           deleted_by       = p_actor_id,
           deleted_by_name  = p_actor_name,
           delete_reason    = p_reason,
           deleted_query_id = p_query_id,
           deleted_query_no = p_query_no
     where id = v_orig.id;
    -- Closed in the same transaction, before anything else posts.
    return jsonb_build_object('action', 'deleted', 'voucherNo', v_orig.voucher_no,
                              'recompute', recompute_finance_ledger_balances());
  end;
  $$;

revoke all on function app.remove_or_reverse_ledger_entry(uuid, text, uuid, text, uuid, text, date) from public;
revoke all on function app.ledger_date_is_signed_off(date) from public;
grant execute on function app.remove_or_reverse_ledger_entry(uuid, text, uuid, text, uuid, text, date) to service_role;
grant execute on function app.ledger_date_is_signed_off(date) to service_role;

-- A deleted cash deposit's receipts: removed on open days, reversed today on
-- signed-off ones. A reversal whose original sits on a signed-off day is kept,
-- so that original is never left marked reversed with nothing reversing it.
create or replace function app.delete_cash_transfer_entries(p_id uuid, p_reason text, p_actor_id uuid, p_actor_name text, p_query_id uuid, p_query_no text)
  returns jsonb
  language plpgsql
  as $$
  declare
    r           record;
    v_out       jsonb;
    v_removed   text[] := '{}';
    v_reversed  text[] := '{}';
    v_recompute jsonb;
  begin
    -- Removals first (each recomputes), then reversals (each posts at the end).
    for r in
      select e.id, e.voucher_no
        from ledger_entries e
       where e.id in (select app.cash_transfer_ledger_chain(p_id)) and e.deleted_at is null
         and not app.ledger_date_is_signed_off(e.entry_date)
         and not exists (select 1 from ledger_entries o
                          where o.id = e.reverses_entry_id and app.ledger_date_is_signed_off(o.entry_date))
       order by e.seq
    loop
      v_out := app.remove_or_reverse_ledger_entry(r.id, p_reason, p_actor_id, p_actor_name, p_query_id, p_query_no);
      if v_out ->> 'action' = 'deleted' then v_removed := v_removed || r.voucher_no; end if;
    end loop;

    for r in
      select e.id
        from ledger_entries e
       where e.id in (select app.cash_transfer_ledger_chain(p_id)) and e.deleted_at is null
         and e.status <> 'reversed' and e.reverses_entry_id is null
         and app.ledger_date_is_signed_off(e.entry_date)
       order by e.seq
    loop
      v_out := app.remove_or_reverse_ledger_entry(r.id, p_reason, p_actor_id, p_actor_name, p_query_id, p_query_no);
      if v_out ->> 'action' = 'reversed' then
        v_reversed := v_reversed || ((v_out ->> 'voucherNo') || ' → ' || (v_out ->> 'reversalVoucherNo'));
      end if;
    end loop;

    -- For the caller's report: where the book landed.
    if cardinality(v_removed) > 0 or cardinality(v_reversed) > 0 then
      v_recompute := recompute_finance_ledger_balances();
    end if;

    return jsonb_build_object(
      'voucherNos',  nullif(array_to_string(v_removed, ', '), ''),
      'reversed',    nullif(array_to_string(v_reversed, ', '), ''),
      'recompute',   v_recompute
    );
  end;
  $$;

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
        returning salary_no into v_ref;

      when 'employee_advance' then
        update employee_advances
           set deleted_at = now(), deleted_by = p_actor_id, deleted_by_name = p_actor_name,
               delete_reason = p_reason, deleted_query_id = p_query_id, deleted_query_no = p_query_no
         where id = p_reference_id and deleted_at is null
        returning advance_no into v_ref;

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

-- Finance Admin's Reverse. A corrected figure is still an in-place edit (and
-- still refused on a closed day); a plain Reverse follows the rule above and
-- returns the reversing entry when it posted one, else the removed voucher.
create or replace function public.reverse_finance_ledger_entry(p_entry_id uuid, p_entry_date date, p_reason text, p_actor_id uuid, p_actor_name text, p_corrected_amount numeric default null::numeric, p_corrected_description text default null::text)
  returns setof public.ledger_entries
  language plpgsql
  as $$
  declare
    v_orig   ledger_entries%rowtype;
    v_set    jsonb := '{}'::jsonb;
    v_out    jsonb;
  begin
    select * into v_orig from ledger_entries where id = p_entry_id and deleted_at is null for update;
    if not found then
      raise exception 'ledger entry % does not exist, or it has already been deleted', p_entry_id;
    end if;
    if v_orig.status = 'reversed' then
      raise exception 'voucher % was reversed by % and is no longer part of the book',
        v_orig.voucher_no, coalesce((select voucher_no from ledger_entries where id = v_orig.reversed_by_entry_id), '?');
    end if;
    if v_orig.reverses_entry_id is not null then
      raise exception 'voucher % is a reversing entry and cannot be changed', v_orig.voucher_no;
    end if;

    if p_corrected_amount is not null or nullif(btrim(coalesce(p_corrected_description, '')), '') is not null then
      if p_corrected_amount is not null then
        v_set := v_set || jsonb_build_object('amount', round(p_corrected_amount, 2));
      end if;
      if nullif(btrim(coalesce(p_corrected_description, '')), '') is not null then
        v_set := v_set || jsonb_build_object('description', btrim(p_corrected_description));
      end if;
      perform app.edit_ledger_entry(p_entry_id, v_set, p_actor_id, p_actor_name, p_entry_date);
    else
      v_out := app.remove_or_reverse_ledger_entry(p_entry_id, p_reason, p_actor_id, p_actor_name, null, null, p_entry_date);
      if v_out ->> 'action' = 'reversed' then
        return query select * from ledger_entries where voucher_no = v_out ->> 'reversalVoucherNo';
        return;
      end if;
    end if;

    return query select * from ledger_entries where id = p_entry_id;
  end;
  $$;
