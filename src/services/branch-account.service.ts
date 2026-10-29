import { getPrisma } from '../db';
import {
  businessDateStr,
  companyShareOf,
  computeBranchAccount,
  totalBranchAccount,
  toPaisa,
  type BranchAccountAdjustment,
  type BranchAccountFacts,
  type BranchAccountRow,
  type DemandRecordDetail,
  type DemandRecordResult,
  type DemandRecordRow,
  type MonthStatement,
  type MonthStatementBranch,
  type MonthStatementStock,
} from '../shared';
import { priceOnDateLateral, UNIT_PRICE_LATERAL } from './returns-summary.service';

/**
 * The Demand Record: each branch's account with the company, demand by demand,
 * carried forward. The money rules live in shared/utils/branch-account.ts; this
 * module gathers the facts each row is built from, and owns Finance's entries
 * (opening balances, adjustments) and the go-live switch. Schema and the
 * reasons behind it: prisma/migrations/20261024000001_branch_account_ledger.
 *
 * HOW A RECORD IS PLACED. A branch's rows are its delivered demands
 * (awaiting verification, verified or approved) from the go-live day on, in
 * submission order, plus an opening row before the first one. Each record lands
 * in the row of the latest demand submitted strictly before it — the same
 * (previous, next] window the delivery slip bills by — and so in exactly one
 * row:
 *   - accepted returns, by `created_at`, at the price on the return's own date
 *     (the Return Summary's price);
 *   - approved cash transfers (not deleted, amount > 0), by `created_at`, each
 *     once — unlike the slip, which also shows the rest of a day's deposits;
 *   - POS sales (not cancelled, not staff), by `created_at`;
 *   - Finance's entries, by `effective_at`;
 *   - approved discounts go to the demand they were claimed against when that
 *     demand is in the record, and by `created_at` otherwise.
 * Only records from the go-live instant on count; everything earlier is the
 * branch's opening balance.
 *
 * The opening row holds Finance's entries and accepted returns. A deposit,
 * sale or loose discount recorded before a branch's first demand in the record
 * settles a demand from before the go-live day, so it is not counted, and the
 * first demand's Previous is 0 unless Finance entered an opening balance (the
 * owner's rule from 1 Oct 2026: on the live data, deposits made on the
 * morning of 1 Oct for 30 Sep's demands had opened two branches in credit).
 * Returns are the exception (the owner's rule from 27 Oct 2026): an accepted
 * return saved after the go-live instant counts even before the first demand,
 * in the opening row at today's share %, so the Demand Record's returns match
 * the Return Stock page from the go-live day.
 *
 * A row runs until the branch's NEXT demand, whatever its date, so the last row
 * of a branch stays open until that demand arrives. That is what keeps one
 * period's closing balance equal to the next period's opening balance.
 */

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

const DELIVERED = `('awaiting_verification', 'verified', 'approved')`;

/** The go-live instant: 02:00 Karachi on the start date — the business-day start. */
const START_AT = `(($2::date + time '02:00') at time zone 'Asia/Karachi')`;

const ROWS_SQL = `
  with br as (
    select b.id, b.name from public.branches b where ($1::uuid is null or b.id = $1::uuid)
  ),
  d as (
    select o.id, o.branch_id, o.demand_number, o.business_date as bd, o.submitted_at,
           o.status::text as status, coalesce(o.branch_name, br.name) as branch_name,
           sn.company_share_pct as frozen_pct
      from public.production_orders o
      join br on br.id = o.branch_id
      left join public.production_order_share_snapshots sn on sn.production_order_id = o.id
     where o.status::text in ${DELIVERED}
       and o.business_date >= $2::date
  ),
  w as (
    select x.branch_id, x.order_id, x.lo,
           lead(x.lo) over (partition by x.branch_id order by x.ord, x.lo, x.order_id) as hi
      from (
        select br.id as branch_id, null::uuid as order_id, '-infinity'::timestamptz as lo, 0 as ord from br
        union all
        select d.branch_id, d.id, d.submitted_at, 1 from d
      ) x
  ),
  dv as (
    select d.id as order_id,
           coalesce(sum(coalesce(i.approved_qty, 0) * coalesce(i.unit_price, ip.unit_price, 0)), 0) as delivered,
           count(*) filter (where coalesce(i.approved_qty, 0) <> 0 and i.unit_price is null and ip.unit_price is null) as unpriced
      from d
      join public.production_order_items i on i.production_order_id = d.id
      left join public.products p on p.id = i.product_id
      ${priceOnDateLateral('i.product_id', 'd.bd', 'p.price', 'ip')}
     group by d.id
  ),
  ret as (
    select w.branch_id, w.order_id,
           coalesce(sum(round(r.qty * px.unit_price, 2)), 0) as amount,
           coalesce(sum(r.qty), 0) as qty,
           count(*) filter (where px.unit_price is null) as unpriced
      from w
      join public.production_returns r
        on r.branch_id = w.branch_id and r.created_at > w.lo and (w.hi is null or r.created_at <= w.hi)
      left join public.products p on p.id = r.product_id
      ${UNIT_PRICE_LATERAL}
     where r.status::text = 'accepted' and r.created_at >= ${START_AT}
     group by w.branch_id, w.order_id
  ),
  disc as (
    select d.branch_id, d.id as order_id, sum(x.amount) as amount
      from d join public.branch_discounts x on x.production_order_id = d.id
     where x.status::text = 'approved'
     group by d.branch_id, d.id
    union all
    select w.branch_id, w.order_id, sum(x.amount)
      from w
      join public.branch_discounts x
        on x.branch_id = w.branch_id and x.created_at > w.lo and (w.hi is null or x.created_at <= w.hi)
     where w.order_id is not null and x.status::text = 'approved' and x.created_at >= ${START_AT}
       and not exists (select 1 from d where d.id = x.production_order_id)
     group by w.branch_id, w.order_id
  ),
  pay as (
    select w.branch_id, w.order_id, sum(t.amount) as amount
      from w
      join public.cash_transfers t
        on t.branch_id = w.branch_id and t.created_at > w.lo and (w.hi is null or t.created_at <= w.hi)
     where w.order_id is not null and t.status::text = 'approved' and t.deleted_at is null and t.amount > 0
       and t.created_at >= ${START_AT}
     group by w.branch_id, w.order_id
  ),
  sale as (
    select w.branch_id, w.order_id, sum(s.grand_total) as amount
      from w
      join public.orders s
        on s.branch_id = w.branch_id and s.created_at > w.lo and (w.hi is null or s.created_at <= w.hi)
     where w.order_id is not null and s.status::text <> 'cancelled' and s.payment_method::text <> 'staff'
       and s.created_at >= ${START_AT}
     group by w.branch_id, w.order_id
  ),
  adj as (
    select w.branch_id, w.order_id, sum(a.amount) as amount
      from w
      join public.branch_account_adjustments a
        on a.branch_id = w.branch_id and a.effective_at > w.lo and (w.hi is null or a.effective_at <= w.hi)
     where a.effective_at >= ${START_AT}
     group by w.branch_id, w.order_id
  )
  select w.branch_id::text                                   as "branchId",
         coalesce(d.branch_name, br.name)                    as "branchName",
         w.order_id::text                                    as "orderId",
         d.demand_number                                     as "demandNumber",
         to_char(coalesce(d.bd, $2::date), 'YYYY-MM-DD')     as "businessDate",
         to_json(coalesce(d.submitted_at, ${START_AT}))#>>'{}' as "at",
         d.status                                            as "status",
         d.frozen_pct::float8                                as "frozenPct",
         app.resolve_company_share_pct(w.branch_id)::float8  as "livePct",
         coalesce(dv.delivered, 0)::float8                   as "delivered",
         coalesce(ret.amount, 0)::float8                     as "returns",
         coalesce(ret.qty, 0)::float8                        as "returnsQty",
         coalesce((select sum(amount) from disc where disc.branch_id = w.branch_id
                     and disc.order_id is not distinct from w.order_id), 0)::float8 as "discount",
         coalesce(pay.amount, 0)::float8                     as "received",
         coalesce(sale.amount, 0)::float8                    as "sales",
         coalesce(adj.amount, 0)::float8                     as "adjustments",
         (coalesce(dv.unpriced, 0) + coalesce(ret.unpriced, 0))::int as "unpricedLines",
         to_json(w.lo)#>>'{}'                                as "lo",
         to_json(w.hi)#>>'{}'                                as "hi"
    from w
    join br on br.id = w.branch_id
    left join d on d.id = w.order_id
    left join dv on dv.order_id = w.order_id
    left join ret on ret.branch_id = w.branch_id and ret.order_id is not distinct from w.order_id
    left join pay on pay.branch_id = w.branch_id and pay.order_id is not distinct from w.order_id
    left join sale on sale.branch_id = w.branch_id and sale.order_id is not distinct from w.order_id
    left join adj on adj.branch_id = w.branch_id and adj.order_id is not distinct from w.order_id
   order by w.branch_id, w.order_id is not null, w.lo, w.order_id
`;

