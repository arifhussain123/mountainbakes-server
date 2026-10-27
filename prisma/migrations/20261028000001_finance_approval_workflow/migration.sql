-- Finance approval workflow: Accountant → Finance Admin, end to end and on the
-- record.
--
-- What was already true and stays so: an Income & Expense entry
-- (finance_transactions) is raised as a draft or straight into the queue,
-- reaches the Daily Ledger only when an approver approves it, and only then
-- gets an RV- / PV- voucher (post_finance_ledger_entry). What this adds:
--
--   1. APPROVAL IS ONE TRANSACTION. approve_finance_transaction locks the
--      entry, posts the voucher and marks it posted in one statement, as
--      approve_cash_transfer already does for deposits. Before, the API marked
--      it approved and then posted in a second call, so a refused posting (a
--      closed day, an inactive head) left an entry "approved" with no voucher.
--      Now any failure rolls the lot back, voucher number included, and the
--      entry stays pending.
--   2. WHO DID WHAT, KEPT. Submitted-by/at, rejected-by/at (a rejection used to
--      be written into the approved_* columns), the approver's note (it used to
--      overwrite the accountant's notes) and a revision that goes up on every
--      resubmission.
--   3. A HISTORY THAT CANNOT BE SKIPPED. finance_document_events gets one row
--      per create / edit / submit / reject / resubmit / approve / delete, from
--      triggers, so no code path can change an entry or a cash deposit without
--      leaving a row. Append-only. A rejection's remarks stay in it after the
--      entry is corrected and resubmitted.
--   4. LEGAL MOVES ONLY. A trigger refuses a status change the workflow does not
--      have (e.g. rejected → posted, posted → pending) and a posted entry with
--      no voucher.
--   5. A REJECTED CASH DEPOSIT CAN BE CORRECTED AND RESUBMITTED by its branch
--      (resubmit_cash_transfer): the same CT- row, its branch and date fixed,
--      the revision up, back in Finance's queue.
--
-- Existing rows are kept. The only rewrite is moving a rejection's decider out
-- of approved_* into rejected_* (with updated_at left alone), and recording a
-- non-draft entry's creator as its submitter — every entry not saved as a draft
-- went into the queue the moment it was created.
-- ---------------------------------------------------------------------------

-- 1. finance_transactions: the decision trail ---------------------------------

alter table public.finance_transactions
  add column submitted_by      uuid references public.users (id) on delete set null,
  add column submitted_by_name text,
  add column submitted_at      timestamptz,
  add column rejected_by       uuid references public.users (id) on delete set null,
  add column rejected_by_name  text,
  add column rejected_at       timestamptz,
  add column updated_by        uuid references public.users (id) on delete set null,
  add column updated_by_name   text,
  add column approval_note     text,
  add column revision          integer not null default 1 constraint finance_transactions_revision_check check (revision >= 1);

alter table public.finance_transactions disable trigger finance_transactions_touch;

update public.finance_transactions
   set rejected_by      = approved_by,
       rejected_by_name = approved_by_name,
       rejected_at      = approved_at,
       approved_by      = null,
       approved_by_name = null,
       approved_at      = null
 where status = 'rejected';

update public.finance_transactions
   set submitted_by      = created_by,
       submitted_by_name = created_by_name,
       submitted_at      = created_at
 where status <> 'draft';

alter table public.finance_transactions enable trigger finance_transactions_touch;

-- A rejection says why. NOT VALID: enforced from here on without re-reading
-- history (every rejection so far went through RejectSchema anyway).
alter table public.finance_transactions
  add constraint finance_transactions_rejection_has_reason
  check (status <> 'rejected' or nullif(btrim(coalesce(rejection_reason, '')), '') is not null) not valid;

-- One entry, one voucher: no two entries can point at the same ledger row.
create unique index finance_transactions_ledger_entry_key
  on public.finance_transactions (ledger_entry_id) where ledger_entry_id is not null;

-- The approval queue: oldest submission first, pending only.
create index finance_transactions_queue_idx
  on public.finance_transactions (submitted_at) where status = 'pending_approval' and deleted_at is null;

-- 2. cash_transfers: correct and resubmit -------------------------------------

