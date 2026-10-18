import type { Attachment } from './attachment.types';

// Central Production department operations: the production stock pool, Branch
// Return Stock, product returns, and production expenses. These are distinct from per-branch `stock`
// (see stock.types.ts) — the production pool is a single, branch-agnostic pool
// keyed by productId.

// ── Production Stock pool ────────────────────────────────────────────────────

export type ProductionStockMovementType =
  | 'prepare' // Production prepared units → pool +
  | 'transfer_out' // branch VERIFIED the delivery, goods left the pool → pool − (migration 58)
  // LEGACY. Before migration 139 an accepted return was credited to the pool
  // automatically. Nothing writes this any more — an accepted return now lands in
  // Branch Return Stock (`return_stock`) and never in the pool. The value stays
  // because the old rows do.
  | 'return_in'
  // Explicit, authorised transfer from Branch Return Stock → pool + (migration
  // 139). The ONLY way returned units can become production stock.
  | 'return_transfer'
  | 'sale' // sold at the production counter → pool − (branch stock untouched)
  | 'adjustment';

/**
 * The `production_stock` row itself — the pool's running total across all time.
 *
 * Equal, by construction, to Σ delta over the whole of `production_stock_history`
 * for the product, which is why it is also today's closing balance and tomorrow's
 * opening. It is maintained by the movement RPCs and is never assigned directly.
 *
 * Read it for TODAY only. For any other date the figure has to be folded out of
 * the ledger, because this column has no history — see `getProductionStockRows`.
 */
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

/**
 * How a Production Stock row fits together.
 *
 * ── THE LEDGER IS THE TRUTH ──────────────────────────────────────────────────
 * `production_stock_history` is append-only: one signed `delta` per movement,
 * stamped with the business date it belongs to. Every figure below is folded out
 * of it. Nothing here is a stored, editable number, and no code path assigns a
 * balance — a mistake is corrected by a REVERSAL, never by an edit.
 *
 * ── OPENING NEEDS NO CLOSING JOB ─────────────────────────────────────────────
 *     opening(D) = Σ delta WHERE business_date < D
 *
 * which IS the previous business day's closing balance, by construction. There is
 * nothing to reset, nothing to snapshot, and no 02:00 job to miss — which matters,
 * because the node-cron schedulers in this project are all commented out, so a
 * carry-forward that depended on one would silently never happen. The date
 * changing does not zero anything: yesterday's balance simply keeps being the sum
 * that it was.
 *
 * ── THE ARITHMETIC ───────────────────────────────────────────────────────────
 *     totalStock = opening + preparedToday
 *     balance    = opening + preparedToday + returnTransferIn + returned
 *                  + adjustment − demandFulfilled − soldToday
 *     available  = balance − branchDemand
 *
 * `adjustment` is SIGNED, so the spec's "+ positive adjustments − negative
 * adjustments" is one addition of a number that may be negative. Every figure is
 * counted exactly once.
 *
 * ── BRANCH RETURNS ARE NOT IN HERE ───────────────────────────────────────────
 * A branch return is Branch Return Stock (`ReturnStockRow`), a separate inventory
 * with its own ledger. Accepting one moves NOTHING in this pool. The only return
 * units inside the balance are the ones somebody explicitly transferred in
 * (`returnTransferIn`) — and, on days before migration 139, the ones the old
 * automatic credit booked (`returned`), which is zero on every day since.
 *
 * Note what `balance` does NOT subtract: OUTSTANDING branch demand. A branch
 * asking for goods does not consume them, and reducing the pool at submission
 * would report stock as gone while it is still on the shelf. Stock leaves when the
 * branch VERIFIES the delivery — that is `demandFulfilled`, and it is the only
 * demand figure inside the balance.
 *
 * `balance` is therefore exactly Σ delta over the whole ledger up to the date,
 * which is why it is also the next day's `opening` with no further work.
 *
 * ── BRANCH DEMAND IS A CLAIM, NOT A MOVEMENT ─────────────────────────────────
 * `branchDemand` is what branches are still owed: submitted or approved and not
 * yet verified. It is read live off `production_orders` and is NOT in the ledger,
 * because writing it there would double-count against the `transfer_out` booked
 * when the same goods are verified out.
 *
 * It is displayed beside the balance rather than subtracted from it, and the two
 * are compared by `stockStatus` — which is what turns "we hold 15, we owe 25" into
 * a shortage the floor can act on instead of a negative number with no explanation.
 */
