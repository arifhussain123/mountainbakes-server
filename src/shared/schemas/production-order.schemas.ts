import { z } from 'zod';
import { optionalAttachmentIds, requiredAttachmentIds } from './attachment.schemas';
import { optionalBusinessDate } from './business-date.schemas';

/**
 * 'YYYY-MM-DD', and a date that actually exists — `new Date('2026-02-31')` rolls
 * over to March rather than failing, so the round-trip back to a string is what
 * catches it. Kept as a plain string end to end: the column is a Postgres `date`
 * with no time component, and parsing it into a Date would drag the Karachi
 * offset into a value that has no time of day to offset.
 */
export const dateOnly = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

export const ProductionOrderItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  remarks: z.string().max(500).default(''),
});

/**
 * An optional packing-material line on the same demand. Quantity must be > 0 —
 * a zero-quantity request is just a row the branch forgot to remove.
 */
export const ProductionOrderPackingItemSchema = z.object({
  packingMaterialId: z.string().min(1, 'Packing material is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
});

// branchId is derived from the auth token server-side, never trusted from the client.
export const CreateProductionOrderSchema = z
  .object({
    // A demand may consist only of packing materials, so this is not `.min(1)`;
    // the superRefine below enforces the real rule — a demand must contain SOMETHING.
    items: z.array(ProductionOrderItemSchema).default([]),
    // Optional by design: most demands are products only, and an absent key must
    // behave exactly like the pre-packing-material payload.
    packingItems: z.array(ProductionOrderPackingItemSchema).default([]),
    /**
     * ALWAYS EMPTY. A Special Order is not a demand (migration 143): it is raised
     * through POST /api/special-orders and never becomes a demand line.
     *
     * The key is still accepted, empty, because the mobile app sends
     * `specialItems: []` on every demand and a stale web bundle sends it too. A
     * NON-empty list is refused rather than quietly dropped or quietly turned
     * into demand lines — the first loses what the branch asked for, the second
     * is the exact thing this rule exists to stop.
     */
    specialItems: z
      .array(z.unknown())
      .max(0, 'Special Order items are no longer sent with a demand. Refresh the app and submit them as a Special Order.')
      .default([]),
    /**
     * The date the branch needs this delivered by. REQUIRED — a demand with no
     * required date is the thing this field exists to stop.
     *
     * Note this TIGHTENS the contract, which the attachmentIds comment below
     * explains is the risky direction for a static-export PWA: a tab still
     * running the previous bundle omits the key and will 400 until it reloads.
     * That is accepted deliberately — the alternative is defaulting the date
     * server-side, which would file a made-up commitment under the branch's
     * name and is exactly the outcome being designed out. The update poller
     * reloads those tabs within a couple of minutes.
     *
     * Not bounded here. "Not in the past" is enforced on the form, against the
     * user's own clock; re-checking it server-side would turn ordinary
     * client/server clock skew at the day boundary into a rejected demand, and
     * a required date a day behind is a typo to read, not corrupt data.
     */
    requiredDate: dateOnly,
    /**
     * Photos of what the demand is for. OPTIONAL.
     *
     * This was briefly required (the photo was captured on the confirm step),
     * and is deliberately being relaxed rather than removed: demands raised
     * before this change still carry their photos and the read path still shows
     * them. Requiring a camera capture on every demand put a blocking step in
     * front of the most frequent action in the app, several times a day, for a
     * photo of a shelf that told Production nothing it could not see in the
     * quantities. The photo that actually matters is the VERIFICATION one — the
     * only independent record of a delivery that has already been unpacked —
     * and that one remains required.
     *
     * Relaxing a constraint is safe for the static-export PWA in a way that
     * tightening one is not: a tab still running the previous bundle sends a
     * photo, which is still accepted.
     */
    attachmentIds: optionalAttachmentIds,
    /**
     * The day the demand was RAISED, as captured on the device — distinct from
     * `requiredDate`, which is the day the branch wants it delivered. Sent by
     * the mobile app only; see business-date.schemas.ts.
     */
    businessDate: optionalBusinessDate,
  })
  .superRefine((val, ctx) => {
    // A demand has to ask for something.
    if (val.items.length === 0 && val.packingItems.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'At least one item is required',
      });
    }

    // One material, one quantity — a duplicate row is meaningless and would also
    // violate the unique constraint in migration 39. Caught here so the user gets a
    // field error instead of a database error.
    const seen = new Set<string>();
    val.packingItems.forEach((item, i) => {
      if (seen.has(item.packingMaterialId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packingItems', i, 'packingMaterialId'],
          message: 'This packing material is already on the demand',
        });
      }
      seen.add(item.packingMaterialId);
    });
  });

// Per-item approved quantity override, supplied when Production adjusts a demand
// before approving. Omitted items keep their requested quantity.
export const ApprovedItemSchema = z.object({
  productId: z.string().min(1),
  approvedQty: z.number().int().nonnegative('Approved quantity cannot be negative'),
});

