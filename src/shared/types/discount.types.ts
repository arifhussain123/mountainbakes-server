// Branch discount requests: money a branch claims back against a production
// demand, reviewed by Production.
//
// Shaped after `production_returns` (see production-ops.types.ts) on purpose —
// Production reviews both on screens that read alike, with the same four states
// and the same three decisions. What differs is that a discount MOVES NO STOCK.
// A return debits the branch as it is raised and credits the pool on approval; a
// discount books nothing at any point. Approving one records that the claim was
// allowed, and that is the entire effect.

/**
 * Where a discount request sits in Production's review.
 *
 * Two of the four are terminal and two are open — the same split
 * `ProductionReturnStatus` has, and for the same reason:
 *
 * - `pending`  — waiting on Production. The branch may still correct the amount
 *                or withdraw the claim outright.
 * - `returned` — Production handed it back to be fixed. Still open, still the
 *                branch's to change; correcting and resubmitting returns it to
 *                `pending`.
 * - `approved` — allowed. Final.
 * - `rejected` — refused. Final.
 *
 * `pending` and `returned` are the ONLY states in which a branch may change or
 * withdraw its own claim. The server enforces that in branch-discounts.routes.ts;
 * `isDiscountOpen` below is the client-side mirror deciding which buttons render.
 *
 * Note 'approved', where returns say 'accepted'. The Returns screen already
 * labels 'accepted' as "Approved" for the operator, so this table spells it the
 * way it reads rather than carrying a word only the database uses.
 */
export type BranchDiscountStatus = 'pending' | 'approved' | 'rejected' | 'returned';

/**
 * Whether the branch may still act on its own claim.
 *
 * The single place that rule is written down on the client. Both open states
 * allow it: `returned` in particular is not a refusal but a request to correct,
 * and treating it as closed would strand a claim the branch was explicitly asked
 * to fix.
 */
export function isDiscountOpen(status: BranchDiscountStatus): boolean {
  return status === 'pending' || status === 'returned';
}

export interface BranchDiscount {
  id: string;
  branchId: string;
  branchName: string;
  /**
   * The demand the claim is about. Never null — a discount is a claim ABOUT a
   * delivery, and an amount with no demand behind it is not reviewable: there is
   * nothing for Production to check it against.
   */
  productionOrderId: string;
  /** Human-readable DMD-######, denormalised at insert so a board of thirty days
   *  across every branch does not join for a label. */
  demandNumber: string;
  /** Money, not units. Positive — a negative discount would be a charge. */
  amount: number;
  reason: string;
  status: BranchDiscountStatus;
  date: string; // 'YYYY-MM-DD' (Karachi) — the business day the claim was raised
  createdBy: string;
  createdByName: string;
  createdAt: string; // ISO UTC
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  /**
   * Why Production refused it or sent it back, in their words.
   *
   * Returns have no equivalent and the gap shows on that screen — a branch reads
   * "Sent Back" and has to guess what to correct. A claim about money says.
   */
  reviewNote: string | null;
  /**
   * The branch's own figure, set when Production corrected `amount` from its
   * Discount Detail popup; null while the amount is still the branch's.
   */
  originalAmount: number | null;
  /** Who at Production last changed the amount, and when. Null with originalAmount. */
  amountChangedByName: string | null;
  amountChangedAt: string | null; // ISO UTC
}

/**
 * One product's till discounts on one branch's business day — a row of the
 * Production → Discounts "Product breakdown" table.
 */
export interface DiscountDayProduct {
  /** Null for an order line whose product has since been deleted. */
  productId: string | null;
  productName: string;
  /** Units sold on discounted lines. */
  qty: number;
  /** Money taken off on this product that day. */
  discount: number;
}

/**
 * What the branch's till actually gave away on a day, per product, set against
 * what the branch claimed for that day. GET /api/production-discounts/day-check.
 *
 * `actualTotal` comes from the POS (order_items.discount on non-cancelled sales,
 * staff sales included — they can carry a discount too). `claimedTotal` is every
 * claim the branch raised for the day that still stands — rejected ones are left
 * out, since a refused claim asks for nothing.
 */
export interface DiscountDayCheck {
  branchId: string;
  date: string; // 'YYYY-MM-DD'
  products: DiscountDayProduct[];
  actualTotal: number;
  claimedTotal: number;
  /** claimedTotal − actualTotal. Positive = the branch claimed more than the till gave. */
  difference: number;
  matches: boolean;
  claims: { id: string; demandNumber: string | null; amount: number; status: BranchDiscountStatus }[];
}