/** A row's facts plus the bounds of its window, for the detail view. */
type FactsRow = BranchAccountFacts & { lo: string; hi: string | null };

export async function getLedgerStart(): Promise<string | null> {
  const rows = await getPrisma().$queryRawUnsafe<{ start: string | null }[]>(
    `select to_char(account_ledger_start, 'YYYY-MM-DD') as start from public.finance_settings limit 1`,
  );
  return rows[0]?.start ?? null;
}

async function requireLedgerStart(): Promise<string> {
  const start = await getLedgerStart();
  if (!start) throw httpError(409, 'The Demand Record has not been switched on yet. Finance sets its start date first.');
  return start;
}

/** Every row of every branch in scope, from the go-live day to now, with the running balance. */
async function loadAccounts(branchId: string | null, start: string): Promise<(BranchAccountRow & { lo: string; hi: string | null })[]> {
  const facts = await getPrisma().$queryRawUnsafe<FactsRow[]>(ROWS_SQL, branchId, start);
  const byBranch = new Map<string, FactsRow[]>();
  for (const f of facts) {
    // An opening row with nothing in it says nothing; a branch's demands always show.
    if (f.orderId === null && isEmptyOpening(f)) continue;
    const list = byBranch.get(f.branchId);
    if (list) list.push(f); else byBranch.set(f.branchId, [f]);
  }
  const out: (BranchAccountRow & { lo: string; hi: string | null })[] = [];
  for (const list of byBranch.values()) {
    const rows = computeBranchAccount(list);
    rows.forEach((r, i) => out.push({ ...r, lo: list[i]!.lo, hi: list[i]!.hi }));
  }
  return out;
}

function isEmptyOpening(f: BranchAccountFacts): boolean {
  return f.returns === 0 && f.discount === 0 && f.received === 0 && f.sales === 0 && f.adjustments === 0;
}

export interface DemandRecordQuery {
  branchId?: string | null;
  from?: string;
  to?: string;
  search?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/**
 * The period's rows (every branch in scope, unsorted) and each branch's balance
 * either side of it. `from` is clamped to the go-live day and `to` to today.
 */
async function loadPeriod(q: { branchId?: string | null; from?: string; to?: string }, start: string) {
  const today = businessDateStr();
  const from = q.from && q.from > start ? q.from : start;
  const to = q.to && q.to < today ? q.to : today;
  const all = await loadAccounts(q.branchId ?? null, start);

  // Balances are per branch and read off the rows either side of the period —
  // never summed down a column, which would count carried money once per row.
  const branches = new Map<string, { branchId: string; branchName: string; openingBalance: number; closingBalance: number }>();
  const inPeriod: DemandRecordRow[] = [];
  for (const r of all) {
    let b = branches.get(r.branchId);
    if (!b) {
      b = { branchId: r.branchId, branchName: r.branchName, openingBalance: 0, closingBalance: 0 };
      branches.set(r.branchId, b);
    }
    if (r.businessDate < from) {
      b.openingBalance = r.closingBalance;
      b.closingBalance = r.closingBalance;
    } else if (r.businessDate <= to) {
      b.closingBalance = r.closingBalance;
      inPeriod.push({ ...stripBounds(r), open: r.hi === null });
    }
  }
  const balances = [...branches.values()].sort((a, b) => a.branchName.localeCompare(b.branchName));
  return { from, to, inPeriod, balances };
}

export async function getDemandRecord(q: DemandRecordQuery): Promise<DemandRecordResult> {
  const start = await requireLedgerStart();
  const { from, to, inPeriod, balances } = await loadPeriod(q, start);

  const search = q.search?.trim().toLowerCase();
  const matched = search
    ? inPeriod.filter((r) => (r.demandNumber ?? 'opening').toLowerCase().includes(search) || r.branchName.toLowerCase().includes(search))
    : inPeriod;
  const dir = q.sortDir === 'asc' ? 1 : -1;
  matched.sort((a, b) => dir * (Date.parse(a.at) - Date.parse(b.at)) || a.branchName.localeCompare(b.branchName));

  const pageSize = Math.min(500, Math.max(1, Math.trunc(q.pageSize ?? 50)));
  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(q.page ?? 1)), totalPages);
  return {
    start,
    from,
    to,
    rows: matched.slice((page - 1) * pageSize, page * pageSize),
    // Totals cover the whole period (every branch in scope), not one page and
    // not the search: a search narrows what you look at, not what is owed.
    totals: totalBranchAccount(inPeriod, balances),
    branches: balances,
    pagination: { page, pageSize, total, totalPages },
  };
}

// ---------------------------------------------------------------------------
// Month-end statement
// ---------------------------------------------------------------------------

/**
 * Stock over a run of business days, per branch, summed in Postgres: the
 * ledger can hold tens of thousands of movements a month, far past what one
 * row read returns. Closing is the live balance with every later movement
 * taken back off, opening is closing less the days' net, and both are valued
 * at today's product price per product, as the Stock page values them.
 * $1 branch (null: every active branch), $2 first day, $3 last day.
 */
