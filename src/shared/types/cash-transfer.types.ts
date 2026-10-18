import type { Attachment } from './attachment.types';

// ---------------------------------------------------------------------------
// Cash transfers — money a branch hands over to the company (migration 118).
//
// A branch records the handover with a photo of the slip; Finance approves it,
// and the approval posts ONE RV- receipt to the Daily Ledger in the same
// transaction. The transfer is its own transaction: it never adds to or
// subtracts from a sale, a demand, a discount or a previous balance. The
// production slip SUMS approved transfers as "Payment Received" and shows the
// figure beside the existing ones (previous-balance.service.ts).
// ---------------------------------------------------------------------------

/**
 * The three channels a branch hands money over by. The same values the daily
 * sale record lets a branch key by hand (DAILY_SALE_MANUAL_METHODS).
 *
 * Since migration 121 a deposit carries an amount PER channel (`cashAmount`,
 * `easypaisaAmount`, `bankAmount`) rather than one method; these values now
 * name the channels — for filters and labels — and the legacy
 * `cash_transfers.payment_method` column that a pre-121 row was raised with.
 * Foodpanda is deliberately absent: the branch keys it into Easypaisa by hand.
 */
export const CASH_TRANSFER_METHODS = ['cash', 'easypaisa', 'bank_account'] as const;
export type CashTransferMethod = (typeof CASH_TRANSFER_METHODS)[number];

export const CASH_TRANSFER_METHOD_LABELS: Record<CashTransferMethod, string> = {
  cash: 'Cash',
  easypaisa: 'Easypaisa',
  bank_account: 'Bank',
};

/** The three channel figures of a deposit, as every reader of one holds them. */
export interface CashTransferChannels {
  cashAmount: number;
  easypaisaAmount: number;
  bankAmount: number;
}

/**
 * Total Amount = Cash + Easypaisa + Bank — never Fuel Charges, never Foodpanda.
 * Rounded to the paisa so three 2-dp figures cannot sum to a float tail.
 * The database CHECK `cash_transfers_total_is_channels` holds the same rule.
 */
export function cashTransferTotal(c: CashTransferChannels): number {
  return Math.round((c.cashAmount + c.easypaisaAmount + c.bankAmount) * 100) / 100;
}

/** "Cash + Easypaisa", "Bank", or "Fuel only" — the channels a deposit used. */
export function cashTransferChannelsLabel(c: CashTransferChannels & { fuelCharges?: number }): string {
  const used = (
    [
      ['cash', c.cashAmount],
      ['easypaisa', c.easypaisaAmount],
      ['bank_account', c.bankAmount],
    ] as [CashTransferMethod, number][]
  )
    .filter(([, v]) => v > 0)
    .map(([m]) => CASH_TRANSFER_METHOD_LABELS[m]);
  if (used.length > 0) return used.join(' + ');
  return (c.fuelCharges ?? 0) > 0 ? 'Fuel only' : '—';
}

/**
 * How many live (pending or approved) deposits a branch may raise for one
 * business day. Rejected and deleted ones do not count. The API enforces it;
 * the deposit popup reads the same number to warn before anything is typed.
 */
export const CASH_DEPOSITS_PER_DAY = 3;


/**
 * pending  — waiting on Finance. The branch cannot edit it; a wrong figure is
 *            rejected and raised again under a fresh photo.
 * approved — booked; `voucherNo` / `ledgerEntryId` are set. Final.
 * rejected — refused with a reason. The record and photo stay. Final.
 */
export const CASH_TRANSFER_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type CashTransferStatus = (typeof CASH_TRANSFER_STATUSES)[number];

export const CASH_TRANSFER_STATUS_LABELS: Record<CashTransferStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export interface CashTransfer extends CashTransferChannels {
  id: string;
  /** CT-000001 … issued at insert, before Finance has seen it. */
  transferNo: string;
  branchId: string;
  branchName: string;
  /** Total Amount = cashAmount + easypaisaAmount + bankAmount. Excludes fuel. */
  amount: number;
  /** Delivery charges handed over with the deposit; booked as income under Fuel. */
  fuelCharges: number;
  /** Legacy: the one method a pre-121 deposit named. Null on new deposits. */
  paymentMethod: CashTransferMethod | null;
  note: string | null;
  /** Business date of the handover (`business_date`), as the API's `date`. */
  date: string;
  status: CashTransferStatus;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  /** Stamped on approve AND reject — `status` says which. */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  rejectionReason: string | null;
  /** Last corrected by (Help Desk / Support Center) — migration 121. */
  updatedBy: string | null;
  updatedByName: string | null;
  /** The first RV- receipt this became; null until approved. */
  ledgerEntryId: string | null;
  /** Every RV- the approval posted (the Total, and Fuel when entered), comma separated. */
  voucherNo: string | null;
  updatedAt: string;
  /**
   * Soft delete through the Finance Help Desk (migration 120). Every ordinary
   * read excludes stamped rows; the desk's own reference lookup resolves them
   * on purpose so "where did CT-000012 go?" stays answerable.
   */
  deletedAt: string | null;
  deletedByName: string | null;
  deleteReason: string | null;
  deletedQueryNo: string | null;
  /** The handover photo(s). Signed URLs — see Attachment. */
  attachments: Attachment[];
}

export type CashTransferSortKey =
  | 'date'
  | 'createdAt'
  | 'approvedAt'
  | 'transferNo'
  | 'voucherNo'
  | 'branchName'
  | 'amount'
  | 'fuelCharges'
  | 'status';

/** How many transfers one status holds, and their Total Amount (fuel excluded). */
export interface CashTransferStatusFigure {
  count: number;
  amount: number;
}

/**
 * Finance's Cash Transfers board, summed over EVERY row its filters match —
 * not the page on screen. GET /api/finance/cash-transfers/summary takes the
 * list's filters with the list's defaults, so `totals.count` is the list's
 * `total` for the same query string. Summed in Postgres; soft-deleted rows are
 * in no figure, as they are in no list.
 *
 * Every count is rows, fuel-only deposits included, so the three statuses add
 * up to `totals.count`. (The branch's monthly summary counts per channel
 * instead — see shared/utils/cash-transfer-summary.ts.)
 */
export interface CashTransferListSummary {
  /** The window applied, defaults included; null when open (a pending queue has no start). */
  from: string | null;
  to: string | null;
  totals: {
    count: number;
    /** Total Amount = cash + easypaisa + bank. Never fuel. */
    amount: number;
    cash: number;
    easypaisa: number;
    bank: number;
    /** Fuel Charges — beside the Total, never in it. */
    fuel: number;
  };
  pending: CashTransferStatusFigure;
  approved: CashTransferStatusFigure;
  rejected: CashTransferStatusFigure;
}

/**
 * One approved transfer as the production slip lists it under "Payment
 * Received" — the lines the total was built from, itemised server-side so the
 * slip cannot drift from the figure (same reason `discountItems` exists).
 */
export interface PaymentReceivedItem extends CashTransferChannels {
  transferId: string;
  transferNo: string;
  voucherNo: string | null;
  date: string;
  /** The deposit's Total — fuel charges are not a payment against the slip. */
  amount: number;
}
