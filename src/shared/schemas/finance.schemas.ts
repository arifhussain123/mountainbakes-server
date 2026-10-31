import { z } from 'zod';
import {
  FINANCE_ACCOUNTS,
  FINANCE_PAYMENT_METHODS,
  FINANCE_REPORT_TYPES,
  FINANCE_ROLES,
} from '../types/finance.types';
import { LOAN_ENTRY_STATUSES, LOAN_ENTRY_TYPES } from '../types/finance-loan.types';
import { optionalAttachmentIds, requiredAttachmentIds } from './attachment.schemas';

/**
 * Finance Ledger request schemas.
 *
 * Two conventions worth knowing before editing:
 *
 *   * Money is `z.number().positive()`, never `nonnegative()`. A zero-value
 *     voucher is always a mistake — it posts a row that moves nothing and
 *     silently pads the audit trail. Deductions and bonuses are the exception
 *     (they legitimately default to 0).
 *   * Ledger head TYPE is never taken from the client. The client sends a head
 *     id; the server reads the head and uses ITS type to decide whether the
 *     posting is a debit or a credit. Trusting a client-supplied type would let
 *     a mis-set radio button book an expense as income.
 */

const businessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const salaryMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM');

const money = (label: string) =>
  z
    .number({ invalid_type_error: `${label} must be a number` })
    .positive(`${label} must be greater than 0`)
    .max(9_999_999_999.99, `${label} is out of range`);

const optionalMoney = z.number().nonnegative().max(9_999_999_999.99).default(0);

// ---------------------------------------------------------------------------
// Ledger heads
// ---------------------------------------------------------------------------

export const CreateLedgerHeadSchema = z.object({
  /**
   * Uppercased server-side. Restricted to A–Z, 0–9 and dashes because the code
   * is what a Trial Balance and an exported spreadsheet key on — spaces and
   * case variants would produce two heads that look identical on paper.
   */
  code: z
    .string()
    .min(2, 'Code must be at least 2 characters')
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/, 'Code may contain only letters, numbers and dashes'),
  name: z.string().min(2, 'Name is required').max(120),
  type: z.enum(['income', 'expense']),
  description: z.string().max(300).nullish(),
  groupName: z.string().max(80).nullish(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const UpdateLedgerHeadSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(300).nullish(),
  groupName: z.string().max(80).nullish(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
  // `code` and `type` are deliberately absent. Changing either would restate
  // every historical voucher filed under the head; raise a new head instead.
});

// ---------------------------------------------------------------------------
// Manual income / expense
// ---------------------------------------------------------------------------

export const CreateFinanceTransactionSchema = z.object({
  ledgerHeadId: z.string().uuid('Select a ledger head'),
  branchId: z.string().uuid().nullish(),
  description: z.string().min(2, 'Description is required').max(300),
  amount: money('Amount'),
  paymentMethod: z.enum(FINANCE_PAYMENT_METHODS),
  account: z.enum(FINANCE_ACCOUNTS),
  businessDate: businessDate.optional(),
  referenceNo: z.string().max(80).nullish(),
  notes: z.string().max(500).nullish(),
  /** Save as a draft instead of going straight to Pending Approval. */
  asDraft: z.boolean().default(false),
  /** Set after the server warns this looks like a duplicate of a Branch Income
   *  entry (same head/amount/date) and the user confirms it anyway. */
  confirmDuplicate: z.boolean().default(false),
  /**
   * Staged photos of the receipt/voucher, uploaded before this request. Required
   * even for a draft: the point of the photo is that it is taken at the moment
   * the money moves, and "I'll attach it when I submit" is exactly the gap it
   * exists to close.
   */
  attachmentIds: requiredAttachmentIds,
  /** The AI Expense Capture run the entry was generated from; omitted for an entry keyed by hand. */
  aiCaptureId: z.string().uuid().nullish(),
});

// attachmentIds is omitted: an edit revises the figures on a draft or rejected
// document, and the photos bound at creation stay bound. Rebinding on update
// would let a rejected voucher swap its evidence for a different receipt before
// coming back to the same approver.
export const UpdateFinanceTransactionSchema = CreateFinanceTransactionSchema.partial()
  .omit({
    asDraft: true,
    confirmDuplicate: true,
    attachmentIds: true,
    aiCaptureId: true,
  })
  .extend({
    /**
     * Send a draft or a corrected rejected entry for approval in the same
     * statement as the edit. Without it the edit is saved and the entry stays
     * where it was — a rejected one keeps its remarks until it is resubmitted.
     */
    resubmit: z.boolean().optional(),
  });

// ---------------------------------------------------------------------------
// Approvals — one shape reused by every document type
// ---------------------------------------------------------------------------

export const ApproveSchema = z.object({
  notes: z.string().max(500).nullish(),
});

export const RejectSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});