const STOCK_SQL = `
  with br as (
    select b.id from public.branches b where ($1::uuid is null and b.is_active) or b.id = $1::uuid
  ),
  mv as (
    select h.branch_id, h.product_id,
           coalesce(sum(h.delta) filter (where h.business_date > $3::date), 0) as later,
           coalesce(sum(h.delta) filter (where h.business_date <= $3::date), 0) as net,
           coalesce(sum(h.delta) filter (where h.business_date <= $3::date and h.type::text = 'production'), 0) as new_qty,
           -coalesce(sum(h.delta) filter (where h.business_date <= $3::date and h.type::text = 'sale'), 0) as sold_qty,
           -coalesce(sum(h.delta) filter (where h.business_date <= $3::date and h.type::text = 'return'), 0) as returned_qty,
           coalesce(sum(h.delta) filter (where h.business_date <= $3::date and h.type::text = 'adjustment'), 0) as adj_qty
      from public.stock_history h
      join br on br.id = h.branch_id
     where h.business_date >= $2::date
     group by h.branch_id, h.product_id
  ),
  st as (
    select s.branch_id, s.product_id, s.balance from public.stock s join br on br.id = s.branch_id
  ),
  pp as (
    select coalesce(st.branch_id, mv.branch_id) as branch_id,
           coalesce(st.product_id, mv.product_id) as product_id,
           coalesce(st.balance, 0) - coalesce(mv.later, 0) as closing,
           coalesce(mv.net, 0) as net,
           coalesce(mv.new_qty, 0) as new_qty, coalesce(mv.sold_qty, 0) as sold_qty,
           coalesce(mv.returned_qty, 0) as returned_qty, coalesce(mv.adj_qty, 0) as adj_qty
      from st full outer join mv on mv.branch_id = st.branch_id and mv.product_id = st.product_id
  )
  select pp.branch_id::text                                          as "branchId",
         sum(pp.closing - pp.net)::float8                            as "openingQty",
         sum((pp.closing - pp.net) * coalesce(p.price, 0))::float8   as "openingAmount",
         sum(pp.new_qty)::float8                                     as "newQty",
         sum(pp.new_qty * coalesce(p.price, 0))::float8              as "newAmount",
         sum(pp.sold_qty)::float8                                    as "soldQty",
         sum(pp.sold_qty * coalesce(p.price, 0))::float8             as "soldAmount",
         sum(pp.returned_qty)::float8                                as "returnedQty",
         sum(pp.returned_qty * coalesce(p.price, 0))::float8         as "returnedAmount",
         sum(pp.adj_qty)::float8                                     as "adjustmentQty",
         sum(pp.adj_qty * coalesce(p.price, 0))::float8              as "adjustmentAmount",
         sum(pp.closing)::float8                                     as "closingQty",
         sum(pp.closing * coalesce(p.price, 0))::float8              as "closingAmount"
    from pp
    left join public.products p on p.id = pp.product_id
   group by pp.branch_id
`;

/**
 * The value of each branch's stock at one moment of a business day, from the
 * stock ledger: the live balance with every movement after that moment taken
 * back off. Valued at each product's price in force on that day
 * (priceOnDateLateral), never today's, so a past month's statement keeps its
 * own rates. $1 branch (null: every active branch), $2 the day, $3 false for
 * the start of the day (before any of its movements), true for its end.
 */
const STOCK_VALUE_SQL = `
  with br as (
    select b.id from public.branches b where ($1::uuid is null and b.is_active) or b.id = $1::uuid
  ),
  mv as (
    select h.branch_id, h.product_id, sum(h.delta) as later
      from public.stock_history h
      join br on br.id = h.branch_id
     where h.business_date > $2::date or (not $3::boolean and h.business_date = $2::date)
     group by h.branch_id, h.product_id
  ),
  st as (
    select s.branch_id, s.product_id, s.balance from public.stock s join br on br.id = s.branch_id
  ),
  q as (
    select coalesce(st.branch_id, mv.branch_id) as branch_id,
           coalesce(st.product_id, mv.product_id) as product_id,
           coalesce(st.balance, 0) - coalesce(mv.later, 0) as qty
      from st full outer join mv on mv.branch_id = st.branch_id and mv.product_id = st.product_id
  )
  select q.branch_id::text as "branchId",
         coalesce(sum(q.qty * coalesce(px.unit_price, 0)), 0)::float8 as "amount"
    from q
    left join public.products p on p.id = q.product_id
    ${priceOnDateLateral('q.product_id', '$2::date', 'p.price', 'px')}
   group by q.branch_id
`;

/** A Collections row: a Demand Record row, or one of a branch's two stock rows (`orderId` null). */
export interface CollectionsRow extends DemandRecordRow {
  stockRow: 'opening' | 'closing' | null;
}

export interface CollectionsMonth extends Omit<DemandRecordResult, 'pagination' | 'rows'> {
  rows: CollectionsRow[];
  /** The window reaches its month's last day, so each branch ends on a Closing Stock row. */
  monthClosed: boolean;
}

/** The last day of a 'YYYY-MM-DD' date's month. */
function monthEndOf(ymd: string): string {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)), 0)).toISOString().slice(0, 10);
}

/**
 * What is still undecided in the month and will move its figures: returns not
 * accepted yet (pending, or sent back to the branch) at the Return Summary's
 * price, and deposits not approved yet. $1 branch, $2 first day, $3 last day.
 */
const PENDING_SQL = `
  with br as (
    select b.id from public.branches b where ($1::uuid is null and b.is_active) or b.id = $1::uuid
  )
  select br.id::text as "branchId",
         (select count(*) from public.production_returns r
           where r.branch_id = br.id and r.status::text in ('pending', 'returned')
             and r.business_date between $2::date and $3::date)::int as "returnsCount",
         (select coalesce(sum(round(r.qty * px.unit_price, 2)), 0) from public.production_returns r
            left join public.products p on p.id = r.product_id
            ${UNIT_PRICE_LATERAL}
           where r.branch_id = br.id and r.status::text in ('pending', 'returned')
             and r.business_date between $2::date and $3::date)::float8 as "returnsAmount",
         (select count(*) from public.cash_transfers t
           where t.branch_id = br.id and t.status::text = 'pending' and t.deleted_at is null
             and t.business_date between $2::date and $3::date)::int as "depositsCount",
         (select coalesce(sum(t.amount), 0) from public.cash_transfers t
           where t.branch_id = br.id and t.status::text = 'pending' and t.deleted_at is null
             and t.business_date between $2::date and $3::date)::float8 as "depositsAmount"
    from br
`;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * One month for every active branch (or one branch): its payment from the
 * Demand Record and its stock from the ledger, side by side. A month before
 * the go-live day, or after today, is refused; the running month is given up
 * to today and marked incomplete.
 */
