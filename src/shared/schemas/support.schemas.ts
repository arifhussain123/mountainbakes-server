import { z } from 'zod';

export const SUPPORT_REFERENCE_TYPES = ['sale', 'expense', 'stock'] as const;

/** Help Desk → raise a query against a reference ID with an issue message. */
export const CreateSupportTicketSchema = z.object({
  referenceId: z.string().trim().min(1, 'Reference ID is required').max(40),
  message: z.string().trim().min(3, 'Please describe the issue').max(2000),
});
export type CreateSupportTicketInput = z.infer<typeof CreateSupportTicketSchema>;

/** Support Center → admin edits the ticket text (message and/or internal note). */
export const EditSupportTicketSchema = z.object({
  message: z.string().trim().min(3).max(2000).optional(),
  resolutionNote: z.string().trim().max(2000).optional(),
});
export type EditSupportTicketInput = z.infer<typeof EditSupportTicketSchema>;

/** Support Center → admin resolves or rejects the query. */
export const ResolveSupportTicketSchema = z.object({
  status: z.enum(['resolved', 'rejected']),
  resolutionNote: z.string().trim().max(2000).optional().default(''),
});
export type ResolveSupportTicketInput = z.infer<typeof ResolveSupportTicketSchema>;

/**
 * Support Center → admin "Change figures". `edits` maps an editable field key to
 * its new value. Applied as a live mutation for expenses; for sale/stock the
 * requested figures are recorded on the ticket for manual follow-up.
 */
export const ChangeFiguresSchema = z.object({
  edits: z.record(z.string(), z.union([z.string(), z.number()])),
  note: z.string().trim().max(2000).optional().default(''),
});
export type ChangeFiguresInput = z.infer<typeof ChangeFiguresSchema>;
