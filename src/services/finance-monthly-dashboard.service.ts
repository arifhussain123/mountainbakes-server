import { dbFor, getPrisma } from '../db';
import {
  businessDateStr,
  type FinanceDashboardDay,
  type FinanceDashboardLedgerRow,
  type FinanceDashboardMetric,
  type FinanceDashboardMonthTrend,
  type FinanceDashboardPreviousBalance,
  type FinanceDashboardRecord,
  type FinanceDashboardRecordsPage,
  type FinanceMonthlyDashboard,
  type DemandRecordRow,
  SYSTEM_LEDGER_HEAD_CODES,
} from '../shared';
import { round2 } from './finance-settings.service';
import { getCollectionsMonth, getLedgerStart, type CollectionsRow } from './branch-account.service';

const db = dbFor('finance-monthly-dashboard');

/**
 * The monthly Finance Dashboard — production income against ledger receipts,
 * per branch per business month, plus the source records behind each figure.
 *
 * Every sum is taken in Postgres (migration 128: `finance_monthly_dashboard`,
 * `finance_dashboard_records`); this service only picks the windows, adds the
 * ledger's own totals from `finance_ledger_totals`, and folds the daily rows
 * into the summary. The rules each figure follows, and where they were lifted
 * from, are in docs/finance-dashboard-audit.md.
 *
 * Three RPCs per load, in parallel: the selected window (with ledger heads),
 * the six whole months ending at the selected one (trend + last month's
 * balance), and the ledger totals. Nothing downloads transactions.
 *
 * Once the Demand Record is switched on, the income figures from its go-live
 * day are the Collections export's (owner's rule, 2026-11-07) — see
 * collectionsFor / applyDemandRecord:
 *   Demand         = Delivered − Returns − Discount (the net demand), each
 *                    demand on its required date; each month opens with an
 *                    Opening Stock row on the 1st (the stock the branch held,
 *                    charged like a demand) and, once finished, takes its
 *                    Closing Stock off the branch's last demand
 *   Company Share  = Demand × the demand's frozen share %
 *   Last Month Balance = what the Collections sheet carries into the month
 *
 * Received is the Daily Ledger's Company Share income only (no Fuel, no
 * other head), per branch, by entry date — see applyCompanyShareReceipts.
 */

const num = (v: unknown) => Number(v ?? 0);

/** 'YYYY-MM' shifted by whole months. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(lastDay).padStart(2, '0')}` };
}

interface RawDashboard {
  days: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
}

async function callDashboard(from: string, to: string, branchId: string | null, includeHeads: boolean): Promise<RawDashboard> {
  const { data, error } = await db.rpc('finance_monthly_dashboard', {
    p_from: from,
    p_to: to,
    p_branch_id: branchId,
    p_include_heads: includeHeads,
  });
  if (error) throw error;
  const raw = (data ?? {}) as Partial<RawDashboard>;
  return { days: raw.days ?? [], ledger: raw.ledger ?? [] };
}

function toDay(r: Record<string, unknown>): FinanceDashboardDay {
  return {
    date: String(r['date']),
    branchId: (r['branchId'] as string | null) ?? null,
    demand: num(r['demand']),
    companyShare: num(r['companyShare']),
    received: num(r['received']),
    returns: num(r['returns']),
    discount: num(r['discount']),
    orders: num(r['orders']),
    unpricedLines: num(r['unpricedLines']),
    receipts: num(r['receipts']),
    returnCount: num(r['returnCount']),
    discountCount: num(r['discountCount']),
  };
}

function toLedgerRow(r: Record<string, unknown>): FinanceDashboardLedgerRow {
  return {
    date: String(r['date']),
    branchId: (r['branchId'] as string | null) ?? null,
    ledgerHeadId: String(r['ledgerHeadId']),
    ledgerHeadName: String(r['ledgerHeadName'] ?? ''),
    amount: num(r['amount']),
    entries: num(r['entries']),
  };
}

const sum = <T>(rows: T[], pick: (r: T) => number) => round2(rows.reduce((s, r) => s + pick(r), 0));

/**
 * The dashboard's Balance: Received − Company Share (owner's rule, 2026-11-07).
 * Negative: the branch paid less than the share (still owed); positive: it
 * paid more than the share.
 */
export const dashboardBalance = (companyShare: number, received: number) => round2(received - companyShare);