export interface ProductionStockFigures {
  /** Previous business day's closing balance. Derived, never stored or reset. */
  opening: number;
  /** Σ prepare deltas on the day — what the floor made. Positive movement. */
  preparedToday: number;
  /** opening + preparedToday. What the day had to work with. */
  totalStock: number;
  /**
   * OUTSTANDING branch claim: submitted or approved, not yet verified. Live from
   * `production_orders`, not the ledger. Displayed, never subtracted from balance.
   */
  branchDemand: number;
  /** Σ −transfer_out on the day — verified out to branches. This IS in the balance. */
  demandFulfilled: number;
  /** Σ −sale on the day, reported positive. Production counter sales. */
  soldToday: number;
  /**
   * Σ return_transfer on the day — units explicitly transferred in from Branch
   * Return Stock. NOT the day's branch returns: those stay in Return Stock.
   */
  returnTransferIn: number;
  /**
   * LEGACY: Σ return_in on the day. Non-zero only on days before migration 139,
   * when accepting a return credited the pool automatically. Kept so those closed
   * days still add up; always 0 afterwards.
   */
  returned: number;
  /** Σ adjustment on the day. SIGNED: the direction is the information. */
  adjustment: number;
  /** The ledger's closing balance for the day. Also tomorrow's `opening`. */
  balance: number;
  /** balance − branchDemand. What can still be promised or sold. May be negative. */
  available: number;
}

/**
 * Where a product stands, per §16 — the comparison the floor actually plans on.
 *
 * Order matters: `out` is checked before `shortage` so a product with nothing on
 * the shelf reads as out of stock rather than as a shortage of whatever happens to
 * be owed. `low` is the boundary case where the pool exactly covers what is owed
 * and one more demand tips it over.
 */
export type ProductionStockStatus = 'healthy' | 'low' | 'out' | 'shortage';

export function productionStockStatus(balance: number, branchDemand: number): ProductionStockStatus {
  if (balance <= 0) return 'out';
  if (balance < branchDemand) return 'shortage';
  if (balance <= branchDemand) return 'low';
  return 'healthy';
}

/** Computed per-product row for the Production Stock page. */
export interface ProductionStockRow extends ProductionStockFigures {
  productId: string;
  /**
   * The product's human-readable STK-###### — the same code the branch Stock page
   * shows, because it identifies the PRODUCT, not a branch's row. It is what the
   * Help Desk is given to raise a stock query, so the pool page has to show it or
   * a production user has nothing to quote.
   */
  stockCode: string;
  productName: string;
  categoryId: string | null;
  categoryName: string | null;
  status: ProductionStockStatus;
}

// ── Stock ledger ─────────────────────────────────────────────────────────────

/**
 * The transaction types the LEDGER VIEW reports (§13), which are not one-for-one
 * with the `production_stock_movement_type` values stored in Postgres.
 *
 * Three are SYNTHESISED rather than stored, and deliberately so:
 *
 *   · OPENING and CLOSING are derived figures (Σ delta before / up to the day),
 *     not movements. Storing them would be a second source of truth for a number
 *     the ledger already implies, and the first bug would be the two disagreeing —
 *     which is precisely the failure a ledger exists to prevent.
 *   · DEMAND_RESERVED is a claim, not a stock movement. Writing it into
 *     `production_stock_history` would double-count against the DEMAND_FULFILLED
 *     (`transfer_out`) row booked when the same goods are verified out.
 *
 * The stored types map:
 *   prepare → PREPARED · transfer_out → DEMAND_FULFILLED · return_in → RETURN
 *   return_transfer → RETURN_TRANSFER
 *   sale → SALE · adjustment → ADJUSTMENT_IN (delta > 0) / ADJUSTMENT_OUT (delta < 0)
 */
