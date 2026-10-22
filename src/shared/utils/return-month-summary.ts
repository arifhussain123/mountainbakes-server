import { businessDateStr } from './timezone';
import { RETURN_REASONS, RETURN_REASON_LABELS, returnReasonBucket, type ReturnReason } from './production-dashboard';

/**
 * Production → Product Returns → Return Summary: one calendar month of
 * returns, consolidated per branch × item × reason, plus the same lines added
 * up per item across every branch.
 *
 * WHICH RETURNS COUNT. Every status except `rejected` — the same rule as the
 * "Monthly Return Amount by Branch" boxes on Product Returns: approved, awaiting
 * review and sent back are all goods a branch has handed back, while a rejected
 * request was never a return. Each row is one return record, so nothing can be
 * counted twice: a sent-back return that is corrected comes back on the SAME
 * row.
 *
 * THE AMOUNT is each return priced at the product's price on its own business
 * date (see services/returns-summary.service.ts — a return row has no price
 * column of its own), never today's price. A return with no price anywhere is
 * counted in quantity and flagged, never given an invented amount.
 *
 * THE REASON is free text ("Exp", "damage", often blank), so it is sorted into
 * the production dashboard's reason buckets (`returnReasonBucket`) — Expired,
 * Damaged, Unsold, Other, Not given. Different buckets stay separate lines, so
 * two reasons for the same item and branch are never merged.
 *
 * THE MONTH is the business month: `business_date` from the 1st to the last
 * day, both inclusive (it is a date column, so the whole of the last day is in).
 * The current month is the one today's business date falls in, so the report
 * rolls over by itself at the 02:00 business-day start on the 1st.
 */

/** One SQL row: a branch × product × reason text, already summed. */
export interface ReturnMonthSqlRow {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  /** `lower(btrim(reason))`, '' when there was none. */
  reason: string;
  count: number;
  qty: number;
  amount: number;
  unpriced: number;
}

/** One line of the branch-wise table. */
export interface ReturnMonthLine {
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  reason: ReturnReason;
  reasonLabel: string;
  qty: number;
  amount: number;
  /** Return records behind this line. */
  count: number;
  /** Of `count`, the ones with no price on record — in `qty`, left out of `amount`. */
  unpricedCount: number;
}

/** One item across every branch. */
export interface ReturnMonthItem {
  productId: string;
  productName: string;
  qty: number;
  amount: number;
  count: number;
  unpricedCount: number;
  /** The same item per branch, largest quantity first. */
  branches: { branchId: string; branchName: string; qty: number; amount: number }[];
}

export interface ReturnMonthTotals {
  qty: number;
  amount: number;
  count: number;
  unpricedCount: number;
  /** Distinct branches with at least one return this month. */
  branchCount: number;
  /** Distinct products returned this month. */
  itemCount: number;
}

export interface ProductionReturnMonthSummary {
  /** 'YYYY-MM' */
  month: string;
  /** First day, 'YYYY-MM-DD'. */
  from: string;
  /** Last day, 'YYYY-MM-DD', inclusive. */
  to: string;
  /** The business month today falls in — the latest one the report allows. */
  currentMonth: string;
  lines: ReturnMonthLine[];
  items: ReturnMonthItem[];
  totals: ReturnMonthTotals;
}

export const RETURN_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The business month today falls in, 'YYYY-MM'. */
export function currentBusinessMonth(now: Date = new Date()): string {
  return businessDateStr(now).slice(0, 7);
}

/** 'YYYY-MM' → its first and last day. February has 29 days in a leap year. */
export function businessMonthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/** 'YYYY-MM' moved by `delta` months: shiftMonth('2026-12', 1) → '2027-01'. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Money in whole paisa, quantities in thousandths: 0.1 + 0.2 must be 0.3. */
const addMoney = (a: number, b: number) => (Math.round(a * 100) + Math.round(b * 100)) / 100;
const addQty = (a: number, b: number) => (Math.round(a * 1000) + Math.round(b * 1000)) / 1000;

const reasonOrder = (r: ReturnReason) => RETURN_REASONS.indexOf(r);

