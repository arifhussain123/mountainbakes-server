import { z } from 'zod';
import { FINANCE_PAYMENT_METHODS } from '../types/finance.types';
import { LOAN_ENTRY_STATUSES, LOAN_ENTRY_TYPES } from '../types/finance-loan.types';
import { optionalAttachmentIds } from './attachment.schemas';

/**
 * Refundable & Receivable Loans — request bodies. The SQL functions in
 * migration 20261031000001 re-check every rule here (client active, head
 * type, amount, date); these give the form its messages.
 */

const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/** Spaces and dashes are typing, not number: 0300-1234567 and 0300 1234567 are 03001234567. */
const phone = (label: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/[\s-]/g, '') || null : v),
    z
      .string()
      .regex(/^\+?\d{10,15}$/, `${label} must be a valid phone number, e.g. 03001234567`)
      .nullish(),
  );

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim() || null : v), z.string().max(max).nullish());

export const CreateLoanClientSchema = z.object({
  companyName: optionalText(120),
  clientName: z.string().trim().min(2, 'Client name is required').max(120),
  mobileNumber: phone('Mobile number'),
  whatsappNumber: phone('WhatsApp number'),
  address: optionalText(300),
  note: optionalText(500),
  /** Set after the API warned that a client with this name or mobile exists. */
  confirmDuplicate: z.boolean().default(false),
});

export const UpdateLoanClientSchema = CreateLoanClientSchema.omit({ confirmDuplicate: true }).partial().extend({
  confirmDuplicate: z.boolean().default(false),
});

export const SetLoanClientStatusSchema = z.object({ isActive: z.boolean() });

const money = z
  .number({ invalid_type_error: 'Amount must be a number' })
  .positive('Amount must be greater than 0')
  .max(9_999_999_999.99, 'Amount is out of range');

export const CreateLoanEntrySchema = z
  .object({
    /** Generated once per opened form, so a retried Save is the same entry. */
    requestId: z.string().uuid(),
    entryType: z.enum(LOAN_ENTRY_TYPES),
    clientId: z.string().uuid('Select a client'),
    ledgerHeadId: z.string().uuid('Select a ledger head'),
    branchId: z.string().uuid().nullish(),
    businessDate,
    amount: money,
    paymentMethod: z.enum(FINANCE_PAYMENT_METHODS).nullish(),
    description: z.string().trim().min(2, 'Description is required').max(300),
    note: optionalText(500),
    attachmentIds: optionalAttachmentIds,
  })
  .superRefine((v, ctx) => {
    if (v.entryType === 'paid_payment' && !v.paymentMethod) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentMethod'], message: 'Select a payment method' });
    }
  });

export const CancelLoanEntrySchema = z.object({
  reason: z.string().trim().min(3, 'Say why this entry is being cancelled').max(300),
});

export const LoanLedgerQuerySchema = z.object({
  from: businessDate,
  to: businessDate,
  clientId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  entryType: z.enum(LOAN_ENTRY_TYPES).optional(),
  ledgerHeadId: z.string().uuid().optional(),
  paymentMethod: z.enum(FINANCE_PAYMENT_METHODS).optional(),
  status: z.enum(LOAN_ENTRY_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateLoanClientInput = z.infer<typeof CreateLoanClientSchema>;
export type UpdateLoanClientInput = z.infer<typeof UpdateLoanClientSchema>;
export type CreateLoanEntryInput = z.infer<typeof CreateLoanEntrySchema>;
export type CancelLoanEntryInput = z.infer<typeof CancelLoanEntrySchema>;
export type LoanLedgerQueryInput = z.infer<typeof LoanLedgerQuerySchema>;
