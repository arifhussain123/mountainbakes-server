import { z } from 'zod';

export const ProductionOrderItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  remarks: z.string().max(500).default(''),
});

// branchId is derived from the auth token server-side, never trusted from the client.
export const CreateProductionOrderSchema = z.object({
  items: z.array(ProductionOrderItemSchema).min(1, 'At least one item is required'),
});

// Per-item approved quantity override, supplied when Production adjusts a demand
// before approving. Omitted items keep their requested quantity.
export const ApprovedItemSchema = z.object({
  productId: z.string().min(1),
  approvedQty: z.number().int().nonnegative('Approved quantity cannot be negative'),
});

export const ReviewProductionOrderSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  // Only meaningful when status === 'approved'.
  approvedItems: z.array(ApprovedItemSchema).optional(),
  reason: z.string().max(500).optional(),
});

export type CreateProductionOrderInput = z.infer<typeof CreateProductionOrderSchema>;
export type ReviewProductionOrderInput = z.infer<typeof ReviewProductionOrderSchema>;