export async function getMonthStatement(month: string, branchId: string | null): Promise<MonthStatement> {
  const m = MONTH.exec(month);
  if (!m) throw httpError(400, 'month must be YYYY-MM');
  const start = await requireLedgerStart();
  const today = businessDateStr();
  const first = `${month}-01`;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
  if (last < start) throw httpError(400, `The Demand Record starts on ${start}; there is no statement for ${month}.`);
  if (first > today) throw httpError(400, `${month} has not started yet.`);
  const from = first > start ? first : start;
  const to = last < today ? last : today;

  const prisma = getPrisma();
  const [period, stockRows, pendingRows, names] = await Promise.all([
    loadPeriod({ branchId, from, to }, start),
    prisma.$queryRawUnsafe<(MonthStatementStock & { branchId: string })[]>(STOCK_SQL, branchId, from, to),
    prisma.$queryRawUnsafe<{ branchId: string; returnsCount: number; returnsAmount: number; depositsCount: number; depositsAmount: number }[]>(
      PENDING_SQL, branchId, from, to),
    prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
      `select id::text as id, name from public.branches where ($1::uuid is null and is_active) or id = $1::uuid order by name`, branchId),
  ]);

  const zeroStock: MonthStatementStock = {
    openingQty: 0, openingAmount: 0, newQty: 0, newAmount: 0, soldQty: 0, soldAmount: 0,
    returnedQty: 0, returnedAmount: 0, adjustmentQty: 0, adjustmentAmount: 0, closingQty: 0, closingAmount: 0,
  };
  const stockBy = new Map(stockRows.map((r) => [r.branchId, r]));
  const pendingBy = new Map(pendingRows.map((r) => [r.branchId, r]));
  const balanceBy = new Map(period.balances.map((b) => [b.branchId, b]));

  const branches: MonthStatementBranch[] = names.map(({ id, name }) => {
    const rows = period.inPeriod.filter((r) => r.branchId === id);
    const bal = balanceBy.get(id) ?? { openingBalance: 0, closingBalance: 0 };
    const t = totalBranchAccount(rows, [bal]);
    const { branchId: _b, ...stock } = stockBy.get(id) ?? { branchId: id, ...zeroStock };
    for (const k of Object.keys(stock) as (keyof MonthStatementStock)[]) stock[k] = toPaisa(stock[k]);
    const p = pendingBy.get(id);
    return {
      branchId: id,
      branchName: name,
      payment: {
        openingBalance: t.openingBalance,
        delivered: t.delivered,
        returns: t.returns,
        discount: t.discount,
        gTotal: t.gTotal,
        companyShare: t.companyShare,
        adjustments: t.adjustments,
        received: t.received,
        closingBalance: t.closingBalance,
        demands: rows.filter((r) => r.orderId !== null).length,
        lastRowOpen: rows.length > 0 && rows[rows.length - 1]!.open,
      },
      stock,
      pending: {
        returns: { count: p?.returnsCount ?? 0, amount: toPaisa(p?.returnsAmount ?? 0) },
        deposits: { count: p?.depositsCount ?? 0, amount: toPaisa(p?.depositsAmount ?? 0) },
      },
    };
  });

  return { month, from, to, complete: last < today, start, branches };
}

/**
 * Every row of every branch in scope from the go-live day, in each branch's
 * order — for reports that regroup the Demand Record (the Finance Dashboard's
 * income). Null while the Demand Record is not switched on.
 */
export async function getDemandRecordRows(branchId: string | null): Promise<{ start: string; rows: DemandRecordRow[] } | null> {
  const start = await getLedgerStart();
  if (!start) return null;
  const rows = await loadAccounts(branchId, start);
  return { start, rows: rows.map((r) => ({ ...stripBounds(r), open: r.hi === null })) };
}

/**
 * The whole period with no paging or search — every row, by branch then in
 * order — for an export that must hold all of it (the Collections sheet).
 * Null while the Demand Record is not switched on, so the caller can fall back
 * rather than fail.
 */
export async function getDemandRecordPeriod(q: { branchId?: string | null; from?: string; to?: string }): Promise<Omit<DemandRecordResult, 'pagination'> | null> {
  const start = await getLedgerStart();
  if (!start) return null;
  const { from, to, inPeriod, balances } = await loadPeriod(q, start);
  inPeriod.sort((a, b) => a.branchName.localeCompare(b.branchName) || Date.parse(a.at) - Date.parse(b.at));
  return { start, from, to, rows: inPeriod, totals: totalBranchAccount(inPeriod, balances), branches: balances };
}

/**
 * The Collections export's month (the owner's rules, 2026-10-29), built from
 * the Demand Record's rows but laid out differently from the page:
 *
 *  - A demand belongs to its REQUIRED date, not the day it was submitted: a
 *    demand submitted on 31 Oct for 1 Nov is November's, and its Date is 1 Nov
 *    (`businessDate` carries the required date here). A demand with no
 *    required date keeps its business date. Each row's own figures (delivered,
 *    the returns, deposits and discounts in its window) are the record's.
 *  - Each branch starts the window with an "Opening Stock" row (`orderId` and
 *    `demandNumber` null) on the first day: Delivered is the value of the stock
 *    the branch held that morning (STOCK_SQL's opening, at today's prices), and
 *    it is calculated like a demand — G. Total, Company Share at the branch's
 *    % today, into the balance. When the window holds the record's own opening
 *    row (the go-live month), its returns, deposits and Finance entries are
 *    folded into this row.
 *  - A demand submitted before the go-live day but required inside the
 *    window (submitted 30 Sep for 1 Oct) follows the opening stock as a row
 *    of its own, with no Received.
 *  - When the window reaches the last day of its month (owner's rule,
 *    2026-10-29), each branch closes it with a "Closing Stock" row on that
 *    day: the stock still held at the end of it, deducted — Delivered is
 *    minus its value, so its Company Share comes off the balance — the
 *    mirror of the next month's Opening Stock, which charges it back. Nothing
 *    is posted: it is worked out from the records on every export, so
 *    exporting a month again gives the same figures and deducts nothing twice.
 *  - Both stock rows are valued at the prices in force on their own day
 *    (STOCK_VALUE_SQL), so a closed month keeps its rates.
 *  - Previous / Closing run per branch down the rows in date order, starting
 *    from the balance of every row dated before the window. Counting the opening
 *    stock adds to that balance, so this sheet's Closing is NOT the Demand
 *    Record page's — the owner chose this knowing it.
 *
 * Null while the Demand Record is not switched on.
 */
