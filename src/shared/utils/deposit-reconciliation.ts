import { isDailySaleRecordOpen, type DailySaleRecord } from '../types/daily-sale.types';
import type {
  BranchDayDeposit,
  DailySaleReconciliation,
  DepositMatchKind,
  DepositReconStatus,
  FinanceDailySaleSummary,
} from '../types/finance-daily-sale.types';
import { round2 } from './daily-sale';

/**
 * Setting each branch day's Company Share against the deposit that paid it.
 *
 * ─── Why a deposit has to be searched for ────────────────────────────────────
 * A deposit is dated the day it was handed over. The sales it pays for are
 * usually the day before, sometimes two days before, and nothing on the deposit
 * says which. So a day's deposit cannot be read off by date; it is found by
 * AMOUNT, among the branch's deposits dated on that day or within
 * `DEPOSIT_MATCH_DAYS` after it.
 *
 * ─── Every deposit is used once ──────────────────────────────────────────────
 * A deposit set against one day is never offered to another, and the passes run
 * in order of certainty across ALL of a branch's days before the next begins —
 * so a deposit that is exactly Tuesday's share is not taken by Monday as a near
 * miss first:
 *
 *   1. approved, same amount      → matched
 *   2. pending,  same amount      → awaiting approval
 *   3. approved, nearest in date  → discrepancy
 *   4. pending,  nearest in date  → awaiting approval
 *
 * "Nearest" is the earliest date in the window that still has an unclaimed
 * deposit, taken whole. It is a likely pairing shown so the gap is visible, and
 * is labelled as such (`match: 'nearest'`); it is never called matched.
 *
 * Nothing here changes a sale, a record or a deposit.
 */

/** How many days after a sale day its deposit may be dated. */
export const DEPOSIT_MATCH_DAYS = 2;

/** The part of a record the reconciliation reads. */
export type DepositReconRecord = Pick<
  DailySaleRecord,
  'id' | 'status' | 'branchId' | 'businessDate' | 'companyShare'
>;

/**
 * Whether a deposit is "the same amount" as a share.
 *
 * To the rupee. A Company Share is a percentage and often ends in 50 paisa; the
 * branch hands over notes, so 38,737.50 arrives as 38,737. Calling that a
 * discrepancy would flag every such day and bury the real ones. Anything a rupee
 * or more apart is a different amount.
 */
export function amountsAgree(a: number, b: number): boolean {
  return Math.abs(round2(a - b)) < 1;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const dayKey = (branchId: string, businessDate: string) => `${branchId}|${businessDate}`;

const total = (deposits: BranchDayDeposit[]) => round2(deposits.reduce((s, d) => s + d.amount, 0));

/** One date's deposits out of a list that is already in date order. */
function firstDate(deposits: BranchDayDeposit[]): BranchDayDeposit[] {
  const date = deposits[0]?.businessDate;
  return deposits.filter((d) => d.businessDate === date);
}

/** The deposits of the same amount as `share`: one alone, else one date's together. */
function sameAmount(candidates: BranchDayDeposit[], share: number): BranchDayDeposit[] {
  const single = candidates.find((d) => amountsAgree(d.amount, share));
  if (single) return [single];

  for (const date of [...new Set(candidates.map((d) => d.businessDate))]) {
    const onDate = candidates.filter((d) => d.businessDate === date);
    if (onDate.length > 1 && amountsAgree(total(onDate), share)) return onDate;
  }
  return [];
}

function compose(
  record: DepositReconRecord,
  deposits: BranchDayDeposit[],
  match: DepositMatchKind,
): DailySaleReconciliation {
  const approved = deposits.filter((d) => d.status === 'approved');
  const waiting = deposits.filter((d) => d.status === 'pending');
  const expected = round2(Math.max(0, record.companyShare));
  const received = total(approved);

  let status: DepositReconStatus;
  if (waiting.length > 0) status = 'pending';
  else if (approved.length === 0) status = expected === 0 ? 'nothing_due' : 'not_received';
  else status = match === 'amount' ? 'matched' : 'discrepancy';

  return {
    expected,
    received,
    pending: total(waiting),
    difference: round2(expected - received),
    approvedCount: approved.length,
    pendingCount: waiting.length,
    status,
    match,
    provisional: record.id === null || isDailySaleRecordOpen(record.status),
    deposits,
  };
}

/**
 * Reconcile a set of branch days against a set of deposits.
 *
 * Returns one reconciliation per record, keyed `branchId|businessDate`, and the
 * deposits nothing claimed. Neither input is changed.
 */
export function reconcileDeposits(
  records: DepositReconRecord[],
  deposits: BranchDayDeposit[],
): { byDay: Map<string, DailySaleReconciliation>; unclaimed: BranchDayDeposit[] } {
  const claimed = new Set<string>();
  const found = new Map<string, { deposits: BranchDayDeposit[]; match: DepositMatchKind }>();

  // Oldest day first, so when two days could take the same deposit the earlier
  // one — whose deposit is the more overdue — is served first.
  const days = [...records].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const pool = [...deposits].sort((a, b) => a.businessDate.localeCompare(b.businessDate));

  const candidates = (record: DepositReconRecord, status: 'approved' | 'pending') => {
    const last = addDays(record.businessDate, DEPOSIT_MATCH_DAYS);
    return pool.filter(
      (d) =>
        !claimed.has(d.id) &&
        d.status === status &&
        d.branchId === record.branchId &&
        d.businessDate >= record.businessDate &&
        d.businessDate <= last,
    );
  };

  const pass = (status: 'approved' | 'pending', match: 'amount' | 'nearest') => {
    for (const record of days) {
      const key = dayKey(record.branchId, record.businessDate);
      // A day with no share is owed nothing and takes no deposit.
      if (found.has(key) || record.companyShare <= 0) continue;

      const open = candidates(record, status);
      const taken = match === 'amount' ? sameAmount(open, record.companyShare) : firstDate(open);
      if (taken.length === 0) continue;

      for (const d of taken) claimed.add(d.id);
      found.set(key, { deposits: taken, match });
    }
  };

  pass('approved', 'amount');
  pass('pending', 'amount');
  pass('approved', 'nearest');
  pass('pending', 'nearest');

  const byDay = new Map<string, DailySaleReconciliation>();
  for (const record of records) {
    const key = dayKey(record.branchId, record.businessDate);
    const hit = found.get(key);
    byDay.set(key, compose(record, hit?.deposits ?? [], hit?.match ?? 'none'));
  }

  return { byDay, unclaimed: pool.filter((d) => !claimed.has(d.id)) };
}

/** The reconciliation totals over a window of rows. */
export function summarizeDepositReconciliation(
  rows: { reconciliation: DailySaleReconciliation }[],
): FinanceDailySaleSummary {
  const counts: Record<DepositReconStatus, number> = {
    nothing_due: 0,
    not_received: 0,
    pending: 0,
    matched: 0,
    discrepancy: 0,
  };
  let expected = 0;
  let received = 0;
  let pending = 0;

  for (const { reconciliation: r } of rows) {
    counts[r.status] += 1;
    expected += r.expected;
    received += r.received;
    pending += r.pending;
  }

  return {
    expected: round2(expected),
    received: round2(received),
    pending: round2(pending),
    difference: round2(expected - received),
    counts,
  };
}