/**
 * The income days on the Demand Record's rules, from its go-live day.
 *
 * `demand` and `companyShare` on each (day, branch) become the sum of the
 * Demand Record rows dated that day — the net demand (Delivered − Returns −
 * Discount) and the share on it at the demand's frozen % — so this table and
 * the Demand Record cannot disagree. `orders` becomes the number of demands
 * dated that day. A Demand Record row is dated by its demand's REQUIRED date
 * (its business date when it has none), so a demand submitted on 31 Oct for
 * 1 Nov counts on 1 Nov, in November. A Demand Record row places a return or
 * discount on the demand it is billed to (the slip's own window), so that is
 * where it is netted. Days before go-live keep the old figures; a (day,
 * branch) the SQL had no row for (an opening row) is added.
 */
export function applyDemandRecord(
  days: FinanceDashboardDay[],
  rows: DemandRecordRow[],
  start: string,
  from: string,
  to: string,
): FinanceDashboardDay[] {
  const byKey = new Map<string, { date: string; branchId: string; demand: number; share: number; orders: number }>();
  for (const r of rows) {
    if (r.businessDate < from || r.businessDate > to) continue;
    const k = `${r.businessDate}|${r.branchId}`;
    const e = byKey.get(k) ?? { date: r.businessDate, branchId: r.branchId, demand: 0, share: 0, orders: 0 };
    e.demand += r.demand;
    e.share += r.companyShare;
    if (r.orderId) e.orders += 1;
    byKey.set(k, e);
  }
  const out = days.map((d) => {
    if (d.date < start || d.branchId === null) return d;
    const k = `${d.date}|${d.branchId}`;
    const e = byKey.get(k);
    byKey.delete(k);
    return { ...d, demand: round2(e?.demand ?? 0), companyShare: round2(e?.share ?? 0), orders: e?.orders ?? 0 };
  });
  for (const e of byKey.values()) {
    out.push({
      date: e.date, branchId: e.branchId, demand: round2(e.demand), companyShare: round2(e.share),
      received: 0, returns: 0, discount: 0, orders: e.orders, unpricedLines: 0, receipts: 0, returnCount: 0, discountCount: 0,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.branchId ?? '').localeCompare(b.branchId ?? ''));
}

/** Company Share ledger income summed per (entry date, branch). */
export interface LedgerReceipt {
  date: string;
  branchId: string | null;
  amount: number;
  entries: number;
}

/**
 * The Daily Ledger entries that count as Received: live (not deleted) income
 * on the Company Share head (INC-COMPANY-SHARE) only — never Fuel or any other
 * head. Σ debit − credit, so a reversal nets out, as the Daily Ledger totals
 * it. Dated by the ledger entry date; $1/$2 the window, $3 the branch.
 */
const RECEIVED_FILTER = `
  e.deleted_at is null and e.ledger_head_type::text = 'income' and h.code = '${SYSTEM_LEDGER_HEAD_CODES.COMPANY_SHARE}'
  and e.entry_date between $1::date and $2::date
  and ($3::uuid is null or e.branch_id = $3::uuid)`;

async function companyShareReceipts(from: string, to: string, branchId: string | null): Promise<LedgerReceipt[]> {
  return getPrisma().$queryRawUnsafe<LedgerReceipt[]>(`
    select to_char(e.entry_date, 'YYYY-MM-DD') as "date", e.branch_id::text as "branchId",
           sum(e.debit - e.credit)::float8 as "amount", count(*)::int as "entries"
      from public.ledger_entries e
      join public.ledger_heads h on h.id = e.ledger_head_id
     where ${RECEIVED_FILTER}
     group by e.entry_date, e.branch_id`, from, to, branchId);
}

/**
 * Received on each (day, branch) becomes the Daily Ledger's Company Share
 * income dated that day, and `receipts` the number of those entries — so Fuel
 * Charges and every other income head stay out. A (day, branch) with Company
 * Share entries but no other row is added.
 */
export function applyCompanyShareReceipts(
  days: FinanceDashboardDay[],
  receipts: LedgerReceipt[],
  from: string,
  to: string,
): FinanceDashboardDay[] {
  const byKey = new Map<string, LedgerReceipt>();
  for (const r of receipts) {
    if (r.date >= from && r.date <= to) byKey.set(`${r.date}|${r.branchId ?? ''}`, r);
  }
  const out = days.map((d) => {
    const k = `${d.date}|${d.branchId ?? ''}`;
    const r = byKey.get(k);
    byKey.delete(k);
    return { ...d, received: round2(r?.amount ?? 0), receipts: r?.entries ?? 0 };
  });
  for (const r of byKey.values()) {
    out.push({
      date: r.date, branchId: r.branchId, demand: 0, companyShare: 0, received: round2(r.amount),
      returns: 0, discount: 0, orders: 0, unpricedLines: 0, receipts: r.entries, returnCount: 0, discountCount: 0,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.branchId ?? '').localeCompare(b.branchId ?? ''));
}

/**
 * Each branch's balance carried into the month on the Collections sheet (owed
 * positive): the Previous of its first row on or after `monthFirst` (the
 * month's Opening Stock row), else the Closing of its last row before it.
 * `rows` are the sheet's, by branch then date.
 */
export function collectionsCarried(rows: CollectionsRow[], monthFirst: string): FinanceDashboardPreviousBalance[] {
  const carried = new Map<string, { balance: number; fixed: boolean }>();
  for (const r of rows) {
    const c = carried.get(r.branchId);
    if (c?.fixed) continue;
    if (r.businessDate < monthFirst) carried.set(r.branchId, { balance: r.closingBalance, fixed: false });
    else carried.set(r.branchId, { balance: r.previousBalance, fixed: true });
  }
  return [...carried].map(([branchId, c]) => ({ branchId, balance: round2(c.balance) }));
}

/** The rows that count: a Closing Stock row is shown on the sheet, never counted. */
const counted = (rows: CollectionsRow[]) => rows.filter((r) => r.stockRow !== 'closing');

/**
 * The Collections sheet for [from, to], as the export makes it — `to` cut at
 * today, as the export's own default (the month to date), so an unfinished
 * month takes no closing stock off. Null while the Demand Record is off; no
 * rows for a window that lies wholly before the go-live day or after today.
 */
async function collectionsFor(branchId: string | null, from: string, to: string): Promise<{ start: string; rows: CollectionsRow[] } | null> {
  const start = await getLedgerStart();
  if (!start) return null;
  const today = businessDateStr();
  const lo = from > start ? from : start;
  const hi = to < today ? to : today;
  if (hi < lo) return { start, rows: [] };
  const sheet = await getCollectionsMonth({ branchId, from: lo, to: hi });
  return sheet ? { start, rows: sheet.rows } : null;
}

export async function getFinanceMonthlyDashboard(params: {
  month: string;
  from?: string;
  to?: string;
  branchId: string | null;
}): Promise<FinanceMonthlyDashboard> {
  const { month, branchId } = params;
  const bounds = monthBounds(month);
  const from = params.from ?? bounds.first;
  const to = params.to ?? bounds.last;
  const previousMonth = shiftMonth(month, -1);
  const trendFrom = monthBounds(shiftMonth(month, -5)).first;

  // The trend's sheet runs a month at a time, so its rows for the selected
  // month are that month's own sheet; a custom window gets a sheet of its own.
  const wholeMonth = from === bounds.first && to === bounds.last;
  const [current, window6, ledgerTotals, branchesRes, trendSheet, windowSheet, receipts] = await Promise.all([
    callDashboard(from, to, branchId, true),
    callDashboard(trendFrom, bounds.last, branchId, false),
    db.rpc('finance_ledger_totals', { p_from: from, p_to: to, p_branch_id: branchId }),
    db.from('branches').select('id, name, is_active').order('name'),
    collectionsFor(branchId, trendFrom, bounds.last),
    wholeMonth ? Promise.resolve(null) : collectionsFor(branchId, from, to),
    // The selected window always lies inside the trend's six months.
    companyShareReceipts(trendFrom, bounds.last, branchId),
  ]);
  if (ledgerTotals.error) throw ledgerTotals.error;
  if (branchesRes.error) throw branchesRes.error;

  let days = current.days.map(toDay);
  const ledger = current.ledger.map(toLedgerRow);
  let trendDays = window6.days.map(toDay);
  const record = trendSheet;
  if (trendSheet) {
    const windowRows = wholeMonth ? trendSheet.rows : (windowSheet?.rows ?? []);
    days = applyDemandRecord(days, counted(windowRows), trendSheet.start, from, to);
    trendDays = applyDemandRecord(trendDays, counted(trendSheet.rows), trendSheet.start, trendFrom, bounds.last);
  }
  days = applyCompanyShareReceipts(days, receipts, from, to);
  trendDays = applyCompanyShareReceipts(trendDays, receipts, trendFrom, bounds.last);

  // Six whole months, oldest first — a month with no rows is a real zero month
  // inside a window that has data, so it is emitted rather than skipped.
  const trend: FinanceDashboardMonthTrend[] = [];
  for (let i = -5; i <= 0; i++) {
    const m = shiftMonth(month, i);
    const rows = trendDays.filter((d) => d.date.startsWith(m));
    const companyShare = sum(rows, (r) => r.companyShare);
    const received = sum(rows, (r) => r.received);
    trend.push({
      month: m,
      demand: sum(rows, (r) => r.demand),
      companyShare,
      received,
      balance: dashboardBalance(companyShare, received),
      returns: sum(rows, (r) => r.returns),
      discount: sum(rows, (r) => r.discount),
    });
  }

  // Last month's balance per branch (and for unassigned receipts). A branch with
  // no rows at all last month gets null — "no records", not a fabricated zero.
  const prevRows = trendDays.filter((d) => d.date.startsWith(previousMonth));
  const prevByBranch = new Map<string | null, FinanceDashboardDay[]>();
  for (const r of prevRows) {
    const list = prevByBranch.get(r.branchId);
    if (list) list.push(r);
    else prevByBranch.set(r.branchId, [r]);
  }
  let previous: FinanceDashboardPreviousBalance[] = [...prevByBranch].map(([b, rows]) => ({
    branchId: b,
    balance: dashboardBalance(sum(rows, (r) => r.companyShare), sum(rows, (r) => r.received)),
  }));
  // On the Demand Record, a branch's last-month balance is what the Collections
  // sheet carries into this month — previous balances included — not last
  // month's activity alone, on the dashboard's sign: what is still owed is
  // negative. Receipts with no branch keep their old line.
  if (record) {
    const carried = collectionsCarried(record.rows, bounds.first)
      .map((c) => ({ branchId: c.branchId, balance: c.balance === null ? null : round2(-c.balance) || 0 }));
    previous = [...carried, ...previous.filter((p) => p.branchId === null)];
  }

  const companyShare = sum(days, (r) => r.companyShare);
  const received = sum(days, (r) => r.received);
  const lt = (Array.isArray(ledgerTotals.data) ? ledgerTotals.data[0] : ledgerTotals.data) as Record<string, unknown> | null;
  const ledgerIncome = round2(num(lt?.['total_debit']));
  const ledgerExpenseTotal = round2(num(lt?.['total_credit']));

  return {
    month,
    previousMonth,
    from,
    to,
    branchId,
    businessDate: businessDateStr(),
    generatedAt: new Date().toISOString(),
    branches: ((branchesRes.data ?? []) as { id: string; name: string; is_active: boolean }[]).map((b) => ({
      id: b.id,
      name: b.name,
      isActive: b.is_active,
    })),
    summary: {
      demand: sum(days, (r) => r.demand),
      companyShare,
      received,
      balance: dashboardBalance(companyShare, received),
      lastMonthBalance: record
        ? (previous.length ? sum(previous, (p) => p.balance ?? 0) : null)
        : prevRows.length
          ? dashboardBalance(sum(prevRows, (r) => r.companyShare), sum(prevRows, (r) => r.received))
          : null,
      ledgerExpense: sum(ledger, (r) => r.amount),
      returns: sum(days, (r) => r.returns),
      discount: sum(days, (r) => r.discount),
      orders: sum(days, (r) => r.orders),
      receipts: sum(days, (r) => r.receipts),
      ledgerEntries: sum(ledger, (r) => r.entries),
      returnCount: sum(days, (r) => r.returnCount),
      discountCount: sum(days, (r) => r.discountCount),
      unpricedLines: sum(days, (r) => r.unpricedLines),
      ledgerIncome,
      ledgerExpenseTotal,
      ledgerNet: round2(ledgerIncome - ledgerExpenseTotal),
    },
    days,
    ledger,
    previous,
    trend,
  };
}

type RecordsParams = {
  metric: FinanceDashboardMetric;
  from: string;
  to: string;
  branchId: string | null;
  noBranch: boolean;
  ledgerHeadId: string | null;
  search: string | null;
  page: number;
  pageSize: number;
};

async function callRecords(params: RecordsParams, limit: number, offset: number): Promise<FinanceDashboardRecordsPage> {
  const { data, error } = await db.rpc('finance_dashboard_records', {
    p_metric: params.metric,
    p_from: params.from,
    p_to: params.to,
    p_branch_id: params.branchId,
    p_no_branch: params.noBranch,
    p_head_id: params.ledgerHeadId,
    p_search: params.search,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  const raw = (data ?? {}) as { total?: unknown; amount?: unknown; rows?: Record<string, unknown>[] };
  return {
    total: num(raw.total),
    amount: round2(num(raw.amount)),
    page: params.page,
    pageSize: params.pageSize,
    rows: (raw.rows ?? []).map(
      (r): FinanceDashboardRecord => ({
        id: String(r['id']),
        reference: (r['reference'] as string | null) ?? null,
        date: String(r['date']),
        branchId: (r['branchId'] as string | null) ?? null,
        branchName: (r['branchName'] as string | null) ?? null,
        source: String(r['source'] ?? ''),
        detail: (r['detail'] as string | null) ?? null,
        status: String(r['status'] ?? ''),
        amount: num(r['amount']),
        createdBy: (r['createdBy'] as string | null) ?? null,
        approvedBy: (r['approvedBy'] as string | null) ?? null,
      }),
    ),
  };
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayBefore = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export async function getFinanceDashboardRecords(params: RecordsParams): Promise<FinanceDashboardRecordsPage> {
  // Demand and Company Share drill into the Demand Record's rows once it is on,
  // so the list behind a figure adds up to that figure. Demands always have a
  // branch, so the "no branch" list stays the SQL's (empty for these metrics).
  if ((params.metric === 'demand' || params.metric === 'share') && !params.noBranch) {
    const sheet = await collectionsFor(params.branchId, params.from, params.to);
    if (sheet) return demandRecordRecords(params, { start: sheet.start, rows: counted(sheet.rows) });
  }
  if (params.metric === 'received') return companyShareRecords(params);
  return callRecords(params, params.pageSize, (params.page - 1) * params.pageSize);
}

/**
 * The drill-down list for Received: the Daily Ledger's Company Share entries
 * behind it, each opening its own voucher.
 */
async function companyShareRecords(params: RecordsParams): Promise<FinanceDashboardRecordsPage> {
  const q = params.search?.trim().toLowerCase() || null;
  const res = await getPrisma().$queryRawUnsafe<{ total: number; amount: number; rows: Record<string, unknown>[] }[]>(`
    with f as (
      select e.id, e.voucher_no, e.entry_date, e.seq, e.branch_id, e.description, e.status, e.source_type,
             coalesce(b.name, e.branch_name) as bname, coalesce(h.name, e.ledger_head_name) as hname,
             e.debit - e.credit as amount, e.created_by_name, e.approved_by_name
        from public.ledger_entries e
        join public.ledger_heads h on h.id = e.ledger_head_id
        left join public.branches b on b.id = e.branch_id
       where ${RECEIVED_FILTER}
         and (case when $7::boolean then e.branch_id is null else true end)
         and ($4::text is null
              or lower(e.voucher_no) like '%' || $4 || '%'
              or lower(e.id::text) like '%' || $4 || '%'
              or lower(coalesce(b.name, e.branch_name, '')) like '%' || $4 || '%'
              or lower(coalesce(e.description, '')) like '%' || $4 || '%')
    )
    select (select count(*)::int from f) as "total",
           (select coalesce(sum(amount), 0)::float8 from f) as "amount",
           coalesce((select json_agg(json_build_object(
                       'id', p.id::text, 'reference', p.voucher_no, 'date', to_char(p.entry_date, 'YYYY-MM-DD'),
                       'branchId', p.branch_id::text, 'branchName', p.bname,
                       'source', 'Ledger · ' || p.hname || ' · ' || p.source_type::text, 'detail', p.description,
                       'status', p.status::text, 'amount', p.amount::float8,
                       'createdBy', p.created_by_name, 'approvedBy', p.approved_by_name)
                     order by p.entry_date, p.bname nulls last, p.seq)
                     from (select * from f order by entry_date, bname nulls last, seq limit $5 offset $6) p),
                    '[]'::json) as "rows"`,
    params.from, params.to, params.noBranch ? null : params.branchId, q, params.pageSize,
    (params.page - 1) * params.pageSize, params.noBranch);
  const raw = res[0];
  return {
    total: num(raw?.total),
    amount: round2(num(raw?.amount)),
    page: params.page,
    pageSize: params.pageSize,
    rows: (raw?.rows ?? []).map((r): FinanceDashboardRecord => ({
      id: String(r['id']),
      reference: (r['reference'] as string | null) ?? null,
      date: String(r['date']),
      branchId: (r['branchId'] as string | null) ?? null,
      branchName: (r['branchName'] as string | null) ?? null,
      source: String(r['source'] ?? ''),
      detail: (r['detail'] as string | null) ?? null,
      status: String(r['status'] ?? ''),
      amount: num(r['amount']),
      createdBy: (r['createdBy'] as string | null) ?? null,
      approvedBy: (r['approvedBy'] as string | null) ?? null,
    })),
  };
}

/** The drill-down list for Demand / Company Share, from the Collections sheet's counted rows. */
async function demandRecordRecords(
  params: RecordsParams,
  record: { start: string; rows: CollectionsRow[] },
): Promise<FinanceDashboardRecordsPage> {
  const share = params.metric === 'share';
  const lo = params.from > record.start ? params.from : record.start;
  const list: FinanceDashboardRecord[] = record.rows
    .filter((r) => r.businessDate >= lo && r.businessDate <= params.to)
    // An Opening Stock row that charges nothing (no stock, no returns) adds
    // nothing to the figure, so it is not listed behind it.
    .filter((r) => r.orderId !== null || r.demand !== 0 || r.companyShare !== 0)
    .map((r) => ({
      id: r.orderId ?? `opening-stock-${r.branchId}-${r.businessDate}`,
      reference: r.demandNumber ?? 'Opening Stock',
      date: r.businessDate,
      branchId: r.branchId,
      branchName: r.branchName,
      source: r.orderId ? 'Production order' : 'Opening stock',
      detail: share
        ? `${r.sharePct}% of ${money(r.demand)}`
        : r.orderId
          ? `Delivered ${money(r.delivered + r.closingStockDeducted)}${r.closingStockDeducted
            ? ` − Closing stock ${money(r.closingStockDeducted)}` : ''} − Return ${money(r.returns)} − Discount ${money(r.discount)}`
          : `Opening stock ${money(r.delivered)} − Return ${money(r.returns)} − Discount ${money(r.discount)}`,
      status: r.status ?? 'opening',
      amount: share ? r.companyShare : r.demand,
      createdBy: null,
      approvedBy: null,
    }));
  // Anything dated before go-live keeps the old rows — none in practice, since
  // the go-live day is the start of the data.
  if (params.from < record.start) {
    const before = await callRecords({ ...params, to: dayBefore(record.start) }, 10_000, 0);
    list.push(...before.rows);
  }
  const q = params.search?.trim().toLowerCase();
  const hit = q
    ? list.filter((r) => [r.reference, r.id, r.branchName, r.detail, r.source].some((v) => (v ?? '').toLowerCase().includes(q)))
    : list;
  // The day's Opening Stock first, as on the sheet.
  const stockFirst = (r: FinanceDashboardRecord) => Number(r.source !== 'Opening stock');
  hit.sort((a, b) => a.date.localeCompare(b.date) || (a.branchName ?? '').localeCompare(b.branchName ?? '')
    || stockFirst(a) - stockFirst(b) || (a.reference ?? '').localeCompare(b.reference ?? '') || a.id.localeCompare(b.id));
  const page = hit.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);

  // Who raised and approved each demand on this page, as the SQL list shows.
  const ids = page.filter((r) => r.source === 'Production order').map((r) => r.id);
  if (ids.length > 0) {
    const { data, error } = await db
      .from('production_orders')
      .select('id, created_by_name, approved_by_name, verified_by_name')
      .in('id', ids);
    if (error) throw error;
    const who = new Map(((data ?? []) as { id: string; created_by_name: string | null; approved_by_name: string | null; verified_by_name: string | null }[])
      .map((o) => [o.id, o]));
    for (const r of page) {
      const o = who.get(r.id);
      if (o) { r.createdBy = o.created_by_name; r.approvedBy = o.approved_by_name ?? o.verified_by_name; }
    }
  }
  return {
    total: hit.length,
    amount: sum(hit, (r) => r.amount),
    page: params.page,
    pageSize: params.pageSize,
    rows: page,
  };
}
