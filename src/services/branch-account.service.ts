import { getPrisma } from '../db';
import {
  businessDateStr,
  computeBranchAccount,
  totalBranchAccount,
  toPaisa,
  type BranchAccountAdjustment,
  type BranchAccountFacts,
  type BranchAccountRow,
  type DemandRecordDetail,
  type DemandRecordResult,
  type DemandRecordRow,
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
     where x.status::text = 'approved' and x.created_at >= ${START_AT}
       and not exists (select 1 from d where d.id = x.production_order_id)
     group by w.branch_id, w.order_id
  ),
  pay as (
    select w.branch_id, w.order_id, sum(t.amount) as amount
      from w
      join public.cash_transfers t
        on t.branch_id = w.branch_id and t.created_at > w.lo and (w.hi is null or t.created_at <= w.hi)
     where t.status::text = 'approved' and t.deleted_at is null and t.amount > 0
       and t.created_at >= ${START_AT}
     group by w.branch_id, w.order_id
  ),
  sale as (
    select w.branch_id, w.order_id, sum(s.grand_total) as amount
      from w
      join public.orders s
        on s.branch_id = w.branch_id and s.created_at > w.lo and (w.hi is null or s.created_at <= w.hi)
     where s.status::text <> 'cancelled' and s.payment_method::text <> 'staff'
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
    prisma.$queryRawUnsafe<DemandRecordDetail['discounts']>(`
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
    prisma.$queryRawUnsafe<DemandRecordDetail['payments']>(`
      select t.id::text as "id", t.transfer_no as "transferNo", t.voucher_no as "voucherNo",
             to_char(t.business_date, 'YYYY-MM-DD') as "businessDate", t.amount::float8 as "amount",
             to_json(t.created_at)#>>'{}' as "createdAt"
        from public.cash_transfers t
       where t.branch_id = $1::uuid and t.status::text = 'approved' and t.deleted_at is null and t.amount > 0
         and ${win('t.created_at')}
       order by t.created_at`, ...args),
    prisma.$queryRawUnsafe<{ count: number; amount: number }[]>(`
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
