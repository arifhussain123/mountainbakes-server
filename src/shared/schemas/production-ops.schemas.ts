import { z } from 'zod';

// ── Today's Prepared Products ────────────────────────────────────────────────
export const PrepareProductionItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
});

export const PrepareProductionSchema = z.object({
  items: z.array(PrepareProductionItemSchema).min(1, 'At least one product is required'),
});

// ── Product Returns (recorded by Production) ─────────────────────────────────
// branchId + productId identify what came back; names are resolved server-side.
export const CreateProductionReturnSchema = z.object({
  branchId: z.string().min(1, 'Branch is required'),
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  reason: z.string().min(1, 'Reason is required').max(500),
});

export const ReviewProductionReturnSchema = z.object({
  status: z.enum(['accepted', 'rejected']),
});

// ── Branch-initiated Returns (from the branch Stock page) ────────────────────
// The branch returns unsold/damaged stock straight to production. branchId is
// derived server-side from the caller; reason is optional here (the Production
// flow above requires it). Applied immediately, no review step.
export const CreateBranchReturnSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  reason: z.string().max(500).optional().default(''),
});

// ── Production Expenses ──────────────────────────────────────────────────────
export const PRODUCTION_EXPENSE_PAYMENT_METHODS = ['cash', 'easypaisa', 'bank_account'] as const;

export const CreateProductionExpenseSchema = z.object({
  category: z.string().min(1, 'Category is required').max(100),
  description: z.string().min(1, 'Description is required').max(200),
  amount: z.number().positive('Amount must be greater than 0'),
  paymentMethod: z.enum(PRODUCTION_EXPENSE_PAYMENT_METHODS),
  supplier: z.string().max(200).default(''),
  notes: z.string().max(500).default(''),
  // Optional Karachi date; defaults to today server-side when omitted.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date').optional(),
});

export type PrepareProductionInput = z.infer<typeof PrepareProductionSchema>;
export type CreateProductionReturnInput = z.infer<typeof CreateProductionReturnSchema>;
export type ReviewProductionReturnInput = z.infer<typeof ReviewProductionReturnSchema>;
export type CreateBranchReturnInput = z.infer<typeof CreateBranchReturnSchema>;
export type CreateProductionExpenseInput = z.infer<typeof CreateProductionExpenseSchema>;
