-- Cash deposits pass through Accounts before Finance Admin, by the owner's
-- order, 2026-10-28.
--
-- Before: a branch's deposit went straight into Finance Admin's queue. Now it
-- lands with Accounts first. The Accountant opens it, may correct its figures
-- or note (Edit), and sends it on (Submit for Approval). Only then may Finance
-- Admin approve or reject it. Income & Expense entries already work this way:
-- an entry is saved, then submitted, then decided.
--
-- The status stays `pending` for both halves: to every reader that counts
-- money (daily closing, missing-deposit check, the branch's daily limit) a
-- deposit with Accounts is exactly as unconfirmed as one with Finance Admin.
-- What tells the halves apart is `forwarded_at`:
--
--   pending, forwarded_at null      — with Accounts: Edit / Submit for Approval
--   pending, forwarded_at not null  — with Finance Admin: Approve / Reject
--
-- A rejected deposit the branch corrects and resubmits goes back to Accounts.
--
-- Existing pending deposits were already in Finance Admin's queue and stay
-- there: they are stamped forwarded at the time they were (re)submitted, with
-- no forwarder named.
-- ---------------------------------------------------------------------------

alter table public.cash_transfers
  add column forwarded_at      timestamptz,
  add column forwarded_by      uuid references public.users (id) on delete set null,
  add column forwarded_by_name text;

comment on column public.cash_transfers.forwarded_at is
  'When Accounts submitted the pending deposit for Finance Admin approval; null while it is with Accounts. Cleared when a rejected deposit is resubmitted.';

-- Before the trigger functions change, so the backfill writes no history and
-- leaves updated_at alone.
alter table public.cash_transfers disable trigger cash_transfers_touch;
update public.cash_transfers
   set forwarded_at = coalesce(resubmitted_at, created_at)
 where status = 'pending' and deleted_at is null;
alter table public.cash_transfers enable trigger cash_transfers_touch;

-- Legal moves, now with the Accounts step: Finance Admin decides only what
-- Accounts has submitted; a resubmission returns to Accounts.
create or replace function app.cash_transfer_guard() returns trigger
  language plpgsql as $$
  begin
    if new.status is distinct from old.status then
      if (old.status::text, new.status::text) not in (
        ('pending', 'approved'),
        ('pending', 'rejected'),
        ('rejected', 'pending')
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

-- History: Accounts' submission is its own event, carrying any correction
-- made in the same save.
create or replace function app.cash_transfer_event() returns trigger
  language plpgsql as $$
  declare
    v_event   text;
    v_actor   uuid;
    v_name    text;
    v_remarks text;
    v_changes jsonb := '{}'::jsonb;
  begin
    if tg_op = 'INSERT' then
      v_event := 'created'; v_actor := new.created_by; v_name := new.created_by_name; v_remarks := new.note;
    else
      v_changes := app.finance_row_changes(to_jsonb(old), to_jsonb(new), array[
        'business_date', 'branch_name', 'amount', 'cash_amount', 'easypaisa_amount',
        'bank_amount', 'fuel_charges', 'note']);

      if new.deleted_at is not null and old.deleted_at is null then
        v_event := 'deleted'; v_actor := new.deleted_by; v_name := new.deleted_by_name; v_remarks := new.delete_reason;
      elsif new.status is distinct from old.status then
        case new.status
          when 'pending' then
            v_event := 'resubmitted'; v_actor := new.resubmitted_by; v_name := new.resubmitted_by_name; v_remarks := new.note;
          when 'rejected' then
            v_event := 'rejected'; v_actor := new.approved_by; v_name := new.approved_by_name; v_remarks := new.rejection_reason;
          else
            v_event := 'approved'; v_actor := new.approved_by; v_name := new.approved_by_name; v_remarks := new.approval_note;
        end case;
      elsif new.forwarded_at is not null and old.forwarded_at is null then
        v_event := 'submitted'; v_actor := new.forwarded_by; v_name := new.forwarded_by_name;
      elsif v_changes <> '{}'::jsonb then
        v_event := case when new.status = 'approved' then 'corrected' else 'edited' end;
        v_actor := new.updated_by; v_name := new.updated_by_name;
      else
        return null;
      end if;
    end if;

    insert into public.finance_document_events (
      document_type, document_id, document_ref, revision, event, from_status, to_status,
      actor_id, actor_name, actor_role, remarks, changes, ledger_entry_id, voucher_no
    ) values (
      'cash_transfer', new.id, new.transfer_no, new.revision, v_event,
      case when tg_op = 'UPDATE' then old.status::text end, new.status::text,
      v_actor, v_name, app.finance_actor_role(v_actor), v_remarks, v_changes,
      new.ledger_entry_id, new.voucher_no
    );
    return null;
  end;
  $$;
