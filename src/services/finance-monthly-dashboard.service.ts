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
} from '../shared';
import { round2 } from './finance-settings.service';
import { getDemandRecordRows } from './branch-account.service';

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
 * day follow the Demand Record restructure
 * (docs/demand-record-accounting-migration.md) — see applyDemandRecord:
 *   Demand         = Delivered − Returns − Discount (the net demand)
 *   Company Share  = Demand × the demand's frozen share %
 *   Last Month Balance = each branch's Remaining carried into the month
 *
 * Received is the Cash Transfer Details table's Total Amount — see
 * applyCashTransfers — not the income ledger.
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
 * The income days on the Demand Record's rules, from its go-live day.
 *
 * `demand` and `companyShare` on each (day, branch) become the sum of the
 * Demand Record rows dated that day — the net demand (Delivered − Returns −
 * Discount) and the share on it at the demand's frozen % — so this table and
 * the Demand Record cannot disagree. A Demand Record row places a return or
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
  const byKey = new Map<string, { date: string; branchId: string; demand: number; share: number }>();
  for (const r of rows) {
    if (r.businessDate < from || r.businessDate > to) continue;
    const k = `${r.businessDate}|${r.branchId}`;
    const e = byKey.get(k) ?? { date: r.businessDate, branchId: r.branchId, demand: 0, share: 0 };
    e.demand += r.demand;
    e.share += r.companyShare;
    byKey.set(k, e);
  }
  const out = days.map((d) => {
    if (d.date < start || d.branchId === null) return d;
    const k = `${d.date}|${d.branchId}`;
    const e = byKey.get(k);
    byKey.delete(k);
    return { ...d, demand: round2(e?.demand ?? 0), companyShare: round2(e?.share ?? 0) };
  });
  for (const e of byKey.values()) {
    out.push({
      date: e.date, branchId: e.branchId, demand: round2(e.demand), companyShare: round2(e.share),
      received: 0, returns: 0, discount: 0, orders: 0, unpricedLines: 0, receipts: 0, returnCount: 0, discountCount: 0,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.branchId ?? '').localeCompare(b.branchId ?? ''));
}

/** Approved cash transfers summed per (business date, branch). */
export interface TransferReceipt {
  date: string;
  branchId: string;
  amount: number;
  transfers: number;
}

/**
 * The approved, live cash transfers that count as Received — the same rows the
 * Demand Record counts (branch-account.service `pay`): status approved, not
 * soft-deleted, Total Amount > 0. Total Amount is `amount`
 * (cash + easypaisa + bank); Fuel Charges are not part of it. Dated by the
 * transfer's business date, the date the Cash Transfer Details table shows.
 */
const TRANSFER_FILTER = `
  t.status::text = 'approved' and t.deleted_at is null and t.amount > 0
  and t.business_date between $1::date and $2::date
  and ($3::uuid is null or t.branch_id = $3::uuid)`;

async function transferReceipts(from: string, to: string, branchId: string | null): Promise<TransferReceipt[]> {
  return getPrisma().$queryRawUnsafe<TransferReceipt[]>(`
    select to_char(t.business_date, 'YYYY-MM-DD') as "date", t.branch_id::text as "branchId",
           sum(t.amount)::float8 as "amount", count(*)::int as "transfers"
      from public.cash_transfers t
     where ${TRANSFER_FILTER}
     group by t.business_date, t.branch_id`, from, to, branchId);
}

/**
 * Received on each (day, branch) becomes the Total Amount of the approved cash
 * transfers dated that day, and `receipts` their count — so the Income table
 * agrees with Cash Transfer Details. Ledger receipts with no branch drop to 0:
 * every transfer has a branch. A (day, branch) with transfers but no other row
 * is added.
 */
