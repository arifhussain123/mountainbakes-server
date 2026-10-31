-- Refundable & Receivable Loans: a client-wise loan register kept beside the
-- finance ledger, never inside it.
--
--   Refundable Loan  ── debit  ─┐
--   Receivable Loan  ── debit  ─┼─► running balance per filter set
--   Paid Payment     ── credit ─┘
--
-- THE RULES THIS SCHEMA HOLDS, whatever the API does:
--
--   * Nothing here writes ledger_entries. A loan entry is not General Ledger
--     income or expense, does not move the cash book, and is not in any profit
--     figure. The only place the two meet is the accounting workbook, which
--     shows the outstanding loan balances as a memorandum under Liabilities.
--   * Every entry names a client. The side is decided here from the entry type
--     (loans debit, payments credit) — the API never sends a debit or credit.
--   * Loan vouchers are their own series (LN-000001), so the Daily Ledger's
--     RV-/PV- numbering is untouched.
--   * A posted entry is never edited. It is cancelled with a reason; the row
--     stays, struck through, and leaves every balance.
--   * Balances are computed when read (finance_loan_ledger), never stored, so a
--     back-dated entry cannot leave a stale running balance behind it.
--
-- Additive only.
-- ---------------------------------------------------------------------------

-- Not used in this file (an enum value added in a transaction cannot be used in
-- that transaction); attachments.service.ts binds photos to it at run time.
alter type public.attachment_entity add value if not exists 'finance_loan_entry';

-- Document numbers (app.next_finance_number refuses a missing counter).
insert into public.counters (id, count) values
  ('finance_loan_client',  0),
  ('finance_loan_voucher', 0)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------

