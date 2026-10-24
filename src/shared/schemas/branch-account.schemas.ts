import { z } from 'zod';

/**
 * Demand Record (branch account) request schemas. See
 * shared/utils/branch-account.ts for what the figures mean.
 *
 * Money here is SIGNED, unlike the rest of Finance: a positive amount raises
 * what the branch owes the company, a negative one is a credit. Zero is
 * refused for the reason finance.schemas.ts gives — an entry that moves nothing
 * only pads the audit trail.
 */

const businessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const reason = z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500);

/** A client-generated id for this submission; sending it again is a no-op. */
const requestId = z.string().uuid('requestId must be a UUID');

export const BranchAccountStartSchema = z.object({
  startDate: businessDate,
});

export const PostBranchAccountAdjustmentSchema = z.object({
  requestId,
  branchId: z.string().uuid(),
  kind: z.enum(['opening', 'adjustment']),
  amount: z
    .number()
    .finite()
    .refine((v) => v !== 0, 'Amount cannot be zero')
    .refine((v) => Math.abs(v) <= 100_000_000, 'Amount is too large')
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, 'Amount can have at most 2 decimal places'),
  /** Adjustments only; an opening balance always sits on the go-live day. */
  businessDate: businessDate.optional(),
  reason,
});

export const ReverseBranchAccountAdjustmentSchema = z.object({
  requestId,
  reason,
});

export type BranchAccountStartInput = z.infer<typeof BranchAccountStartSchema>;
export type PostBranchAccountAdjustmentInput = z.infer<typeof PostBranchAccountAdjustmentSchema>;
export type ReverseBranchAccountAdjustmentInput = z.infer<typeof ReverseBranchAccountAdjustmentSchema>;