export async function getCollectionsMonth(q: { branchId?: string | null; from: string; to: string }): Promise<CollectionsMonth | null> {
  const start = await getLedgerStart();
  if (!start) return null;
  const from = q.from > start ? q.from : start;
  // Not cut at today: a demand already delivered can be required on a later
  // day, and the window runs to whatever required date was asked for.
  const to = q.to;
  const branchId = q.branchId ?? null;
  const prisma = getPrisma();

  const all = await loadAccounts(branchId, start);
  const orderIds = all.flatMap((r) => (r.orderId ? [r.orderId] : []));
  const monthClosed = to === monthEndOf(to);
  const [required, stock, closingStock, branchRows, before] = await Promise.all([
    orderIds.length === 0
      ? Promise.resolve([] as { id: string; day: string }[])
      : prisma.$queryRawUnsafe<{ id: string; day: string }[]>(
        `select id::text as id, to_char(coalesce(required_date, business_date), 'YYYY-MM-DD') as day
           from public.production_orders where id = any($1::uuid[])`, orderIds),
    // The window's first morning, and the end of the month's last day.
    prisma.$queryRawUnsafe<{ branchId: string; amount: number }[]>(STOCK_VALUE_SQL, branchId, from, false),
    monthClosed
      ? prisma.$queryRawUnsafe<{ branchId: string; amount: number }[]>(STOCK_VALUE_SQL, branchId, to, true)
      : Promise.resolve([] as { branchId: string; amount: number }[]),
    prisma.$queryRawUnsafe<{ id: string; name: string; pct: number }[]>(
      `select id::text as id, name, app.resolve_company_share_pct(id)::float8 as pct
         from public.branches where $1::uuid is null or id = $1::uuid order by name`, branchId),
    getDemandFiguresBeforeRecord({ branchId, from, to }),
  ]);
  const beforeByBranch = new Map<string, DemandBeforeRecordRow[]>();
  for (const r of before?.rows ?? []) {
    const list = beforeByBranch.get(r.branchId);
    if (list) list.push(r); else beforeByBranch.set(r.branchId, [r]);
  }
  const dayOf = new Map(required.map((r) => [r.id, r.day]));
  const stockOf = new Map(stock.map((s) => [s.branchId, toPaisa(s.amount)]));
  const closingStockOf = new Map(closingStock.map((s) => [s.branchId, toPaisa(s.amount)]));
  const dateOf = (r: BranchAccountRow) => (r.orderId ? dayOf.get(r.orderId) ?? r.businessDate : r.businessDate);

  const byBranch = new Map<string, (BranchAccountRow & { lo: string; hi: string | null })[]>();
  for (const r of all) {
    const list = byBranch.get(r.branchId);
    if (list) list.push(r); else byBranch.set(r.branchId, [r]);
  }

  const rows: CollectionsRow[] = [];
  const balances: DemandRecordResult['branches'] = [];
  for (const b of branchRows) {
    const list = byBranch.get(b.id) ?? [];
    // What every row dated before the window left owing — each row's own effect, by its date.
    const carried = toPaisa(list.filter((r) => dateOf(r) < from).reduce((a, r) => a + r.closingBalance - r.previousBalance, 0));
    const inWindow = list
      .filter((r) => { const d = dateOf(r); return d >= from && d <= to; })
      .sort((x, y) => dateOf(x).localeCompare(dateOf(y)) || Date.parse(x.at) - Date.parse(y.at));
    const recordOpening = inWindow.find((r) => r.orderId === null);
    // A demand submitted before the go-live day but required inside the
    // window is a demand of the window like any other (owner's rule,
    // 2026-10-29): its own figures (getDemandFiguresBeforeRecord), no Received
    // — cash then was not in the app — and into the balance after the opening
    // stock. Its returns and discounts stop at the go-live instant, and what
    // came after is the record's opening row, folded in below, so nothing
    // counts twice.
    const demands: { fact: BranchAccountFacts; open: boolean }[] = [
      ...inWindow.filter((r) => r.orderId !== null).map(({ lo: _lo, hi, ...r }) => ({ fact: { ...r, businessDate: dateOf(r) }, open: hi === null })),
      ...(beforeByBranch.get(b.id) ?? []).map((r) => ({
        fact: {
          branchId: b.id, branchName: r.branchName, orderId: r.orderId, demandNumber: r.demandNumber,
          businessDate: r.businessDate, at: r.submittedAt, status: null, frozenPct: r.sharePct, livePct: b.pct,
          delivered: r.delivered, returns: r.returns, returnsQty: 0, discount: r.discount,
          received: 0, sales: 0, adjustments: 0, unpricedLines: 0,
        },
        open: false,
      })),
    ].sort((x, y) => x.fact.businessDate.localeCompare(y.fact.businessDate) || Date.parse(x.fact.at) - Date.parse(y.fact.at));
    const stockValue = stockOf.get(b.id) ?? 0;
    const closingValue = closingStockOf.get(b.id) ?? 0;
    if (demands.length === 0 && !recordOpening && stockValue === 0 && closingValue === 0 && carried === 0) continue;

    const opening: BranchAccountFacts = {
      branchId: b.id,
      branchName: recordOpening?.branchName ?? list[0]?.branchName ?? b.name,
      orderId: null,
      demandNumber: null,
      businessDate: from,
      at: recordOpening?.at ?? new Date(Date.parse(`${from}T02:00:00+05:00`)).toISOString(),
      status: null,
      frozenPct: null,
      livePct: b.pct,
      delivered: stockValue,
      returns: recordOpening?.returns ?? 0,
      returnsQty: recordOpening?.returnsQty ?? 0,
      discount: recordOpening?.discount ?? 0,
      received: recordOpening?.received ?? 0,
      sales: recordOpening?.sales ?? 0,
      adjustments: recordOpening?.adjustments ?? 0,
      unpricedLines: 0,
    };
    // Last of all on the month's last day, after every demand of that day.
    const closing: BranchAccountFacts | null = !monthClosed ? null : {
      ...opening,
      businessDate: to,
      at: new Date(Date.parse(`${to}T23:59:59+05:00`)).toISOString(),
      delivered: -closingValue,
      returns: 0, returnsQty: 0, discount: 0, received: 0, sales: 0, adjustments: 0,
    };
    const computed = computeBranchAccount([opening, ...demands.map((d) => d.fact), ...(closing ? [closing] : [])], carried);
    computed.forEach((r, i) => rows.push({
      ...r,
      open: i === 0 || i > demands.length ? false : demands[i - 1]!.open,
      stockRow: i === 0 ? 'opening' : i > demands.length ? 'closing' : null,
    }));
    balances.push({
      branchId: b.id,
      branchName: opening.branchName,
      openingBalance: carried,
      closingBalance: computed[computed.length - 1]!.closingBalance,
    });
  }
  const rank = (r: CollectionsRow) => (r.stockRow === 'opening' ? 0 : r.stockRow === 'closing' ? 2 : 1);
  rows.sort((a, b) => a.branchName.localeCompare(b.branchName) || a.businessDate.localeCompare(b.businessDate)
    || rank(a) - rank(b) || Date.parse(a.at) - Date.parse(b.at));
  return { start, from, to, rows, totals: totalBranchAccount(rows, balances), branches: balances, monthClosed };
}

function stripBounds<T extends { lo: string; hi: string | null }>(r: T): Omit<T, 'lo' | 'hi'> {
  const { lo: _lo, hi: _hi, ...rest } = r;
  return rest;
}