create table public.finance_loan_clients (
  id               uuid primary key default gen_random_uuid(),
  client_code      text not null unique default app.next_finance_number('finance_loan_client', 'LC'),
  company_name     text,
  client_name      text not null check (btrim(client_name) <> ''),
  mobile_number    text,
  whatsapp_number  text,
  address          text,
  note             text,
  is_active        boolean not null default true,
  created_by       uuid references public.users (id) on delete set null,
  created_by_name  text,
  updated_by       uuid references public.users (id) on delete set null,
  updated_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger finance_loan_clients_touch before update on public.finance_loan_clients
  for each row execute function app.touch_updated_at();
create index finance_loan_clients_name_idx on public.finance_loan_clients (lower(client_name));
create index finance_loan_clients_mobile_idx on public.finance_loan_clients (mobile_number) where mobile_number is not null;

comment on table public.finance_loan_clients is
  'Parties in the Refundable & Receivable Loans register. Deactivated, never deleted, once they have entries.';

-- ---------------------------------------------------------------------------
-- Entries
-- ---------------------------------------------------------------------------

create table public.finance_loan_entries (
  id                 uuid primary key default gen_random_uuid(),
  voucher_no         text not null unique,
  -- Posting sequence: the tie-break for entries on the same business date.
  seq                bigserial not null unique,
  client_id          uuid not null references public.finance_loan_clients (id) on delete restrict,
  entry_type         text not null check (entry_type in ('paid_payment', 'refundable_loan', 'receivable_loan')),
  ledger_head_id     uuid not null references public.ledger_heads (id) on delete restrict,
  ledger_head_name   text not null,
  branch_id          uuid references public.branches (id) on delete set null,
  branch_name        text,
  business_date      date not null,
  amount             numeric(14,2) not null check (amount > 0 and amount <= 9999999999.99),
  debit              numeric(14,2) not null default 0,
  credit             numeric(14,2) not null default 0,
  payment_method     text,
  description        text not null check (btrim(description) <> ''),
  note               text,
  status             text not null default 'posted' check (status in ('posted', 'cancelled')),
  cancel_reason      text,
  cancelled_by       uuid references public.users (id) on delete set null,
  cancelled_by_name  text,
  cancelled_at       timestamptz,
  -- One row per submitted form: a retried request returns the first row.
  request_id         uuid not null unique,
  created_by         uuid references public.users (id) on delete set null,
  created_by_name    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint finance_loan_entries_side check (
    case entry_type
      when 'paid_payment' then credit = amount and debit = 0
      else debit = amount and credit = 0
    end
  ),
  constraint finance_loan_entries_method check ((entry_type = 'paid_payment') = (payment_method is not null)),
  constraint finance_loan_entries_cancelled check (
    (status = 'cancelled') = (cancelled_at is not null and coalesce(btrim(cancel_reason), '') <> '')
  )
);
create trigger finance_loan_entries_touch before update on public.finance_loan_entries
  for each row execute function app.touch_updated_at();
create index finance_loan_entries_client_idx on public.finance_loan_entries (client_id, business_date, seq);
create index finance_loan_entries_date_idx on public.finance_loan_entries (business_date, seq);
create index finance_loan_entries_type_idx on public.finance_loan_entries (entry_type);
create index finance_loan_entries_status_idx on public.finance_loan_entries (status);
create index finance_loan_entries_head_idx on public.finance_loan_entries (ledger_head_id);

comment on table public.finance_loan_entries is
  'Refundable & Receivable Loans register. Never posted to ledger_entries. Loans debit, payments credit; balances are computed by finance_loan_ledger.';

-- ---------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------

create or replace function public.post_finance_loan_entry(
  p_request_id     uuid,
  p_client_id      uuid,
  p_entry_type     text,
  p_ledger_head_id uuid,
  p_branch_id      uuid,
  p_business_date  date,
  p_amount         numeric,
  p_payment_method text,
  p_description    text,
  p_note           text,
  p_actor_id       uuid,
  p_actor_name     text
) returns public.finance_loan_entries
language plpgsql as $$
declare
  v_row    public.finance_loan_entries;
  v_client public.finance_loan_clients;
  v_head   public.ledger_heads;
  v_branch text;
  v_want   text;
begin
  -- A retried request (double-clicked Save, a network retry) is the same entry.
  select * into v_row from finance_loan_entries where request_id = p_request_id;
  if v_row.id is not null then
    return v_row;
  end if;

  if p_entry_type not in ('paid_payment', 'refundable_loan', 'receivable_loan') then
    raise exception 'Unknown entry type "%"', p_entry_type using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero' using errcode = 'P0001';
  end if;
  if p_business_date is null or p_business_date > app.karachi_business_date() then
    raise exception 'That business date has not happened yet' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_description), '') = '' then
    raise exception 'Description is required' using errcode = 'P0001';
  end if;
  if p_entry_type = 'paid_payment' and coalesce(btrim(p_payment_method), '') = '' then
    raise exception 'Select a payment method' using errcode = 'P0001';
  end if;

  select * into v_client from finance_loan_clients where id = p_client_id;
  if v_client.id is null then
    raise exception 'Client not found' using errcode = 'P0001';
  end if;
  if not v_client.is_active then
    raise exception 'Client % is inactive. Activate the client before recording an entry.', v_client.client_name
      using errcode = 'P0001';
  end if;

  -- Loans and payments are classified under an Expense head; a Receivable Loan
  -- under an Income head. The head never decides the side — the type does.
  v_want := case when p_entry_type = 'receivable_loan' then 'income' else 'expense' end;
  select * into v_head from ledger_heads where id = p_ledger_head_id;
  if v_head.id is null then
    raise exception 'Ledger head not found' using errcode = 'P0001';
  end if;
  if not v_head.is_active then
    raise exception 'Ledger head % is inactive', v_head.name using errcode = 'P0001';
  end if;
  if v_head.type::text <> v_want then
    raise exception 'Select an % ledger head for this entry', v_want using errcode = 'P0001';
  end if;

  if p_branch_id is not null then
    select name into v_branch from branches where id = p_branch_id;
    if v_branch is null then
      raise exception 'Branch not found' using errcode = 'P0001';
    end if;
  end if;

  insert into finance_loan_entries (
    voucher_no, client_id, entry_type, ledger_head_id, ledger_head_name, branch_id, branch_name,
    business_date, amount, debit, credit, payment_method, description, note, request_id,
    created_by, created_by_name
  ) values (
    app.next_finance_number('finance_loan_voucher', 'LN'), p_client_id, p_entry_type, v_head.id, v_head.name,
    p_branch_id, v_branch, p_business_date, round(p_amount, 2),
    case when p_entry_type = 'paid_payment' then 0 else round(p_amount, 2) end,
    case when p_entry_type = 'paid_payment' then round(p_amount, 2) else 0 end,
    case when p_entry_type = 'paid_payment' then btrim(p_payment_method) end,
    btrim(p_description), nullif(btrim(coalesce(p_note, '')), ''), p_request_id,
    p_actor_id, p_actor_name
  )
  -- Two concurrent requests with one request_id: the loser returns the winner.
  on conflict (request_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from finance_loan_entries where request_id = p_request_id;
  end if;
  return v_row;
end;
$$;

comment on function public.post_finance_loan_entry(uuid, uuid, text, uuid, uuid, date, numeric, text, text, text, uuid, text) is
  'Post one loan register entry atomically with its LN- voucher. Replays by request_id. P0001 on any refused rule.';

create or replace function public.cancel_finance_loan_entry(
  p_id         uuid,
  p_reason     text,
  p_actor_id   uuid,
  p_actor_name text
) returns public.finance_loan_entries
language plpgsql as $$
declare
  v_row public.finance_loan_entries;
begin
  select * into v_row from finance_loan_entries where id = p_id for update;
  if v_row.id is null then
    raise exception 'Loan entry not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'Voucher % is already cancelled', v_row.voucher_no using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why this entry is being cancelled' using errcode = 'P0001';
  end if;

  update finance_loan_entries set
    status = 'cancelled', cancel_reason = btrim(p_reason),
    cancelled_by = p_actor_id, cancelled_by_name = p_actor_name, cancelled_at = now()
   where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.cancel_finance_loan_entry(uuid, text, uuid, text) is
  'Cancel a posted loan entry with a reason. The row is kept and leaves every balance. P0001 if already cancelled; P0002 if missing.';

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- The ledger for a window, in posting order (business date, then seq), with
-- the running balance. Every filter defines the set the balance runs over, the
-- same way the Daily Ledger's totals do; the opening balance is that set's
-- posted debit − credit before p_from. Cancelled rows are listed (struck
-- through by the UI) carrying the balance before them, and count in no total.
create or replace function public.finance_loan_ledger(
  p_from           date,
  p_to             date,
  p_client_id      uuid default null,
  p_branch_id      uuid default null,
  p_entry_type     text default null,
  p_ledger_head_id uuid default null,
  p_payment_method text default null,
  p_status         text default null,
  p_search         text default null,
  p_limit          integer default 50,
  p_offset         integer default 0
) returns jsonb
language plpgsql stable as $$
declare
  v_q      text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_limit  int := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_out    jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid date range' using errcode = '22023';
  end if;

  with f as (
    select e.*, c.client_code, c.client_name, c.company_name,
           sum(case when e.status = 'posted' then e.debit - e.credit else 0 end)
             over (order by e.business_date, e.seq rows between unbounded preceding and current row) as balance
      from finance_loan_entries e
      join finance_loan_clients c on c.id = e.client_id
     where e.business_date <= p_to
       and (p_client_id is null or e.client_id = p_client_id)
       and (p_branch_id is null or e.branch_id = p_branch_id)
       and (p_entry_type is null or e.entry_type = p_entry_type)
       and (p_ledger_head_id is null or e.ledger_head_id = p_ledger_head_id)
       and (p_payment_method is null or e.payment_method = p_payment_method)
       and (v_q is null
            or lower(e.voucher_no) like '%' || v_q || '%'
            or lower(c.client_name) like '%' || v_q || '%'
            or lower(coalesce(c.company_name, '')) like '%' || v_q || '%'
            or lower(c.client_code) like '%' || v_q || '%'
            or lower(e.description) like '%' || v_q || '%'
            or lower(e.ledger_head_name) like '%' || v_q || '%'
            or lower(coalesce(e.branch_name, '')) like '%' || v_q || '%'
            or e.id::text = v_q)
  ),
  w as (
    select * from f
     where business_date >= p_from
       and (p_status is null or status = p_status)
  ),
  opening as (
    select coalesce(sum(debit - credit), 0) as v
      from f where business_date < p_from and status = 'posted'
  ),
  totals as (
    select count(*) as n,
           coalesce(sum(debit) filter (where status = 'posted'), 0) as debit,
           coalesce(sum(credit) filter (where status = 'posted'), 0) as credit
      from w
  ),
  page as (
    select * from w order by business_date, seq limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'openingBalance', (select v from opening),
    'totalDebit',     (select debit from totals),
    'totalCredit',    (select credit from totals),
    'closingBalance', (select v from opening) + (select debit - credit from totals),
    'count',          (select n from totals),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'voucherNo', p.voucher_no, 'seq', p.seq,
        'clientId', p.client_id, 'clientCode', p.client_code, 'clientName', p.client_name,
        'companyName', p.company_name, 'entryType', p.entry_type,
        'ledgerHeadId', p.ledger_head_id, 'ledgerHeadName', p.ledger_head_name,
        'branchId', p.branch_id, 'branchName', p.branch_name,
        'businessDate', p.business_date, 'amount', p.amount, 'debit', p.debit, 'credit', p.credit,
        'balance', p.balance, 'paymentMethod', p.payment_method,
        'description', p.description, 'note', p.note, 'status', p.status,
        'cancelReason', p.cancel_reason, 'cancelledByName', p.cancelled_by_name, 'cancelledAt', p.cancelled_at,
        'createdByName', p.created_by_name, 'createdAt', p.created_at
      ) order by p.business_date, p.seq)
      from page p
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