export type ProductionLedgerType =
  | 'OPENING'
  | 'PREPARED'
  | 'DEMAND_RESERVED'
  | 'DEMAND_FULFILLED'
  | 'SALE'
  | 'RETURN'
  | 'RETURN_TRANSFER'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'
  | 'CLOSING';

/** One row of the Stock Ledger. */
export interface ProductionStockLedgerRow {
  /** Row identity. The ledger uuid for a stored movement, a deterministic key otherwise. */
  id: string;
  /**
   * Human-readable transaction number, `STK-YYYYMMDD-NNNNNN`. Present on stored
   * movements; null on the synthesised OPENING / CLOSING / DEMAND_RESERVED rows,
   * which are arithmetic rather than transactions and must not be quotable as one.
   */
  transactionNo: string | null;
  createdAt: string; // ISO UTC
  businessDate: string;
  productId: string;
  productName: string;
  stockCode: string;
  transactionType: ProductionLedgerType;
  /** SIGNED, as the shelf sees it: + adds to the pool, − takes from it. */
  qty: number;
  branchId: string | null;
  branchName: string | null;
  productionOrderId: string | null;
  /** Demand number, order number, return id or ticket — whatever booked it. */
  referenceId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  remarks: string | null;
  /** Running pool balance after a stored movement. Null on synthesised rows. */
  balanceAfter: number | null;
}

/**
 * The shortfall payload behind an INSUFFICIENT_STOCK error (§8/§26).
 *
 * Carries the arithmetic rather than a sentence, so the API, the branch screen and
 * the Production review dialog can each phrase it their own way without any of
 * them recomputing it.
 */
export interface ProductionShortfall {
  productId: string;
  productName: string;
  requested: number;
  available: number;
  shortage: number;
}

/**
 * What happened to returned goods, independent of whether the return was accepted.
 *
 * Accepting a return and restocking it are two different decisions (§10). Expired
 * cake genuinely came back and the branch is genuinely credited for it — but it is
 * not stock, and treating every accepted return as saleable put it back on the
 * shelf for the counter and the next demand to draw against.
 *
 * Since migration 139 NO accepted return reaches production stock, whatever its
 * disposition: every one lands in Branch Return Stock. The disposition is now the
 * record of the goods' condition, which is what whoever later considers
 * transferring them into production needs to know.
 */
export type ProductionReturnDisposition = 'saleable' | 'damaged' | 'expired' | 'repaired';

export const RETURN_DISPOSITION_LABELS: Record<ProductionReturnDisposition, string> = {
  saleable: 'Saleable',
  damaged: 'Damaged',
  expired: 'Expired',
  // Came back damaged and Production repaired it (migration 20261018000001).
  // Read by the Production Dashboard's Repaired Stock section.
  repaired: 'Repaired',
};

// ── Branch Return Stock ──────────────────────────────────────────────────────

/**
 * Movements on the Branch Return Stock ledger (`return_stock_history`).
 *
 * There are exactly two, and no write-off: Return Stock goes up when a return is
 * accepted and down only by an explicit transfer into production.
 */
export type ReturnStockMovementType =
  | 'return_in' // accepted branch return → return stock +
  | 'transfer_out'; // explicit transfer to production → return stock −

/**
 * One product's Branch Return Stock for a business day.
 *
 * A SEPARATE inventory from `ProductionStockRow`. The two are never summed: a
 * figure here is not production stock until `transferredToday` says somebody
 * moved it.
 *
 *     balance = opening + returnedToday − transferredToday
 */
export interface ReturnStockRow {
  productId: string;
  stockCode: string;
  productName: string;
  categoryId: string | null;
  categoryName: string | null;
  /** Σ delta before the day. */
  opening: number;
  /** Σ return_in on the day — returns accepted from branches. */
  returnedToday: number;
  /** Σ −transfer_out on the day, reported positive — moved into production stock. */
  transferredToday: number;
  /** Return Stock on hand at the end of the day. */
  balance: number;
}