export function applyCashTransfers(
  days: FinanceDashboardDay[],
  receipts: TransferReceipt[],
  from: string,
  to: string,
): FinanceDashboardDay[] {
  const byKey = new Map<string, TransferReceipt>();
  for (const r of receipts) {
    if (r.date >= from && r.date <= to) byKey.set(`${r.date}|${r.branchId}`, r);
  }
  const out = days.map((d) => {
    const k = `${d.date}|${d.branchId ?? ''}`;
    const r = byKey.get(k);
    byKey.delete(k);
    return { ...d, received: round2(r?.amount ?? 0), receipts: r?.transfers ?? 0 };
  });
  for (const r of byKey.values()) {
    out.push({
      date: r.date, branchId: r.branchId, demand: 0, companyShare: 0, received: round2(r.amount),
      returns: 0, discount: 0, orders: 0, unpricedLines: 0, receipts: r.transfers, returnCount: 0, discountCount: 0,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.branchId ?? '').localeCompare(b.branchId ?? ''));
}

/**
 * Each branch's Remaining carried into a month: the closing balance of its last
 * Demand Record row dated before `monthFirst`.
 *
 * A branch in the record with no row before the month still carried something
 * real: its opening row's balance (Finance's opening entry) or, with none, 0 —
 * the owner's rule is that every branch starts the Demand Record at zero. So it
 * is listed with that figure, not left blank, once the record has started by
 * the month's end. A branch whose rows all fall after the month (the record
 * had not begun) is left out: null on the table, "no records".
 */
export function carriedBalances(rows: DemandRecordRow[], monthFirst: string, monthLast: string): FinanceDashboardPreviousBalance[] {
  const carried = new Map<string, number>();
  for (const r of rows) {
    if (r.businessDate < monthFirst) {
      carried.set(r.branchId, r.remaining);
    } else if (!carried.has(r.branchId) && r.businessDate <= monthLast) {
      // The branch's first row in this month: an opening row's balance is
      // brought forward; a demand's Previous is what it started from (0).
      carried.set(r.branchId, r.orderId === null ? r.remaining : r.previousBalance);
    }
  }
  return [...carried].map(([branchId, balance]) => ({ branchId, balance: round2(balance) }));
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

  const [current, window6, ledgerTotals, branchesRes, record, transfers] = await Promise.all([
    callDashboard(from, to, branchId, true),
    callDashboard(trendFrom, bounds.last, branchId, false),
    db.rpc('finance_ledger_totals', { p_from: from, p_to: to, p_branch_id: branchId }),
    db.from('branches').select('id, name, is_active').order('name'),
    getDemandRecordRows(branchId),
    // The selected window always lies inside the trend's six months.
    transferReceipts(trendFrom, bounds.last, branchId),
  ]);
  if (ledgerTotals.error) throw ledgerTotals.error;
  if (branchesRes.error) throw branchesRes.error;

  let days = current.days.map(toDay);
  const ledger = current.ledger.map(toLedgerRow);
  let trendDays = window6.days.map(toDay);
  if (record) {
    days = applyDemandRecord(days, record.rows, record.start, from, to);
    trendDays = applyDemandRecord(trendDays, record.rows, record.start, trendFrom, bounds.last);
  }
  days = applyCashTransfers(days, transfers, from, to);
  trendDays = applyCashTransfers(trendDays, transfers, trendFrom, bounds.last);

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
      balance: round2(companyShare - received),
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
    balance: round2(sum(rows, (r) => r.companyShare) - sum(rows, (r) => r.received)),
  }));
  // On the Demand Record, a branch's last-month balance is what it carried into
  // this month — its Remaining, previous balances included — not last month's
  // activity alone. Receipts with no branch keep their old line.
  if (record) {
    previous = [...carriedBalances(record.rows, bounds.first, bounds.last), ...previous.filter((p) => p.branchId === null)];
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
      balance: round2(companyShare - received),
      lastMonthBalance: record
        ? (previous.length ? sum(previous, (p) => p.balance ?? 0) : null)
        : prevRows.length
          ? round2(sum(prevRows, (r) => r.companyShare) - sum(prevRows, (r) => r.received))
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
    const record = await getDemandRecordRows(params.branchId);
    if (record) return demandRecordRecords(params, record);
  }
  if (params.metric === 'received') return cashTransferRecords(params);
  return callRecords(params, params.pageSize, (params.page - 1) * params.pageSize);
}

/**
 * The drill-down list for Received: the approved cash transfers behind it.
 * `id` and `reference` are the transfer's live Company Share ledger entry and
 * its voucher, so a row opens that voucher. The transfer's own `voucher_no`
 * lists every voucher it posted, the Fuel one too, so it is not used. The
 * transfer number is in `source`.
 */
