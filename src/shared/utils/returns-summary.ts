import type { ProductionReturnStatus } from '../types/production-ops.types';
import { businessDateStr, businessMonthStartStr } from './timezone';

/**
 * The month-to-date Product Returns summary — what Production sees per branch
 * and what each branch sees of its own returns.
 *
 * Shared because three surfaces state the same figures (Production's returns
 * page, the branch's Return Stock page, and the mobile app) and they must
 * agree. The server is the one that sums; clients only lay it out.
 *
 * ─── What a figure means ─────────────────────────────────────────────────────
 * - A "transaction" is one `production_returns` row: one product, one quantity,
 *   one status, one ID. A branch submission of five products is five of them —
 *   each is reviewed on its own, so each is counted on its own.
 * - `amount` is qty × the product's price IN FORCE ON THE RETURN'S BUSINESS
 *   DATE, read from the immutable `product_price_history` log (falling back to
 *   `products.price` for a product whose price never changed). A later price
 *   change therefore never rewrites an earlier month's amounts. Rounded to the
 *   paisa per line, the same way the finance dashboard rounds return lines.
 * - `submitted` is every return raised in the window, whatever its status —
 *   pending, approved, rejected and sent back alike. `accepted` is the only
 *   bucket that is a final, credited value; the two are shown side by side so
 *   an unreviewed request is never read as an approved one.
 * - Each status bucket holds only that status's rows. The four buckets sum to
 *   `submitted`; no row is ever counted in two of them.
 * - Withdrawn returns are deleted rows, so they are in no figure at all.
 */

export interface ReturnsBucket {
  /** Units returned. */
  qty: number;
  /** Rs. value of those units — see the file comment for the price rule. */
  amount: number;
  /** Return transactions (rows). */
  count: number;
}

export interface ReturnsSummaryTotals {
  /** Every return in the window, all statuses. */
  submitted: ReturnsBucket;
  /** Awaiting Production's review. */
  pending: ReturnsBucket;
  /** Approved by Production — the only final, credited value. */
  accepted: ReturnsBucket;
  /** Refused by Production; the units went back on the branch's balance. */
  rejected: ReturnsBucket;
  /** Sent back to the branch for correction. */
  returned: ReturnsBucket;
  /**
   * Rows with no price at all (no history and no product price), so they carry
   * quantity but no amount. Surfaced, never guessed: a non-zero count means the
   * amount is understated by those rows.
   */
  unpricedCount: number;
}

export interface BranchReturnsSummary extends ReturnsSummaryTotals {
  branchId: string;
  branchName: string;
}

export interface MonthlyReturnsSummary {
  /** 'YYYY-MM-01' — first day of the current business month. */
  from: string;
  /** 'YYYY-MM-DD' — today's business date, inclusive. */
  to: string;
  /** One entry per branch in scope, alphabetical. Zero-return branches included. */
  branches: BranchReturnsSummary[];
  /** Every branch in `branches` added together. */
  totals: ReturnsSummaryTotals;
}

/** One SQL aggregate row: a branch × status group. */
export interface ReturnsSummaryRow {
  branchId: string;
  branchName: string;
  status: ProductionReturnStatus | string;
  count: number;
  qty: number;
  amount: number;
  unpriced: number;
}

export const RETURN_SUMMARY_STATUSES: readonly ProductionReturnStatus[] = ['pending', 'accepted', 'rejected', 'returned'];

/**
 * First day of the current business month through today's business date,
 * inclusive. The window moves on by itself: the business day that starts at
 * 02:00 on the 1st opens a new month, so nothing ever has to be reset.
 */
export function monthToDateRange(now: Date = new Date()): { from: string; to: string } {
  return { from: businessMonthStartStr(now), to: businessDateStr(now) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** qty is numeric(14,3) — keep float addition from drifting past that. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function emptyBucket(): ReturnsBucket {
  return { qty: 0, amount: 0, count: 0 };
}

export function emptyReturnsTotals(): ReturnsSummaryTotals {
  return {
    submitted: emptyBucket(),
    pending: emptyBucket(),
    accepted: emptyBucket(),
    rejected: emptyBucket(),
    returned: emptyBucket(),
    unpricedCount: 0,
  };
}

function addInto(target: ReturnsBucket, qty: number, amount: number, count: number) {
  target.qty = round3(target.qty + qty);
  target.amount = round2(target.amount + amount);
  target.count += count;
}

function addTotals(target: ReturnsSummaryTotals, source: ReturnsSummaryTotals) {
  for (const key of ['submitted', ...RETURN_SUMMARY_STATUSES] as const) {
    addInto(target[key], source[key].qty, source[key].amount, source[key].count);
  }
  target.unpricedCount += source.unpricedCount;
}

/**
 * Folds the branch × status aggregate rows into the summary. `branches` is the
 * branch list in scope (so a branch with no returns still shows, at zero);
 * a row for a branch missing from it (e.g. one since deactivated) is kept,
 * under the name the return row carries.
 */
export function buildReturnsSummary(
  rows: ReturnsSummaryRow[],
  branches: { id: string; name: string }[],
  range: { from: string; to: string },
): MonthlyReturnsSummary {
  const byBranch = new Map<string, BranchReturnsSummary>();
  for (const b of branches) byBranch.set(b.id, { branchId: b.id, branchName: b.name, ...emptyReturnsTotals() });

  for (const row of rows) {
    let entry = byBranch.get(row.branchId);
    if (!entry) {
      entry = { branchId: row.branchId, branchName: row.branchName, ...emptyReturnsTotals() };
      byBranch.set(row.branchId, entry);
    }
    const qty = Number(row.qty) || 0;
    const amount = Number(row.amount) || 0;
    const count = Number(row.count) || 0;
    addInto(entry.submitted, qty, amount, count);
    if ((RETURN_SUMMARY_STATUSES as readonly string[]).includes(row.status)) {
      addInto(entry[row.status as ProductionReturnStatus], qty, amount, count);
    }
    entry.unpricedCount += Number(row.unpriced) || 0;
  }

  const list = [...byBranch.values()].sort((a, b) => a.branchName.localeCompare(b.branchName));
  const totals = emptyReturnsTotals();
  for (const b of list) addTotals(totals, b);
  return { from: range.from, to: range.to, branches: list, totals };
}