comment on function public.finance_loan_ledger(date, date, uuid, uuid, text, uuid, text, text, text, integer, integer) is
  'Loan register window: opening balance, posted totals, closing balance and a page of rows with running balance. 22023 on a bad range.';

-- Per-client totals of posted entries up to p_to (all time when null), every
-- client listed even with no entries. The clients table, the client detail and
-- the accounting workbook's Balance Sheet memorandum all read this. One jsonb
-- array rather than a row set, so the API's per-read row cap can never cut the
-- client list (and with it the Balance Sheet total) short.
create or replace function public.finance_loan_client_balances(
  p_to        date default null,
  p_branch_id uuid default null
) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'clientId', t.id, 'clientCode', t.client_code, 'clientName', t.client_name,
           'companyName', t.company_name, 'isActive', t.is_active,
           'totalRefundable', t.total_refundable, 'totalReceivable', t.total_receivable,
           'totalDebit', t.total_debit, 'totalCredit', t.total_credit,
           'balance', t.total_debit - t.total_credit, 'entryCount', t.entry_count
         ) order by lower(t.client_name), t.client_code), '[]'::jsonb)
    from (
      select c.id, c.client_code, c.client_name, c.company_name, c.is_active,
             coalesce(sum(e.debit)  filter (where e.entry_type = 'refundable_loan'), 0) as total_refundable,
             coalesce(sum(e.debit)  filter (where e.entry_type = 'receivable_loan'), 0) as total_receivable,
             coalesce(sum(e.debit), 0)  as total_debit,
             coalesce(sum(e.credit), 0) as total_credit,
             count(e.id)                as entry_count
        from finance_loan_clients c
        left join finance_loan_entries e
               on e.client_id = c.id
              and e.status = 'posted'
              and (p_to is null or e.business_date <= p_to)
              and (p_branch_id is null or e.branch_id = p_branch_id)
       group by c.id
    ) t;
$$;

comment on function public.finance_loan_client_balances(date, uuid) is
  'Posted loan totals and outstanding balance per client up to a date (optionally one branch), as one jsonb array. Every client is listed.';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.finance_loan_clients, public.finance_loan_entries to service_role;
    grant all on sequence public.finance_loan_entries_seq_seq to service_role;
  end if;
end; $$;
