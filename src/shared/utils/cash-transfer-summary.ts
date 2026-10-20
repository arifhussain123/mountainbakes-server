import { CASH_TRANSFER_STATUSES, type CashTransferStatus } from '../types/cash-transfer.types';

/**
 * The month-to-date Cash Transfer summary a branch sees above its Cash
 * Deposits table (Branch → Cash Transfer Details).
 *
 * Shared so the server and the page agree on what a figure means. The server
 * is the one that sums; the page only lays it out.
 *
 * ─── What a figure means ─────────────────────────────────────────────────────
 * - A transfer is one live `cash_transfers` row. Rows soft-deleted through the
 *   Help Desk are in no figure, as they are in no list.
 * - The month is the transfer's `business_date` (the business day it was
 *   recorded, 02:00 Karachi rollover), 1st of the current business month
 *   through today, inclusive — the same date the table lists and filters by.
 * - `transferred` is Total Amount (`amount`), every status. The database holds
 *   `amount = cash + easypaisa + bank`, so the three channel cards split it.
 * - `approved` / `pending` / `rejected` split that same Total Amount by status:
 *   they add up to `transferred`, and no transfer is in two of them.
 * - `fuel` is Fuel Charges, every status. It is never part of Total Amount —
 *   Finance books it as income under INC-FUEL — so it is its own figure and is
 *   not added to, or taken from, any other card. A fuel-only deposit (Total 0)
 *   counts only here.
 * - Every `count` is the number of transfers with a non-zero amount for that
 *   card: a cash-only deposit is in Cash's count, not in Easypaisa's.
 */

export interface CashTransferBucket {
  /** Rs. */
  amount: number;
  /** Transfers with a non-zero amount for this figure. */
  count: number;
}

export interface CashTransferSummaryTotals {
  /** Total Amount, every status. */
  transferred: CashTransferBucket;
  cash: CashTransferBucket;
  easypaisa: CashTransferBucket;
  bank: CashTransferBucket;
  /** Total Amount of transfers Finance approved. */
  approved: CashTransferBucket;
  /** Total Amount still awaiting Finance. */
  pending: CashTransferBucket;
  /** Total Amount Finance rejected. */
  rejected: CashTransferBucket;
  /** Fuel Charges, every status — separate from Total Amount. */
  fuel: CashTransferBucket;
}

export interface MonthlyCashTransferSummary {
  /** 'YYYY-MM-01' — first day of the current business month. */
  from: string;
  /** 'YYYY-MM-DD' — today's business date, inclusive. */
  to: string;
  branchId: string;
  /** Every live transfer in the window, fuel-only ones included. */
  transfers: number;
  totals: CashTransferSummaryTotals;
}

/** One SQL aggregate row: the branch's transfers of one status in the window. */
export interface CashTransferSummaryRow {
  status: CashTransferStatus | string;
  transfers: number;
  amount: number;
  amountCount: number;
  cash: number;
  cashCount: number;
  easypaisa: number;
  easypaisaCount: number;
  bank: number;
  bankCount: number;
  fuel: number;
  fuelCount: number;
}

/** Money is added in whole paisa, never as rupee floats. Every column is numeric(14,2), so this is exact. */
const addMoney = (a: number, b: number) => (Math.round(a * 100) + Math.round(b * 100)) / 100;

export function emptyCashTransferTotals(): CashTransferSummaryTotals {
  const zero = () => ({ amount: 0, count: 0 });
  return {
    transferred: zero(), cash: zero(), easypaisa: zero(), bank: zero(),
    approved: zero(), pending: zero(), rejected: zero(), fuel: zero(),
  };
}

function addInto(target: CashTransferBucket, amount: unknown, count: unknown) {
  target.amount = addMoney(target.amount, Number(amount) || 0);
  target.count += Number(count) || 0;
}

/** Folds the per-status aggregate rows into the summary. No rows is a month at Rs. 0, not an error. */
export function buildCashTransferSummary(
  rows: CashTransferSummaryRow[],
  range: { from: string; to: string },
  branchId: string,
): MonthlyCashTransferSummary {
  const totals = emptyCashTransferTotals();
  let transfers = 0;
  for (const r of rows) {
    transfers += Number(r.transfers) || 0;
    addInto(totals.transferred, r.amount, r.amountCount);
    addInto(totals.cash, r.cash, r.cashCount);
    addInto(totals.easypaisa, r.easypaisa, r.easypaisaCount);
    addInto(totals.bank, r.bank, r.bankCount);
    addInto(totals.fuel, r.fuel, r.fuelCount);
    if ((CASH_TRANSFER_STATUSES as readonly string[]).includes(r.status)) {
      addInto(totals[r.status as CashTransferStatus], r.amount, r.amountCount);
    }
  }
  return { from: range.from, to: range.to, branchId, transfers, totals };
}
