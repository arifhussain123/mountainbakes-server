import type { BranchDiscountStatus } from '../types/discount.types';

/**
 * The month-to-date Branch Discount summary — what Production and super admin
 * see per branch on Production → Discounts, and what a branch sees of its own
 * claims on Branch → Discounts.
 *
 * Shared because three surfaces state the same figures (the two web pages and
 * the mobile app) and they must agree. The server is the one that sums; clients
 * only lay it out.
 *
 * ─── What a figure means ─────────────────────────────────────────────────────
 * - A claim is one `branch_discounts` row: an amount of money claimed back
 *   against one demand. There are no units and no price lookup — the claim IS
 *   its amount, so a later price change cannot alter it.
 * - The month is the claim's `business_date` (the business day it was raised),
 *   1st of the current business month through today, inclusive — the same date
 *   the Discount pages list and filter by.
 * - `approved` is the headline: the only final figure, and the one netted off
 *   the branch's collection slip (previous-balance.service.ts counts approved
 *   claims only). `pending` is shown beside it so money still awaiting review is
 *   visible without being read as granted.
 * - Each status bucket holds only that status's rows; the four sum to
 *   `submitted`, and no claim is counted in two of them.
 * - Withdrawn claims are deleted rows, so they are in no figure at all.
 */

export interface DiscountBucket {
  /** Rs. claimed. */
  amount: number;
  /** Claims (rows). */
  count: number;
}

export interface DiscountSummaryTotals {
  /** Every claim raised in the window, all statuses. */
  submitted: DiscountBucket;
  /** Waiting on Production. */
  pending: DiscountBucket;
  /** Allowed — the final, deducted figure. */
  approved: DiscountBucket;
  /** Refused. */
  rejected: DiscountBucket;
  /** Sent back to the branch to correct. */
  returned: DiscountBucket;
}

export interface BranchDiscountTotals extends DiscountSummaryTotals {
  branchId: string;
  branchName: string;
}

export interface MonthlyDiscountSummary {
  /** 'YYYY-MM-01' — first day of the current business month. */
  from: string;
  /** 'YYYY-MM-DD' — today's business date, inclusive. */
  to: string;
  /** One entry per branch in scope, alphabetical. Zero-claim branches included, at Rs. 0. */
  branches: BranchDiscountTotals[];
  /** Every branch in `branches` added together. */
  totals: DiscountSummaryTotals;
}

/** One SQL aggregate row: a branch × status group. */
export interface DiscountSummaryRow {
  branchId: string;
  branchName: string;
  status: BranchDiscountStatus | string;
  count: number;
  amount: number;
}

export const DISCOUNT_SUMMARY_STATUSES: readonly BranchDiscountStatus[] = ['pending', 'approved', 'rejected', 'returned'];

/** Money is added in whole paisa, never as rupee floats. `amount` is numeric(14,2), so this is exact. */
const addMoney = (a: number, b: number) => (Math.round(a * 100) + Math.round(b * 100)) / 100;

function emptyTotals(): DiscountSummaryTotals {
  const zero = () => ({ amount: 0, count: 0 });
  return { submitted: zero(), pending: zero(), approved: zero(), rejected: zero(), returned: zero() };
}

function addInto(target: DiscountBucket, amount: number, count: number) {
  target.amount = addMoney(target.amount, amount);
  target.count += count;
}

/**
 * Folds the branch × status aggregate rows into the summary. `branches` is the
 * branch list in scope, so a branch with no claims still shows at Rs. 0; a row
 * for a branch missing from it (one since deactivated) is kept under the name
 * the claim carries, so the overall total never silently drops money.
 */
export function buildDiscountSummary(
  rows: DiscountSummaryRow[],
  branches: { id: string; name: string }[],
  range: { from: string; to: string },
): MonthlyDiscountSummary {
  const byBranch = new Map<string, BranchDiscountTotals>();
  const ensure = (id: string, name: string) => {
    let entry = byBranch.get(id);
    if (!entry) {
      entry = { branchId: id, branchName: name, ...emptyTotals() };
      byBranch.set(id, entry);
    }
    return entry;
  };
  for (const b of branches) ensure(b.id, b.name);

  for (const row of rows) {
    const entry = ensure(row.branchId, row.branchName);
    const amount = Number(row.amount) || 0;
    const count = Number(row.count) || 0;
    addInto(entry.submitted, amount, count);
    if ((DISCOUNT_SUMMARY_STATUSES as readonly string[]).includes(row.status)) {
      addInto(entry[row.status as BranchDiscountStatus], amount, count);
    }
  }

  const list = [...byBranch.values()].sort((a, b) => a.branchName.localeCompare(b.branchName));
  const totals = emptyTotals();
  for (const b of list) {
    for (const key of ['submitted', ...DISCOUNT_SUMMARY_STATUSES] as const) addInto(totals[key], b[key].amount, b[key].count);
  }
  return { from: range.from, to: range.to, branches: list, totals };
}