/**
 * Reversing or adjusting an entry that is already in the book — the ONLY way to
 * change a posted figure. A reason is mandatory: an adjustment with no stated
 * cause is indistinguishable from tampering when the auditor arrives.
 */
export const AdjustLedgerEntrySchema = z.object({
  reason: z.string().min(5, 'Explain why this entry is being adjusted').max(500),
  /**
   * Omit for a straight reversal (mirror of the original). Provide an amount to
   * post a correcting entry of a different size — the original is reversed in
   * full and the corrected amount re-posted, so both figures stay visible.
   */
  correctedAmount: money('Corrected amount').optional(),
  correctedDescription: z.string().min(2).max(300).optional(),
});

/**
 * Daily Ledger → Edit. The SAME voucher is changed (migrations 133, 135): its
 * number, its place in the posting order and its side of the book are not in
 * this payload and cannot be sent — a key that is not listed here is dropped
 * by the parser before the route sees it.
 *
 * `expected` is what the form showed when it was opened. The database compares
 * it with the voucher as it stands and refuses the edit if somebody else has
 * changed it since, instead of silently writing over their change.
 */
const ledgerEntryFields = {
  amount: money('Amount').optional(),
  entryDate: businessDate.optional(),
  ledgerHeadId: z.string().uuid('Choose a category from the list').optional(),
  /** '' moves the voucher to company-wide. */
  branchId: z.union([z.literal(''), z.string().uuid('Choose a branch from the list')]).optional(),
  paymentMethod: z.string().trim().max(60).optional(),
  account: z.enum(['cash', 'bank']).optional(),
  description: z.string().trim().min(2, 'Description is too short').max(300).optional(),
};

export const EditLedgerEntrySchema = z.object({
  reason: z.string().trim().min(5, 'Explain why this entry is being changed').max(500),
  changes: z
    .object(ledgerEntryFields)
    .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'No changes detected.' }),
  expected: z
    .object({
      amount: z.number().optional(),
      entryDate: z.string().optional(),
      ledgerHeadId: z.string().optional(),
      branchId: z.string().optional(),
      paymentMethod: z.string().optional(),
      account: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});

/** Daily Ledger → Delete. The voucher is removed; nothing is posted to cancel it. */
export const DeleteLedgerEntrySchema = z.object({
  reason: z.string().trim().min(5, 'Explain why this entry is being deleted').max(500),
});

// ---------------------------------------------------------------------------
// Branch income
// ---------------------------------------------------------------------------

export const ImportBranchIncomeSchema = z.object({
  /** Defaults to the business day that just ended when omitted. */
  businessDate: businessDate.optional(),
  branchId: z.string().uuid().optional(),
  /** Re-read the branch figures over an existing, still-unapproved row. */
  refresh: z.boolean().default(false),
});

/**
 * Optional, not required — the only finance document where that is true.
 *
 * A branch-income row is imported from the branch closing by
 * `importBranchIncome`, so it comes into being with no human at a camera.
 * Requiring a photo would break that import outright. The verifier may attach
 * one (a shot of the counted cash, say) and most will not.
 */
export const VerifyIncomeSchema = z.object({
  notes: z.string().max(500).nullish(),
  attachmentIds: optionalAttachmentIds,
});

// ---------------------------------------------------------------------------
// Employees & salaries
// ---------------------------------------------------------------------------

export const CreateEmployeeSchema = z.object({
  name: z.string().min(2, 'Name is required').max(120),
  department: z.string().trim().min(1, 'Department is required').max(80),
  designation: z.string().min(1, 'Designation is required').max(80),
  branchId: z.string().uuid().nullish(),
  baseSalary: z.number().nonnegative('Base salary cannot be negative').max(9_999_999_999.99).default(0),
  phone: z.string().max(30).nullish(),
  joinedOn: businessDate.nullish(),
});

