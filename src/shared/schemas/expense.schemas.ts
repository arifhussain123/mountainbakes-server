import { z } from 'zod';

export const EXPENSE_PAYMENT_METHODS = ['cash', 'easypaisa'] as const;

/**
 * One category vocabulary for BOTH expense tables (shop `expenses` and
 * `production_expenses`), so the two breakdowns are directly comparable and the
 * lists cannot drift. Previously this literal lived only in
 * ProductionExpenseForm.tsx.
 */
export const EXPENSE_CATEGORIES = [
  'Ingredients', 'Packaging', 'Utilities', 'Rent', 'Salaries',
  'Maintenance', 'Transport', 'Equipment', 'Other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CreateExpenseSchema = z.object({
  // Validated as a bounded string rather than z.enum, matching
  // CreateProductionExpenseSchema and the plain `text` DB column: the list can
  // grow or be renamed without a migration, and historical rows holding a
  // retired value never become un-parseable.
  category: z.string().min(1, 'Category is required').max(100),
  description: z.string().min(1, 'Description is required').max(200),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS),
  amount: z.number().positive('Amount must be greater than 0'),
  remarks: z.string().max(500).default(''),
  // Optional Karachi date; defaults to today server-side when omitted.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date').optional(),
});

export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>;
