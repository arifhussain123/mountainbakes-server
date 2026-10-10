// Finance Daily Closing — the branch's Daily Sale Record, as Finance reads it.
//
// The row is the branch's own `DailySaleRecord`, unchanged, with one thing beside
// it: what the branch has actually handed over for that day. Nothing here is a
// second copy of the sales figures. The record is composed by the same service
// the branch page calls, so the two screens cannot disagree about a day.
//
// "Handed over" means the day's cash deposits (cash_transfers) that Finance has
// APPROVED. Approving a deposit is Finance saying the money arrived, which is
// what makes it a verified receipt rather than a branch's claim.

import type { DailySaleRecord, DailySaleRecordList } from './daily-sale.types';

/**
 * How a day's deposits stand against what the day recorded.
 *
 *   nothing_due   — nothing to hand over and nothing handed over
 *   not_received  — money is due and no deposit has been approved
 *   pending       — a deposit is waiting for Finance's decision
 *   matched       — approved deposits equal the recorded figures, channel by channel
 *   discrepancy   — approved deposits differ from the recorded figures
 *
 * `matched` is an exact zero on every channel, for the reason `differenceStatus`
 * gives: a tolerance wide enough to hide the noise is wide enough to hide a habit.
 * It also needs an approved deposit behind it, so a day is never called matched
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

/** One figure per channel a branch can deposit through, and their sum. */
export interface DepositChannelAmounts {
  cash: number;
  easypaisa: number;
  bank: number;
  total: number;
}

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

/** A deposit with the branch day it was booked against. */
export interface BranchDayDeposit extends ReconciliationDeposit {
  branchId: string;
  branchName: string;
  businessDate: string;
}

/**
 * One branch day's recorded money against its verified receipts.
 *
 * `difference` is RECORDED − VERIFIED RECEIVED, per channel. Positive means money
 * the day recorded has not been received; negative means more was received than
 * recorded. It is a different question from the record's own `overallDifference`
 * (what the branch counted against the system) and never replaces it.
 */
export interface DailySaleReconciliation {
  /** What the day's record says should be handed over. */
  expected: DepositChannelAmounts;
  /** Approved deposits. */
  received: DepositChannelAmounts;
  /** Deposits submitted and not yet decided. Never counted as received. */
  pending: DepositChannelAmounts;
  difference: DepositChannelAmounts;
  approvedCount: number;
  pendingCount: number;
  status: DepositReconStatus;
  /**
   * The record is still open, so its figures can still move with the day's sales
   * and the comparison is not final.
   */
  provisional: boolean;
  /** The total agrees but a channel does not — money sent through another channel. */
  totalMatches: boolean;
  deposits: ReconciliationDeposit[];
}

export interface FinanceDailySaleRow extends DailySaleRecord {
  reconciliation: DailySaleReconciliation;
}

/** The reconciliation over the window on show. */
export interface FinanceDailySaleSummary {
  expected: DepositChannelAmounts;
  received: DepositChannelAmounts;
  pending: DepositChannelAmounts;
  difference: DepositChannelAmounts;
  /** How many branch days sit in each state. */
  counts: Record<DepositReconStatus, number>;
}

export interface FinanceDailySaleList extends Omit<DailySaleRecordList, 'records' | 'locks'> {
  records: FinanceDailySaleRow[];
  reconciliation: FinanceDailySaleSummary;
  /**
   * Deposits dated on a day that has no row in this window. They are reported
   * rather than moved to a neighbouring day: which day a deposit belongs to is
   * the branch's statement, and correcting it is a Help Desk amendment.
   */
  unmatchedDeposits: BranchDayDeposit[];
}
