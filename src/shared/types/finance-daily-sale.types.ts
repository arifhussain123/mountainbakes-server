// Finance Daily Closing — the branch's Daily Sale Record, as Finance reads it.
//
// The row is the branch's own `DailySaleRecord`, unchanged, with one thing beside
// it: what the branch has handed over for that day. Nothing here is a second copy
// of the sales figures. The record is composed by the same service the branch
// page calls, so the two screens cannot disagree about a day.
//
// What a branch owes the company for a day is that day's COMPANY SHARE. It hands
// it over as a cash deposit (cash_transfers), usually the next day, and Finance
// approving the deposit is what makes it a verified receipt rather than a claim.
// A deposit carries the date it was handed over, not the date of the sales it
// pays for — so a day's deposit is FOUND, by amount, among the deposits dated on
// that day or shortly after it. See utils/deposit-reconciliation.ts.

import type { DailySaleRecord, DailySaleRecordList } from './daily-sale.types';

/**
 * How a day's Company Share stands against the deposits found for it.
 *
 *   nothing_due   — no Company Share for the day
 *   not_received  — a share is due and no deposit was found for it
 *   pending       — the deposit found is waiting for Finance's decision
 *   matched       — an approved deposit of the same amount was found
 *   discrepancy   — the nearest approved deposit is a different amount
 *
 * `matched` needs an approved deposit behind it, so a day is never called matched
 * because its figures merely loaded.
 */
export type DepositReconStatus =
  | 'nothing_due'
  | 'not_received'
  | 'pending'
  | 'matched'
  | 'discrepancy';

export const DEPOSIT_RECON_STATUS_LABELS: Record<DepositReconStatus, string> = {
  nothing_due: 'Nothing due',
  not_received: 'Not received',
  pending: 'Awaiting approval',
  matched: 'Matched',
  discrepancy: 'Discrepancy',
};

/**
 * How the deposits on a row came to be set against that day.
 *
 *   amount   — a deposit (or one date's deposits together) of the same amount as
 *              the day's Company Share
 *   nearest  — no deposit of that amount; the earliest unclaimed deposits in the
 *              window, shown so the gap can be seen. A likely pairing, not a
 *              certain one.
 *   none     — nothing in the window
 */
export type DepositMatchKind = 'amount' | 'nearest' | 'none';

/** A deposit as the reconciliation reads it — the amounts and how to find it. */
export interface ReconciliationDeposit {
  id: string;
  transferNo: string;
  voucherNo: string | null;
  /** Rejected and deleted deposits never reach the reconciliation. */
  status: 'pending' | 'approved';
  cashAmount: number;
  easypaisaAmount: number;
  bankAmount: number;
  /** The three channels summed. Fuel charges are not part of it. */
  amount: number;
}

/** A deposit with the branch and the date it was handed over. */
export interface BranchDayDeposit extends ReconciliationDeposit {
  branchId: string;
  branchName: string;
  businessDate: string;
}

/**
 * One branch day's Company Share against the deposits found for it.
 *
 * `difference` is COMPANY SHARE − RECEIVED. Positive means the share has not
 * been received in full; negative means more was received than the share. It is a
 * different question from the record's own `overallDifference` (what the branch
 * counted against the system) and never replaces it.
 */
export interface DailySaleReconciliation {
  /** The day's Company Share. */
  expected: number;
  /** Approved deposits set against this day. */
  received: number;
  /** Undecided deposits set against this day. Never counted as received. */
  pending: number;
  difference: number;
  approvedCount: number;
  pendingCount: number;
  status: DepositReconStatus;
  match: DepositMatchKind;
  /**
   * The record is still open, so its figures can still move with the day's sales
   * and the comparison is not final.
   */
  provisional: boolean;
  /** The deposits set against this day, each with the date it was handed over. */
  deposits: BranchDayDeposit[];
}

export interface FinanceDailySaleRow extends DailySaleRecord {
  reconciliation: DailySaleReconciliation;
}

/** The reconciliation over the window on show. */
export interface FinanceDailySaleSummary {
  expected: number;
  received: number;
  pending: number;
  difference: number;
  /** How many branch days sit in each state. */
  counts: Record<DepositReconStatus, number>;
}

export interface FinanceDailySaleList extends Omit<DailySaleRecordList, 'records' | 'locks'> {
  records: FinanceDailySaleRow[];
  reconciliation: FinanceDailySaleSummary;
  /**
   * Deposits dated inside the window that were not set against any day. They are
   * reported rather than forced onto a day: which sales a deposit pays for is the
   * branch's statement, and a pairing nobody can explain is worse than none.
   */
  unmatchedDeposits: BranchDayDeposit[];
}
