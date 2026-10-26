import { z } from 'zod';
import { CASH_DEPOSIT_MAX_BACKDATE_DAYS, RESTRICTION_REQUEST_TYPES } from '../types/restriction.types';

const dateOnly = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

/**
 * One schema per group, because each group is saved on its own. Every schema is
 * the WHOLE group — a save replaces the group's config, so a half-sent body
 * cannot leave a rule with one threshold from before and one from now.
 */
export const RestrictionGroupSchemas = {
  demand: z
    .object({
      pendingLimit: z.object({
        enabled: z.boolean(),
        warnAt: z.number().int().min(0).max(100),
        blockAt: z.number().int().min(1).max(100),
      }),
      backdated: z.object({ enabled: z.boolean(), requireApproval: z.boolean() }),
      lowSales: z.object({ enabled: z.boolean(), minSoldPercent: z.number().int().min(1).max(100) }),
    })
    .refine((v) => v.pendingLimit.warnAt < v.pendingLimit.blockAt, {
      message: 'Warning threshold must be lower than the blocking threshold.',
      path: ['pendingLimit', 'warnAt'],
    }),
  sales: z.object({
    hourly: z.object({
      enabled: z.boolean(),
      threshold: z.number().int().min(1).max(1000),
    }),
  }),
  production: z.object({
    stockShortage: z.object({ enabled: z.boolean(), allowAdminOverride: z.boolean() }),
  }),
  cash: z.object({
    dailyLimit: z.object({
      enabled: z.boolean(),
      limit: z.number().int().min(1).max(100),
      allowExceptions: z.boolean(),
    }),
    // Optional only for an older client that does not know the rule yet; the
    // API keeps the saved value when it is left out.
    backdate: z
      .object({ enabled: z.boolean(), allowedDays: z.number().int().min(0).max(CASH_DEPOSIT_MAX_BACKDATE_DAYS) })
      .optional(),
  }),
  ledger: z.object({
    backdate: z.object({ enabled: z.boolean(), allowedDays: z.number().int().min(0).max(365) }),
  }),
  company: z.object({
    shareIncome: z.object({ enabled: z.boolean(), allowApproval: z.boolean() }),
  }),
} as const;

/**
 * A request to lift a restriction once.
 *
 * What is NOT here is the point: no branch, no user, no status, no current
 * business date. The API takes those from the token and its own clock.
 */
export const CreateRestrictionRequestSchema = z
  .object({
    type: z.enum(RESTRICTION_REQUEST_TYPES),
    /** The date of the held transaction. */
    date: dateOnly,
    reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500),
    // Finance entries only — the entry the approval is bound to.
    ledgerHeadId: z.string().uuid().optional(),
    amount: z.number().positive().max(1_000_000_000).optional(),
    description: z.string().trim().max(500).optional(),
    branchId: z.string().uuid().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'LEDGER_BACKDATE' || v.type === 'COMPANY_SHARE_INCOME') {
      if (!v.ledgerHeadId) ctx.addIssue({ code: 'custom', path: ['ledgerHeadId'], message: 'Choose a ledger head first' });
      if (v.amount === undefined) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Enter the amount first' });
    }
  });
export type CreateRestrictionRequestInput = z.infer<typeof CreateRestrictionRequestSchema>;

export const DecideRestrictionRequestSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.decision === 'approved' || (v.reason ?? '').length > 0, {
    message: 'Enter a reason before rejecting.',
    path: ['reason'],
  });
export type DecideRestrictionRequestInput = z.infer<typeof DecideRestrictionRequestSchema>;
