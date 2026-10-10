-- Salary Ledger, Company Transaction Details, and employee resignation.
--
-- Two read-only, year-by-month ledgers were added over records that already
-- exist (salary_payments, partner_expenses). Neither ledger stores anything:
-- every figure is computed from approved source records each time it is read.
-- What the database was missing to support them is added here.
--
--   1. employee_resignations   date, time, reason and who recorded it. The
--                              payroll master only had `is_active`.
--   2. finance_partners.partner_code   a readable, permanent Partner ID.
--   3. a guard on salary_payments      no ordinary salary is approved for a
--                              month after the employee's resignation month.
--   4. two views               the one definition of "counts in the ledger",
--                              read by both the totals and the drill-down, so
--                              a month's figure and the list behind it cannot
--                              disagree.
--
-- Additive only. No table is dropped and no existing row is changed, except
-- that each partner is given its code.
-- ---------------------------------------------------------------------------

-- ── 1. Resignations ─────────────────────────────────────────────────────────
--
-- A table of its own rather than columns on finance_employees: a resignation
-- that is cancelled and recorded again must leave both records behind, and a
-- column can only hold the latest one.
--
-- `resignation_date` + `resignation_time` are what the person recording it
-- entered (Asia/Karachi wall clock). `created_at` is when the server wrote the
-- row. They are separate on purpose and neither is derived from the other.
create table if not exists public.employee_resignations (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references public.finance_employees (id) on delete restrict,
  -- Snapshots, for the same reason a payslip keeps the employee's name: the
  -- record must read the same after the master is edited.
  employee_code     text not null,
  employee_name     text not null,
  resignation_date  date not null,
  resignation_time  time not null,
  reason            text not null,
  remarks           text,
  status            text not null default 'recorded',
  submitted_by      uuid references public.users (id) on delete set null,
  submitted_by_name text not null default '',
  cancelled_by      uuid references public.users (id) on delete set null,
  cancelled_by_name text,
  cancelled_at      timestamptz,
  cancel_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint employee_resignations_status_check check (status in ('recorded', 'cancelled')),
  constraint employee_resignations_reason_check check (btrim(reason) <> ''),
  constraint employee_resignations_cancel_check check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (status <> 'cancelled' or btrim(coalesce(cancel_reason, '')) <> '')
  )
);

-- One live resignation per employee. This, not the form, is what makes a
-- double submission harmless: the second insert fails with 23505.
create unique index if not exists employee_resignations_one_live_idx
  on public.employee_resignations (employee_id) where status = 'recorded';

create index if not exists employee_resignations_employee_idx
  on public.employee_resignations (employee_id, created_at desc);

drop trigger if exists employee_resignations_touch on public.employee_resignations;
create trigger employee_resignations_touch
  before update on public.employee_resignations
  for each row execute function app.touch_updated_at();

-- History is kept. A wrong resignation is cancelled (status, who, when, why),
-- never removed.
create or replace function app.employee_resignations_keep_history() returns trigger
  language plpgsql
  as $$
  begin
    raise exception 'employee_resignations rows are never deleted. Cancel the resignation instead.';
  end;
  $$;

drop trigger if exists employee_resignations_no_delete on public.employee_resignations;
create trigger employee_resignations_no_delete
  before delete on public.employee_resignations
  for each row execute function app.employee_resignations_keep_history();

-- ── 2. Partner ID ───────────────────────────────────────────────────────────
--
-- finance_partners had a uuid and a unique name. The ledger needs an ID a
-- person can read out and search for, which stays the same if the name is
-- corrected. Numbered the way employees are (EMP-000001 → PT-000001).
insert into public.counters (id, count) values ('finance_partner_code', 0)
  on conflict (id) do nothing;

alter table public.finance_partners add column if not exists partner_code text;

do $$
  declare r record;
  begin
    for r in
      select id from public.finance_partners
       where partner_code is null
       order by created_at, name
    loop
      update public.finance_partners
         set partner_code = app.next_finance_number('finance_partner_code', 'PT')
       where id = r.id;
    end loop;
  end;
$$;

alter table public.finance_partners
  alter column partner_code set default app.next_finance_number('finance_partner_code'::text, 'PT'::text),
  alter column partner_code set not null;

do $$
  begin
    if not exists (select 1 from pg_constraint where conname = 'finance_partners_partner_code_key') then
      alter table public.finance_partners
        add constraint finance_partners_partner_code_key unique (partner_code);
    end if;
  end;
$$;

-- ── 3. No ordinary salary after the resignation month ───────────────────────
--
-- The API checks this before it approves. This trigger is what holds when an
-- approval and a resignation are submitted at the same moment: the approval
-- claims the payslip by moving it to 'approved', and that move is refused here
-- if the resignation got in first.
--
-- Only that one move is guarded. A payslip approved BEFORE the resignation was
-- recorded is left exactly as it is — the ledger flags it for review instead.
-- The resignation month itself is allowed: the final month's salary is real.
create or replace function app.salary_payment_resignation_guard() returns trigger
  language plpgsql
  as $$
  declare
    v_date date;
  begin
    select resignation_date into v_date
      from public.employee_resignations
     where employee_id = new.employee_id and status = 'recorded';

    if found and new.salary_month > to_char(v_date, 'YYYY-MM') then
      raise exception using
        errcode = 'MBRSG',
        message = format(
          '%s resigned on %s. Salary for %s is after the resignation month and cannot be approved.',
          new.employee_name, to_char(v_date, 'DD Mon YYYY'), new.salary_month);
    end if;
    return new;
  end;
  $$;