// baseSalary is deliberately NOT editable here — changing it needs a reason
// and an effective date, which only CreateSalaryRevisionSchema below collects.
// A plain PUT that carried baseSalary would overwrite it with no trail at all.
export const UpdateEmployeeSchema = CreateEmployeeSchema.omit({ baseSalary: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

export const CreateSalaryRevisionSchema = z.object({
  newSalary: z.number().nonnegative('New salary cannot be negative').max(9_999_999_999.99),
  reason: z.string().min(3, 'Reason is required').max(300),
  effectiveFrom: businessDate,
});

export const CreateSalaryPaymentSchema = z.object({
  employeeId: z.string().uuid('Select an employee'),
  salaryMonth,
  grossSalary: money('Salary amount'),
  bonus: optionalMoney,
  deductions: optionalMoney,
  paymentDate: businessDate.nullish(),
  paymentMethod: z.enum(FINANCE_PAYMENT_METHODS),
  account: z.enum(FINANCE_ACCOUNTS),
  notes: z.string().max(500).nullish(),
  asDraft: z.boolean().default(false),
  /**
   * The outstanding advances this payslip recovers. The form prefills it with
   * everything the employee still owes and drives `bonus` / `deductions` from
   * it, but the two are NOT re-derived server-side: an approver may legitimately
   * recover only part of a large loan while still clearing the row it sits on.
   *
   * Sent explicitly rather than inferred from the employee, because "which
   * advances did this payslip settle?" is a question the audit trail has to
   * answer years later, and inferring it would make the answer a function of
   * whatever the balance happened to be at read time.
   */
  recoverAdvanceIds: z.array(z.string().uuid()).max(50).default([]),
  /** Photo of the signed payslip or the cash handover. */
  attachmentIds: requiredAttachmentIds,
})
  // netSalary is computed server-side, but a payslip that nets out to nothing —
  // or below it — is a data-entry error worth catching before it reaches an
  // approver, not after.
  .refine((d) => d.grossSalary + d.bonus - d.deductions > 0, {
    message: 'Deductions cannot exceed salary plus bonus',
    path: ['deductions'],
  });

export const UpdateSalaryPaymentSchema = z.object({
  grossSalary: money('Salary amount').optional(),
  bonus: z.number().nonnegative().max(9_999_999_999.99).optional(),
  deductions: z.number().nonnegative().max(9_999_999_999.99).optional(),
  paymentDate: businessDate.nullish(),
  paymentMethod: z.enum(FINANCE_PAYMENT_METHODS).optional(),
  account: z.enum(FINANCE_ACCOUNTS).optional(),
  notes: z.string().max(500).nullish(),
});

// ---------------------------------------------------------------------------
// Employee advances
// ---------------------------------------------------------------------------

/**
 * The three amounts are individually optional-and-zero but collectively
 * positive: a handover is routinely one of them alone (just an advance, just a
 * bonus), and requiring all three would mean typing two zeroes every time. What
 * is never legitimate is a document where nothing moved — see the note at the
 * top of this file.
 */
const employeeAdvanceFields = {
  employeeId: z.string().uuid('Select an employee'),
  /** Defaults to today's business date server-side when omitted. */
  businessDate: businessDate.optional(),
  /** Against this month's salary. */
  advanceAmount: optionalMoney,
  /** A bonus, paid early. Deducted from the payslip like the rest, then added
   *  back as its Bonus figure — paid once, shown as earnings. */
  bonusAmount: optionalMoney,
  /** A loan. */
  loanAmount: optionalMoney,
  paymentMethod: z.enum(FINANCE_PAYMENT_METHODS),
  account: z.enum(FINANCE_ACCOUNTS),
  notes: z.string().max(500).nullish(),
};

const atLeastOneAmount = {
  message: 'Enter an advance, a bonus or a loan amount',
  path: ['advanceAmount'],
};

export const CreateEmployeeAdvanceSchema = z
  .object({
    ...employeeAdvanceFields,
    asDraft: z.boolean().default(false),
    /** Photo of the cash handover or the transfer slip. */
    attachmentIds: requiredAttachmentIds,
  })
  .refine((d) => d.advanceAmount + d.bonusAmount + d.loanAmount > 0, atLeastOneAmount);

// employeeId is excluded for the same reason UpdateSalaryPaymentSchema excludes
// it: re-pointing a signed handover at a different person is not an edit.
// attachmentIds is excluded for the reason given on UpdateFinanceTransactionSchema.
//
// The amounts stay individually optional here, so the "> 0" rule cannot be
// checked on the request alone — a payload carrying only `bonusAmount` says
// nothing about the advance and loan it is not touching. The service applies it
// to the MERGED figures instead (see updateEmployeeAdvance).
export const UpdateEmployeeAdvanceSchema = z
  .object({ ...employeeAdvanceFields })
  .omit({ employeeId: true })
  .partial();

// ---------------------------------------------------------------------------
// Partners, partner advances/draws, branch share payouts
// ---------------------------------------------------------------------------

/** Profile-only — the four partners and their 25% split are fixed at seed time. */
export const UpdateFinancePartnerSchema = z.object({
  fatherName: z.string().max(120).nullish(),
  dateOfBirth: businessDate.nullish(),
  joinedOn: businessDate.nullish(),
  partnerType: z.enum(['founder', 'co_founder']).nullish(),
  address: z.string().max(300).nullish(),
  contactNumber: z.string().max(30).nullish(),
  emergencyNumber: z.string().max(30).nullish(),
});

// ledgerHeadId and description are gone: an advance/draw always books against
// EXP-PARTNER (resolved server-side) with a description generated from the
// partner name and txnKind — the form only asks for what the brief asks for.
export const CreatePartnerExpenseSchema = z.object({
  partnerId: z.string().uuid('Select a partner'),
  txnKind: z.enum(['advance', 'draw']),
  amount: money('Amount'),
  paymentMethod: z.enum(FINANCE_PAYMENT_METHODS),
  account: z.enum(FINANCE_ACCOUNTS),
  businessDate: businessDate.optional(),
  notes: z.string().max(500).nullish(),
  asDraft: z.boolean().default(false),
  /** Photo of the cash handover or the transfer slip. */
  attachmentIds: requiredAttachmentIds,
});

// partnerId and txnKind are excluded from editing for the same reason
// UpdateSalaryPaymentSchema excludes employeeId/salaryMonth: changing either
// would sidestep the constraint the field exists to enforce. attachmentIds is
// excluded for the reason given on UpdateFinanceTransactionSchema.
export const UpdatePartnerExpenseSchema = CreatePartnerExpenseSchema.omit({
  partnerId: true,
  txnKind: true,
  asDraft: true,
  attachmentIds: true,
}).partial();

export const CreateBranchSharePaymentSchema = z
  .object({
    branchId: z.string().uuid('Select a branch'),
    amount: z.number().nonnegative().max(9_999_999_999.99).default(0),
    bonus: z.number().nonnegative().max(9_999_999_999.99).default(0),
    paymentMethod: z.enum(FINANCE_PAYMENT_METHODS),
    account: z.enum(FINANCE_ACCOUNTS),
    businessDate: businessDate.optional(),
    notes: z.string().max(500).nullish(),
    asDraft: z.boolean().default(false),
    /** Photo of the payout being handed over. */
    attachmentIds: requiredAttachmentIds,
  })
  .refine((d) => d.amount > 0 || d.bonus > 0, {
    message: 'Enter a share amount, a bonus, or both',
    path: ['amount'],
  });

export const UpdateBranchSharePaymentSchema = z.object({
  amount: z.number().nonnegative().max(9_999_999_999.99).optional(),
  bonus: z.number().nonnegative().max(9_999_999_999.99).optional(),
  paymentMethod: z.enum(FINANCE_PAYMENT_METHODS).optional(),
  account: z.enum(FINANCE_ACCOUNTS).optional(),
  businessDate: businessDate.optional(),
  notes: z.string().max(500).nullish(),
});

// ---------------------------------------------------------------------------
// Daily closing
// ---------------------------------------------------------------------------

export const CloseFinanceDaySchema = z.object({
  businessDate,
  notes: z.string().max(500).nullish(),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const UpdateFinanceSettingsSchema = z
  .object({
    companySharePct: z.number().min(0).max(100).optional(),
    branchSharePct: z.number().min(0).max(100).optional(),
    shareBasis: z.enum(['gross', 'net']).optional(),
    openingCashBalance: z.number().min(-9_999_999_999.99).max(9_999_999_999.99).optional(),
    openingBankBalance: z.number().min(-9_999_999_999.99).max(9_999_999_999.99).optional(),
    openingBalanceDate: businessDate.nullish(),
    autoImportBranchIncome: z.boolean().optional(),
    requireAdminVerification: z.boolean().optional(),
    allowSuperAdminWrite: z.boolean().optional(),
  })
  /**
   * The two percentages are only checked TOGETHER, and only when both are
   * present. A PATCH that moves the company to 80 without also moving the branch
   * to 20 would otherwise pass here and then fail on the table's CHECK
   * constraint as an opaque 23514 — so the UI always submits the pair.
   */
  .refine(
    (d) =>
      d.companySharePct === undefined ||
      d.branchSharePct === undefined ||
      Math.abs(d.companySharePct + d.branchSharePct - 100) < 0.005,
    {
      message: 'Company share and branch share must add up to 100%',
      path: ['branchSharePct'],
    },
  )
  .refine((d) => (d.companySharePct === undefined) === (d.branchSharePct === undefined), {
    message: 'Change both share percentages together',
    path: ['companySharePct'],
  });

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const FinanceReportQuerySchema = z.object({
  type: z.enum(FINANCE_REPORT_TYPES),
  from: businessDate.optional(),
  to: businessDate.optional(),
  branchId: z.string().uuid().optional(),
  ledgerHeadId: z.string().uuid().optional(),
  partnerName: z.string().max(120).optional(),
  employeeId: z.string().uuid().optional(),
  department: z.string().max(80).optional(),
  salaryMonth: salaryMonth.optional(),
  // Loan ledger only (type 'loan_ledger').
  clientId: z.string().uuid().optional(),
  loanEntryType: z.enum(LOAN_ENTRY_TYPES).optional(),
  paymentMethod: z.enum(FINANCE_PAYMENT_METHODS).optional(),
  loanStatus: z.enum(LOAN_ENTRY_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
  // Only meaningful for the row-level reports (cash book, general ledger,
  // expense report, share reports, salary, partner expense) — the aggregated
  // ones (income statement, P&L, trial balance) always return every head. The
  // route decides whether to honour these at all: /export never does, because
  // the exported file is the document of record and must hold every row.
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
  // Validated against the JUST-BUILT report's own `columns` in
  // `buildFinanceReport` — the sortable key set differs per report type, so it
  // can't be a fixed enum here the way `type` above is.
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

// ---------------------------------------------------------------------------
// Finance sign-in
// ---------------------------------------------------------------------------

/**
 * The Finance login asks for a "Finance User ID", not an email — accounts staff
 * are issued an ID, and the brief calls for it explicitly. This endpoint
 * resolves `users.username` → email BEFORE the browser signs in with it. An email is accepted too, so an admin who knows
 * the address is not locked out of their own module.
 */
export const FinanceLoginLookupSchema = z.object({
  userId: z.string().min(3, 'Enter your Finance User ID').max(255),
});

export const FinanceRoleSchema = z.enum(FINANCE_ROLES);

export type CreateLedgerHeadInput = z.infer<typeof CreateLedgerHeadSchema>;
export type UpdateLedgerHeadInput = z.infer<typeof UpdateLedgerHeadSchema>;
export type CreateFinanceTransactionInput = z.infer<typeof CreateFinanceTransactionSchema>;
export type UpdateFinanceTransactionInput = z.infer<typeof UpdateFinanceTransactionSchema>;
export type ApproveInput = z.infer<typeof ApproveSchema>;
export type RejectInput = z.infer<typeof RejectSchema>;
export type AdjustLedgerEntryInput = z.infer<typeof AdjustLedgerEntrySchema>;
export type EditLedgerEntryInput = z.infer<typeof EditLedgerEntrySchema>;
export type DeleteLedgerEntryInput = z.infer<typeof DeleteLedgerEntrySchema>;
export type ImportBranchIncomeInput = z.infer<typeof ImportBranchIncomeSchema>;
export type CreateEmployeeInput = z.infer<typeof CreateEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof UpdateEmployeeSchema>;
export type CreateSalaryRevisionInput = z.infer<typeof CreateSalaryRevisionSchema>;
export type CreateSalaryPaymentInput = z.infer<typeof CreateSalaryPaymentSchema>;
export type UpdateSalaryPaymentInput = z.infer<typeof UpdateSalaryPaymentSchema>;
export type CreateEmployeeAdvanceInput = z.infer<typeof CreateEmployeeAdvanceSchema>;
export type UpdateEmployeeAdvanceInput = z.infer<typeof UpdateEmployeeAdvanceSchema>;
export type UpdateFinancePartnerInput = z.infer<typeof UpdateFinancePartnerSchema>;
export type CreatePartnerExpenseInput = z.infer<typeof CreatePartnerExpenseSchema>;
export type UpdatePartnerExpenseInput = z.infer<typeof UpdatePartnerExpenseSchema>;
export type CreateBranchSharePaymentInput = z.infer<typeof CreateBranchSharePaymentSchema>;
export type UpdateBranchSharePaymentInput = z.infer<typeof UpdateBranchSharePaymentSchema>;
export type CloseFinanceDayInput = z.infer<typeof CloseFinanceDaySchema>;
export type UpdateFinanceSettingsInput = z.infer<typeof UpdateFinanceSettingsSchema>;
export type FinanceReportQueryInput = z.infer<typeof FinanceReportQuerySchema>;
