import type { PaymentMethod } from './order.types';
import type { StockRow } from './stock.types';

export type ClosureStatus = 'running' | 'success' | 'failed';
export type ClosureTrigger = 'scheduler' | 'manual';

/** Sales rollup for a closed business day. */
export interface SalesSummary {
  totalSales: number; // Σ grandTotal
  totalOrders: number;
  byPaymentMethod: Record<PaymentMethod, number>; // cash / easypaisa / foodpanda / bank_account
  totalDiscounts: number; // Σ discountTotal
  governmentTax: number; // Σ taxAmount
  netSales: number; // totalSales − totalDiscounts − governmentTax
}

/** Expense rollup. `byCategory` is keyed by expense category (both shop and production). */
export interface ExpenseSummary {
  total: number;
  byCategory: Record<string, number>;
  byPaymentMethod: Record<string, number>;
}

/** Production rollup for the day. */
export interface ProductionSummary {
  ordersClosed: number; // approved/reviewed orders dated to the business day
  ordersPending: number; // still-pending orders carried forward
  approvedQty: number; // units approved (moved into branches)
  returnedQty: number; // units returned into the central pool
  pendingBalanceQty: number; // outstanding production_balances carried forward
}

/** Per-branch immutable stock snapshot at close (reuses the Stock page row shape). */
export interface StockSnapshotBranch {
  branchId: string;
  branchName: string;
  rows: StockRow[];
}

/**
 * One document per closed business day — the archive + idempotency lock.
 * Table `business_day_closures`, keyed by the business date.
 */
export interface DailyClosure {
  businessDate: string; // 'YYYY-MM-DD'
  status: ClosureStatus;
  trigger: ClosureTrigger;
  closedBy: string; // 'System Scheduler' or the admin email
  autoStockClosing: boolean;
  salesSummary: SalesSummary | null;
  expenseSummary: ExpenseSummary | null; // shop expenses
  productionExpenseSummary: ExpenseSummary | null;
  productionSummary: ProductionSummary | null;
  stockSnapshot: StockSnapshotBranch[] | null;
  error: string | null;
  startedAt: string; // ISO UTC
  closedAt: string | null; // ISO UTC
  durationMs: number | null;
}