alter table public.cash_transfers
  add column revision            integer not null default 1 constraint cash_transfers_revision_check check (revision >= 1),
  add column resubmitted_at      timestamptz,
  add column resubmitted_by      uuid references public.users (id) on delete set null,
  add column resubmitted_by_name text;

-- 3. The history -----------------------------------------------------------------

create table public.finance_document_events (
  id            uuid primary key default gen_random_uuid(),
  document_type text not null constraint finance_document_events_type_check
                check (document_type in ('finance_transaction', 'cash_transfer')),
  -- No foreign key: the table is append-only, and a key with an ON DELETE
  -- action would make Postgres try to update it.
  document_id   uuid not null,
  document_ref  text,
  revision      integer not null default 1,
  event         text not null constraint finance_document_events_event_check
                check (event in ('created', 'edited', 'corrected', 'submitted', 'resubmitted',
                                 'approved', 'rejected', 'locked', 'reopened', 'deleted')),
  from_status   text,
  to_status     text not null,
  actor_id      uuid,
  actor_name    text,
  actor_role    text,
  remarks       text,
  -- { field: { "from": …, "to": … } } for every figure the change moved.
  changes       jsonb not null default '{}'::jsonb,
  ledger_entry_id uuid,
  voucher_no    text,
  created_at    timestamptz not null default now()
);

comment on table public.finance_document_events is
  'Append-only workflow history of Income & Expense entries and cash deposits: one row per create, edit, submit, reject, resubmit, approve and delete, written by triggers on finance_transactions and cash_transfers.';

create index finance_document_events_doc_idx
  on public.finance_document_events (document_type, document_id, created_at);

create function app.finance_document_events_immutable() returns trigger
  language plpgsql as $$
  begin
    raise exception 'finance_document_events is append-only' using errcode = 'P0001';
  end;
  $$;

create trigger finance_document_events_immutable
  before update or delete on public.finance_document_events
  for each row execute function app.finance_document_events_immutable();

-- { field: { from, to } } for the named columns that differ between two rows.
create function app.finance_row_changes(p_old jsonb, p_new jsonb, p_fields text[]) returns jsonb
  language sql immutable as $$
  select coalesce(jsonb_object_agg(f, jsonb_build_object('from', p_old -> f, 'to', p_new -> f)), '{}'::jsonb)
    from unnest(p_fields) as f
   where (p_old -> f) is distinct from (p_new -> f)
  $$;

create function app.finance_actor_role(p_actor uuid) returns text
  language sql stable as $$
  select role::text from public.users where id = p_actor
  $$;

-- 4. finance_transactions: legal moves, revision, history ---------------------

create function app.finance_transaction_guard() returns trigger
  language plpgsql as $$
  begin
    if new.status is distinct from old.status then
      if (old.status::text, new.status::text) not in (
        ('draft', 'pending_approval'),
        ('draft', 'rejected'),
        ('pending_approval', 'rejected'),
        ('pending_approval', 'approved'),
        ('pending_approval', 'posted'),
        ('approved', 'posted'),
        ('rejected', 'pending_approval'),
        ('posted', 'locked'),
        ('locked', 'posted')
      ) then
        raise exception '% cannot move from % to %.', old.txn_no, old.status, new.status using errcode = 'P0001';
      end if;
      -- A correction sent back for review is the next revision of the same entry.
      if old.status = 'rejected' and new.status = 'pending_approval' then
        new.revision := old.revision + 1;
      end if;
    else
      new.revision := old.revision;
    end if;

    if new.status in ('posted', 'locked') and new.ledger_entry_id is null then
      raise exception '% cannot be % without its ledger entry.', new.txn_no, new.status using errcode = 'P0001';
    end if;
    return new;
  end;
  $$;

create trigger finance_transactions_guard
  before update on public.finance_transactions
  for each row execute function app.finance_transaction_guard();