async function cashTransferRecords(params: RecordsParams): Promise<FinanceDashboardRecordsPage> {
  const empty = { total: 0, amount: 0, page: params.page, pageSize: params.pageSize, rows: [] };
  // Every transfer has a branch, so the "no branch" list is empty.
  if (params.noBranch) return empty;
  const q = params.search?.trim().toLowerCase() || null;
  const res = await getPrisma().$queryRawUnsafe<{ total: number; amount: number; rows: Record<string, unknown>[] }[]>(`
    with f as (
      select t.*, coalesce(b.name, t.branch_name) as bname, cs.id as cs_entry_id, cs.voucher_no as cs_voucher_no
        from public.cash_transfers t
        left join public.branches b on b.id = t.branch_id
        left join lateral (
          select e.id, e.voucher_no
            from public.ledger_entries e
            join public.ledger_heads h on h.id = e.ledger_head_id
           where e.source_type::text = 'cash_transfer' and e.source_id = t.id and h.code = 'INC-COMPANY-SHARE'
             and e.deleted_at is null and e.status::text <> 'reversed' and e.reverses_entry_id is null
           order by e.seq desc
           limit 1
        ) cs on true
       where ${TRANSFER_FILTER}
         and ($4::text is null
              or lower(t.transfer_no) like '%' || $4 || '%'
              or lower(coalesce(cs.voucher_no, '')) like '%' || $4 || '%'
              or lower(t.id::text) like '%' || $4 || '%'
              or lower(coalesce(b.name, t.branch_name)) like '%' || $4 || '%'
              or lower(coalesce(t.note, '')) like '%' || $4 || '%')
    )
    select (select count(*)::int from f) as "total",
           (select coalesce(sum(amount), 0)::float8 from f) as "amount",
           coalesce((select json_agg(json_build_object(
                       'id', coalesce(p.cs_entry_id, p.ledger_entry_id, p.id)::text, 'reference', p.cs_voucher_no,
                       'transferNo', p.transfer_no, 'date', to_char(p.business_date, 'YYYY-MM-DD'),
                       'branchId', p.branch_id::text, 'branchName', p.bname,
                       'cash', p.cash_amount::float8, 'easypaisa', p.easypaisa_amount::float8, 'bank', p.bank_amount::float8,
                       'amount', p.amount::float8, 'createdBy', p.created_by_name, 'approvedBy', p.approved_by_name)
                     order by p.business_date, p.bname, p.transfer_no)
                     from (select * from f order by business_date, bname, transfer_no limit $5 offset $6) p),
                    '[]'::json) as "rows"`,
    params.from, params.to, params.branchId, q, params.pageSize, (params.page - 1) * params.pageSize);
  const raw = res[0];
  if (!raw) return empty;
  return {
    total: num(raw.total),
    amount: round2(num(raw.amount)),
    page: params.page,
    pageSize: params.pageSize,
    rows: raw.rows.map((r): FinanceDashboardRecord => ({
      id: String(r['id']),
      reference: (r['reference'] as string | null) ?? null,
      date: String(r['date']),
      branchId: (r['branchId'] as string | null) ?? null,
      branchName: (r['branchName'] as string | null) ?? null,
      source: `Cash transfer · ${String(r['transferNo'])}`,
      detail: ([['Cash', r['cash']], ['Easypaisa', r['easypaisa']], ['Bank', r['bank']]] as [string, unknown][])
        .filter(([, v]) => num(v) > 0)
        .map(([k, v]) => `${k} ${money(num(v))}`)
        .join(' · ') || null,
      status: 'approved',
      amount: num(r['amount']),
      createdBy: (r['createdBy'] as string | null) ?? null,
      approvedBy: (r['approvedBy'] as string | null) ?? null,
    })),
  };
}

/** The drill-down list for Demand / Company Share, from the Demand Record's rows. */
async function demandRecordRecords(
  params: RecordsParams,
  record: { start: string; rows: DemandRecordRow[] },
): Promise<FinanceDashboardRecordsPage> {
  const share = params.metric === 'share';
  const lo = params.from > record.start ? params.from : record.start;
  const list: FinanceDashboardRecord[] = record.rows
    .filter((r) => r.businessDate >= lo && r.businessDate <= params.to)
    .map((r) => ({
      id: r.orderId ?? `opening-${r.branchId}`,
      reference: r.demandNumber ?? 'Opening',
      date: r.businessDate,
      branchId: r.branchId,
      branchName: r.branchName,
      source: r.orderId ? 'Production order' : 'Opening',
      detail: share
        ? `${r.sharePct}% of ${money(r.demand)}`
        : `Delivered ${money(r.delivered)} − Return ${money(r.returns)} − Discount ${money(r.discount)}`,
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
  hit.sort((a, b) => a.date.localeCompare(b.date) || (a.branchName ?? '').localeCompare(b.branchName ?? '')
    || (a.reference ?? '').localeCompare(b.reference ?? '') || a.id.localeCompare(b.id));
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
