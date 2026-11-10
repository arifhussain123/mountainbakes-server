import { z } from 'zod';
import { STORE_QUERY_STATUSES, STORE_QUERY_TYPES } from '../types/store.types';

// ── Dry Items Store ──────────────────────────────────────────────────────────
//
// Shapes only. Numbers, statuses, balances, costs and who did what are the
// server's. The database functions re-check every rule (free stock, FIFO,
// Price Control, whole units); these give a form a field-level message first.

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

const quantity = z
  .number({ message: 'Enter a valid quantity' })
  .gt(0, 'Enter a quantity above 0')
  .max(1_000_000, 'That quantity looks wrong — check the figure')
  .multipleOf(0.001, 'Quantity can have at most 3 decimal places');

const money = z
  .number({ message: 'Enter a valid amount' })
  .gt(0, 'Enter an amount above 0')
  .max(100_000_000, 'That amount looks wrong — check the figure')
  .multipleOf(0.01, 'Amount can have at most 2 decimal places');

const text = (max: number) => z.string().trim().max(max, `At most ${max} characters`);
const optionalText = (max: number) => text(max).optional().nullable();
const uuid = z.string().uuid('Invalid id');

/** Client-minted (crypto.randomUUID): a retried create returns the first result. */
const clientRequestId = z.string().uuid('Invalid request id').optional();

export const StoreItemInputSchema = z.object({
  itemCode: text(12).regex(/^[A-Za-z0-9-]{2,12}$/, 'Use 2–12 letters, numbers or dashes'),
  name: text(80).min(1, 'Enter the item name'),
  category: text(40).min(1, 'Select a category'),
  baseUnit: text(40).min(1, 'Select a base unit'),
  purchaseUnit: text(40).min(1, 'Select a purchase unit'),
  conversionQty: quantity,
  minStock: z.number({ message: 'Enter 0 or more' }).min(0, 'Enter 0 or more').max(1_000_000).multipleOf(0.001),
  remarks: optionalText(300),
  purchaseItemId: uuid.optional().nullable(),
});
export type StoreItemInput = z.infer<typeof StoreItemInputSchema>;

export const StoreItemStatusSchema = z.object({ active: z.boolean() });

export const StorePriceInputSchema = z.object({
  itemId: uuid,
  packageName: text(40).min(1, 'Select the purchase package'),
  packageQty: quantity,
  price: money,
  effectiveFrom: isoDate,
});
export type StorePriceInput = z.infer<typeof StorePriceInputSchema>;

export const StoreReceiptLineSchema = z.object({
  itemId: uuid,
  priceId: uuid,
  packages: z.number().int('Whole packages only').min(1, 'At least 1 package').max(100_000),
  overridePrice: money.optional().nullable(),
  overrideReason: optionalText(200),
  batchNo: optionalText(60),
  expiryDate: isoDate.optional().nullable(),
});

export const StoreReceiptInputSchema = z.object({
  receiptDate: isoDate,
  supplierId: uuid.optional().nullable(),
  supplierName: optionalText(120),
  invoiceNo: optionalText(60),
  remarks: optionalText(500),
  confirmDuplicate: z.boolean().optional(),
  clientRequestId,
  lines: z.array(StoreReceiptLineSchema).min(1, 'Add at least one item').max(100),
}).refine((v) => !!v.supplierId || !!v.supplierName?.trim(), { message: 'Select the supplier', path: ['supplierName'] });
export type StoreReceiptInput = z.infer<typeof StoreReceiptInputSchema>;

export const StoreAdjustInputSchema = z.object({
  itemId: uuid,
  direction: z.enum(['in', 'out']),
  qty: quantity,
  reason: text(40).min(1, 'Select a reason'),
  note: optionalText(300),
  businessDate: isoDate.optional(),
  clientRequestId,
});
export type StoreAdjustInput = z.infer<typeof StoreAdjustInputSchema>;

export const StoreDemandInputSchema = z.object({
  requiredDate: isoDate,
  remarks: optionalText(500),
  clientRequestId,
  lines: z
    .array(z.object({ itemId: uuid, qty: quantity, remarks: optionalText(200) }))
    .min(1, 'Add at least one item with a quantity')
    .max(60)
    .refine((ls) => new Set(ls.map((l) => l.itemId)).size === ls.length, 'An item appears twice'),
});
export type StoreDemandInput = z.infer<typeof StoreDemandInputSchema>;

export const StoreDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), qty: quantity.optional().nullable(), note: optionalText(300) }),
  z.object({ decision: z.literal('reject'), note: text(300).min(1, 'Give Production a reason') }),
  z.object({ decision: z.literal('undo') }),
]);
export type StoreDecisionInput = z.infer<typeof StoreDecisionSchema>;

export const StoreIssueInputSchema = z.object({
  demandId: uuid,
  receivedBy: text(80).min(1, 'Enter who in Production received the items'),
  remarks: optionalText(300),
  clientRequestId,
  /** Omit to issue everything approved; give lines to issue part of a line. */
  lines: z.array(z.object({ lineId: uuid, qty: quantity })).max(60).optional(),
});
export type StoreIssueInput = z.infer<typeof StoreIssueInputSchema>;

export const StoreConfirmIssueSchema = z.object({
  lines: z
    .array(z.object({ issueItemId: uuid, receivedQty: z.number().min(0).max(1_000_000).multipleOf(0.001) }))
    .max(60)
    .optional(),
  note: optionalText(300),
});
export type StoreConfirmIssueInput = z.infer<typeof StoreConfirmIssueSchema>;

export const StoreQueryInputSchema = z.object({
  subject: text(120).min(1, 'Enter a subject'),
  queryType: z.enum(STORE_QUERY_TYPES),
  description: text(2000).min(1, 'Describe the problem'),
  relatedReceiptNo: optionalText(30),
  relatedDemandNo: optionalText(30),
  relatedIssueNo: optionalText(30),
});
export type StoreQueryInput = z.infer<typeof StoreQueryInputSchema>;

export const StoreQueryMessageSchema = z.object({
  body: optionalText(2000),
  status: z.enum(STORE_QUERY_STATUSES).optional(),
}).refine((v) => !!v.body?.trim() || !!v.status, { message: 'Write a reply or change the status', path: ['body'] });
export type StoreQueryMessageInput = z.infer<typeof StoreQueryMessageSchema>;

export const StoreAccountFlagsSchema = z.object({
  canManageItems: z.boolean(),
  canEditPrices: z.boolean(),
  canAdjustStock: z.boolean(),
  canIssue: z.boolean(),
  notes: optionalText(300),
});
export type StoreAccountFlagsInput = z.infer<typeof StoreAccountFlagsSchema>;

export const StoreLookupInputSchema = z.object({
  kind: z.enum(['category', 'base_unit', 'purchase_unit', 'adjust_reason']),
  value: text(40).min(1, 'Enter a value'),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type StoreLookupInput = z.infer<typeof StoreLookupInputSchema>;

export const StoreSettingsSchema = z.object({
  name: text(80).min(1, 'Enter the store name'),
  openingDate: isoDate.optional().nullable(),
});
export type StoreSettingsInput = z.infer<typeof StoreSettingsSchema>;
