import { z } from 'zod';
import {
  DELIVERY_PROVIDERS,
  PURCHASE_PAYMENT_PREFERENCES,
  PURCHASE_PRIORITIES,
  PURCHASE_UNITS,
  SUPPLIER_PAYMENT_METHODS,
} from '../types/purchasing.types';

// ── WhatsApp Purchasing ──────────────────────────────────────────────────────
//
// Shapes only. Status, numbers, totals, approvers and the supplier's identity
// on a demand are the server's: none of them is accepted from a client. The
// database functions re-check every rule here; these exist to give a form a
// field-level message before the round trip.

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

const money = z
  .number({ message: 'Enter a valid amount' })
  .min(0, 'Amount cannot be negative')
  .max(100_000_000, 'That amount looks wrong — check the figure')
  .multipleOf(0.01, 'Amount can have at most 2 decimal places');

const positiveMoney = money.refine((n) => n > 0, 'Enter an amount above zero');

const quantity = z
  .number({ message: 'Enter a valid quantity' })
  .min(0, 'Quantity cannot be negative')
  .max(1_000_000, 'That quantity looks wrong — check the figure')
  .multipleOf(0.001, 'Quantity can have at most 3 decimal places');

const text = (max: number) => z.string().trim().max(max, `At most ${max} characters`);
const optionalText = (max: number) => text(max).optional().nullable();

/** A client-minted id that makes a retried create return the first result. */
const clientRequestId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,100}$/, 'Invalid request id')
  .optional();

// ── Suppliers and items ──────────────────────────────────────────────────────

export const SupplierInputSchema = z.object({
  name: text(120).min(1, 'Enter the supplier name'),
  contactPerson: optionalText(120),
  /** Any local or international shape; the server stores E.164. */
  whatsappNumber: text(30).min(7, 'Enter the WhatsApp number'),
  phone: optionalText(30),
  category: optionalText(60),
  address: optionalText(300),
  paymentTerms: optionalText(200),
  notes: optionalText(500),
  isActive: z.boolean().optional(),
  /** WhatsApp requires the supplier's consent before Mountain Bakes messages them. */
  whatsappOptIn: z.boolean().optional(),
  whatsappOptInSource: optionalText(200),
});
export type SupplierInput = z.infer<typeof SupplierInputSchema>;

export const PurchaseItemInputSchema = z.object({
  name: text(120).min(1, 'Enter the item name'),
  unit: z.enum(PURCHASE_UNITS),
  category: optionalText(60),
  isActive: z.boolean().optional(),
});
export type PurchaseItemInput = z.infer<typeof PurchaseItemInputSchema>;

export const IngredientAdjustSchema = z.object({
  itemId: z.string().uuid(),
  delta: z
    .number()
    .multipleOf(0.001, 'Quantity can have at most 3 decimal places')
    .refine((n) => n !== 0 && Math.abs(n) <= 1_000_000, 'Enter the quantity to add (+) or remove (−)'),
  reason: text(300).min(3, 'Give a reason'),
});

// ── Demand ───────────────────────────────────────────────────────────────────

export const DemandItemInputSchema = z.object({
  itemId: z.string().uuid().optional().nullable(),
  itemName: text(120).min(1, 'Enter the item name'),
  itemCode: optionalText(40),
  requestedQty: quantity.refine((n) => n > 0, 'Enter a quantity above zero'),
  unit: z.enum(PURCHASE_UNITS, { message: 'Choose a unit' }),
  note: optionalText(300),
});

export const DemandInputSchema = z
  .object({
    supplierId: z.string().uuid({ message: 'Choose a supplier' }),
    priority: z.enum(PURCHASE_PRIORITIES),
    requiredDate: isoDate,
    notes: optionalText(1000),
    deliveryInstructions: optionalText(1000),
    paymentPreference: z.enum(PURCHASE_PAYMENT_PREFERENCES).default('cash'),
    creditReference: optionalText(100),
    creditAmountRequested: money.optional().nullable(),
    creditTerms: optionalText(300),
    creditDueDate: isoDate.optional().nullable(),
    creditNotes: optionalText(500),
    items: z.array(DemandItemInputSchema).min(1, 'Add at least one item').max(100, 'At most 100 items'),
    clientRequestId,
  })
  .superRefine((d, ctx) => {
    if (d.paymentPreference === 'credit' && !(d.creditAmountRequested && d.creditAmountRequested > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['creditAmountRequested'], message: 'Enter the credit amount requested' });
    }
  });
export type DemandInput = z.infer<typeof DemandInputSchema>;

export const DemandUpdateSchema = z.intersection(
  DemandInputSchema,
  z.object({ revision: z.number().int().positive() }),
);

export const RevisionSchema = z.object({ revision: z.number().int().positive() });

export const ReasonSchema = z.object({ reason: text(1000).min(3, 'Give a reason') });

export const NoteSchema = z.object({ note: text(1000).min(1, 'Write a note') });

// ── Quotation ────────────────────────────────────────────────────────────────

export const QuotationItemInputSchema = z
  .object({
    demandItemId: z.string().uuid().optional().nullable(),
    substituteForDemandItemId: z.string().uuid().optional().nullable(),
    itemName: text(120).min(1, 'Enter the item name'),
    unit: z.enum(PURCHASE_UNITS).optional(),
    availableQty: quantity,
    unitRate: money,
    availability: z.enum(['available', 'partial', 'unavailable', 'substitute']),
    note: optionalText(300),
  })
  .superRefine((l, ctx) => {
    if (l.availability === 'unavailable' && l.availableQty !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['availableQty'], message: 'An unavailable item has quantity 0' });
    }
    if (l.availability !== 'unavailable' && l.availableQty <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['availableQty'], message: 'Enter the quantity available' });
    }
    if (l.availability === 'substitute' && l.demandItemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['availability'], message: 'A substitute is a new line' });
    }
    if (l.availability !== 'substitute' && !l.demandItemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['demandItemId'], message: 'Choose which requested item this is' });
    }
  });

