import { z } from 'zod';
import { optionalBusinessDate } from './business-date.schemas';

// ── Branch Discount requests ─────────────────────────────────────────────────
//
// A branch claims money back against a demand it raised. `branchId` is NEVER in
// any schema here: it is derived server-side from the caller's JWT, the same rule
// CreateBranchReturnSchema follows. A branch that could name its own branch could
// name someone else's.

/**
 * Money, to two decimal places, positive.
 *
 * `.multipleOf(0.01)` rather than an integer: a discount is currency and 250.50
 * is a real claim, but 250.505 is a typo the database column (numeric(14,2))
 * would silently round — refusing it here is the difference between the branch
 * fixing a digit and the record quietly disagreeing with what was typed.
 *
 * The upper bound is a fat-finger guard, not a policy limit. Nothing about the
 * business caps a discount; what this catches is the missing decimal point that
 * turns 500 into 50000000 on a screen where the branch is typing quickly.
 */
const discountAmount = z
  .number()
  .positive('Amount must be more than 0')
  .max(10_000_000, 'That amount looks wrong — check the figure')
  .multipleOf(0.01, 'Amount can have at most 2 decimal places');

/**
 * A reason is MANDATORY, and unlike a branch return's it may not be blank.
 *
 * An end-of-day return is self-explanatory — the goods are in the crate — which
 * is why CreateBranchReturnSchema lets its reason default to ''. A sum of money
 * is not: "the branch is owed 500" with no cause is not something Production can
 * approve or refuse, only guess at. The one field that makes the claim reviewable
 * is the one field that cannot be empty.
 */
const discountReason = z.string().trim().min(3, 'Say what the discount is for').max(500);

export const CreateBranchDiscountSchema = z.object({
  productionOrderId: z.string().min(1, 'Pick the demand this discount is against'),
  amount: discountAmount,
  reason: discountReason,
  // Sent by the mobile app only; see business-date.schemas.ts.
  businessDate: optionalBusinessDate,
});

/**
 * Correcting a claim the branch still owns — 'pending' or 'returned' only.
 *
 * Unlike ReviseBranchReturnSchema, this really is a draft edit: no stock moved
 * when the claim was raised, so there is no difference to settle and no direction
 * for the server to work out. The new amount simply replaces the old one.
 *
 * The demand is deliberately absent. Re-pointing a claim at a different delivery
 * is not a correction of this claim — it is a different claim, and Production may
 * already have looked at this one. Withdraw and raise it again.
 */
export const ReviseBranchDiscountSchema = z.object({
  amount: discountAmount,
  reason: discountReason,
});

/**
 * The three decisions Production can take on a pending claim.
 *
 * 'returned' hands it back to the branch to correct and is NOT terminal — it is
 * the one outcome the branch can act on afterwards, and it is why `reviewNote` is
 * required for it: "Sent Back" with no note asks the branch to fix something
 * without saying what, which is how a claim bounces twice.
 *
 * A rejection may carry a note and does not have to. It is final either way and
 * there is nothing for the branch to do with it, so a mandatory note there would
 * be a box to fill rather than a message to send — but a rejection over money is
 * exactly where one is worth writing, so the field stays offered.
 */
/**
 * Production correcting a pending claim's amount (PUT
 * /api/production-discounts/:id/amount). Same limits as the branch's own figure.
 */
export const ProductionDiscountAmountSchema = z.object({
  amount: discountAmount,
});

export const ReviewBranchDiscountSchema = z
  .object({
    status: z.enum(['approved', 'rejected', 'returned']),
    reviewNote: z.string().trim().max(500).optional(),
  })
  .refine((r) => r.status !== 'returned' || !!r.reviewNote, {
    message: 'Say what the branch needs to correct.',
    path: ['reviewNote'],
  });

export type CreateBranchDiscountInput = z.infer<typeof CreateBranchDiscountSchema>;
export type ReviseBranchDiscountInput = z.infer<typeof ReviseBranchDiscountSchema>;
export type ReviewBranchDiscountInput = z.infer<typeof ReviewBranchDiscountSchema>;
export type ProductionDiscountAmountInput = z.infer<typeof ProductionDiscountAmountSchema>;
