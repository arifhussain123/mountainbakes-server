/**
 * Demand Record: what a branch owes the company, demand by demand, with the
 * balance carried from each demand to the next.
 *
 *   G. Total        = Delivered − Returns − Discount
 *   Company Share   = G. Total × the demand's frozen share % ÷ 100
 *   Closing Balance = Previous Balance + Company Share + Adjustments − Share Received
 *
 * Share Received is money Finance approved (cash transfers), each deposit
 * counted once. Actual Sales and the share calculated on them are shown beside
 * it and never stand in for it. A negative closing balance is a credit (the
 * branch has paid ahead) and is kept as it is, never floored at zero.
 *
 * Each row is one demand plus everything that happened after it and before
 * the branch's next demand (returns, deposits, sales, Finance entries;
 * discounts go to the demand they were claimed against). Row 0 of a branch is
 * its opening: Finance's opening entry, and anything between the go-live day
 * and the branch's first demand. The server gathers those facts
 * (services/branch-account.service.ts); this module turns them into money, so
 * every screen and export computes it the same way.
 */

/** Facts for one row, as the server gathers them. Amounts in rupees. */
export interface BranchAccountFacts {
  branchId: string;
  branchName: string;
  /** null for the branch's opening row. */
  orderId: string | null;
  demandNumber: string | null;
  businessDate: string;
  /** ISO time the demand was submitted; the go-live instant for an opening row. */
  at: string;
  status: string | null;
  /** The % frozen when the demand was delivered; null when none was (see `pctFrozen`). */
  frozenPct: number | null;
  /** The branch's % today — used only where nothing was frozen. */
  livePct: number;
  delivered: number;
  returns: number;
  returnsQty: number;
  discount: number;
  received: number;
  sales: number;
  adjustments: number;
  /** Lines with no price anywhere, counted at 0. */
  unpricedLines: number;
}

export interface BranchAccountRow extends BranchAccountFacts {
  sharePct: number;
  /** False when the row fell back to today's % (opening rows, or a demand nothing froze). */
  pctFrozen: boolean;
  gTotal: number;
  companyShare: number;
  /** Actual Sales × %: for comparison with Share Received only. */
  shareOnSales: number;
  previousBalance: number;
  closingBalance: number;
}

/** Rupees to the paisa, without binary-fraction drift (0.1 + 0.2 = 0.3). */
export const toPaisa = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function companyShareOf(base: number, pct: number): number {
  return toPaisa((base * pct) / 100);
}

/**
 * One branch's rows, already in order (opening first, then by submission
 * time), into money with the running balance. `startBalance` is the balance
 * before the first row given — 0 when the list starts at the opening row.
 */
export function computeBranchAccount(facts: BranchAccountFacts[], startBalance = 0): BranchAccountRow[] {
  let balance = toPaisa(startBalance);
  return facts.map((f) => {
    const pctFrozen = f.frozenPct !== null;
    const sharePct = pctFrozen ? f.frozenPct! : f.livePct;
    const gTotal = toPaisa(f.delivered - f.returns - f.discount);
    const companyShare = companyShareOf(gTotal, sharePct);
    const previousBalance = balance;
    const closingBalance = toPaisa(previousBalance + companyShare + f.adjustments - f.received);
    balance = closingBalance;
    return {
      ...f,
      sharePct,
      pctFrozen,
      gTotal,
      companyShare,
      shareOnSales: companyShareOf(f.sales, sharePct),
      previousBalance,
      closingBalance,
    };
  });
}

export type BalanceStanding = 'owed' | 'settled' | 'credit';

/** Positive: still owed to the company. Zero: settled. Negative: paid ahead. */
export function balanceStanding(balance: number): BalanceStanding {
  const b = toPaisa(balance);
  return b > 0 ? 'owed' : b < 0 ? 'credit' : 'settled';
}

export interface BranchAccountTotals {
  delivered: number;
  sales: number;
  returns: number;
  discount: number;
  gTotal: number;
  companyShare: number;
  shareOnSales: number;
  received: number;
  adjustments: number;
  /** Balance before the period's first row, summed over branches. */
  openingBalance: number;
  /** Balance after the period's last row, summed over branches. */
  closingBalance: number;
}

/**
 * Period totals. Activity is summed over the rows in the period; the opening
 * and closing balances are taken once per branch (from `balances`), never
 * summed down a column — a carried-forward balance added up row by row would
 * count the same money once per demand.
 */
export function totalBranchAccount(
  rows: BranchAccountRow[],
  balances: { openingBalance: number; closingBalance: number }[],
): BranchAccountTotals {
  const t: BranchAccountTotals = {
    delivered: 0, sales: 0, returns: 0, discount: 0, gTotal: 0, companyShare: 0,
    shareOnSales: 0, received: 0, adjustments: 0, openingBalance: 0, closingBalance: 0,
  };
  for (const r of rows) {
    t.delivered += r.delivered;
    t.sales += r.sales;
    t.returns += r.returns;
    t.discount += r.discount;
    t.gTotal += r.gTotal;
    t.companyShare += r.companyShare;
    t.shareOnSales += r.shareOnSales;
    t.received += r.received;
    t.adjustments += r.adjustments;
  }
  for (const b of balances) {
    t.openingBalance += b.openingBalance;
    t.closingBalance += b.closingBalance;
  }
  for (const k of Object.keys(t) as (keyof BranchAccountTotals)[]) t[k] = toPaisa(t[k]);
  return t;
}

// ---------------------------------------------------------------------------
// API shapes — /api/finance/branch-account
// ---------------------------------------------------------------------------

export interface DemandRecordRow extends BranchAccountRow {
  /** True while the branch has no later demand: returns and deposits can still land here. */
  open: boolean;
}

export interface DemandRecordResult {
  start: string;
  from: string;
  to: string;
  rows: DemandRecordRow[];
  totals: BranchAccountTotals;
  /** Per branch in scope: balance before `from` and after `to`. */
  branches: { branchId: string; branchName: string; openingBalance: number; closingBalance: number }[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface DemandRecordDetail {
  row: DemandRecordRow;
  lines: { productName: string; orderedQty: number; deliveredQty: number; unitPrice: number | null; priceSource: 'order' | 'price_history' | 'none'; amount: number }[];
  returns: { id: string; businessDate: string; productName: string; qty: number; unitPrice: number | null; amount: number; createdAt: string }[];
  discounts: { id: string; demandNumber: string | null; amount: number; reason: string; createdAt: string; linked: boolean }[];
  payments: { id: string; transferNo: string | null; voucherNo: string | null; businessDate: string; amount: number; createdAt: string }[];
  sales: { count: number; amount: number };
  adjustments: BranchAccountAdjustment[];
}

export interface BranchAccountAdjustment {
  id: string;
  branchId: string;
  branchName: string;
  kind: 'opening' | 'adjustment' | 'reversal';
  amount: number;
  businessDate: string;
  effectiveAt: string;
  reason: string;
  reversalOf: string | null;
  /** Set on an entry that has been reversed: the reversal's id. */
  reversedBy: string | null;
  createdByName: string | null;
  createdAt: string;
}