/** One row of the Demand Record with every record behind it. `orderId` null: the branch's opening row. */
export async function getDemandRecordDetail(branchId: string, orderId: string | null): Promise<DemandRecordDetail> {
  const start = await requireLedgerStart();
  const rows = await loadAccounts(branchId, start);
  const row = rows.find((r) => r.orderId === orderId);
  if (!row) throw httpError(404, orderId ? 'That demand is not in the Demand Record.' : 'This branch has no opening row.');
  const prisma = getPrisma();
  // The same predicates as ROWS_SQL, for one window: $1 branch, $2 start, $3 lo, $4 hi (null: open), and
  // for discounts $5 the demand.
  const win = (col: string) => `${col} > $3::timestamptz and ($4::timestamptz is null or ${col} <= $4::timestamptz) and ${col} >= ${START_AT}`;
  const args = [branchId, start, row.lo, row.hi] as const;

  // The opening row counts Finance's entries and returns only (see the header), so it lists nothing else.
  const counted = orderId !== null;
  const [lines, returns, discounts, payments, sales, adjustments] = await Promise.all([
    orderId
      ? prisma.$queryRawUnsafe<DemandRecordDetail['lines']>(`
          select coalesce(p.name, i.product_name, 'Unknown product')       as "productName",
                 coalesce(i.qty, 0)::float8                                as "orderedQty",
                 coalesce(i.approved_qty, 0)::float8                       as "deliveredQty",
                 coalesce(i.unit_price, ip.unit_price)::float8             as "unitPrice",
                 case when i.unit_price is not null then 'order'
                      when ip.unit_price is not null then 'price_history' else 'none' end as "priceSource",
                 (coalesce(i.approved_qty, 0) * coalesce(i.unit_price, ip.unit_price, 0))::float8 as "amount"
            from public.production_order_items i
            join public.production_orders o on o.id = i.production_order_id
            left join public.products p on p.id = i.product_id
            ${priceOnDateLateral('i.product_id', 'o.business_date', 'p.price', 'ip')}
           where i.production_order_id = $1::uuid
           order by 1`, orderId)
      : Promise.resolve([]),
    prisma.$queryRawUnsafe<DemandRecordDetail['returns']>(`
      select r.id::text as "id", to_char(r.business_date, 'YYYY-MM-DD') as "businessDate",
             coalesce(r.product_name, p.name) as "productName", r.qty::float8 as "qty",
             px.unit_price::float8 as "unitPrice", coalesce(round(r.qty * px.unit_price, 2), 0)::float8 as "amount",
             to_json(r.created_at)#>>'{}' as "createdAt"
        from public.production_returns r
        left join public.products p on p.id = r.product_id
        ${UNIT_PRICE_LATERAL}
       where r.branch_id = $1::uuid and r.status::text = 'accepted' and ${win('r.created_at')}
       order by r.created_at`, ...args),
    !counted ? Promise.resolve([]) : prisma.$queryRawUnsafe<DemandRecordDetail['discounts']>(`
      with d as (
        select o.id from public.production_orders o
         where o.branch_id = $1::uuid and o.status::text in ${DELIVERED} and o.business_date >= $2::date
      )
      select x.id::text as "id", x.demand_number as "demandNumber", x.amount::float8 as "amount", x.reason as "reason",
             to_json(x.created_at)#>>'{}' as "createdAt", coalesce(x.production_order_id = $5::uuid, false) as "linked"
        from public.branch_discounts x
       where x.branch_id = $1::uuid and x.status::text = 'approved'
         and ((x.production_order_id = $5::uuid)
              or (not exists (select 1 from d where d.id = x.production_order_id) and ${win('x.created_at')}))
       order by x.created_at`, ...args, orderId),
    !counted ? Promise.resolve([]) : prisma.$queryRawUnsafe<DemandRecordDetail['payments']>(`
      select t.id::text as "id", t.transfer_no as "transferNo", t.voucher_no as "voucherNo",
             to_char(t.business_date, 'YYYY-MM-DD') as "businessDate", t.amount::float8 as "amount",
             to_json(t.created_at)#>>'{}' as "createdAt"
        from public.cash_transfers t
       where t.branch_id = $1::uuid and t.status::text = 'approved' and t.deleted_at is null and t.amount > 0
         and ${win('t.created_at')}
       order by t.created_at`, ...args),
    !counted ? Promise.resolve([]) : prisma.$queryRawUnsafe<{ count: number; amount: number }[]>(`
      select count(*)::int as "count", coalesce(sum(s.grand_total), 0)::float8 as "amount"
        from public.orders s
       where s.branch_id = $1::uuid and s.status::text <> 'cancelled' and s.payment_method::text <> 'staff'
         and ${win('s.created_at')}`, ...args),
    prisma.$queryRawUnsafe<BranchAccountAdjustment[]>(`
      select ${ADJUSTMENT_COLUMNS}
        from public.branch_account_adjustments a
        join public.branches b on b.id = a.branch_id
       where a.branch_id = $1::uuid and ${win('a.effective_at')}
       order by a.effective_at, a.created_at`, ...args),
  ]);
  return {
    row: { ...stripBounds(row), open: row.hi === null },
    lines,
    returns,
    discounts,
    payments,
    sales: sales[0] ?? { count: 0, amount: 0 },
    adjustments,
  };
}

// ---------------------------------------------------------------------------
// Finance's entries
// ---------------------------------------------------------------------------

const ADJUSTMENT_COLUMNS = `
  a.id::text as "id", a.branch_id::text as "branchId", b.name as "branchName", a.kind as "kind",
  a.amount::float8 as "amount", to_char(a.business_date, 'YYYY-MM-DD') as "businessDate",
  to_json(a.effective_at)#>>'{}' as "effectiveAt", a.reason as "reason",
  a.reversal_of::text as "reversalOf",
  (select r.id::text from public.branch_account_adjustments r where r.reversal_of = a.id) as "reversedBy",
  a.created_by_name as "createdByName", to_json(a.created_at)#>>'{}' as "createdAt"
`;

export async function listAdjustments(branchId: string | null): Promise<BranchAccountAdjustment[]> {
  return getPrisma().$queryRawUnsafe<BranchAccountAdjustment[]>(`
    select ${ADJUSTMENT_COLUMNS}
      from public.branch_account_adjustments a
      join public.branches b on b.id = a.branch_id
     where ($1::uuid is null or a.branch_id = $1::uuid)
     order by a.effective_at desc, a.created_at desc`, branchId);
}

export interface Actor { uid: string; name: string }

export interface PostAdjustmentInput {
  requestId: string;
  branchId: string;
  kind: 'opening' | 'adjustment';
  amount: number;
  /** Ignored for an opening entry, which always sits at the go-live day. */
  businessDate?: string;
  reason: string;
}

/**
 * Post an opening balance or an adjustment. A retry with the same `requestId`
 * returns the entry the first call made instead of posting a second one.
 *
 * Serialised per branch with a transaction-scoped advisory lock, so two
 * concurrent openings for one branch cannot both pass the "one live opening"
 * check.
 */
export async function postAdjustment(input: PostAdjustmentInput, actor: Actor): Promise<{ entry: BranchAccountAdjustment; replayed: boolean }> {
  const start = await requireLedgerStart();
  const amount = toPaisa(input.amount);
  if (amount === 0) throw httpError(400, 'Amount cannot be zero.');
  const businessDate = input.kind === 'opening' ? start : (input.businessDate ?? businessDateStr());
  if (businessDate < start) throw httpError(400, `Entries start on ${start}, the Demand Record's go-live day. Earlier money belongs in the opening balance.`);
  if (businessDate > businessDateStr()) throw httpError(400, 'An entry cannot be dated in the future.');

  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
      `select id::text as id from public.branch_account_adjustments where request_id = $1::uuid`, input.requestId);
    if (existing[0]) return { entry: await getAdjustment(tx, existing[0].id), replayed: true };

    await tx.$queryRawUnsafe(`select pg_advisory_xact_lock(hashtext('branch_account:' || $1))::text`, input.branchId);
    const branch = await tx.$queryRawUnsafe<{ id: string }[]>(`select id::text as id from public.branches where id = $1::uuid`, input.branchId);
    if (!branch[0]) throw httpError(404, 'Branch not found.');
    if (input.kind === 'opening') {
      const live = await tx.$queryRawUnsafe<{ id: string }[]>(`
        select a.id::text as id from public.branch_account_adjustments a
         where a.branch_id = $1::uuid and a.kind = 'opening'
           and not exists (select 1 from public.branch_account_adjustments r where r.reversal_of = a.id)`, input.branchId);
      if (live[0]) throw httpError(409, 'This branch already has an opening balance. Reverse it first to enter a different one.');
    }

    // Placed so it lands where it belongs: an opening at the go-live instant
    // (the opening row); an adjustment dated today now, and one dated earlier
    // at the end of that business day, after that day's demands.
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`
      insert into public.branch_account_adjustments
        (branch_id, kind, amount, effective_at, business_date, reason, request_id, created_by, created_by_name)
      values ($1::uuid, $2, $3::numeric, case
                when $2 = 'opening' then (($4::date + time '02:00') at time zone 'Asia/Karachi')
                when $4::date = $8::date then now()
                else (($4::date + 1 + time '02:00') at time zone 'Asia/Karachi') - interval '1 microsecond'
              end, $4::date, $5, $6::uuid, $7::uuid, $9)
      on conflict (request_id) do nothing
      returning id::text as id`,
      input.branchId, input.kind, amount, businessDate, input.reason.trim(), input.requestId, actor.uid,
      businessDateStr(), actor.name);
    if (!rows[0]) {
      // A concurrent call with the same requestId won the insert.
      const again = await tx.$queryRawUnsafe<{ id: string }[]>(
        `select id::text as id from public.branch_account_adjustments where request_id = $1::uuid`, input.requestId);
      return { entry: await getAdjustment(tx, again[0]!.id), replayed: true };
    }
    return { entry: await getAdjustment(tx, rows[0].id), replayed: false };
  });
}

