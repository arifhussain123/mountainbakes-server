import type { DailySaleRecord, DailySaleSummary } from '../types/daily-sale.types';
import { splitShare } from './share';

/**
 * The difference figures for one Daily Sale Record.
 *
 * ─── Why this exists when the database already computes them ─────────────────
 * `daily_sale_records` carries `cash_difference`, `easypaisa_difference`,
 * `bank_difference` and `overall_difference` as GENERATED columns (migration
 * 101). Those are the durable record — impossible to falsify, and what any
 * SQL-side report reads.
 *
 * This is the same formula for the one case the generated columns cannot cover:
 * a record that is still OPEN, whose auto figures are re-derived from `orders` on
 * every read so the branch is counting against what the till says now rather than
 * against a snapshot taken at breakfast. The stored columns are computed from the
 * stored snapshot; this computes from the presented one.
 *
 * For a FROZEN record (verified / locked / amended) the presented auto figures
 * ARE the stored ones, so this returns exactly what the generated columns hold —
 * by construction, not by coincidence. That is what makes one formula in one
 * place safe: the two agree wherever they overlap.
 *
 * Shared because the API composes the list with it and the client's View popup
 * and print sheet read the same numbers, and a screen that disagreed with its own
 * printout by one counted figure is not a cosmetic problem.
 */
export interface DailySaleDifferences {
  /**
   * Counted cash minus CASH ON TABLE — not minus gross takings.
   *
   * null where nothing was counted, which is not the same as nothing being wrong.
   */
  cashDifference: number | null;
  easypaisaDifference: number | null;
  bankDifference: number | null;
  /** The three above summed, an uncounted method contributing 0. */
  overallDifference: number;
  /** The payment breakdown re-added. Should equal the total sale. */
  paymentTotal: number;
  /**
   * Cash on Table — what the drawer should physically hold: cash taken, less cash
   * paid out of it. This is the figure `cashDifference` reconciles against.
   */
  expectedCashInHand: number;
}

/** The auto (system) half of one day. */
export interface DailySaleAutoFigures {
  autoTotalSale: number;
  autoCash: number;
  autoEasypaisa: number;
  autoFoodpanda: number;
  autoBank: number;
  autoOther: number;
  cashExpense: number;
}

/** The counted half. `null` means the method has not been counted. */
export interface DailySaleManualFigures {
  manualCash: number | null;
  manualEasypaisa: number | null;
  manualBank: number | null;
}

/**
 * The company's share of one day's Total Sale.
 *
 * `snapshotPct` is the percentage recorded on the day's income approval, when the
 * day has one; `currentPct` is what Admin has configured for the branch now
 * (already resolved through `resolveShareSplit`). The snapshot wins: a day booked
 * at 70% stays at 70% after Admin moves the branch to 75%.
 *
 * The amount is `splitShare`'s, so it rounds exactly as the ledger's split does.
 * A missing or out-of-range percentage yields 0 rather than NaN.
 */
export function computeDailySaleCompanyShare(
  totalSale: number,
  snapshotPct: number | null | undefined,
  currentPct: number,
): { companySharePct: number; companyShare: number; branchSharePct: number; branchShare: number } {
  const usable = (v: unknown): v is number =>
    v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100;
  const companySharePct = usable(snapshotPct) ? Number(snapshotPct) : usable(currentPct) ? Number(currentPct) : 0;
  const total = Number.isFinite(Number(totalSale)) ? Number(totalSale) : 0;
  const { companyShare, branchShare } = splitShare(total, companySharePct);
  return { companySharePct, companyShare, branchSharePct: round2(100 - companySharePct), branchShare };
}

/** `manual − expected`, or null when nothing was counted. */
function diff(manual: number | null, expected: number): number | null {
  return manual === null || manual === undefined ? null : round2(manual - expected);
}

/** Money to two places. Guards the float drift that a chain of subtractions invites. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeDailySaleDifferences(
  auto: DailySaleAutoFigures,
  manual: DailySaleManualFigures,
): DailySaleDifferences {
  // What should physically be in the drawer, and therefore what a counted note
  // total is checked against. Cash is the ONLY method netted against expenses —
  // money paid out of the till never reaches the bank or the aggregator, so
  // subtracting it from those would invent a discrepancy rather than remove one.
  const expectedCashInHand = round2(auto.autoCash - auto.cashExpense);

  // Against CASH ON TABLE, not gross takings (migration 102). The person counting
  // is counting notes, and the day's cash expenses have already left the drawer —
  // comparing against gross would report a shortfall equal to the expenses on
  // every record, every day, and bury the discrepancies that are real.
  const cashDifference = diff(manual.manualCash, expectedCashInHand);
  const easypaisaDifference = diff(manual.manualEasypaisa, auto.autoEasypaisa);
  const bankDifference = diff(manual.manualBank, auto.autoBank);

  return {
    cashDifference,
    easypaisaDifference,
    bankDifference,
    overallDifference: round2(
      (cashDifference ?? 0) + (easypaisaDifference ?? 0) + (bankDifference ?? 0),
    ),
    // Gross, and it must stay gross: this is the payment breakdown re-added, and
    // it has to keep equalling the day's total sale. A breakdown whose rows do
    // not sum to their own heading is worse than one with a row missing.
    paymentTotal: round2(
      auto.autoCash + auto.autoEasypaisa + auto.autoFoodpanda + auto.autoBank + auto.autoOther,
    ),
    expectedCashInHand,
  };
}

/**
 * The summary cards above the table (§18), over whatever window is on show.
 *
 * `difference` sums the rows' `overallDifference`, and `uncounted` is reported
 * beside it rather than hidden: a window where nothing has been counted sums to
 * a difference of zero, and a zero that means "we have not looked" must not be
 * shown next to a tick that means "it balances". The card reads the count and
 * says so.
 */
export function computeDailySaleSummary(records: DailySaleRecord[]): DailySaleSummary {
  const summary: DailySaleSummary = {
    totalSale: 0,
    cash: 0,
    easypaisa: 0,
    foodpanda: 0,
    bank: 0,
    cashExpense: 0,
    discount: 0,
    difference: 0,
    uncounted: 0,
  };

  for (const r of records) {
    summary.totalSale += r.autoTotalSale;
    summary.cash += r.autoCash;
    summary.easypaisa += r.autoEasypaisa;
    summary.foodpanda += r.autoFoodpanda;
    summary.bank += r.autoBank;
    summary.cashExpense += r.cashExpense;
    summary.discount += r.discount;
    summary.difference += r.overallDifference;
    if (r.cashDifference === null && r.easypaisaDifference === null && r.bankDifference === null) {
      summary.uncounted += 1;
    }
  }

  return {
    totalSale: round2(summary.totalSale),
    cash: round2(summary.cash),
    easypaisa: round2(summary.easypaisa),
    foodpanda: round2(summary.foodpanda),
    bank: round2(summary.bank),
    cashExpense: round2(summary.cashExpense),
    discount: round2(summary.discount),
    difference: round2(summary.difference),
    uncounted: summary.uncounted,
  };
}
