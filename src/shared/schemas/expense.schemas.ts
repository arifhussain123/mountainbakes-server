import { z } from 'zod';

export const EXPENSE_PAYMENT_METHODS = ['cash', 'easypaisa'] as const;

export const CreateExpenseSchema = z.object({
  description: z.string().min(1, 'Description is required').max(200),
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS),
  amount: z.number().positive('Amount must be greater than 0'),
  remarks: z.string().max(500).default(''),
  // Optional Karachi date; defaults to today server-side when omitted.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date').optional(),
});

export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>;