/** Undo an entry with its exact opposite, dated now. The original stays as it was. */
export async function reverseAdjustment(
  id: string,
  input: { requestId: string; reason: string },
  actor: Actor,
): Promise<{ entry: BranchAccountAdjustment; replayed: boolean }> {
  await requireLedgerStart();
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
      `select id::text as id from public.branch_account_adjustments where request_id = $1::uuid`, input.requestId);
    if (existing[0]) return { entry: await getAdjustment(tx, existing[0].id), replayed: true };

    const orig = await tx.$queryRawUnsafe<{ branchId: string; kind: string; amount: number }[]>(
      `select branch_id::text as "branchId", kind, amount::float8 as amount
         from public.branch_account_adjustments where id = $1::uuid for update`, id);
    if (!orig[0]) throw httpError(404, 'Entry not found.');
    if (orig[0].kind === 'reversal') throw httpError(400, 'A reversal cannot be reversed. Post a new entry instead.');
    const done = await tx.$queryRawUnsafe<{ id: string }[]>(
      `select id::text as id from public.branch_account_adjustments where reversal_of = $1::uuid`, id);
    if (done[0]) throw httpError(409, 'This entry has already been reversed.');

    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`
      insert into public.branch_account_adjustments
        (branch_id, kind, amount, effective_at, business_date, reason, reversal_of, request_id, created_by, created_by_name)
      values ($1::uuid, 'reversal', $2::numeric, now(), $3::date, $4, $5::uuid, $6::uuid, $7::uuid, $8)
      returning id::text as id`,
      orig[0].branchId, -orig[0].amount, businessDateStr(), input.reason.trim(), id, input.requestId, actor.uid, actor.name);
    return { entry: await getAdjustment(tx, rows[0]!.id), replayed: false };
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof getPrisma>['$transaction']>[0]>[0];

