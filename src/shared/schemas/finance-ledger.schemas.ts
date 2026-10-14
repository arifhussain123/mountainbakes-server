import { z } from 'zod';
import {
  PARTNER_LEDGER_SORTS,
  SALARY_LEDGER_SORTS,
  SALARY_LEDGER_STATUS_FILTERS,
} from '../types/finance-ledger.types';

/**
 * Requests for the two read-only ledgers and for an employee resignation.
 *
 * The ledgers take a query and nothing else: there is no schema here that
 * creates or changes a ledger figure, because no such request exists.
 */

/** A real calendar date, not just the right shape ('2026-02-31' is refused). */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

const year = z.coerce.number().int().min(2000, 'Year is out of range').max(2100, 'Year is out of range');
const month = z.coerce.number().int().min(1).max(12);
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(12);
const search = z.string().trim().max(80).optional();

export const SalaryLedgerQuerySchema = z.object({
  year: year.optional(),
  search,
  department: z.string().trim().max(80).optional(),
  status: z.enum(SALARY_LEDGER_STATUS_FILTERS).default('all'),
  sort: z.enum(SALARY_LEDGER_SORTS).default('code'),
  page,
  pageSize,
});

export const SalaryLedgerPaymentsQuerySchema = z.object({
  year: year.optional(),
  month: month.optional(),
  employeeId: z.string().uuid().optional(),
  search,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const PartnerLedgerQuerySchema = z.object({
  year: year.optional(),
  search,
  txnKind: z.enum(['advance', 'draw']).optional(),
  sort: z.enum(PARTNER_LEDGER_SORTS).default('code'),
  page,
  pageSize,
});

export const PartnerLedgerTransactionsQuerySchema = z.object({
  year: year.optional(),
  month: month.optional(),
  partnerId: z.string().uuid().optional(),
  txnKind: z.enum(['advance', 'draw']).optional(),
  search,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Recording a resignation.
 *
 * The employee is the one in the URL and the recorder is the signed-in user;
 * neither is taken from this body. Whether the date is acceptable for THIS
 * employee (not before joining, not in the future) is decided on the server,
 * which is the only place that knows both.
 */
export const RecordResignationSchema = z
  .object({
    resignationDate: calendarDate,
    resignationTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM'),
    reason: z.string().trim().min(2, 'Select a resignation reason').max(120),
    remarks: z.string().trim().max(500).nullish(),
  })
  .refine((d) => d.reason.toLowerCase() !== 'other' || Boolean(d.remarks), {
    message: 'Describe the reason in Remarks when "Other" is selected',
    path: ['remarks'],
  });

export const CancelResignationSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this resignation is being cancelled').max(300),
});

export type SalaryLedgerQueryInput = z.infer<typeof SalaryLedgerQuerySchema>;
export type SalaryLedgerPaymentsQueryInput = z.infer<typeof SalaryLedgerPaymentsQuerySchema>;
export type PartnerLedgerQueryInput = z.infer<typeof PartnerLedgerQuerySchema>;
export type PartnerLedgerTransactionsQueryInput = z.infer<typeof PartnerLedgerTransactionsQuerySchema>;
export type RecordResignationInput = z.infer<typeof RecordResignationSchema>;
export type CancelResignationInput = z.infer<typeof CancelResignationSchema>;