create function app.finance_transaction_event() returns trigger
  language plpgsql as $$
  declare
    v_event   text;
    v_actor   uuid;
    v_name    text;
    v_remarks text;
    v_changes jsonb := '{}'::jsonb;
    v_voucher text;
  begin
    if tg_op = 'INSERT' then
      v_event := 'created';
      v_actor := new.created_by;
      v_name  := new.created_by_name;
    else
      v_changes := app.finance_row_changes(to_jsonb(old), to_jsonb(new), array[
        'business_date', 'txn_type', 'ledger_head_name', 'branch_name', 'description',
        'amount', 'payment_method', 'account', 'reference_no', 'notes']);

      if new.deleted_at is not null and old.deleted_at is null then
        v_event := 'deleted'; v_actor := new.deleted_by; v_name := new.deleted_by_name; v_remarks := new.delete_reason;
      elsif new.status is distinct from old.status then
        case new.status
          when 'pending_approval' then
            v_event := case when old.status = 'rejected' then 'resubmitted' else 'submitted' end;
            v_actor := new.submitted_by; v_name := new.submitted_by_name;
          when 'rejected' then
            v_event := 'rejected'; v_actor := new.rejected_by; v_name := new.rejected_by_name; v_remarks := new.rejection_reason;
          when 'locked' then
            v_event := 'locked';
          when 'posted' then
            if old.status = 'locked' then
              v_event := 'reopened';
            else
              v_event := 'approved'; v_actor := new.approved_by; v_name := new.approved_by_name; v_remarks := new.approval_note;
            end if;
          else
            v_event := 'approved'; v_actor := new.approved_by; v_name := new.approved_by_name; v_remarks := new.approval_note;
        end case;
      elsif v_changes <> '{}'::jsonb then
        -- A posted entry changes only through a Help Desk correction (its own
        -- reversal and re-post); anything earlier is the author's edit.
        v_event := case when new.status in ('posted', 'locked') then 'corrected' else 'edited' end;
        v_actor := new.updated_by; v_name := new.updated_by_name;
      else
        return null;
      end if;
    end if;

    if new.ledger_entry_id is not null then
      select voucher_no into v_voucher from public.ledger_entries where id = new.ledger_entry_id;
    end if;

    insert into public.finance_document_events (
      document_type, document_id, document_ref, revision, event, from_status, to_status,
      actor_id, actor_name, actor_role, remarks, changes, ledger_entry_id, voucher_no
    ) values (
      'finance_transaction', new.id, new.txn_no, new.revision, v_event,
      case when tg_op = 'UPDATE' then old.status::text end, new.status::text,
      v_actor, v_name, app.finance_actor_role(v_actor), v_remarks, v_changes,
      new.ledger_entry_id, v_voucher
    );
    return null;
  end;
  $$;

create trigger finance_transactions_event
  after insert or update on public.finance_transactions
  for each row execute function app.finance_transaction_event();

-- 5. Approve = post, atomically -------------------------------------------------

create function public.approve_finance_transaction(
  p_id uuid,
  p_actor_id uuid,
  p_actor_name text,
  p_note text default null
) returns public.finance_transactions
  language plpgsql as $$
  declare
    v_row   public.finance_transactions%rowtype;
    v_entry public.ledger_entries%rowtype;
  begin
    -- The row lock is what makes two approvers at the same moment safe: the
    -- second waits here, then finds the entry posted and is refused.
    select * into v_row from public.finance_transactions
     where id = p_id and deleted_at is null
       for update;
    if not found then
      raise exception 'Entry % does not exist.', p_id using errcode = 'P0002';
    end if;
    if v_row.status = 'draft' then
      raise exception '% is a draft. Submit it for approval first.', v_row.txn_no using errcode = 'P0001';
    end if;
    if v_row.status <> 'pending_approval' or v_row.ledger_entry_id is not null then
      raise exception '% is % and cannot be approved again.', v_row.txn_no, v_row.status using errcode = 'P0001';
    end if;
    if exists (select 1 from public.finance_day_closings where business_date = v_row.business_date) then
      raise exception 'The finance day % is closed, so % cannot be posted on it. Reject it so the date can be corrected.',
        v_row.business_date, v_row.txn_no using errcode = 'P0001';
    end if;

    -- Raises (and so rolls this whole statement back, voucher number and all)
    -- on an inactive head or a zero amount.
    v_entry := public.post_finance_ledger_entry(
      v_row.business_date,
      v_row.ledger_head_id,
      v_row.description || ' (' || v_row.txn_no || ')',
      case when v_row.txn_type = 'income' then v_row.amount else 0 end,
      case when v_row.txn_type = 'expense' then v_row.amount else 0 end,
      v_row.account,
      'manual',
      v_row.id,
      v_row.branch_id,
      v_row.branch_name,
      v_row.payment_method,
      p_actor_id, p_actor_name,
      p_actor_id, p_actor_name,
      null
    );

    update public.finance_transactions
       set status           = 'posted',
           approved_by      = p_actor_id,
           approved_by_name = p_actor_name,
           approved_at      = now(),
           approval_note    = nullif(btrim(coalesce(p_note, '')), ''),
           ledger_entry_id  = v_entry.id
     where id = p_id
     returning * into v_row;

    return v_row;
  end;
  $$;

