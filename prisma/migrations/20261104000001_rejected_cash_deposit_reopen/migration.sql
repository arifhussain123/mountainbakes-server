-- A rejected cash deposit is no longer final, by the owner's order, 2026-11-04.
--
-- Before: Finance's rejection ended a CT- for good. The Support Center showed
-- "rejected and final — nothing can be corrected"; amend_finance_record and
-- amend_cash_transfer_date refused it; the only way back was the branch
-- correcting it and resubmitting it through Accounts.
--
-- Now a Super Admin answering a query about a rejected deposit may, from the
-- Support Center:
--   * correct its Cash / Easypaisa / Bank / Fuel Charges, note and date, and
--   * move it straight from Rejected to Approved — which books it exactly as a
--     normal approval does (RV- receipts via app.sync_cash_transfer_entries,
--     dated the deposit's day, or today if Finance has closed that day),
--   * or delete it (already possible: soft_delete_finance_record takes any status).
--
-- Both writes happen in one statement here, so a refused posting (a closed
-- head, a zero deposit) leaves the deposit rejected and uncorrected rather
-- than half-done. The history trigger records the correction as 'edited' and
-- the decision as 'approved' (from_status 'rejected'); the rejection that
-- preceded it stays in finance_document_events.
--
-- The branch's own Resubmit path (rejected → pending) is unchanged.
-- ---------------------------------------------------------------------------

-- Legal moves: everything from migration 20261028000002, plus rejected → approved.
create or replace function app.cash_transfer_guard() returns trigger
  language plpgsql as $$
  begin
    if new.status is distinct from old.status then
      if (old.status::text, new.status::text) not in (
        ('pending', 'approved'),
        ('pending', 'rejected'),
        ('rejected', 'pending'),
        ('rejected', 'approved')
      ) then
        raise exception 'Transfer % cannot move from % to %.', old.transfer_no, old.status, new.status
          using errcode = 'P0001';
      end if;
      if old.status = 'pending' and old.forwarded_at is null then
        raise exception 'Transfer % is still with Accounts — it must be submitted for approval first.', old.transfer_no
          using errcode = 'P0001';
      end if;
      if old.status = 'rejected' and new.status = 'pending' then
        new.revision := old.revision + 1;
        new.forwarded_at := null;
        new.forwarded_by := null;
        new.forwarded_by_name := null;
      end if;
    else
      new.revision := old.revision;
      if new.forwarded_at is not null and old.forwarded_at is null and new.status <> 'pending' then
        raise exception 'Transfer % is % — only a pending transfer is submitted for approval.', old.transfer_no, old.status
          using errcode = 'P0001';
      end if;
    end if;
    return new;
  end;
  $$;

-- Correct a REJECTED deposit and, when p_approve, approve it — one transaction.
-- Every figure is the deposit's final value (the caller merges its edits onto
-- the live row); a null date keeps the current one.
create function public.correct_rejected_cash_transfer(
  p_id            uuid,
  p_cash          numeric,
  p_easypaisa     numeric,
  p_bank          numeric,
  p_fuel          numeric,
  p_note          text,
  p_business_date date,
  p_approve       boolean,
  p_actor_id      uuid,
  p_actor_name    text,
  p_today         date,
  p_approval_note text default null
) returns public.cash_transfers
  language plpgsql as $$
  declare
    v_row    public.cash_transfers%rowtype;
    v_cash   numeric := round(coalesce(p_cash, 0), 2);
    v_ep     numeric := round(coalesce(p_easypaisa, 0), 2);
    v_bank   numeric := round(coalesce(p_bank, 0), 2);
    v_fuel   numeric := round(coalesce(p_fuel, 0), 2);
    v_date   date;
    v_posted jsonb;
  begin
    select * into v_row from public.cash_transfers
     where id = p_id and deleted_at is null
       for update;
    if not found then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;
    if v_row.status <> 'rejected' then
      raise exception 'Transfer % is % — only a rejected transfer is corrected or approved here.',
        v_row.transfer_no, v_row.status using errcode = 'P0001';
    end if;
    if v_cash < 0 or v_ep < 0 or v_bank < 0 or v_fuel < 0 then
      raise exception 'The amounts of a cash deposit must each be 0 or more.' using errcode = 'P0001';
    end if;
    if v_cash + v_ep + v_bank + v_fuel <= 0 then
      raise exception 'Every amount of % would be 0. Delete the deposit instead of zeroing it.', v_row.transfer_no
        using errcode = 'P0001';
    end if;
    if p_business_date is not null and p_business_date > p_today then
      raise exception 'The date of a cash deposit cannot be in the future.' using errcode = 'P0001';
    end if;

    -- 1. The correction. Status unchanged, so the history logs it as 'edited'
    --    (and logs nothing when every value already matched).
    update public.cash_transfers
       set cash_amount      = v_cash,
           easypaisa_amount = v_ep,
           bank_amount      = v_bank,
           fuel_charges     = v_fuel,
           amount           = v_cash + v_ep + v_bank,
           payment_method   = case
                                when (v_cash, v_ep, v_bank) is distinct from
                                     (v_row.cash_amount, v_row.easypaisa_amount, v_row.bank_amount)
                                then null else payment_method
                              end,
           note             = nullif(btrim(coalesce(p_note, '')), ''),
           business_date    = coalesce(p_business_date, business_date),
           updated_by       = p_actor_id,
           updated_by_name  = p_actor_name
     where id = p_id
     returning * into v_row;

    if not coalesce(p_approve, false) then
      return v_row;
    end if;

    -- 2. The decision, booked as approve_cash_transfer books a pending one:
    --    dated the day the money moved, unless Finance has closed it.
    v_date := v_row.business_date;
    if exists (select 1 from finance_day_closings where business_date = v_date) then
      v_date := p_today;
    end if;

    v_posted := app.sync_cash_transfer_entries(p_id, v_date, null, p_actor_id, p_actor_name);

    -- The rejection reason is cleared from the row (an approved deposit showing
    -- one reads as rejected); the 'rejected' history event keeps it.
    update public.cash_transfers
       set status           = 'approved',
           approved_by      = p_actor_id,
           approved_by_name = p_actor_name,
           approved_at      = now(),
           approval_note    = nullif(btrim(coalesce(p_approval_note, '')), ''),
           rejection_reason = null,
           ledger_entry_id  = (v_posted ->> 'firstEntryId')::uuid,
           voucher_no       = v_posted ->> 'voucherNos'
     where id = p_id
     returning * into v_row;

    return v_row;
  end;
  $$;

comment on function public.correct_rejected_cash_transfer(uuid, numeric, numeric, numeric, numeric, text, date, boolean, uuid, text, date, text) is
  'Support Center: correct a REJECTED cash transfer''s figures, note and date and, when p_approve, move it rejected → approved, posting its RV- receipts as approve_cash_transfer does. One transaction. P0001 if not rejected or all zero; P0002 if missing.';
