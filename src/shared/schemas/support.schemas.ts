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

/**
 * Support Center → admin edits a sale's line items (change product / qty / unit
 * price, add or remove a line). Applied live and atomically via edit_sale_items:
 * order_items are replaced, order totals recomputed, and stock reconciled with a
 * compensating movement. `unitPrice` is the per-unit "amount" the admin sets.
 */
export const SaleItemEditSchema = z.object({
  productId: z.string().uuid().nullable(),
  productName: z.string().trim().min(1, 'Product is required').max(200),
  categoryId: z.string().uuid().nullable().optional(),
  categoryName: z.string().max(200).nullable().optional(),
  unitPrice: z.number().nonnegative('Amount cannot be negative'),
  qty: z.number().positive('Quantity must be greater than 0'),
  discount: z.number().min(0).optional().default(0),
});
export type SaleItemEditInput = z.infer<typeof SaleItemEditSchema>;

export const EditSaleItemsSchema = z.object({
  items: z.array(SaleItemEditSchema).min(1, 'A sale must have at least one item'),
  note: z.string().trim().max(2000).optional().default(''),
});
export type EditSaleItemsInput = z.infer<typeof EditSaleItemsSchema>;