export const QuotationInputSchema = z.object({
  items: z.array(QuotationItemInputSchema).min(1, 'Add at least one line').max(150),
  deliveryCharge: money.default(0),
  estimatedDeliveryDate: isoDate.optional().nullable(),
  deliveryNotes: optionalText(500),
  notes: optionalText(1000),
  clientRequestId,
});
export type QuotationInput = z.infer<typeof QuotationInputSchema>;

export const QuotationDecisionSchema = z
  .object({
    version: z.number().int().positive(),
    decision: z.enum(['approve', 'request_changes', 'reject']),
    reason: optionalText(1000),
  })
  .superRefine((d, ctx) => {
    if (d.decision !== 'approve' && !(d.reason && d.reason.length >= 3)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Give a reason' });
    }
  });

// ── Bill ─────────────────────────────────────────────────────────────────────

export const BillInputSchema = z.object({
  supplierBillNo: text(60).min(1, 'Enter the bill number'),
  invoiceDate: isoDate,
  deliveryDate: isoDate.optional().nullable(),
  items: z
    .array(z.object({ quotationItemId: z.string().uuid(), qty: quantity.refine((n) => n > 0, 'Enter a quantity above zero'), unitRate: money }))
    .min(1, 'A bill needs at least one line')
    .max(150),
  deliveryCharge: money.default(0),
  discount: money.default(0),
  otherCharges: money.default(0),
  otherChargesNote: optionalText(300),
  supplierPaymentMethod: optionalText(60),
  supplierStatedPaid: money.default(0),
  notes: optionalText(1000),
  clientRequestId,
});
export type BillInput = z.infer<typeof BillInputSchema>;

export const BillDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    acceptDifferences: z.boolean().optional(),
    reason: optionalText(1000),
  })
  .superRefine((d, ctx) => {
    if (d.decision === 'reject' && !(d.reason && d.reason.length >= 3)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Give a reason' });
    }
  });

// ── Delivery, receipt ────────────────────────────────────────────────────────

export const DeliveryInputSchema = z
  .object({
    provider: z.enum(DELIVERY_PROVIDERS),
    providerName: optionalText(80),
    bookingReference: optionalText(80),
    estimatedFee: money.optional().nullable(),
    actualFee: money.optional().nullable(),
    feePaidBy: z.enum(['mountain_bakes', 'supplier']).default('mountain_bakes'),
    pickupDetails: optionalText(500),
    deliveryNotes: optionalText(500),
    status: z.enum(['booked', 'dispatched', 'delivered']).default('booked'),
    receivedByName: optionalText(120),
  })
  .superRefine((d, ctx) => {
    if (d.provider === 'other' && !d.providerName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providerName'], message: 'Name the service' });
    }
    if (d.status === 'delivered' && !d.receivedByName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['receivedByName'], message: 'Enter who received it' });
    }
  });

export const ReceiptInputSchema = z.object({
  items: z
    .array(
      z
        .object({
          billItemId: z.string().uuid(),
          itemId: z.string().uuid({ message: 'Choose the stock item' }),
          receivedQty: quantity,
          damagedQty: quantity.default(0),
          note: optionalText(300),
        })
        .refine((l) => l.damagedQty <= l.receivedQty, { path: ['damagedQty'], message: 'Damaged cannot exceed received' }),
    )
    .max(150),
  /** Close the receipt even though some billed quantity never arrived. */
  final: z.boolean().default(false),
  notes: optionalText(1000),
  businessDate: isoDate.optional(),
  clientRequestId,
});

// ── Payments and credit ──────────────────────────────────────────────────────

export const PaymentInputSchema = z
  .object({
    method: z.enum(SUPPLIER_PAYMENT_METHODS),
    amount: positiveMoney,
    referenceNo: optionalText(80),
    paidOn: isoDate,
    notes: optionalText(500),
    creditId: z.string().uuid().optional().nullable(),
    clientRequestId,
  })
  .superRefine((p, ctx) => {
    if (p.method !== 'cash' && !p.referenceNo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceNo'], message: 'Enter the transaction reference' });
    }
  });

export const CreditInputSchema = z.object({
  amount: positiveMoney,
  terms: optionalText(300),
  dueDate: isoDate.optional().nullable(),
  reference: optionalText(80),
  notes: optionalText(500),
});

export const PaymentApproveSchema = z.object({ ledgerHeadId: z.string().uuid().optional().nullable() });

export const CreditDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    approvedAmount: positiveMoney.optional().nullable(),
    reason: optionalText(500),
  })
  .superRefine((d, ctx) => {
    if (d.decision === 'reject' && !(d.reason && d.reason.length >= 3)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Give a reason' });
    }
  });

// ── Messages ─────────────────────────────────────────────────────────────────

export const MessageReplySchema = z.object({
  body: text(1000).min(1, 'Write a message'),
  demandId: z.string().uuid().optional().nullable(),
  clientRequestId,
});

export const MessageReviewSchema = z
  .object({
    action: z.enum(['assign', 'dismiss']),
    supplierId: z.string().uuid().optional().nullable(),
    demandId: z.string().uuid().optional().nullable(),
  })
  .superRefine((d, ctx) => {
    if (d.action === 'assign' && !d.supplierId && !d.demandId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['demandId'], message: 'Choose a supplier or a demand' });
    }
  });
