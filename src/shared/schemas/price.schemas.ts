import { z } from 'zod';

// Effective date is a business date string 'YYYY-MM-DD'. Past/today → applied
// immediately; a future date is scheduled for activation on that business day.
const effectiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Effective date must be YYYY-MM-DD');

export const ChangePriceSchema = z.object({
  newPrice: z.number().positive('Price must be positive'),
  effectiveDate,
  reason: z.string().min(1, 'Reason is required').max(500),
});

export const ImportCommitSchema = z.object({
  rows: z
    .array(
      z.object({
        productId: z.string().min(1),
        newPrice: z.number().positive(),
      }),
    )
    .min(1, 'No rows to import'),
  effectiveDate,
  reason: z.string().min(1, 'Reason is required').max(500),
});

export type ChangePriceInput = z.infer<typeof ChangePriceSchema>;
export type ImportCommitInput = z.infer<typeof ImportCommitSchema>;