/** One row of the Branch Return Stock ledger. */
export interface ReturnStockMovementRow {
  id: string;
  createdAt: string; // ISO UTC
  businessDate: string;
  productId: string;
  productName: string;
  type: ReturnStockMovementType;
  /** SIGNED: + came back from a branch, − transferred to production. */
  qty: number;
  balanceAfter: number;
  branchId: string | null;
  branchName: string | null;
  /** The return that booked it; null on a transfer. */
  productionReturnId: string | null;
  referenceId: string;
  createdByName: string | null;
  reason: string | null;
}

// ── Product Returns ──────────────────────────────────────────────────────────

/**
 * Where a return sits in Production's review.
 *
 * Two of the four are terminal and two are open:
 *
 * - `pending`  — awaiting Production. The units have already left the branch
 *                balance (a branch return moves them as it is saved) but the
 *                Branch Return Stock has NOT been credited yet.
 * - `returned` — Production handed it back to the branch to correct. Same stock
 *                position as `pending`, moves nothing on its own; the branch
 *                fixes the figure and resubmits, which returns it to `pending`.
 * - `accepted` — Production took it. Branch Return Stock is credited, NOT
 *                production stock. Final.
 * - `rejected` — Production refused it. The units go back onto the branch
 *                balance. Final.
 *
 * `pending` and `returned` are the ONLY states in which a branch may change or
 * delete its own return; both terminal states are locked to it. That rule lives
 * in `branch-returns.service.ts` on the server, and the Return Stock page's
 * `isCorrectable` is its client-side mirror deciding which buttons render.
 */
export type ProductionReturnStatus = 'pending' | 'accepted' | 'rejected' | 'returned';

export interface ProductionReturn {
  id: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  status: ProductionReturnStatus;
  /**
   * Which side raised it: 'branch' for the branch-initiated path
   * (POST /api/stock/return), null when Production recorded it
   * (POST /api/production-returns). Both now start `pending`; what differs is
   * which stock has already moved by then, and the review has to know:
   *
   * - `'branch'` — the units are already OFF the branch balance and are waiting
   *   on Production, so accepting only credits Branch Return Stock and rejecting only puts
   *   them back on the branch.
   * - `null` — nothing has moved at all; it is Production's note that goods
   *   arrived, so accepting does BOTH movements and rejecting does none.
   *
   * It also decides who may change the record. Branch → Return Stock offers
   * Change, Delete and Resubmit on its own `'branch'` rows only; a
   * Production-recorded return is Production's account of what it received and
   * is corrected on their screen — which is also why Send Back is offered on
   * `'branch'` rows alone, there being no branch paperwork to hand back
   * otherwise. The server enforces both rules in `branch-returns.service.ts` and
   * `production-returns.routes.ts`, so this is the client knowing why a button
   * is absent, not the rule itself.
   */
  source: 'branch' | null;
  date: string; // 'YYYY-MM-DD' (Karachi)
  createdBy: string;
  createdByName: string;
  createdAt: string; // ISO UTC
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  /**
   * The photo taken when the branch raised the return, or null — returns older
   * than migration 148, and ones Production recorded itself, have none. Every
   * product row of one submission carries the SAME photo.
   *
   * `photo.url` is a signed URL with an hour to live (see Attachment); it is
   * re-minted on every read, so key any client-side cache on `photo.id`.
   */
  photo?: Attachment | null;
  /** The product's SKU at read time, or null where none is set. */
  productCode?: string | null;
  /**
   * Rs. per unit — the product's price in force on `date`, from the price
   * history (a return row stores no price of its own). Null when no price
   * exists anywhere. Same rule as the monthly summary's amounts.
   */
  unitPrice?: number | null;
  /** qty × unitPrice, rounded to the paisa; null exactly when unitPrice is. */
  amount?: number | null;
}
