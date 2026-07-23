import { z } from 'zod';

export const NOTIFICATION_CHANNELS = ['whatsapp', 'sms', 'both'] as const;
export const RECIPIENT_DEPARTMENTS = ['production', 'admin'] as const;

/**
 * Mobile numbers are stored in E.164 (+<country><number>) so a provider can dial
 * them without guessing a country. Local 03xx… numbers are rejected with a hint
 * rather than silently prefixed — guessing the country is how messages go to the
 * wrong person.
 */
const MobileNumber = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +923001234567');

/**
 * Exactly one of branchId / department identifies who a recipient is — a branch
 * recipient gets that branch's report; a department recipient is central
 * (production or admin). Mirrors the DB check constraint.
 */
const scopeRefinement = <T extends { branchId?: string | null; department?: string | null }>(v: T) =>
  Boolean(v.branchId) !== Boolean(v.department);
const SCOPE_MESSAGE = 'Set either a branch or a department, not both';

export const CreateRecipientSchema = z
  .object({
    branchId: z.string().uuid().nullable().optional(),
    department: z.enum(RECIPIENT_DEPARTMENTS).nullable().optional(),
    recipientName: z.string().trim().min(2, 'Name is required').max(120),
    mobileNumber: MobileNumber,
    channel: z.enum(NOTIFICATION_CHANNELS).default('whatsapp'),
    active: z.boolean().default(true),
  })
  .refine(scopeRefinement, { message: SCOPE_MESSAGE, path: ['branchId'] });
export type CreateRecipientInput = z.infer<typeof CreateRecipientSchema>;

/** Partial update; scope fields are only re-validated when both are supplied. */
export const UpdateRecipientSchema = z.object({
  recipientName: z.string().trim().min(2).max(120).optional(),
  mobileNumber: MobileNumber.optional(),
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  active: z.boolean().optional(),
});
export type UpdateRecipientInput = z.infer<typeof UpdateRecipientSchema>;

/**
 * Admin "run the closing summaries now" — generates reports for a business date
 * and sends them. Omit businessDate to use the day that just ended.
 */
export const DispatchClosingSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
  /** Re-send even to recipients already marked sent for this date. */
  resend: z.boolean().optional().default(false),
});
export type DispatchClosingInput = z.infer<typeof DispatchClosingSchema>;