/** Packing-material equivalent of ApprovedItemSchema. */
export const ApprovedPackingItemSchema = z.object({
  packingMaterialId: z.string().min(1),
  approvedQty: z.number().int().nonnegative('Approved quantity cannot be negative'),
});

// 'awaiting_verification' replaces the old 'approved' outcome here: Production's
// review still transfers stock immediately (unchanged), but the order only
// becomes 'approved' once the branch verifies what physically arrived.
//
// 'approved' is still ACCEPTED as a legacy alias and normalised to
// 'awaiting_verification' by the route. The web app is a static-export PWA, so a
// client that loaded the old bundle keeps sending 'approved' until it reloads —
// rejecting it here would 400 those users for as long as their tab stays open.
export const ReviewProductionOrderSchema = z.object({
  status: z.enum(['awaiting_verification', 'approved', 'rejected']),
  // Only meaningful when status is 'awaiting_verification' (or its 'approved' alias).
  approvedItems: z.array(ApprovedItemSchema).optional(),
  approvedPackingItems: z.array(ApprovedPackingItemSchema).optional(),
  reason: z.string().max(500).optional(),
});

/**
 * The branch deleting a demand it has just sent.
 *
 * The reason is REQUIRED, and that is the feature — Production is planning
 * against this demand the moment it lands, so a withdrawal that says nothing
 * leaves them with a hole in the summary and no way to find out what happened.
 * `.trim()` before `.min(3)` so a box of spaces cannot satisfy it.
 */
export const CancelProductionOrderSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Please give a reason for deleting this demand')
    .max(500, 'Reason is too long'),
});

/**
 * The branch editing its own demand while it is still 'pending' — before
 * Production submits it for verification.
 *
 * The WHOLE of the branch's side, not a patch: every product line it wants and
 * every packing line, with the quantity it wants now. A product or material left
 * out is removed; one not on the demand yet is added. Lines Production added
 * itself are not the branch's to change and are left as they are.
 */
export const EditProductionOrderSchema = z
  .object({
    items: z
      .array(z.object({
        productId: z.string().min(1, 'Product is required'),
        qty: z.number().int().positive('Quantity must be at least 1'),
      }))
      .default([]),
    packingItems: z.array(ProductionOrderPackingItemSchema).default([]),
  })
  .superRefine((val, ctx) => {
    if (val.items.length === 0 && val.packingItems.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'A demand needs at least one item — delete the demand instead',
      });
    }
    const products = new Set<string>();
    val.items.forEach((item, i) => {
      if (products.has(item.productId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', i, 'productId'], message: 'This product is already on the demand' });
      }
      products.add(item.productId);
    });
    const materials = new Set<string>();
    val.packingItems.forEach((item, i) => {
      if (materials.has(item.packingMaterialId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packingItems', i, 'packingMaterialId'],
          message: 'This packing material is already on the demand',
        });
      }
      materials.add(item.packingMaterialId);
    });
  });

/** Production adding an extra line to a still-'pending' order before submitting it. */
export const AddProductionOrderItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  remarks: z.string().max(500).default(''),
});

/** Production adding a packing material line to a still-'pending' order. */
export const AddProductionOrderPackingItemSchema = z.object({
  packingMaterialId: z.string().min(1, 'Packing material is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
});

// Per-item quantity the branch confirms it physically received, correcting for
// any shortage/overage against what Production recorded. Omitted items keep
// their approved quantity unchanged.
export const VerifiedItemSchema = z.object({
  productId: z.string().min(1),
  verifiedQty: z.number().nonnegative('Verified quantity cannot be negative'),
});

/** An item the branch found on arrival that wasn't on the original demand. */
export const NewVerifiedItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().positive('Quantity must be at least 1'),
});

export const VerifyProductionOrderSchema = z.object({
  verifiedItems: z.array(VerifiedItemSchema).default([]),
  newItems: z.array(NewVerifiedItemSchema).default([]),
  /**
   * Photo of what physically arrived, captured at the moment of counting.
   *
   * Verification is the step that MOVES STOCK (see the note on
   * BranchProductionOrderStatus), and it is the branch's own count that decides
   * how much. The photo is the only independent record Production gets of a
   * delivery it can no longer inspect — which is why this is required rather
   * than encouraged.
   */
  attachmentIds: requiredAttachmentIds,
});

export type CreateProductionOrderInput = z.infer<typeof CreateProductionOrderSchema>;
export type ReviewProductionOrderInput = z.infer<typeof ReviewProductionOrderSchema>;
export type CancelProductionOrderInput = z.infer<typeof CancelProductionOrderSchema>;
export type AddProductionOrderItemInput = z.infer<typeof AddProductionOrderItemSchema>;
export type VerifyProductionOrderInput = z.infer<typeof VerifyProductionOrderSchema>;
