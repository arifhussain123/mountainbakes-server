import { z } from 'zod';
import { optionalBusinessDate } from './business-date.schemas';

// ── Today's Prepared Products ────────────────────────────────────────────────
export const PrepareProductionItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
});

export const PrepareProductionSchema = z.object({
  items: z.array(PrepareProductionItemSchema).min(1, 'At least one product is required'),
});

// ── Stock Adjustments (recorded by Production) ───────────────────────────────
//
// The authorised way to move the pool by hand. It is NOT "edit the balance": the
// caller states a signed quantity and a reason, and the server appends ONE
// movement of that size. There is no field here that assigns a balance, by design
// — §38 of the spec, and the same rule the branch ledger already follows.
//
// A REASON IS MANDATORY. An adjustment with no stated cause is indistinguishable
// from someone typing over an inconvenient number, and the audit trail exists
// precisely so that cannot happen. The RPC re-checks it server-side rather than
// trusting this schema alone.
export const PRODUCTION_ADJUSTMENT_TYPES = [
  'damage',
  'expired',
  'count_correction',
  'production_correction',
  'data_correction',
  'other',
] as const;

export type ProductionAdjustmentType = (typeof PRODUCTION_ADJUSTMENT_TYPES)[number];

/** Human labels, so the popup and the audit note read the same words. */
export const PRODUCTION_ADJUSTMENT_LABELS: Record<ProductionAdjustmentType, string> = {
  damage: 'Damage',
  expired: 'Expired product',
  count_correction: 'Counting correction',
  production_correction: 'Production correction',
  data_correction: 'Data correction',
  other: 'Other authorised adjustment',
};

export const CreateProductionAdjustmentSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  adjustmentType: z.enum(PRODUCTION_ADJUSTMENT_TYPES),
  /**
   * SIGNED and non-zero. Positive adds to the pool (ADJUSTMENT_IN), negative takes
   * from it (ADJUSTMENT_OUT). Zero is refused rather than silently ignored: it is
   * always a mistake, and accepting it would write an audit row that says nothing
   * happened.
   */
  qty: z.number().int().refine((n) => n !== 0, 'Quantity must not be zero'),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
  remarks: z.string().trim().max(1000).optional(),
  approvedBy: z.string().trim().max(200).optional(),
});

// ── Stock Movement History query ─────────────────────────────────────────────
// Every filter is optional and every one is applied SERVER-side. The ledger grows
// without bound, so the page must never be the thing deciding what to show from a
// full download.
export const ProductionMovementQuerySchema = z.object({
  from: optionalBusinessDate,
  to: optionalBusinessDate,
  productId: z.string().optional(),
  categoryId: z.string().optional(),
  branchId: z.string().optional(),
  movementType: z.string().optional(),
  status: z.enum(['posted', 'reserved']).optional(),
  /** Debounced free text: product name/code, branch, demand number, movement id. */
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** An unrecognized key falls back to the service's default column — see its own allowlist. */
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

// ── Product Returns (recorded by Production) ─────────────────────────────────
// branchId + productId identify what came back; names are resolved server-side.
export const CreateProductionReturnSchema = z.object({
  branchId: z.string().min(1, 'Branch is required'),
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  reason: z.string().min(1, 'Reason is required').max(500),
});

// The three decisions Production can take on a pending return. 'returned' hands
// the paperwork back to the branch to correct and is NOT terminal — it moves no
// stock and the branch resubmits from it. It is only valid on a branch-raised
// return; the route refuses it on a Production-recorded one, where there is no
// branch record to hand back.
export const ReviewProductionReturnSchema = z
  .object({
    status: z.enum(['accepted', 'rejected', 'returned']),
    /**
     * What happens to the goods. Only meaningful when accepting — a rejected or
     * sent-back return moves no production stock at all, so it has no disposition
     * to record.
     *
     * Defaults to 'saleable', which is what every accept did before this existed.
     */
    disposition: z.enum(['saleable', 'damaged', 'expired', 'repaired']).optional(),
    dispositionNote: z.string().trim().max(500).optional(),
  })
  .refine((r) => r.status === 'accepted' || !r.disposition || r.disposition === 'saleable', {
    message: 'Only an accepted return can be marked damaged, expired or repaired — reject it instead.',
    path: ['disposition'],
  })
  // A repair is not a write-off: the goods are fit to sell again, so it needs
  // no note any more than 'saleable' does.
  .refine((r) => r.disposition === undefined || r.disposition === 'saleable' || r.disposition === 'repaired' || !!r.dispositionNote, {
    // Writing stock off is the one outcome here that destroys value, so it is the
    // one that has to say why — the same rule adjustments follow.
    message: 'Say why the stock is damaged or expired.',
    path: ['dispositionNote'],
  });

// ── Branch Return Stock → Production Stock transfer ──────────────────────────
// The ONLY way returned units become production stock. Always explicit, always
// with a reason; the server refuses more than Return Stock holds.
export const TransferReturnStockSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().positive('Quantity must be greater than zero'),
  reason: z.string().trim().min(1, 'Reason is required').max(500),
});

