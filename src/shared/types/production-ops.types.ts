// Central Production department operations: the production stock pool, product
// returns, and production expenses. These are distinct from per-branch `stock`
// (see stock.types.ts) — the production pool is a single, branch-agnostic pool
// keyed by productId.

// ── Production Stock pool ────────────────────────────────────────────────────

export type ProductionStockMovementType =
  | 'prepare' // Production prepared units → pool +
  | 'transfer_out' // demand approved, moved to a branch → pool −
  | 'return_in' // accepted return added back → pool +
  | 'adjustment';

/** Running balance for the central production pool. Firestore doc id = `${productId}`. */
export interface ProductionStockDoc {
  productId: string;
  productName: string;
  balance: number;
  updatedAt: string; // ISO UTC
}

/** Append-only movement log for the production pool. doc id = `${refId}_${productId}_${type}`. */
export interface ProductionStockHistoryRow {
  id: string;
  productId: string;
  productName: string;
  type: ProductionStockMovementType;
  delta: number; // signed
  balanceAfter: number;
  refId: string; // prep batch / order / return id
  date: string; // 'YYYY-MM-DD' (Karachi)
  createdAt: string; // ISO UTC
}

/** Computed per-product row for the Production Stock page. */
export interface ProductionStockRow {
  productId: string;
  productName: string;
  preparedToday: number; // Σ prepare deltas today
  totalStock: number; // current balance + what left today (a "gross in" view)
  approvedQty: number; // Σ transferred out today
  balance: number; // current pool balance
  returned: number; // Σ returns added back today
}

// ── Product Returns ──────────────────────────────────────────────────────────

export type ProductionReturnStatus = 'pending' | 'accepted' | 'rejected';

export interface ProductionReturn {
  id: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  status: ProductionReturnStatus;
  date: string; // 'YYYY-MM-DD' (Karachi)
  createdBy: string;
  createdByName: string;
  createdAt: string; // ISO UTC
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
}

// ── Production Expenses ──────────────────────────────────────────────────────

export type ProductionExpensePaymentMethod = 'cash' | 'easypaisa' | 'bank_account';

export interface ProductionExpense {
  id: string;
  date: string; // 'YYYY-MM-DD' (Karachi)
  category: string;
  description: string;
  amount: number;
  paymentMethod: ProductionExpensePaymentMethod;
  supplier: string;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string; // ISO UTC
}
