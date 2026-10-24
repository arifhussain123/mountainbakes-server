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
 *   1. approved, same amount        → matched
 *   2. pending,  same amount        → awaiting approval
 *   3. approved, nearest amount     → discrepancy
 *   4. pending,  nearest amount     → awaiting approval
 *   5. approved, dated the same day → discrepancy
 *   6. pending,  dated the same day → awaiting approval
 *
 * "Nearest amount" is the deposit (or one date's deposits together) closest to
 * the share, and only when it is less than `NEAREST_AMOUNT_GAP` away — 1 to 999
 * rupees. The closest pairings across all of a branch's days are made first, so
 * a deposit goes to the day it is nearest. It is a likely pairing shown so the
 * gap is visible, and is labelled as such (`match: 'nearest'`); it is never
 * called matched.
 *
 * A gap of a thousand or more is not a near miss of that day's share; it is
 * more likely some other day's money. So a day left without a deposit then takes
 * the ones dated on the sale day itself (`match: 'same_day'`), and the gap is
 * shown on that day.
 *
 * ─── A deposit no day claimed is shown on its own date ───────────────────────
 * Last, any deposit still unclaimed — its amount paid no day, or its date's day
 * already had its deposit (a second deposit the same day) — is added to the row
 * of the date it was handed over, as cash received that day (the owner's rule,
 * 2026-10-24). It is never left off the page; the day's difference shows it, and
 * `extraCount` says how many such deposits the row carries. Only a deposit with
 * no row on its date at all stays unclaimed.
 *
 * Nothing here changes a sale, a record or a deposit.
 */

/** How many days after a sale day its deposit may be dated. */
export const DEPOSIT_MATCH_DAYS = 2;

/** A deposit this many rupees or more from a share is not its nearest amount. */
export const NEAREST_AMOUNT_GAP = 1000;

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

/**
 * The ways `candidates` could pay `share` within `NEAREST_AMOUNT_GAP`: one
 * deposit alone, or one date's deposits together, each with its gap.
 */
function nearAmounts(
  candidates: BranchDayDeposit[],
  share: number,
): { deposits: BranchDayDeposit[]; gap: number }[] {
  const options = candidates.map((d) => [d]);
  for (const date of [...new Set(candidates.map((d) => d.businessDate))]) {
    const onDate = candidates.filter((d) => d.businessDate === date);
    if (onDate.length > 1) options.push(onDate);
  }
  return options
    .map((deposits) => ({ deposits, gap: Math.abs(round2(total(deposits) - share)) }))
    .filter((o) => o.gap < NEAREST_AMOUNT_GAP);
}

function compose(
  record: DepositReconRecord,
  deposits: BranchDayDeposit[],
  match: DepositMatchKind,
  extraCount: number,
): DailySaleReconciliation {
  const approved = deposits.filter((d) => d.status === 'approved');
  const waiting = deposits.filter((d) => d.status === 'pending');
  const expected = round2(Math.max(0, record.companyShare));
  const received = total(approved);

  let status: DepositReconStatus;
  if (waiting.length > 0) status = 'pending';
  else if (approved.length === 0) status = expected === 0 ? 'nothing_due' : 'not_received';
  else status = match === 'amount' && extraCount === 0 ? 'matched' : 'discrepancy';

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
    extraCount,
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
  const found = new Map<string, { deposits: BranchDayDeposit[]; match: DepositMatchKind; extraCount: number }>();

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

  // A day with no share is owed nothing and takes no deposit.
  const waiting = () =>
    days.filter((r) => r.companyShare > 0 && !found.has(dayKey(r.branchId, r.businessDate)));

  const take = (record: DepositReconRecord, deposits: BranchDayDeposit[], match: DepositMatchKind) => {
    for (const d of deposits) claimed.add(d.id);
    found.set(dayKey(record.branchId, record.businessDate), { deposits, match, extraCount: 0 });
  };

  const pass = (status: 'approved' | 'pending', match: 'amount' | 'same_day') => {
    for (const record of waiting()) {
      const open = candidates(record, status);
      const taken =
        match === 'amount'
          ? sameAmount(open, record.companyShare)
          : open.filter((d) => d.businessDate === record.businessDate);
      if (taken.length > 0) take(record, taken, match);
    }
  };

  /** Smallest gap first over every day at once, so each deposit goes where it is nearest. */
  const nearestPass = (status: 'approved' | 'pending') => {
    const options = waiting()
      .flatMap((record) =>
        nearAmounts(candidates(record, status), record.companyShare).map((o) => ({ record, ...o })),
      )
      // Stable: equal gaps keep the oldest day, then the earliest deposit, first.
      .sort((a, b) => a.gap - b.gap);
    for (const { record, deposits } of options) {
      if (found.has(dayKey(record.branchId, record.businessDate))) continue;
      if (deposits.some((d) => claimed.has(d.id))) continue;
      take(record, deposits, 'nearest');
    }
  };

  pass('approved', 'amount');
  pass('pending', 'amount');
  nearestPass('approved');
  nearestPass('pending');
  pass('approved', 'same_day');
  pass('pending', 'same_day');

  // What is left goes on the row of the date it was handed over, alongside
  // whatever that day already has.
  const rowKeys = new Set(records.map((r) => dayKey(r.branchId, r.businessDate)));
  for (const d of pool) {
    const key = dayKey(d.branchId, d.businessDate);
    if (claimed.has(d.id) || !rowKeys.has(key)) continue;
    claimed.add(d.id);
    const hit = found.get(key);
    if (hit) {
      hit.deposits = [...hit.deposits, d];
      hit.extraCount += 1;
    } else {
      found.set(key, { deposits: [d], match: 'same_day', extraCount: 1 });
    }
  }

  const byDay = new Map<string, DailySaleReconciliation>();
  for (const record of records) {
    const key = dayKey(record.branchId, record.businessDate);
    const hit = found.get(key);
    byDay.set(key, compose(record, hit?.deposits ?? [], hit?.match ?? 'none', hit?.extraCount ?? 0));
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