// ── Branch-initiated Returns (from the branch Stock page) ────────────────────
// The branch returns unsold/damaged stock straight to production. branchId is
// derived server-side from the caller; reason is optional here (the Production
// flow above requires it).
//
// REVIEWED, NOT AUTO-APPROVED. This used to insert already 'accepted' with both
// stock movements applied before the response was written. It now inserts
// 'pending': the units come off the branch balance immediately (they have
// physically left the shop) but Branch Return Stock is credited only when
// Production approves. Production stock is never credited by a return.
//
// One submission carries MANY products — a branch closing out an evening hands
// back everything unsold at once. `reason` is shared across the whole return
// (an end-of-day batch has one reason) and is copied onto each product's record.
export const BranchReturnItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
});

export const CreateBranchReturnSchema = z.object({
  items: z
    .array(BranchReturnItemSchema)
    .min(1, 'Add at least one product to return')
    .superRefine((items, ctx) => {
      // One row per product, and this is a correctness guard rather than tidiness:
      // the balance check is per row, so two rows for the same product each pass
      // on their own but overdraw together — "Vanilla Cake 5" twice against a
      // balance of 6 takes 10. This is the only input that can drive a branch
      // negative through rows that are each individually valid.
      const seen = new Set<string>();
      items.forEach((it, i) => {
        if (seen.has(it.productId)) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'productId'],
            message: 'This product is already on the return',
          });
        }
        seen.add(it.productId);
      });
    }),
  reason: z.string().max(500).optional().default(''),
  // The return photo, uploaded first to POST /api/attachments (entity
  // `branch_return`). One per return, not one per product.
  //
  // Optional HERE and required by the ROUTE (unless RETURN_PHOTO_REQUIRED=false).
  // The schema cannot be the gate: a till that queued a return offline before
  // this field existed would have it refused as malformed, with no way to edit
  // the queued payload. The route's refusal names the photo instead, and the
  // switch lets the API be deployed ahead of the clients that send one.
  attachmentIds: z.array(z.string().uuid()).max(1, 'Only one photo per return').optional().default([]),
  // Sent by the mobile app only; see business-date.schemas.ts.
  businessDate: optionalBusinessDate,
});

// ── Correcting a branch-initiated return (Branch → Return Stock) ─────────────
// Only valid while the return is still open — 'pending' or 'returned'. Once
// Production has accepted or rejected it the record is final and the server
// refuses this with a 409; the client hides the button for the same reason.
//
// Even open, this is NOT a draft edit: the branch half of the movement has
// already happened (the units came off the balance as the return was saved), so
// this is a request to move the DIFFERENCE. `qty` is the return's new total, not
// a delta — the client shows the figure that is on the record and the server
// works out which way stock has to go, which is the only reading that stays
// right if two corrections race.
//
// `reason` is optional and, unlike the Production-recorded flow, may be blank —
// it mirrors CreateBranchReturnSchema above, where an end-of-day batch carries
// one shared reason and often none at all.
export const ReviseBranchReturnSchema = z.object({
  qty: z.number().int().positive('Quantity must be at least 1'),
  reason: z.string().max(500).optional(),
});

export type PrepareProductionInput = z.infer<typeof PrepareProductionSchema>;
export type CreateProductionReturnInput = z.infer<typeof CreateProductionReturnSchema>;
export type ReviewProductionReturnInput = z.infer<typeof ReviewProductionReturnSchema>;
export type TransferReturnStockInput = z.infer<typeof TransferReturnStockSchema>;
export type CreateBranchReturnInput = z.infer<typeof CreateBranchReturnSchema>;
export type ReviseBranchReturnInput = z.infer<typeof ReviseBranchReturnSchema>;