drop trigger if exists salary_payments_resignation_guard on public.salary_payments;
create trigger salary_payments_resignation_guard
  before update of status on public.salary_payments
  for each row
  when (new.status = 'approved' and old.status is distinct from new.status)
  execute function app.salary_payment_resignation_guard();

-- ── 4. What counts in a ledger ──────────────────────────────────────────────
--
-- A record counts when
--   * it is posted or locked (approved AND in the book — 'approved' alone means
--     the voucher failed to post), and
--   * it has not been deleted, and
--   * its voucher is still in the book. A voucher can be edited or deleted from
--     the Daily Ledger without the payslip changing, so the payslip's own status
--     is not enough.
--
-- The amount is the voucher's, so a voucher corrected in the Daily Ledger is
-- what the ledger shows. A posted record with no voucher link (none is known to
-- exist; approval always sets it) falls back to its own amount.
--
-- Rows that do not count are still returned, with counted = false, so the
-- drill-down can show a pending or rejected payslip as excluded.
create or replace view public.salary_ledger_payments as
  select
    sp.id,
    sp.salary_no,
    sp.employee_id,
    sp.salary_month,
    left(sp.salary_month, 4)::integer  as salary_year,
    right(sp.salary_month, 2)::integer as month_no,
    sp.status,
    sp.gross_salary,
    sp.bonus,
    sp.deductions,
    sp.net_salary,
    sp.payment_date,
    sp.payment_method,
    sp.account,
    sp.notes,
    sp.created_by_name,
    sp.created_at,
    sp.approved_by_name,
    sp.approved_at,
    sp.rejection_reason,
    sp.ledger_entry_id,
    le.voucher_no,
    (sp.ledger_entry_id is not null
       and (le.deleted_at is not null or le.status = 'reversed'))  as voucher_removed,
    (sp.status in ('posted', 'locked')
       and (sp.ledger_entry_id is null
            or (le.deleted_at is null and le.status <> 'reversed'))) as counted,
    case
      when sp.status in ('posted', 'locked')
       and (sp.ledger_entry_id is null or (le.deleted_at is null and le.status <> 'reversed'))
      then coalesce(le.debit + le.credit, sp.net_salary)
      else 0::numeric(14,2)
    end                                                             as counted_amount,
    r.resignation_date,
    (r.id is not null and sp.salary_month > to_char(r.resignation_date, 'YYYY-MM')) as after_resignation
  from public.salary_payments sp
  left join public.ledger_entries le on le.id = sp.ledger_entry_id
  left join public.employee_resignations r
         on r.employee_id = sp.employee_id and r.status = 'recorded'
  where sp.deleted_at is null;

-- Partner advances and draws. The month is the date the voucher sits on, which
-- is the transaction's business date unless the voucher was re-dated in the
-- Daily Ledger.
create or replace view public.partner_ledger_transactions as
  select
    pe.id,
    pe.expense_no,
    pe.partner_id,
    pe.partner_name,
    pe.txn_kind,
    pe.description,
    pe.amount,
    pe.business_date,
    coalesce(le.entry_date, pe.business_date)                              as ledger_date,
    extract(year  from coalesce(le.entry_date, pe.business_date))::integer as txn_year,
    extract(month from coalesce(le.entry_date, pe.business_date))::integer as month_no,
    pe.status,
    pe.payment_method,
    pe.account,
    pe.notes,
    pe.requested_by_name,
    pe.created_at,
    pe.approved_by_name,
    pe.approved_at,
    pe.rejection_reason,
    pe.ledger_entry_id,
    le.voucher_no,
    (pe.ledger_entry_id is not null
       and (le.deleted_at is not null or le.status = 'reversed'))  as voucher_removed,
    (pe.status in ('posted', 'locked')
       and (pe.ledger_entry_id is null
            or (le.deleted_at is null and le.status <> 'reversed'))) as counted,
    case
      when pe.status in ('posted', 'locked')
       and (pe.ledger_entry_id is null or (le.deleted_at is null and le.status <> 'reversed'))
      then coalesce(le.debit + le.credit, pe.amount)
      else 0::numeric(14,2)
    end                                                             as counted_amount
  from public.partner_expenses pe
  left join public.ledger_entries le on le.id = pe.ledger_entry_id
  where pe.deleted_at is null;

-- The year query filters on partner and date; the existing index leads with
-- partner_name, which the ledger never groups by.
create index if not exists partner_expenses_partner_date_idx
  on public.partner_expenses (partner_id, business_date desc)
  where deleted_at is null;

-- ── Access ──────────────────────────────────────────────────────────────────
-- The API's role inherits from service_role. Default privileges already cover
-- new objects on a database set up by infra/railway/post-restore.sql; stated
-- here so the migration does not depend on that.
do $$
  begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      grant all on public.employee_resignations to service_role;
      grant select on public.salary_ledger_payments, public.partner_ledger_transactions to service_role;
    end if;
  end;
$$;