comment on function public.approve_finance_transaction(uuid, uuid, text, text) is
  'Atomically approve a pending Income & Expense entry: posts its RV-/PV- voucher via post_finance_ledger_entry and marks it posted. P0001 if not pending, already posted or the day is closed; P0002 if missing. Any failure rolls back the voucher number too.';

-- 6. cash_transfers: legal moves, history, resubmission -------------------------

create function app.cash_transfer_guard() returns trigger
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
      if old.status = 'rejected' and new.status = 'pending' then
        new.revision := old.revision + 1;
      end if;
    else
      new.revision := old.revision;
    end if;
    return new;
  end;
  $$;

create trigger cash_transfers_guard
  before update on public.cash_transfers
  for each row execute function app.cash_transfer_guard();

create function app.cash_transfer_event() returns trigger
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

create trigger cash_transfers_event
  after insert or update on public.cash_transfers
  for each row execute function app.cash_transfer_event();

-- The branch corrects the figures it is allowed to and sends the same deposit
-- back. The branch and the business date are not parameters: a rejection does
-- not move a deposit to another branch or day.
create function public.resubmit_cash_transfer(
  p_id uuid,
  p_branch_id uuid,
  p_actor_id uuid,
  p_actor_name text,
  p_cash numeric,
  p_easypaisa numeric,
  p_bank numeric,
  p_fuel numeric,
  p_note text default null
) returns public.cash_transfers
  language plpgsql as $$
  declare
    v_row public.cash_transfers%rowtype;
  begin
    select * into v_row from public.cash_transfers
     where id = p_id and deleted_at is null
       for update;
    if not found or (p_branch_id is not null and v_row.branch_id <> p_branch_id) then
      raise exception 'cash transfer % does not exist', p_id using errcode = 'P0002';
    end if;
    if v_row.status <> 'rejected' then
      raise exception 'Transfer % is % — only a rejected transfer can be corrected and resubmitted.',
        v_row.transfer_no, v_row.status using errcode = 'P0001';
    end if;

    update public.cash_transfers
       set cash_amount         = round(coalesce(p_cash, 0), 2),
           easypaisa_amount    = round(coalesce(p_easypaisa, 0), 2),
           bank_amount         = round(coalesce(p_bank, 0), 2),
           fuel_charges        = round(coalesce(p_fuel, 0), 2),
           amount              = round(coalesce(p_cash, 0), 2) + round(coalesce(p_easypaisa, 0), 2) + round(coalesce(p_bank, 0), 2),
           note                = nullif(btrim(coalesce(p_note, '')), ''),
           status              = 'pending',
           approved_by         = null,
           approved_by_name    = null,
           approved_at         = null,
           approval_note       = null,
           rejection_reason    = null,
           resubmitted_at      = now(),
           resubmitted_by      = p_actor_id,
           resubmitted_by_name = p_actor_name,
           updated_by          = p_actor_id,
           updated_by_name     = p_actor_name
     where id = p_id
     returning * into v_row;

    return v_row;
  end;
  $$;

comment on function public.resubmit_cash_transfer(uuid, uuid, uuid, text, numeric, numeric, numeric, numeric, text) is
  'A branch corrects a REJECTED cash transfer and sends it back to Finance: same row and CT- number, branch and business date unchanged, revision + 1. P0001 if not rejected; P0002 if missing or another branch''s.';
