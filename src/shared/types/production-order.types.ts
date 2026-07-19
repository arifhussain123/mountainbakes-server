// Named "Branch…" to avoid colliding with production.types.ts `ProductionOrder`
// (the production-queue view of a customer order). This is the branch's daily
// production *request* (collection `production_orders`).
export type BranchProductionOrderStatus = 'pending' | 'approved' | 'rejected';

export interface BranchProductionOrderItem {
  productId: string;
  productName: string;
  qty: number; // requested quantity — the branch's "New Demand" for this order
  remarks: string;
  /**
   * Quantity Production actually approved. Defaults to `totalRequiredQty` on approval
   * (previous balance + new demand); may be lower/higher when Production adjusts.
   */
  approvedQty?: number;
  /**
   * Pending-balance carry-forward fields, frozen onto the item at approval time.
   * Absent on pending orders (computed live in the print preview) and on legacy
   * orders created before this feature — treat missing values as 0.
   */
  previousBalanceQty?: number; // outstanding balance carried in from prior orders
  totalRequiredQty?: number; // previousBalanceQty + qty (New Demand)
  remainingBalanceQty?: number; // max(0, totalRequiredQty - approvedQty) — carried forward
}

export interface BranchProductionOrder {
  id: string;
  branchId: string;
  branchName: string;
  date: string; // 'YYYY-MM-DD' (Karachi)
  time: string; // 'HH:mm' (Karachi)
  items: BranchProductionOrderItem[];
  status: BranchProductionOrderStatus;
  /** True when any approved quantity differed from the requested quantity. Powers the "Changed Orders" metric. */
  wasChanged?: boolean;
  /** Optional reason Production recorded when adjusting quantities. */
  changeReason?: string | null;
  createdBy: string;
  createdByName: string;
  submittedAt: string; // ISO UTC
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  /** Set once the production slip has been printed. Idempotent — printing never mutates stock. */
  printed?: boolean;
  printedAt?: string | null; // ISO UTC
}

/**
 * Per-(branch, product) outstanding demand that Production has not yet fulfilled.
 * Firestore doc id is `${branchId}_${productId}`. `pendingQty` is an absolute
 * running balance: each approval SETS it to that order's remaining balance
 * (overwrite, never increment — `totalRequiredQty` already folds the prior balance in).
 */
export interface ProductionBalanceDoc {
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  pendingQty: number;
  updatedAt: string; // ISO UTC
}
