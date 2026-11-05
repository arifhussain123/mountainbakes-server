-- A cash deposit and its ledger receipts can no longer disagree, 2026-11-06.
--
-- What happened: on 2026-10-10 the Cash / Easypaisa figures of five approved
-- Committee Chowk deposits (CT-000006/7/8/9/11) were changed in one statement
-- outside the app. Their receipts (RV-000239, 241, 248, 260, 263) kept the old
-- totals, 33,310 short, until a data fix brought them up on 2026-11-06. Every
-- app path already keeps the two in step — a Support Center correction of an
-- approved deposit re-books its RVs in the same transaction — but nothing
-- stopped a write that bypassed those paths.
--
-- Now the database checks, when a transaction COMMITS, every deposit it touched
-- (directly, or through one of its receipts):
--
--   approved and live → its live receipts under Company Share / Cash Received
--                       from Branch add up to Cash + Easypaisa + Bank, and its
--                       live Fuel receipts add up to Fuel Charges;
--   pending, rejected
--   or deleted        → it has no live receipt at all.
--
-- "Live" = not deleted, not reversed, not itself a reversing entry. The check
-- is by totals, so the older shapes (migration 121's one voucher per account,
-- the old Cash Received from Branch head) still pass.
--
-- It runs at commit (a deferred constraint trigger), so the app's own paths —
-- which change the deposit and its receipts inside one transaction — are never
-- caught half-way. A write that leaves them apart fails as a whole, with a
-- message naming the deposit, and nothing is saved.
--
-- Checked against the live data on 2026-11-06: no approved deposit differs.
-- ---------------------------------------------------------------------------

create function app.assert_cash_transfer_booked(p_id uuid) returns void
  language plpgsql as $$
  declare
    v_row   public.cash_transfers%rowtype;
    v_total numeric(14,2);
    v_fuel  numeric(14,2);
    v_live  integer;
  begin
    select * into v_row from public.cash_transfers where id = p_id;
    if not found then
      return;
    end if;

    select coalesce(sum(e.debit - e.credit) filter (where h.code in ('INC-COMPANY-SHARE', 'INC-BRANCH-CASH')), 0),
           coalesce(sum(e.debit - e.credit) filter (where h.code = 'INC-FUEL'), 0),
           count(*)
      into v_total, v_fuel, v_live
      from public.ledger_entries e
      join public.ledger_heads h on h.id = e.ledger_head_id
     where e.source_type = 'cash_transfer'
       and e.source_id = p_id
       and e.deleted_at is null
       and e.status <> 'reversed'
       and e.reverses_entry_id is null;

    if v_row.status = 'approved' and v_row.deleted_at is null then
      if v_total <> v_row.cash_amount + v_row.easypaisa_amount + v_row.bank_amount then
        raise exception
          'Cash deposit % totals % (Cash + Easypaisa + Bank) but its ledger receipts carry %. '
          'Its RVs follow the deposit: correct or delete the deposit itself through the Support Center, not the RV alone. Nothing was saved.',
          v_row.transfer_no, v_row.cash_amount + v_row.easypaisa_amount + v_row.bank_amount, v_total
          using errcode = 'P0001';
      end if;
      if v_fuel <> v_row.fuel_charges then
        raise exception
          'Cash deposit % has Fuel Charges of % but its ledger receipts carry %. '
          'Its RVs follow the deposit: correct or delete the deposit itself through the Support Center, not the RV alone. Nothing was saved.',
          v_row.transfer_no, v_row.fuel_charges, v_fuel
          using errcode = 'P0001';
      end if;
    elsif v_live > 0 then
      raise exception
        'Cash deposit % is % but still has % live ledger receipt(s). Nothing was saved.',
        v_row.transfer_no,
        case when v_row.deleted_at is not null then 'deleted' else v_row.status::text end,
        v_live
        using errcode = 'P0001';
    end if;
  end;
  $$;

-- From the deposit's side.
create function app.cash_transfer_booked_check() returns trigger
  language plpgsql as $$
  begin
    perform app.assert_cash_transfer_booked(new.id);
    return null;
  end;
  $$;

create constraint trigger cash_transfers_booked
  after update on public.cash_transfers
  deferrable initially deferred
  for each row
  when ((old.status, old.deleted_at, old.cash_amount, old.easypaisa_amount, old.bank_amount, old.fuel_charges)
        is distinct from
        (new.status, new.deleted_at, new.cash_amount, new.easypaisa_amount, new.bank_amount, new.fuel_charges))
  execute function app.cash_transfer_booked_check();

-- From the receipt's side: posting, editing, reversing or deleting an RV that
-- belongs to a deposit. The balance recompute (only `balance` changes) and a
-- re-date (only `entry_date`) do not fire it.
create function app.cash_transfer_receipt_check() returns trigger
  language plpgsql as $$
  begin
    if tg_op = 'UPDATE' and old.source_type = 'cash_transfer' and old.source_id is not null then
      perform app.assert_cash_transfer_booked(old.source_id);
    end if;
    if new.source_type = 'cash_transfer' and new.source_id is not null
       and (tg_op = 'INSERT' or new.source_id is distinct from old.source_id or old.source_type is distinct from new.source_type) then
      perform app.assert_cash_transfer_booked(new.source_id);
    end if;
    return null;
  end;
  $$;

create constraint trigger ledger_entries_cash_transfer_booked_ins
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row
  when (new.source_type = 'cash_transfer')
  execute function app.cash_transfer_receipt_check();

create constraint trigger ledger_entries_cash_transfer_booked_upd
  after update on public.ledger_entries
  deferrable initially deferred
  for each row
  when ((old.source_type = 'cash_transfer' or new.source_type = 'cash_transfer')
        and (old.debit, old.credit, old.status, old.deleted_at, old.ledger_head_id, old.reverses_entry_id, old.source_type, old.source_id)
            is distinct from
            (new.debit, new.credit, new.status, new.deleted_at, new.ledger_head_id, new.reverses_entry_id, new.source_type, new.source_id))
  execute function app.cash_transfer_receipt_check();

comment on function app.assert_cash_transfer_booked(uuid) is
  'Raises P0001 unless an approved, live cash deposit''s live receipts equal its Cash + Easypaisa + Bank (Company Share / Cash Received from Branch) and its Fuel Charges (INC-FUEL), and unless any other deposit has no live receipt. Run at commit by the cash_transfers_booked and ledger_entries_cash_transfer_booked_* constraint triggers.';