export function buildReturnMonthSummary(
  rows: ReturnMonthSqlRow[],
  month: string,
  now: Date = new Date(),
): ProductionReturnMonthSummary {
  const lineMap = new Map<string, ReturnMonthLine>();
  for (const row of rows) {
    const reason = returnReasonBucket(row.reason);
    const key = `${row.branchId}|${row.productId}|${reason}`;
    const line = lineMap.get(key) ?? {
      branchId: row.branchId,
      branchName: row.branchName ?? 'Unknown branch',
      productId: row.productId,
      productName: row.productName,
      reason,
      reasonLabel: RETURN_REASON_LABELS[reason],
      qty: 0,
      amount: 0,
      count: 0,
      unpricedCount: 0,
    };
    line.qty = addQty(line.qty, row.qty);
    line.amount = addMoney(line.amount, row.amount);
    line.count += row.count;
    line.unpricedCount += row.unpriced;
    lineMap.set(key, line);
  }

  const lines = [...lineMap.values()].sort(
    (a, b) =>
      a.branchName.localeCompare(b.branchName) ||
      a.productName.localeCompare(b.productName) ||
      reasonOrder(a.reason) - reasonOrder(b.reason),
  );

  const itemMap = new Map<string, ReturnMonthItem>();
  for (const line of lines) {
    const item = itemMap.get(line.productId) ?? {
      productId: line.productId,
      productName: line.productName,
      qty: 0,
      amount: 0,
      count: 0,
      unpricedCount: 0,
      branches: [],
    };
    item.qty = addQty(item.qty, line.qty);
    item.amount = addMoney(item.amount, line.amount);
    item.count += line.count;
    item.unpricedCount += line.unpricedCount;
    const branch = item.branches.find((b) => b.branchId === line.branchId);
    if (branch) {
      branch.qty = addQty(branch.qty, line.qty);
      branch.amount = addMoney(branch.amount, line.amount);
    } else {
      item.branches.push({ branchId: line.branchId, branchName: line.branchName, qty: line.qty, amount: line.amount });
    }
    itemMap.set(line.productId, item);
  }
  const items = [...itemMap.values()]
    .map((item) => ({ ...item, branches: item.branches.sort((a, b) => b.qty - a.qty || a.branchName.localeCompare(b.branchName)) }))
    .sort((a, b) => a.productName.localeCompare(b.productName));

  const totals = lines.reduce<ReturnMonthTotals>(
    (t, l) => ({
      ...t,
      qty: addQty(t.qty, l.qty),
      amount: addMoney(t.amount, l.amount),
      count: t.count + l.count,
      unpricedCount: t.unpricedCount + l.unpricedCount,
    }),
    { qty: 0, amount: 0, count: 0, unpricedCount: 0, branchCount: new Set(lines.map((l) => l.branchId)).size, itemCount: items.length },
  );

  return { month, ...businessMonthRange(month), currentMonth: currentBusinessMonth(now), lines, items, totals };
}

export interface ReturnMonthLineFilter {
  /** Matches the item name, case-insensitively. */
  search?: string;
  branchId?: string | null;
  reason?: ReturnReason | null;
}

/** The branch-wise table's filters. The item-wise box never takes them. */
export function filterReturnMonthLines(lines: ReturnMonthLine[], { search, branchId, reason }: ReturnMonthLineFilter): ReturnMonthLine[] {
  const q = search?.trim().toLowerCase() ?? '';
  return lines.filter(
    (l) =>
      (!q || l.productName.toLowerCase().includes(q)) &&
      (!branchId || l.branchId === branchId) &&
      (!reason || l.reason === reason),
  );
}

/** Totals of whatever lines are on screen. */
export function sumReturnMonthLines(lines: ReturnMonthLine[]): { qty: number; amount: number; count: number } {
  return lines.reduce((t, l) => ({ qty: addQty(t.qty, l.qty), amount: addMoney(t.amount, l.amount), count: t.count + l.count }), {
    qty: 0,
    amount: 0,
    count: 0,
  });
}
