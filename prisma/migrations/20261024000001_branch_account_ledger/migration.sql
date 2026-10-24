-- Demand Record: what each branch owes the company, as a running balance
-- carried from one demand to the next. See docs/demand-record-accounting-audit.md
-- for the rules and why they were chosen.
--
-- THE BALANCE IS DERIVED, NOT STORED. Each demand's figures are read from the
-- records that already exist: the delivered demand, accepted returns, approved
-- discounts, approved cash transfers and POS sales, plus the entries Finance
-- posts here (an opening balance per branch, and reasoned adjustments). So:
--
--   * nothing is posted twice: every source row is counted once, by construction;
--   * two submissions at the same moment cannot read a stale balance and
--     overwrite each other, because there is no balance column to overwrite;
--   * a backdated correction carries through every later balance by itself,
--     and the corrected record keeps its own history.
--
-- WHAT IS FROZEN, so a later price or % change cannot rewrite a past demand:
--   * the company share %: production_order_share_snapshots, written by a
--     trigger the moment a demand is first delivered (left pending), and
--     never updated;
--   * unit prices: production_order_items.unit_price (snapshotted at order
--     time already), else the effective-dated product_price_history, which
--     never changes once applied.
--
-- Nothing here edits or recalculates an existing row of any existing table.
-- ---------------------------------------------------------------------------

-- The share % the delivery slip resolves today (resolveShareSplit in
-- src/shared/utils/share.ts): the branch's own %, else the global setting,
-- else 75 — the fallback getPreviousOrderBalance uses when settings are missing.
create function app.resolve_company_share_pct(p_branch uuid) returns numeric
  language sql stable as $$
  select round(coalesce(
    (select b.company_share_pct from public.branches b
      where b.id = p_branch and b.company_share_pct between 0 and 100),
    (select s.company_share_pct from public.finance_settings s
      where s.company_share_pct between 0 and 100 limit 1),
    75
  ), 2)
  $$;

create table public.production_order_share_snapshots (
  production_order_id uuid primary key references public.production_orders(id) on delete restrict,
  company_share_pct   numeric(5, 2) not null check (company_share_pct between 0 and 100),
  frozen_at           timestamptz not null default now(),
  -- 'delivery': frozen by the trigger below as the demand left pending.
  -- 'go_live':  frozen when Finance switched the Demand Record on, for demands
  --             delivered before this migration existed.
  source              text not null check (source in ('delivery', 'go_live'))
);

create function app.freeze_order_share_pct() returns trigger
  language plpgsql as $$
  begin
    if new.status::text in ('awaiting_verification', 'verified', 'approved') then
      insert into public.production_order_share_snapshots (production_order_id, company_share_pct, source)
      values (new.id, app.resolve_company_share_pct(new.branch_id), 'delivery')
      on conflict (production_order_id) do nothing;
    end if;
    return null;
  end;
  $$;
create trigger production_orders_freeze_share
  after insert or update of status on public.production_orders
  for each row execute function app.freeze_order_share_pct();

create function app.share_snapshots_append_only() returns trigger
  language plpgsql as $$
  begin
    raise exception '% rows are append-only', tg_table_name;
  end;
  $$;
create trigger production_order_share_snapshots_append_only
  before update or delete on public.production_order_share_snapshots
  for each row execute function app.share_snapshots_append_only();

-- The first business day the Demand Record counts. NULL: not switched on yet.
-- Everything before it is in each branch's opening balance.
alter table public.finance_settings add column account_ledger_start date;

-- Finance's own entries: one opening balance per branch, and reasoned
-- adjustments. Append-only; a mistake is undone by a reversal row, never by an
-- edit or a delete. `request_id` makes a retried submission a no-op.
create table public.branch_account_adjustments (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references public.branches(id),
  kind            text not null check (kind in ('opening', 'adjustment', 'reversal')),
  -- Positive raises what the branch owes the company; negative is a credit.
  amount          numeric(14, 2) not null check (amount <> 0 and abs(amount) <= 100000000),
  effective_at    timestamptz not null,
  business_date   date not null,
  reason          text not null check (length(btrim(reason)) between 3 and 500),
  reversal_of     uuid unique references public.branch_account_adjustments(id),
  request_id      uuid not null unique,
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz not null default now(),
  check ((kind = 'reversal') = (reversal_of is not null))
);
create index branch_account_adjustments_branch_idx on public.branch_account_adjustments (branch_id, effective_at);

create trigger branch_account_adjustments_append_only
  before update or delete on public.branch_account_adjustments
  for each row execute function app.share_snapshots_append_only();

-- A reversal must exactly cancel one live entry of the same branch.
create function app.check_branch_account_reversal() returns trigger
  language plpgsql as $$
  declare
    orig public.branch_account_adjustments%rowtype;
  begin
    if new.reversal_of is null then
      return new;
    end if;
    select * into orig from public.branch_account_adjustments where id = new.reversal_of for update;
    if not found then
      raise exception 'nothing to reverse';
    end if;
    if orig.kind = 'reversal' then
      raise exception 'a reversal cannot itself be reversed; post a new entry instead';
    end if;
    if orig.branch_id <> new.branch_id or orig.amount <> -new.amount then
      raise exception 'a reversal must be the exact opposite of the entry it reverses';
    end if;
    return new;
  end;
  $$;
create trigger branch_account_adjustments_reversal
  before insert on public.branch_account_adjustments
  for each row execute function app.check_branch_account_reversal();

-- Each source record is placed after the latest demand before it, per branch,
-- by timestamp — these keep those lookups to an index range.
create index production_orders_branch_submitted_idx on public.production_orders (branch_id, submitted_at);
create index production_returns_branch_created_idx on public.production_returns (branch_id, created_at);
create index cash_transfers_branch_created_idx on public.cash_transfers (branch_id, created_at);