async function getAdjustment(tx: Tx, id: string): Promise<BranchAccountAdjustment> {
  const rows = await tx.$queryRawUnsafe<BranchAccountAdjustment[]>(`
    select ${ADJUSTMENT_COLUMNS}
      from public.branch_account_adjustments a
      join public.branches b on b.id = a.branch_id
     where a.id = $1::uuid`, id);
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Go-live
// ---------------------------------------------------------------------------

/**
 * Switch the Demand Record on from `start`, or move its start. Demands
 * delivered from that day on that the trigger never froze (they were delivered
 * before the migration) get today's % frozen now, marked 'go_live'. Snapshots
 * already taken are never changed.
 */
export async function setLedgerStart(start: string): Promise<{ previous: string | null; start: string; frozen: number }> {
  if (start > businessDateStr()) throw httpError(400, 'The start date cannot be in the future.');
  return getPrisma().$transaction(async (tx) => {
    const prev = await tx.$queryRawUnsafe<{ start: string | null }[]>(
      `select to_char(account_ledger_start, 'YYYY-MM-DD') as start from public.finance_settings limit 1 for update`);
    if (prev.length === 0) throw httpError(409, 'Finance settings are missing.');
    await tx.$executeRawUnsafe(`update public.finance_settings set account_ledger_start = $1::date`, start);
    const frozen = await tx.$executeRawUnsafe(`
      insert into public.production_order_share_snapshots (production_order_id, company_share_pct, source)
      select o.id, app.resolve_company_share_pct(o.branch_id), 'go_live'
        from public.production_orders o
       where o.status::text in ${DELIVERED} and o.business_date >= $1::date
      on conflict (production_order_id) do nothing`, start);
    return { previous: prev[0]!.start, start, frozen };
  });
}

// ---------------------------------------------------------------------------
// For the Daily Ledger's accounting workbook
// ---------------------------------------------------------------------------

/** The Demand Record as the accounting workbook journals it. Amounts in rupees. */
export interface DemandRecordForAccounts {
  start: string;
  /** Every delivered demand from the go-live day, with its Company Share as the page computes it. */
  demands: { orderId: string; demandNumber: string; branchId: string; branchName: string; businessDate: string; gTotal: number; sharePct: number; companyShare: number }[];
  /** Finance's entries the record counts (effective from the go-live instant). */
  adjustments: { id: string; branchId: string; branchName: string; kind: 'opening' | 'adjustment' | 'reversal'; amount: number; businessDate: string; reason: string; reversalOf: string | null }[];
  /** The approved cash transfers the record counts as Received. */
  receivedTransfers: { id: string; transferNo: string; branchId: string; branchName: string; amount: number; businessDate: string }[];
  /** The page's Balance by Branch for the same period and branch filter. */
  pageBalances: { branchId: string; branchName: string; closingBalance: number }[];
}

/**
 * Everything the workbook needs to carry the Demand Record into its books:
 * the same rows the page shows (so each demand's Company Share is the page's
 * figure), Finance's entries, the deposits counted as Received — selected by
 * exactly the rule ROWS_SQL places them by (approved, live, positive, after the
 * go-live instant and after the branch's first demand) — and the page's own
 * Balance by Branch for the period, to reconcile against. Null while the
 * Demand Record is not switched on.
 */
export async function getDemandRecordForAccounts(
  q: { branchId?: string | null; from: string; to: string },
): Promise<DemandRecordForAccounts | null> {
  const start = await getLedgerStart();
  if (!start) return null;
  const branchId = q.branchId ?? null;
  const prisma = getPrisma();

  const [rows, period, adjustments, receivedTransfers] = await Promise.all([
    loadAccounts(branchId, start),
    loadPeriod({ branchId, from: q.from, to: q.to }, start),
    prisma.$queryRawUnsafe<DemandRecordForAccounts['adjustments']>(`
      select a.id::text as "id", a.branch_id::text as "branchId", b.name as "branchName", a.kind as "kind",
             a.amount::float8 as "amount", to_char(a.business_date, 'YYYY-MM-DD') as "businessDate",
             a.reason as "reason", a.reversal_of::text as "reversalOf"
        from public.branch_account_adjustments a
        join public.branches b on b.id = a.branch_id
       where ($1::uuid is null or a.branch_id = $1::uuid) and a.effective_at >= ${START_AT}
       order by a.effective_at, a.created_at`, branchId, start),
    prisma.$queryRawUnsafe<DemandRecordForAccounts['receivedTransfers']>(`
      with first_demand as (
        select o.branch_id, min(o.submitted_at) as lo
          from public.production_orders o
         where o.status::text in ${DELIVERED} and o.business_date >= $2::date
           and ($1::uuid is null or o.branch_id = $1::uuid)
         group by o.branch_id
      )
      select t.id::text as "id", t.transfer_no as "transferNo", t.branch_id::text as "branchId",
             coalesce(b.name, t.branch_name) as "branchName", t.amount::float8 as "amount",
             to_char(t.business_date, 'YYYY-MM-DD') as "businessDate"
        from public.cash_transfers t
        join first_demand f on f.branch_id = t.branch_id
        left join public.branches b on b.id = t.branch_id
       where t.status::text = 'approved' and t.deleted_at is null and t.amount > 0
         and t.created_at > f.lo and t.created_at >= ${START_AT}`, branchId, start),
  ]);

  return {
    start,
    demands: rows
      .filter((r) => r.orderId !== null)
      .map((r) => ({
        orderId: r.orderId!,
        demandNumber: r.demandNumber ?? r.orderId!,
        branchId: r.branchId,
        branchName: r.branchName,
        businessDate: r.businessDate,
        gTotal: r.gTotal,
        sharePct: r.sharePct,
        companyShare: r.companyShare,
      })),
    adjustments,
    receivedTransfers,
    pageBalances: period.balances.map((b) => ({ branchId: b.branchId, branchName: b.branchName, closingBalance: b.closingBalance })),
  };
}

// ---------------------------------------------------------------------------
// Before the Demand Record began
// ---------------------------------------------------------------------------

/** A delivered demand dated before the go-live day, on the Demand Record's money rules. Rupees. */
export interface DemandBeforeRecordRow {
  orderId: string;
  demandNumber: string | null;
  branchId: string;
  branchName: string;
  /** The demand's required date (its business date when it has none). */
  businessDate: string;
  /** ISO time the demand was submitted. */
  submittedAt: string;
  delivered: number;
  returns: number;
  discount: number;
  gTotal: number;
  sharePct: number;
  companyShare: number;
}

/**
 * The demand side of the Demand Record for days BEFORE it began — the owner's
 * rule (2026-10-25): July–September show each delivered demand's Delivered,
 * Return, Discount, G. Total and Company Share, but no Received and no
 * balance, because cash was not recorded in the app before the go-live day
 * (which is why the record starts then).
 *
 * The same rules as ROWS_SQL, so a pre-go-live demand reads like one after it:
 * delivered lines at their own price, else the price on the demand's date;
 * accepted returns in the window up to the branch's next demand; discounts on
 * the demand they were claimed against, else by window; the frozen %, else
 * today's. Windows are cut at the go-live instant, so a return or discount
 * from the record's own days is never counted here as well.
 */
export async function getDemandFiguresBeforeRecord(
  q: { branchId?: string | null; from: string; to: string },
): Promise<{ start: string; rows: DemandBeforeRecordRow[] } | null> {
  const start = await getLedgerStart();
  if (!start) return null;
  // Placed by required date (owner's rule, 2026-10-29), so a demand submitted
  // before the go-live day can still be required inside a window after it.
  const rows = await getPrisma().$queryRawUnsafe<(Omit<DemandBeforeRecordRow, 'gTotal' | 'sharePct' | 'companyShare'> & { frozenPct: number | null; livePct: number })[]>(`
    with br as (
      select b.id, b.name from public.branches b where ($1::uuid is null or b.id = $1::uuid)
    ),
    d as (
      select o.id, o.branch_id, o.demand_number, o.business_date as bd, o.submitted_at,
             coalesce(o.required_date, o.business_date) as rd,
             coalesce(o.branch_name, br.name) as branch_name, sn.company_share_pct as frozen_pct
        from public.production_orders o
        join br on br.id = o.branch_id
        left join public.production_order_share_snapshots sn on sn.production_order_id = o.id
       where o.status::text in ${DELIVERED}
         and o.business_date < $2::date
    ),
    w as (
      select d.branch_id, d.id as order_id, d.submitted_at as lo,
             least(coalesce(lead(d.submitted_at) over (partition by d.branch_id order by d.submitted_at, d.id), ${START_AT}),
                   ${START_AT}) as hi
        from d
    ),
    dv as (
      select d.id as order_id,
             coalesce(sum(coalesce(i.approved_qty, 0) * coalesce(i.unit_price, ip.unit_price, 0)), 0) as delivered
        from d
        join public.production_order_items i on i.production_order_id = d.id
        left join public.products p on p.id = i.product_id
        ${priceOnDateLateral('i.product_id', 'd.bd', 'p.price', 'ip')}
       group by d.id
    ),
    ret as (
      select w.order_id, coalesce(sum(round(r.qty * px.unit_price, 2)), 0) as amount
        from w
        join public.production_returns r
          on r.branch_id = w.branch_id and r.created_at > w.lo and r.created_at <= w.hi
        left join public.products p on p.id = r.product_id
        ${UNIT_PRICE_LATERAL}
       where r.status::text = 'accepted'
       group by w.order_id
    ),
    disc as (
      -- Claimed against the demand, and made before the go-live instant: one
      -- made after it is the record's (ROWS_SQL places it by time), so it is
      -- never counted on both sides.
      select x.production_order_id as order_id, sum(x.amount) as amount
        from public.branch_discounts x
        join d on d.id = x.production_order_id
       where x.status::text = 'approved' and x.created_at < ${START_AT}
       group by x.production_order_id
      union all
      select w.order_id, sum(x.amount)
        from w
        join public.branch_discounts x
          on x.branch_id = w.branch_id and x.created_at > w.lo and x.created_at <= w.hi
       where x.status::text = 'approved'
         and not exists (select 1 from public.production_orders o2
                          where o2.id = x.production_order_id and o2.status::text in ${DELIVERED})
       group by w.order_id
    )
    select d.id::text                                          as "orderId",
           d.demand_number                                     as "demandNumber",
           d.branch_id::text                                   as "branchId",
           d.branch_name                                       as "branchName",
           to_char(d.rd, 'YYYY-MM-DD')                         as "businessDate",
           to_json(d.submitted_at)#>>'{}'                      as "submittedAt",
           coalesce(dv.delivered, 0)::float8                   as "delivered",
           coalesce(ret.amount, 0)::float8                     as "returns",
           coalesce((select sum(amount) from disc where disc.order_id = d.id), 0)::float8 as "discount",
           d.frozen_pct::float8                                as "frozenPct",
           app.resolve_company_share_pct(d.branch_id)::float8  as "livePct"
      from d
      left join dv on dv.order_id = d.id
      left join ret on ret.order_id = d.id
     where d.rd between $3::date and $4::date
     order by d.rd, d.demand_number, d.branch_name`,
    q.branchId ?? null, start, q.from, q.to);

  return {
    start,
    rows: rows.map(({ frozenPct, livePct, ...r }) => {
      const sharePct = frozenPct ?? livePct;
      const gTotal = toPaisa(r.delivered - r.returns - r.discount);
      return { ...r, delivered: toPaisa(r.delivered), returns: toPaisa(r.returns), discount: toPaisa(r.discount), gTotal, sharePct, companyShare: companyShareOf(gTotal, sharePct) };
    }),
  };
}

