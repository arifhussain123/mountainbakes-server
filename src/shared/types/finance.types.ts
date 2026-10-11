/**
 * Finance Ledger — the accounts department's own module.
 *
 * This is deliberately a WORLD APART from Branch / Production / Admin: it is the
 * company's book of account, not an operations screen. Two consequences run
 * through every type below.
 *
 *   1. Nothing here is ever edited in place once posted. A mistake is corrected
 *      with a reversing or adjustment entry that leaves the original visible.
 *      That is why `LedgerEntry` has no `updatedAt` and no update payload type.
 *   2. Every amount that reaches the ledger has passed an approval, and the
 *      approval is recorded on the SOURCE document (a FinanceTransaction, a
 *      SalaryPayment, …) rather than on the ledger row. The ledger row is the
 *      consequence; the source document is the decision.
 *
 * Money is `numeric(14,2)` in Postgres and therefore arrives from PostgREST as a
 * STRING. Every service in this module coerces with Number() at the boundary —
 * see the note on `coerceToDefaultType` in settings.service.ts for what happens
 * when that is forgotten.
 */

import type { UserRole } from './user.types';
import type { Attachment } from './attachment.types';

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

/**
 * The four finance roles. These are values of the `user_role` Postgres enum
 * (migration 51), NOT a separate claim — so `app.jwt_role()`, RLS, RouteGuard
 * and `requireRole()` all keep working unchanged, and a finance account is
 * provisioned through the same POST /api/users path as every other account.
 */
export type FinanceRole = 'finance_admin' | 'finance_manager' | 'accountant' | 'finance_auditor';

export const FINANCE_ROLES = [
  'finance_admin',
  'finance_manager',
  'accountant',
  'finance_auditor',
] as const satisfies readonly FinanceRole[];

export const FINANCE_ROLE_LABELS: Record<FinanceRole, string> = {
  finance_admin: 'Finance Admin',
  finance_manager: 'Finance Manager',
  accountant: 'Accountant',
  finance_auditor: 'Read Only Auditor',
};

export function isFinanceRole(role: unknown): role is FinanceRole {
  return typeof role === 'string' && (FINANCE_ROLES as readonly string[]).includes(role);
}

/**
 * What a finance user may do, in increasing order of consequence.
 *
 *   view      — read every finance screen and report
 *   create    — raise a draft / submit it for approval
 *   approve   — approve or reject, which is what posts money to the ledger
 *   adjust    — reverse or adjust an ALREADY POSTED entry
 *   configure — ledger heads, share percentages, opening balances, employees
 */
export type FinancePermission = 'view' | 'create' | 'approve' | 'adjust' | 'configure';

const FINANCE_ROLE_PERMISSIONS: Record<FinanceRole, readonly FinancePermission[]> = {
  finance_admin: ['view', 'create', 'approve', 'adjust', 'configure'],
  finance_manager: ['view', 'create', 'approve'],
  accountant: ['view', 'create'],
  // The clue is in the name. An auditor who can write is not an auditor.
  finance_auditor: ['view'],
};

/**
 * Whether `role` may perform `permission`.
 *
 * Super Admin is a special case and reads exactly as the brief specifies: they
 * can VIEW every finance record and report unconditionally, but cannot modify
 * one "unless granted permission" — which is the `allowSuperAdminWrite` toggle
 * in Finance Settings, off by default. Being able to see the books and being
 * able to move money in them are separate grants, and separation of duties is
 * the entire point of a finance module living outside admin operations.
 *
 * Every other role — branch_manager, production_user — gets nothing
 * at all, including `view`.
 */
export function financeCan(
  role: UserRole | string | null | undefined,
  permission: FinancePermission,
  allowSuperAdminWrite = false,
): boolean {
  if (role === 'super_admin') return permission === 'view' || allowSuperAdminWrite;
  if (!isFinanceRole(role)) return false;
  return FINANCE_ROLE_PERMISSIONS[role].includes(permission);
}

/** Everyone who may open the module at all. Used for route registration + nav. */
export function canAccessFinance(role: UserRole | string | null | undefined): boolean {
  return role === 'super_admin' || isFinanceRole(role);
}

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** Which side of the books a ledger head belongs to. */
export type LedgerHeadType = 'income' | 'expense';

/**
 * Which pot the money moved through. This is what separates "Cash in Hand" from
 * "Bank Balance" on the dashboard and the daily closing — the ledger's running
 * `balance` is the two combined.
 */
export type FinanceAccount = 'cash' | 'bank';

export const FINANCE_ACCOUNTS = ['cash', 'bank'] as const satisfies readonly FinanceAccount[];

export const FINANCE_ACCOUNT_LABELS: Record<FinanceAccount, string> = {
  cash: 'Cash in Hand',
  bank: 'Bank',
};

/**
 * How money changed hands. A superset of the branch-side `payment_method` enum
 * (migration 01) because finance also settles by cheque and bank transfer, which
 * a shop counter never does. Kept as free text in the database for the same
 * reason expense categories are — see CreateExpenseSchema.
 */
export const FINANCE_PAYMENT_METHODS = [
  'cash',
  'easypaisa',
  'bank_transfer',
  'cheque',
  'foodpanda',
  'online',
  'other',
] as const;

export type FinancePaymentMethod = (typeof FINANCE_PAYMENT_METHODS)[number];

export const FINANCE_PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  easypaisa: 'Easypaisa',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  foodpanda: 'Foodpanda',
  online: 'Online',
  other: 'Other',
};

/**
 * The approval lifecycle every manual document walks:
 *
 *   draft → pending_approval → approved → posted → locked
 *                     ↘ rejected
 *
 * `approved` and `posted` are distinct states even though the API advances
 * through both inside one call: approval is the human decision, posting is the
 * bookkeeping consequence, and a posting that fails must not leave a document
 * looking un-approved. `locked` is applied in bulk when the finance day closes.
 */
export type FinanceDocStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'posted'
  | 'locked'
  | 'rejected';

export const FINANCE_DOC_STATUS_LABELS: Record<FinanceDocStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  posted: 'Posted',
  locked: 'Locked',
  rejected: 'Rejected',
};

/** Statuses whose document is still editable by its author. */
export const EDITABLE_DOC_STATUSES: readonly FinanceDocStatus[] = ['draft', 'rejected'];

// ---------------------------------------------------------------------------
// Ledger heads
// ---------------------------------------------------------------------------

export interface LedgerHead {
  id: string;
  /** Stable short code (INC-CASH-BRANCH, EXP-RENT). Unique; used by reports. */
  code: string;
  name: string;
  type: LedgerHeadType;
  description: string | null;
  /** Optional grouping shown as a section header on the Ledger Heads page. */
  groupName: string | null;
  isActive: boolean;
  /**
   * Seeded by migration 52 and referenced by the automatic postings (branch
   * income, the two share splits, salaries). A system head may be renamed but
   * never deactivated, or the import would have nowhere to post.
   */
  isSystem: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The code of every head the automatic postings depend on. Anything reading one
 * of these MUST use the constant — a typo here is a runtime "ledger head not
 * found" at 2 AM on the closing job, not a compile error.
 */
export const SYSTEM_LEDGER_HEAD_CODES = {
  BRANCH_CASH: 'INC-BRANCH-CASH',
  COMPANY_SHARE: 'INC-COMPANY-SHARE',
  BRANCH_SHARE: 'INC-BRANCH-SHARE',
  SALARIES: 'EXP-SALARIES',
  PARTNER_WITHDRAWAL: 'EXP-PARTNER',
  OPENING_BALANCE: 'INC-OPENING',
  ADJUSTMENT: 'EXP-ADJUSTMENT',
  BRANCH_SHARE_PAYOUT: 'EXP-BRANCH-SHARE-PAYOUT',
  PRODUCTION_EXPENSE: 'EXP-PRODUCTION',
} as const;

// ---------------------------------------------------------------------------
// Ledger entries — the posted book
// ---------------------------------------------------------------------------

/**
 * Where a posted entry came from. Every entry has exactly one source document,
 * and `sourceId` points at it, so any figure on any report can be traced back
 * to the decision that authorised it.
 */
export type LedgerSourceType =
  | 'opening'
  | 'manual'
  | 'branch_income'
  | 'company_share'
  | 'branch_share'
  | 'salary'
  | 'employee_advance'
  | 'partner_expense'
  | 'adjustment'
  | 'branch_share_payout'
  | 'branch_share_bonus'
  // Migration 115 — a vendor payment posted from procurement.
  | 'vendor_payment'
  // Migration 118 — a branch's cash / Easypaisa / bank handover, approved by
  // Finance. One debit under INC-BRANCH-CASH; `sourceId` is the cash_transfers
  // row, which carries the photo the Daily Ledger shows.
  | 'cash_transfer';

/**
 * `posted` is the normal state. `locked` is applied when the finance day closes.
 * `reversed` marks an entry that a later reversing entry has cancelled — the
 * original stays in the book, greyed out, exactly as an audit requires.
 */
export type LedgerEntryStatus = 'posted' | 'locked' | 'reversed';

export interface LedgerEntry {
  id: string;
  voucherNo: string;
  /**
   * Global monotonic posting order. THE ledger is ordered by this, not by
   * `entryDate`: `balance` is the running book balance at the moment of posting,
   * so re-sorting by date would show balances that never existed. Back-dating
   * into a closed day is refused outright (see post_finance_ledger_entry), which
   * is what keeps the two orderings from diverging in practice.
   */
  seq: number;
  /** Business date (Asia/Karachi, 2 AM rollover) the entry belongs to. */
  entryDate: string;
  ledgerHeadId: string | null;
  /** Snapshot — a head renamed later must not rewrite historical vouchers. */
  ledgerHeadName: string;
  ledgerHeadType: LedgerHeadType;
  branchId: string | null;
  branchName: string | null;
  description: string;
  /** Money IN (a receipt). Cash-book convention: debit increases the balance. */
  debit: number;
  /** Money OUT (a payment). */
  credit: number;
  /** Running book balance after this entry, in `seq` order. */
  balance: number;
  account: FinanceAccount;
  paymentMethod: string | null;
  status: LedgerEntryStatus;
  sourceType: LedgerSourceType;
  sourceId: string | null;
  /** Set on a reversing entry: the entry it cancels. */
  reversesEntryId: string | null;
  /** Set on the original once reversed: the entry that cancelled it. */
  reversedByEntryId: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  createdBy: string | null;
  createdByName: string | null;
  postedAt: string;
  /** When the voucher was last edited in place, and by whom (migration 135). Null if never. */
  updatedAt?: string | null;
  updatedByName?: string | null;
  /**
   * Photos of the SOURCE DOCUMENT this voucher was posted from, resolved on read
   * via (sourceType, sourceId) — they are not stored on the ledger row, which is
   * immutable by trigger. Absent on entries whose source carries no photo:
   * opening balances, reversals, and anything imported rather than keyed in.
   *
   * The `url` on each is short-lived. See the note on `Attachment`.
   */
  attachments?: Attachment[];
}

export interface LedgerQuery {
  from?: string;
  to?: string;
  branchId?: string;
  ledgerHeadId?: string;
  type?: LedgerHeadType;
  account?: FinanceAccount;
  status?: LedgerEntryStatus;
  sourceType?: LedgerSourceType;
  voucherNo?: string;
  /** Free-text across description, voucher no, head name, branch name. */
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  limit?: number;
  offset?: number;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  total: number;
  /** Book balance immediately BEFORE the first entry on this page. */
  openingBalance: number;
  /** Book balance after the last entry on this page. */
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
}

/**
 * The Daily Ledger's top summary — month-to-date as of `businessDate`, and
 * independent of the ledger table's own pagination/filters. `openingBalance`
 * is the previous month's final closing balance, carried forward the same way
 * `FinanceDayClosing.openingBalance` is: everything posted before `monthStart`.
 */
export interface LedgerSummary {
  businessDate: string;
  monthStart: string;
  openingBalance: number;
  totalReceived: number;
  totalExpense: number;
  balance: number;
}

// ---------------------------------------------------------------------------
// Branch income approvals
// ---------------------------------------------------------------------------

/**
 *   Branch submits daily closing → Admin verifies → Finance approves → posted.
 *
 * `pending_verification` exists only while Finance Settings has
 * `requireAdminVerification` on; with it off, the import lands straight in
 * `pending_approval`. Nothing reaches the ledger until Finance approves.
 */
export type IncomeApprovalStatus =
  | 'pending_verification'
  | 'pending_approval'
  | 'approved'
  | 'rejected';

export interface FinanceIncomeApproval {
  id: string;
  referenceNo: string;
  branchId: string;
  branchName: string;
  businessDate: string;

  /** Gross collected by the branch — the sum of the five splits below. */
  totalAmount: number;
  cashAmount: number;
  easypaisaAmount: number;
  foodpandaAmount: number;
  bankAmount: number;
  otherAmount: number;

  /** The branch's own shop expenses for the day, for reference and `netAmount`. */
  branchExpenses: number;
  /** totalAmount − branchExpenses. Which of the two the shares are struck on is
   *  the `shareBasis` setting. */
  netAmount: number;

  /** Percentages SNAPSHOT at approval time — changing the setting later must not
   *  silently restate an approved day. */
  companySharePct: number;
  branchSharePct: number;
  companyShare: number;
  branchShare: number;

  status: IncomeApprovalStatus;
  verifiedBy: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  notes: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Optional here, unlike every other finance document. These rows are IMPORTED
   * from the branch closing rather than keyed into a form, so there is no moment
   * of capture to require a photo at. A verifier may attach one; nothing forces
   * it. See the note on `optionalAttachmentIds`.
   */
  attachments?: Attachment[];
}

// ---------------------------------------------------------------------------
// Manual income / expense documents
// ---------------------------------------------------------------------------

export interface FinanceTransaction {
  id: string;
  txnNo: string;
  txnType: LedgerHeadType;
  ledgerHeadId: string;
  ledgerHeadName: string;
  branchId: string | null;
  branchName: string | null;
  description: string;
  amount: number;
  paymentMethod: string;
  account: FinanceAccount;
  businessDate: string;
  status: FinanceDocStatus;
  /** Cheque number, transfer reference, invoice number — whatever backs it up. */
  referenceNo: string | null;
  notes: string | null;
  createdBy: string | null;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  ledgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the receipt or voucher, captured when the entry was raised. */
  attachments?: Attachment[];
}

// ---------------------------------------------------------------------------
// Salaries
// ---------------------------------------------------------------------------

/**
 * The payroll master. Separate from `users` on purpose: `users` is the set of
 * people who can SIGN IN, and most people on a payroll cannot. Linking payroll
 * to auth accounts would mean provisioning a login for every baker.
 */
export interface FinanceEmployee {
  id: string;
  employeeCode: string;
  name: string;
  department: string;
  designation: string;
  branchId: string | null;
  branchName: string | null;
  /** The salary effective as of today — resolved from salary_revisions, not a raw column. */
  baseSalary: number;
  /** An already-recorded revision whose effective date hasn't arrived yet, if any. */
  pendingRevision: { newSalary: number; effectiveFrom: string; reason: string } | null;
  phone: string | null;
  joinedOn: string | null;
  isActive: boolean;
  /** The live resignation, if one is recorded. A cancelled one is history, not this. */
  resignation: EmployeeResignation | null;
  createdAt: string;
  updatedAt: string;
}

/** Offered by the resignation form. "Other" requires remarks. */
export const RESIGNATION_REASONS = [
  'Personal reasons',
  'Better opportunity',
  'Relocation',
  'Health',
  'Further studies',
  'Other',
] as const;

export type EmployeeResignationStatus = 'recorded' | 'cancelled';

/**
 * One resignation record (employee_resignations).
 *
 * `resignationDate` / `resignationTime` are what the person recording it
 * entered, in Asia/Karachi. `createdAt` is when the server wrote the row. The
 * two are kept apart: a resignation handed in on Friday and keyed in on Monday
 * has a Friday date and a Monday timestamp, and both are true.
 *
 * Rows are never deleted. A wrong one is cancelled and stays in the history.
 */
export interface EmployeeResignation {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  /** 'YYYY-MM-DD'. */
  resignationDate: string;
  /** 'HH:MM', 24-hour. */
  resignationTime: string;
  reason: string;
  remarks: string | null;
  status: EmployeeResignationStatus;
  submittedBy: string | null;
  submittedByName: string;
  cancelledBy: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One recorded base-salary change. Append-only (salary_revisions table) — a
 * correction is a new row, not an edit to this one. See the migration
 * comment for why this can never restate a payslip that already exists.
 */
export interface SalaryRevision {
  id: string;
  employeeId: string;
  employeeName: string;
  previousSalary: number;
  newSalary: number;
  reason: string;
  effectiveFrom: string;
  changedBy: string | null;
  changedByName: string;
  createdAt: string;
}

export interface SalaryPayment {
  id: string;
  salaryNo: string;
  employeeId: string;
  /** Snapshots — a promotion must not restate last year's payslips. */
  employeeName: string;
  department: string;
  designation: string;
  /** 'YYYY-MM'. Unique per employee, which is what stops a double payment. */
  salaryMonth: string;
  grossSalary: number;
  bonus: number;
  deductions: number;
  /** grossSalary + bonus − deductions, computed server-side. */
  netSalary: number;
  paymentDate: string | null;
  paymentMethod: string;
  account: FinanceAccount;
  status: FinanceDocStatus;
  notes: string | null;
  createdBy: string | null;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  ledgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the signed payslip or the cash handover. */
  attachments?: Attachment[];
}

/**
 * Money handed to an employee between payslips — an advance against this
 * month's salary, a bonus paid early, a loan, or any mix of the three in one
 * handover.
 *
 * WHY ONE DOCUMENT WITH THREE AMOUNTS rather than three documents: a handover is
 * counted out once and signed for once. See migration 87 for the long version.
 *
 * The cash is gone the moment this posts, so the next payslip deducts the WHOLE
 * `totalAmount` — bonus included — and separately adds `bonusAmount` back as its
 * Bonus figure. The bonus is therefore visible on the payslip as earnings
 * without being paid twice, and total payroll cost still comes to salary + bonus.
 */
export interface EmployeeAdvance {
  id: string;
  advanceNo: string;
  employeeId: string;
  /** Snapshots — a promotion must not restate a handover already signed for. */
  employeeName: string;
  department: string;
  designation: string;
  /** The date the money changed hands (Asia/Karachi business date). */
  businessDate: string;
  advanceAmount: number;
  bonusAmount: number;
  loanAmount: number;
  /** advanceAmount + bonusAmount + loanAmount — what actually left the account. */
  totalAmount: number;
  paymentMethod: string;
  account: FinanceAccount;
  status: FinanceDocStatus;
  notes: string | null;
  /**
   * The payslip that recovers this advance, claimed when that payslip is
   * CREATED — not when it posts. A payslip in the approval queue has already
   * promised to deduct this money; leaving it unclaimed until approval would let
   * next month's payslip deduct the same amount again.
   *
   * A claim by a payslip that ends up rejected does not count: `outstanding`
   * below is computed against the claimer's status, not merely its presence.
   */
  recoveredBySalaryId: string | null;
  /** The payslip's number, resolved on read for display. */
  recoveredBySalaryNo: string | null;
  /** Stamped when the claiming payslip is approved and posts. */
  recoveredAt: string | null;
  /**
   * True once a payslip has claimed it and that payslip has not been rejected.
   * `recoveredAt` is the narrower fact — that the claiming payslip actually
   * posted — and stays null until it does.
   */
  isRecovered: boolean;
  createdBy: string | null;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  ledgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the cash handover or the transfer slip. */
  attachments?: Attachment[];
}

/**
 * One employee's advance position — the "Previous payment" panel on the advance
 * form and the figures the payslip form prefills from.
 *
 * Computed on read from the advance rows themselves rather than stored on the
 * employee: a stored running balance is a number that can disagree with the
 * documents behind it, and the first time it does nobody can tell which is right.
 */
export interface EmployeeAdvanceSummary {
  employeeId: string;
  employeeName: string;
  /** Every posted advance ever, recovered or not. */
  totalPaid: number;
  /**
   * The part a payslip has claimed and not been rejected on — so it counts a
   * payslip still sitting in the approval queue. That is the conservative
   * direction: the alternative would offer the same money to next month's
   * payslip as well, and deduct it twice.
   */
  totalRecovered: number;
  /** totalPaid − totalRecovered: what the next payslip should deduct. */
  outstanding: number;
  /** The bonus part of `outstanding` — what the next payslip should ADD as Bonus. */
  outstandingBonus: number;
  /** The posted, unrecovered advances making up `outstanding`, oldest first. */
  advances: EmployeeAdvance[];
}

// ---------------------------------------------------------------------------
// Partners, partner advances/draws, branch share payouts
// ---------------------------------------------------------------------------

/** One of the four fixed owners. `sharePct` is informational here — the 25%
 * split is enforced by the migration's check constraint, not read live from
 * this row by every consumer, so a future ownership change is one row edit
 * away rather than a re-derivation. */
export interface FinancePartner {
  id: string;
  /** 'PT-000001'. Permanent; the name can be corrected, this cannot change. */
  partnerCode: string;
  name: string;
  fatherName: string | null;
  dateOfBirth: string | null;
  joinedOn: string | null;
  partnerType: 'founder' | 'co_founder' | null;
  address: string | null;
  contactNumber: string | null;
  emergencyNumber: string | null;
  sharePct: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PartnerTxnKind = 'advance' | 'draw';

/**
 * An ADVANCE is money lent to a partner against their future share (deducted
 * later); a DRAW is a partner withdrawing money they are already entitled to
 * from the current grand total. Both post as an expense under EXP-PARTNER —
 * `txnKind` is what the Partner Share Detail report groups by.
 */
export interface PartnerExpense {
  id: string;
  expenseNo: string;
  partnerId: string | null;
  partnerName: string;
  txnKind: PartnerTxnKind;
  ledgerHeadId: string;
  ledgerHeadName: string;
  description: string;
  amount: number;
  paymentMethod: string;
  account: FinanceAccount;
  businessDate: string;
  status: FinanceDocStatus;
  requestedBy: string | null;
  requestedByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  notes: string | null;
  ledgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the cash handover or the transfer slip. */
  attachments?: Attachment[];
}

/**
 * Actually paying a branch its already-recorded share. Branch income
 * approval posts the company/branch share split to the ledger immediately,
 * but that only RECORDS the split — this is the payout. `bonus` is optional
 * and posts separately to Production Expenses rather than the share-payout
 * head, with a note naming the branch.
 */
export interface BranchSharePayment {
  id: string;
  paymentNo: string;
  branchId: string;
  branchName: string;
  amount: number;
  bonus: number;
  businessDate: string;
  paymentMethod: string;
  account: FinanceAccount;
  status: FinanceDocStatus;
  notes: string | null;
  requestedBy: string | null;
  requestedByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  ledgerEntryId: string | null;
  bonusLedgerEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Photo of the payout being handed over. */
  attachments?: Attachment[];
}

/**
 * What one branch is still owed — computed from the ledger, never stored.
 *
 * `recorded` is every posted Branch Share entry for the branch (what income
 * approval booked as theirs); `paidOut` is every posted Branch Share Payout for
 * it. The difference is what a payout should be for, which is the number the
 * payout form previously asked someone to key from memory.
 *
 * Bonuses are excluded on purpose — a bonus posts to Production Expenses, not
 * against the branch's share, so counting it here would make the branch look
 * settled when its share is still outstanding.
 */
export interface BranchShareBalance {
  branchId: string;
  branchName: string;
  /** The split this branch is currently on, and whether it is its own. */
  companySharePct: number;
  branchSharePct: number;
  isOverride: boolean;
  recorded: number;
  paidOut: number;
  /** recorded − paidOut. Negative means the branch has been overpaid. */
  outstanding: number;
}

/** One row of the Partner Share Detail table — computed, not stored. */
export interface PartnerShareRow {
  id: string;
  name: string;
  sharePct: number;
  /** grandTotal × sharePct / 100 */
  sharePctAmount: number;
  advancePaid: number;
  drawPaid: number;
  /** sharePctAmount − advancePaid − drawPaid */
  balance: number;
}

export interface PartnerShareSummary {
  from: string | null;
  to: string | null;
  /** Every posted expense except partner advances/draws — production, utilities, packaging, salaries, branch share payouts, etc. */
  totalExpense: number;
  /** Every posted entry under the Company Share head. */
  totalCompanyShare: number;
  /** totalCompanyShare − totalExpense */
  grandTotal: number;
  partners: PartnerShareRow[];
}

// ---------------------------------------------------------------------------
// Daily closing
// ---------------------------------------------------------------------------

export interface FinanceDayClosing {
  businessDate: string;
  /** Carried from the previous day's closing balance — see financeDaySummary. */
  openingBalance: number;
  openingCash: number;
  openingBank: number;
  totalIncome: number;
  totalExpenses: number;
  /** totalIncome − totalExpenses for the day alone. */
  netBalance: number;
  cashInHand: number;
  bankBalance: number;
  closingBalance: number;
  entryCount: number;
  status: 'open' | 'closed';
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface FinanceDashboard {
  businessDate: string;
  todayIncome: number;
  todayExpenses: number;
  netCashBalance: number;
  companyShare: number;
  branchShare: number;
  pendingIncomeApprovals: number;
  pendingIncomeAmount: number;
  pendingExpenseApprovals: number;
  pendingExpenseAmount: number;
  bankBalance: number;
  cashInHand: number;
  recentEntries: LedgerEntry[];
  /** Oldest first, so a chart can render it without reversing. */
  trend: { businessDate: string; income: number; expenses: number; net: number }[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Whether the company/branch split is struck on gross collection or on net of
 *  the branch's own expenses. */
export type ShareBasis = 'gross' | 'net';

export interface FinanceSettings {
  /** MUST sum to 100 with branchSharePct — enforced by a table CHECK. */
  companySharePct: number;
  branchSharePct: number;
  shareBasis: ShareBasis;
  /** The book's starting position, before any ledger entry exists. */
  openingCashBalance: number;
  openingBankBalance: number;
  openingBalanceDate: string | null;
  /** Pull approved branch closings into the pending-income list automatically. */
  autoImportBranchIncome: boolean;
  /** Insert the Admin-verifies step between import and Finance approval. */
  requireAdminVerification: boolean;
  /** Grants Super Admin write access to finance records. Off by default. */
  allowSuperAdminWrite: boolean;
  updatedAt: string;
  updatedBy: string;
}

export const DEFAULT_FINANCE_SETTINGS = {
  companySharePct: 75,
  branchSharePct: 25,
  shareBasis: 'gross',
  openingCashBalance: 0,
  openingBankBalance: 0,
  autoImportBranchIncome: true,
  requireAdminVerification: true,
  allowSuperAdminWrite: false,
} as const;

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export type FinanceAuditAction =
  | 'created'
  | 'updated'
  | 'submitted'
  | 'verified'
  | 'approved'
  | 'rejected'
  | 'posted'
  | 'reversed'
  | 'adjusted'
  | 'locked'
  | 'imported'
  | 'settings_updated'
  | 'salary_revised'
  | 'resigned'
  | 'resignation_cancelled'
  | 'resolved'
  // §12. Two actions, not one: 'reopened' is an Admin overturning a resolution
  // and IS a change to the query; 'reopen_requested' is the raiser disputing it
  // and changes nothing but the thread. Collapsing them would make the trail
  // unable to answer "who actually reopened this", which is the question §12
  // exists to keep answerable.
  | 'reopened'
  | 'reopen_requested'
  | 'deleted'
  // Migration 106 — the query as a fed record.
  | 'amended'
  | 'restored'
  | 'recreated';

export type FinanceAuditEntity =
  | 'ledger_entry'
  | 'ledger_head'
  | 'finance_transaction'
  | 'income_approval'
  | 'salary_payment'
  | 'employee_advance'
  | 'partner_expense'
  | 'employee'
  | 'day_closing'
  | 'settings'
  | 'branch_share_payment'
  | 'finance_partner'
  | 'finance_ticket'
  // Migration 118 — approve / reject of a branch cash transfer.
  | 'cash_transfer';

export interface FinanceAuditLog {
  id: string;
  entity: FinanceAuditEntity;
  entityId: string | null;
  /** Human handle for the row — voucher no, salary no, reference no. */
  entityRef: string | null;
  action: FinanceAuditAction;
  actorId: string | null;
  actorName: string;
  actorRole: string | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ipAddress: string | null;
  deviceInfo: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const FINANCE_REPORT_TYPES = [
  'daily_cash_book',
  'general_ledger',
  'income_statement',
  'expense_report',
  'profit_loss',
  'company_share',
  'branch_share',
  'salary',
  'partner_expense',
  'trial_balance',
] as const;

export type FinanceReportType = (typeof FINANCE_REPORT_TYPES)[number];

export const FINANCE_REPORT_LABELS: Record<FinanceReportType, string> = {
  daily_cash_book: 'Daily Cash Book',
  general_ledger: 'General Ledger',
  income_statement: 'Income Statement',
  expense_report: 'Expense Report',
  profit_loss: 'Profit & Loss',
  company_share: 'Company Share Report',
  branch_share: 'Branch Share Report',
  salary: 'Salary Report',
  partner_expense: 'Partner Expense Report',
  trial_balance: 'Trial Balance',
};

export type ReportCellFormat = 'text' | 'money' | 'number' | 'date';

export interface FinanceReportColumn {
  key: string;
  label: string;
  format?: ReportCellFormat;
  align?: 'left' | 'right' | 'center';
  /** Relative width hint, used by the PDF/Excel writers. */
  width?: number;
}

/**
 * One shape for all ten reports.
 *
 * The alternative — ten bespoke response types with ten bespoke PDF writers and
 * ten bespoke Excel writers — is thirty places to fix a column. A report is a
 * title, some columns, some rows and some totals; the export layer needs to know
 * nothing else, which is why `exportFinanceReport` can render any of them.
 */
export interface FinanceReport {
  type: FinanceReportType;
  title: string;
  subtitle: string;
  periodFrom: string;
  periodTo: string;
  generatedAt: string;
  generatedBy: string;
  columns: FinanceReportColumn[];
  rows: Record<string, string | number | null>[];
  /** Column key → total, rendered as a bold footer row. */
  totals: Record<string, number>;
  /** Headline figures printed above the table. */
  summary: { label: string; value: number; format?: ReportCellFormat }[];
  /**
   * Present only for the row-level reports (cash book, general ledger, expense
   * report, share reports, salary, partner expense) when the caller asked for
   * a page — `rows` above is then one page, but `total` is the FILTERED count
   * across the whole period (totals/summary are always computed over the full
   * set, never just the visible page). Absent for the aggregated reports
   * (income statement, P&L, trial balance), which always return every row.
   */
  pagination?: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean };
}

export interface FinanceReportQuery {
  type: FinanceReportType;
  from?: string;
  to?: string;
  branchId?: string;
  ledgerHeadId?: string;
  partnerName?: string;
  employeeId?: string;
  department?: string;
  salaryMonth?: string;
}

export type FinanceExportFormat = 'pdf' | 'excel' | 'csv';

// ---------------------------------------------------------------------------
// Finance Help Desk
//
// A query an Accountant or Finance Manager raises against a finance record, and
// the Finance Admin's resolution of it. Kept separate from the admin Support
// Center (`support.types.ts`) on purpose — see migration 60 for why.
// ---------------------------------------------------------------------------

/**
 * The finance records a query can be raised against, each keyed to the table it
 * lives in and the column carrying its human reference number. The API resolves
 * a typed reference number (RV-000001, SAL-000012, …) through this map, so the
 * raiser never has to say which kind of record they mean.
 *
 * `altPrefixes` exists because one table can carry more than one number series.
 * `ledger_entries` carries three: RV- receipts and PV- payments (migration 71),
 * plus every FV- voucher issued before that split — those rows still exist and
 * are still what an old report or an open ticket cites, so the Help Desk has to
 * keep resolving them. Order matters only for display: `prefix` is the one shown
 * as the example.
 */
export const FINANCE_TICKET_REFERENCES = {
  ledger_entry:         { prefix: 'RV',  altPrefixes: ['PV', 'FV'], table: 'ledger_entries',           refColumn: 'voucher_no',   label: 'Ledger Voucher' },
  income_approval:      { prefix: 'INC', table: 'finance_income_approvals', refColumn: 'reference_no', label: 'Branch Income' },
  finance_transaction:  { prefix: 'FTX', table: 'finance_transactions',     refColumn: 'txn_no',       label: 'Transaction' },
  salary_payment:       { prefix: 'SAL', table: 'salary_payments',          refColumn: 'salary_no',    label: 'Salary Payment' },
  employee_advance:     { prefix: 'ADV', table: 'employee_advances',         refColumn: 'advance_no',   label: 'Employee Advance' },
  partner_expense:      { prefix: 'PEX', table: 'partner_expenses',         refColumn: 'expense_no',   label: 'Partner Expense' },
  branch_share_payment: { prefix: 'BSP', table: 'branch_share_payments',    refColumn: 'payment_no',   label: 'Branch Share' },
  // §15's Sale ID (migration 96). The only referencable record here that is not
  // a finance document: it resolves and snapshots like the rest, and is
  // INFORMATIONAL ONLY — `FINANCE_AMENDABLE_FIELDS.order` is empty, which every
  // layer reads as "nothing here can be changed from this desk". A sale is
  // corrected in the Support Center, through `edit_sale_items`, which rewrites
  // the lines and reconciles stock; a second path to the same rewrite is the
  // duplicate support architecture the brief rules out.
  order:                { prefix: 'MB',  table: 'orders',                   refColumn: 'order_number', label: 'Sale' },
  // Migration 120: a branch handover (118). Amendable — amount, method and
  // note — and deletable; an approved one's RV- receipt is reversed and
  // re-posted by the SQL rather than edited.
  cash_transfer:        { prefix: 'CT',  table: 'cash_transfers',           refColumn: 'transfer_no',  label: 'Cash Transfer' },
} as const;

export type FinanceTicketReferenceType = keyof typeof FINANCE_TICKET_REFERENCES;

/**
 * Every prefix a raiser may legitimately type, primary and alternate alike.
 * Derived, so adding a series is one edit to the map above — the Help Desk regex
 * and the "expected one of" error both read this rather than their own list.
 */
export const FINANCE_TICKET_PREFIXES: string[] = Object.values(FINANCE_TICKET_REFERENCES).flatMap(
  (r) => [r.prefix, ...(('altPrefixes' in r ? r.altPrefixes : []) as readonly string[])],
);

export const FINANCE_TICKET_REFERENCE_LABELS: Record<FinanceTicketReferenceType, string> = {
  ledger_entry: 'Ledger Voucher',
  income_approval: 'Branch Income',
  finance_transaction: 'Transaction',
  salary_payment: 'Salary Payment',
  employee_advance: 'Employee Advance',
  partner_expense: 'Partner Expense',
  branch_share_payment: 'Branch Share',
  order: 'Sale',
  cash_transfer: 'Cash Transfer',
};

/**
 * Reference-number prefix → the record type it identifies. Derived, never
 * hand-written. Alternate prefixes map to the same type as their primary, which
 * is what lets RV-, PV- and FV- all resolve to `ledger_entry`.
 */
export const FINANCE_TICKET_PREFIX_MAP: Record<string, FinanceTicketReferenceType> = Object.fromEntries(
  (Object.keys(FINANCE_TICKET_REFERENCES) as FinanceTicketReferenceType[]).flatMap((k) => {
    const ref = FINANCE_TICKET_REFERENCES[k];
    const alts = ('altPrefixes' in ref ? ref.altPrefixes : []) as readonly string[];
    return [ref.prefix, ...alts].map((p) => [p, k] as const);
  }),
);

/**
 * The seven states a Help Desk query moves through (migrations 94, 95).
 *
 * Stored lowercase like every other status in this module; the brief writes them
 * UPPER_SNAKE, which is a display convention and lives in the labels below.
 *
 *   open                → raised, nobody has picked it up
 *   under_review        → an admin is investigating the reference
 *   waiting_for_finance → the admin has asked the raiser something
 *   reopened            → a resolved query was disputed and is live again
 *   resolved            → dealt with, correction applied or explained
 *   rejected            → not an error, or out of scope
 *   closed              → finished and filed
 *
 * `waiting_for_finance` was `waiting_for_information` until migration 95 renamed
 * the value in place. It names who is being waited ON, which is what a queue's
 * status is for; the old spelling named what was being waited FOR and read the
 * same whichever side was holding things up.
 */
export type FinanceTicketStatus =
  | 'draft'
  | 'open'
  | 'under_review'
  | 'waiting_for_finance'
  | 'amended'
  | 'reopened'
  | 'resolved'
  | 'rejected'
  | 'closed';

export const FINANCE_TICKET_STATUSES = [
  'draft',
  'open',
  'under_review',
  'waiting_for_finance',
  'amended',
  'reopened',
  'resolved',
  'rejected',
  'closed',
] as const satisfies readonly FinanceTicketStatus[];

/**
 * Display labels. `open` reads as PENDING and `under_review` as IN REVIEW —
 * the brief's words (migration 106) — while the stored values keep the spelling
 * every audit row and notification written before it already uses.
 */
export const FINANCE_TICKET_STATUS_LABELS: Record<FinanceTicketStatus, string> = {
  draft: 'Draft',
  open: 'Pending',
  under_review: 'In Review',
  waiting_for_finance: 'Waiting for Finance',
  amended: 'Amended',
  reopened: 'Reopened',
  resolved: 'Resolved',
  rejected: 'Rejected',
  closed: 'Closed',
};

/**
 * The legal status moves for PATCH /:id/status — one table, shared by the
 * route that enforces it and the buttons that offer it.
 *
 * Three moves are deliberately absent: INTO `draft` (a query is drafted at
 * creation and never returns), OUT of `draft` (POST /:id/submit, which stamps
 * `submittedAt` and notifies the Admin), INTO `amended` (POST /:id/amend-query,
 * which writes the version) and INTO `reopened` (POST /:id/reopen, which
 * archives the resolution). Each of those has to do something a bare status
 * change does not, and listing them here would be a second door that skips it.
 */
export const FINANCE_TICKET_TRANSITIONS: Record<FinanceTicketStatus, readonly FinanceTicketStatus[]> = {
  draft: [],
  open: ['under_review', 'resolved', 'rejected'],
  under_review: ['waiting_for_finance', 'resolved', 'rejected'],
  waiting_for_finance: ['under_review', 'resolved', 'rejected'],
  amended: ['under_review', 'waiting_for_finance', 'resolved', 'rejected'],
  reopened: ['under_review', 'waiting_for_finance', 'resolved', 'rejected'],
  resolved: ['closed'],
  rejected: ['closed'],
  closed: [],
};

/** The statuses a query may be REOPENED from — the terminal three. */
export const FINANCE_TICKET_REOPENABLE_STATUSES = [
  'resolved',
  'rejected',
  'closed',
] as const satisfies readonly FinanceTicketStatus[];

/**
 * The statuses that END a query.
 *
 * `finance_tickets_resolution_check` (migration 95) requires exactly these to
 * carry a `resolvedAt`, and every other status to carry none.
 *
 * A terminal query is not immovable: migration 95 added REOPEN (§12), which is
 * the one way out and goes through its own endpoint rather than the status
 * table, because it has to archive the resolution it is undoing before it clears
 * it. See {@link FinanceTicketResolution}.
 */
export const FINANCE_TICKET_TERMINAL_STATUSES = [
  'resolved',
  'rejected',
  'closed',
] as const satisfies readonly FinanceTicketStatus[];

export function isFinanceTicketTerminal(status: FinanceTicketStatus): boolean {
  return (FINANCE_TICKET_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The statuses a query is still LIVE in — the complement of the terminal three.
 *
 * Used by the dashboard cards and by the Support Center's badge count, both of
 * which had the list written out inline and would have silently excluded
 * `reopened` when migration 95 added it.
 */
export const FINANCE_TICKET_LIVE_STATUSES = [
  'open',
  'under_review',
  'waiting_for_finance',
  'amended',
  'reopened',
] as const satisfies readonly FinanceTicketStatus[];

/** Live = on the Admin's desk. A draft is neither live nor terminal: it is not sent yet. */
export function isFinanceTicketLive(status: FinanceTicketStatus): boolean {
  return status !== 'draft' && !isFinanceTicketTerminal(status);
}

/**
 * What the query is ABOUT, as chosen by the raiser — the brief's Category.
 *
 * Deliberately not the same axis as {@link FinanceTicketReferenceType}, which is
 * DERIVED from the reference number's prefix and says which table the record
 * lives in. This says what kind of problem the raiser thinks they have — and
 * 'calculation_issue' and 'other' routinely name no record at all, which is why
 * a reference is optional from migration 94 onwards.
 *
 * 'company_share' and 'branch_share' are separate for the same reason the
 * records are: a branch share payment settles what a BRANCH is owed, a company
 * share is the house's own cut of the same split.
 */
export type FinanceQueryType =
  | 'income'
  | 'expense'
  | 'company_transaction'
  | 'partner_advance'
  | 'company_share'
  | 'branch_share'
  | 'salary'
  | 'ledger'
  | 'payment'
  | 'stock_finance_difference'
  | 'calculation_issue'
  | 'other';

/**
 * In the brief's order, which is the order the New Query dropdown shows.
 *
 * 'calculation_issue' is last and is NOT in the brief's list: queries raised
 * before migration 95 carry it, so it stays selectable rather than becoming a
 * value the UI can display but not re-pick.
 */
export const FINANCE_QUERY_TYPES = [
  'income',
  'expense',
  'company_transaction',
  'partner_advance',
  'company_share',
  'branch_share',
  'salary',
  'ledger',
  'payment',
  'stock_finance_difference',
  'other',
  'calculation_issue',
] as const satisfies readonly FinanceQueryType[];

export const FINANCE_QUERY_TYPE_LABELS: Record<FinanceQueryType, string> = {
  income: 'Income',
  expense: 'Expense',
  company_transaction: 'Company Transaction',
  partner_advance: 'Partner Advance',
  company_share: 'Company Share',
  branch_share: 'Branch Share',
  salary: 'Salary',
  ledger: 'Ledger',
  payment: 'Payment',
  stock_finance_difference: 'Stock / Finance Related',
  calculation_issue: 'Calculation Issue',
  other: 'Other',
};

/**
 * `normal` was `medium` until migration 95 renamed the value in place — the
 * brief writes the four levels Low / Normal / High / Urgent.
 */
export type FinanceQueryPriority = 'low' | 'normal' | 'high' | 'urgent';

export const FINANCE_QUERY_PRIORITIES = [
  'low',
  'normal',
  'high',
  'urgent',
] as const satisfies readonly FinanceQueryPriority[];

export const FINANCE_QUERY_PRIORITY_LABELS: Record<FinanceQueryPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/** Sort weight — urgent first. Used by the admin queue and the priority filter. */
export const FINANCE_QUERY_PRIORITY_RANK: Record<FinanceQueryPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * §11's Resolution Type — what KIND of answer closed the query, as distinct from
 * the status, which says only that it closed.
 *
 * Both are needed and neither derives the other: 'rejected' and 'duplicate' both
 * end in the REJECTED status, and a query resolved because the figure was
 * corrected ('fixed') reads very differently in a report from one resolved
 * because the figure was right all along ('information_provided'). The status
 * drives the workflow; this drives the reporting.
 */
export type FinanceResolutionType =
  | 'fixed'
  | 'information_provided'
  | 'rejected'
  | 'duplicate'
  | 'other';

export const FINANCE_RESOLUTION_TYPES = [
  'fixed',
  'information_provided',
  'rejected',
  'duplicate',
  'other',
] as const satisfies readonly FinanceResolutionType[];

export const FINANCE_RESOLUTION_TYPE_LABELS: Record<FinanceResolutionType, string> = {
  fixed: 'Fixed',
  information_provided: 'Information Provided',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
  other: 'Other',
};

/**
 * One resolution a query has already had, archived when it was REOPENED (§12).
 *
 * Appended to `finance_tickets.resolution_history` by POST /:id/reopen in the
 * same UPDATE that clears the live resolution, so the answer being disputed is
 * on the record before it stops being the current one. Never edited, never
 * removed — reopening a query three times leaves three of these, oldest first.
 */
export interface FinanceTicketResolution {
  /** The terminal status this resolution put the query into. */
  status: FinanceTicketStatus;
  resolutionType: FinanceResolutionType | null;
  resolutionNote: string | null;
  adminResponse: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  /** When, and by whom, this resolution was overturned. */
  reopenedAt: string;
  reopenedByName: string;
  reopenReason: string;
}

export interface FinanceTicket {
  id: string;
  /**
   * The brief's Query ID — `FIN-QRY-2026-000124`, a per-year series that never
   * restarts within the year and is never reissued, deleted or not (migration
   * 106).
   *
   * Issued by the DATABASE (`app.next_finance_query_no()`, the column's
   * default), never by the client. Queries raised earlier keep the number they
   * were given — `FQ-000001` (migration 60) or `FIN-Q-20260901-0001` (94) —
   * instead of being renumbered: the old number is quoted in resolution notes
   * and audit rows that already exist, and renumbering would orphan every one.
   */
  queryNo: string;
  /** The pre-migration-94 number. Kept for those existing rows; never displayed. */
  ticketNo: string;

  queryType: FinanceQueryType;
  priority: FinanceQueryPriority;

  /** Null for a query that names no record — a calculation issue, say. */
  referenceType: FinanceTicketReferenceType | null;
  /** Null when the referenced row has since been removed; the snapshot survives. */
  referenceId: string | null;
  referenceNo: string | null;
  /**
   * The brief's separate "Ledger/Voucher ID" field: a secondary handle the
   * raiser cites when it differs from the reference. Never resolved, only shown.
   */
  voucherRef: string | null;
  /** The record's figures as they stood when the query was raised. */
  referenceSnapshot: Record<string, unknown> | null;

  subject: string;
  message: string;
  status: FinanceTicketStatus;

  /**
   * The figure the query is ABOUT, as stated on the query (migration 106).
   * Correcting it corrects the QUERY. It never writes to the record behind the
   * query — that path is `amend_finance_record`, with its own reason and row.
   */
  amount: number | null;
  branchId: string | null;
  branchName: string | null;
  /** The business day the query concerns, `YYYY-MM-DD`. */
  businessDate: string | null;
  remarks: string | null;
  /** The brief's Transaction / Expense / Income IDs — free-text handles, never resolved. */
  transactionRef: string | null;
  expenseRef: string | null;
  incomeRef: string | null;

  /**
   * Which version of the query this row is. 1 on creation; every change that
   * writes a {@link FinanceTicketVersion} bumps it.
   */
  version: number;
  /** Null while a draft. Every pre-106 query was submitted when created. */
  submittedAt: string | null;

  /** §6 amend stamps. */
  amendCount: number;
  amendedAt: string | null;
  amendedByName: string | null;

  /** §9 — set on the NEW query, pointing at the one it replaced. */
  recreatedFromId: string | null;
  recreatedFromQueryNo: string | null;
  /** §9 — set on the OLD query, pointing at its replacement. */
  recreatedAsId: string | null;
  recreatedAsQueryNo: string | null;

  /** §8 restore stamps — set when a deleted query is brought back. */
  restoredAt: string | null;
  restoredByName: string | null;
  restoreReason: string | null;

  /** The admin's written answer, distinct from the closing `resolutionNote`. */
  adminResponse: string | null;
  respondedBy: string | null;
  respondedByName: string | null;
  respondedAt: string | null;
  resolutionNote: string | null;
  /** §11's Resolution Type. Null until the query reaches a terminal status. */
  resolutionType: FinanceResolutionType | null;
  /**
   * §11's Resolution Amount — what the Admin says the correct figure is. A
   * statement on the query for the raiser to read; never a write to the books.
   */
  resolutionAmount: number | null;
  /**
   * §6's internal note — the admin's working notes. Returned to an Admin only;
   * `rowToApi` drops it for a Finance caller rather than relying on the UI not
   * to render it.
   */
  internalNote: string | null;

  assignedTo: string | null;
  assignedToName: string | null;
  assignedAt: string | null;

  /** Set when the raiser answers a `waiting_for_finance` query. */
  informationReceivedAt: string | null;

  raisedBy: string | null;
  raisedByName: string;
  raisedByRole: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;

  /**
   * Every resolution this query has already had, oldest first (§12, migration
   * 95). Empty until the first reopen; appended to, never rewritten.
   */
  resolutionHistory: FinanceTicketResolution[];
  /** `resolutionHistory.length`, denormalised so the queue can show it. */
  reopenCount: number;
  reopenedAt: string | null;
  reopenedByName: string | null;
  reopenReason: string | null;

  /** Soft delete (§10). Only an admin ever sees a stamped query. */
  deletedAt: string | null;
  deletedByName: string | null;
  deleteReason: string | null;

  createdAt: string;
  updatedAt: string;

  /** Populated by GET /api/finance/tickets/:id only — the list omits both. */
  messages?: FinanceTicketMessage[];
  amendments?: FinanceAmendment[];
  attachments?: Attachment[];
  /**
   * §14's Audit History — every change this query has been through, oldest
   * first, ready to render as a timeline. Populated by GET
   * /api/finance/tickets/:id only.
   *
   * Built by the server from two sources it already keeps (`finance_audit_logs`
   * for the query, `finance_amendments` for the records corrected under it)
   * rather than assembled in the client, because the two are ordered against
   * each other by timestamp and because one of them needs REDACTING for a
   * Finance caller — and a redaction the client performs is not one.
   */
  auditTrail?: FinanceTicketAuditEntry[];
}

/**
 * One field that moved, as the Audit History shows it.
 *
 * Both sides are strings: the trail stores whatever the column held — a number,
 * a status code, a note — and the timeline's job is to display it, not to
 * re-type it. `null` means the field was empty on that side, which reads as "—"
 * and is different from the empty string a cleared note leaves behind.
 */
export interface FinanceTicketAuditChange {
  /** Human label — "Priority", "Amount", "Resolution". Never a column name. */
  field: string;
  from: string | null;
  to: string | null;
}

/**
 * One line of §14's Audit History.
 *
 *     03:10 — Query Created
 *     03:15 — Admin Opened Query
 *     03:20 — Amount Amended        50,000 → 55,000
 *     03:25 — Query Resolved
 *
 * The conversation is deliberately NOT folded in here. A message is not a change
 * to the record, it is the discussion around one, and the popup already shows
 * the thread in full directly below — merging them would print every message
 * twice and bury the four lines that say what actually happened.
 */
export interface FinanceTicketAuditEntry {
  /** The underlying audit-log or amendment row's id; unique across both. */
  id: string;
  /**
   * Which trail the entry came from: `query` is a change to the Help Desk query
   * itself, `record` a correction to the finance record behind it. They are
   * different acts with different consequences — one moves a ticket, the other
   * moves the books — and §8 is about being able to tell them apart afterwards.
   */
  source: 'query' | 'record';
  at: string;
  /** The raw action, for colour-coding. `FinanceAuditAction | FinanceAmendmentAction`. */
  action: string;
  /** What happened, in the brief's own words — "Query Created", "Amount Amended". */
  summary: string;
  actorName: string;
  actorRole: string | null;
  /** Empty when the entry records an event rather than a field moving. */
  changes: FinanceTicketAuditChange[];
  /** §8's stated reason, when the action required one. */
  reason: string | null;
}

/** What produced a version of a query (migration 106). */
export type FinanceTicketVersionAction =
  | 'created'
  | 'submitted'
  | 'edited'
  | 'amended'
  | 'status_changed'
  | 'assigned'
  | 'responded'
  | 'resolved'
  | 'reopened'
  | 'deleted'
  | 'restored'
  | 'recreated'
  // Migration 129 — the linked record was corrected from the query (and the
  // query possibly resolved in the same transaction).
  | 'record_corrected';

export const FINANCE_TICKET_VERSION_ACTION_LABELS: Record<FinanceTicketVersionAction, string> = {
  created: 'Created',
  submitted: 'Submitted',
  edited: 'Edited',
  amended: 'Amended',
  status_changed: 'Status changed',
  assigned: 'Assigned',
  responded: 'Admin responded',
  resolved: 'Resolved',
  reopened: 'Reopened',
  deleted: 'Deleted',
  restored: 'Restored',
  recreated: 'Recreated',
  record_corrected: 'Record corrected',
};

/** One field that moved between two versions of a query. */
export interface FinanceTicketVersionChange {
  /** The API (camelCase) field name — `amount`, `remarks`, `status`. */
  field: string;
  /** Human label, for the history screen. */
  label: string;
  old: string | null;
  new: string | null;
}

/**
 * One version of a query — the brief's §7 View History.
 *
 *     Version 2 · Amended by Admin · 07-Sep-2026 07:35 PM
 *       Amount     15,000 → 16,500
 *       Remarks    Payment pending → Payment verified
 *       Reason: Corrected transaction amount
 *
 * `changes` is the diff that produced this version; `snapshot` is the whole
 * query as it stood AFTER it, so any version can be read on its own. Returned
 * by GET /api/finance/tickets/:id/history — lazily, not with the query, because
 * a history is read when someone asks for it and the detail screen is not.
 */
export interface FinanceTicketVersion {
  id: string;
  ticketId: string;
  queryNo: string;
  version: number;
  action: FinanceTicketVersionAction;
  changedBy: string | null;
  changedByName: string;
  changedByRole: string | null;
  changedAt: string;
  reason: string | null;
  changes: FinanceTicketVersionChange[];
  /** Redacted for a Finance caller: the internal note is removed. */
  snapshot: Record<string, unknown>;
}

/** GET /api/finance/tickets — one page of the queue. */
export interface FinanceTicketPage {
  tickets: FinanceTicket[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /api/finance/tickets/stats — the dashboard cards, counted in SQL. */
export interface FinanceTicketStats {
  total: number;
  draft: number;
  open: number;
  underReview: number;
  waiting: number;
  amended: number;
  reopened: number;
  resolved: number;
  rejected: number;
  closed: number;
  highPriority: number;
  urgent: number;
  unassigned: number;
  recent: number;
  deleted: number;
}

/**
 * The fields an Admin may FEED on a query — the one centralised edit form
 * (§4). Everything the raiser typed, plus the branch, the date and the amount.
 * Each is a column on finance_tickets; the labels are what the history prints.
 */
export const FINANCE_TICKET_FEED_FIELD_LABELS = {
  subject: 'Subject',
  queryType: 'Query type',
  priority: 'Priority',
  message: 'Description',
  amount: 'Amount',
  branchName: 'Branch',
  businessDate: 'Business date',
  remarks: 'Remarks',
  referenceNo: 'Reference ID',
  voucherRef: 'Ledger / Voucher ID',
  transactionRef: 'Transaction ID',
  expenseRef: 'Expense ID',
  incomeRef: 'Income ID',
} as const;

export type FinanceTicketFeedField = keyof typeof FINANCE_TICKET_FEED_FIELD_LABELS;

/**
 * Which reference handles a query type calls for (§2 — "only show
 * finance-related reference fields when required"). A type not listed shows
 * none beyond the resolvable Reference ID, which every type may carry.
 */
export const FINANCE_QUERY_TYPE_REFERENCE_FIELDS: Partial<
  Record<FinanceQueryType, readonly ('transactionRef' | 'expenseRef' | 'incomeRef' | 'voucherRef')[]>
> = {
  income: ['incomeRef', 'voucherRef'],
  expense: ['expenseRef', 'voucherRef'],
  company_transaction: ['transactionRef', 'voucherRef'],
  partner_advance: ['transactionRef', 'voucherRef'],
  company_share: ['transactionRef'],
  branch_share: ['transactionRef', 'incomeRef'],
  salary: ['transactionRef', 'voucherRef'],
  ledger: ['voucherRef'],
  payment: ['transactionRef', 'voucherRef'],
  stock_finance_difference: ['transactionRef'],
  calculation_issue: [],
  other: ['transactionRef', 'expenseRef', 'incomeRef', 'voucherRef'],
};

/**
 * One turn of the conversation on a query.
 *
 * Append-only in the database (migration 94): neither side can edit or delete a
 * message, admin included. A thread where a party can retract what they said is
 * not a record of a disagreement, and a disagreement about a financial
 * correction is exactly what the thread holds.
 */
export interface FinanceTicketMessage {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorName: string;
  authorRole: string | null;
  /**
   * Which SIDE of the desk spoke. Stored at write time from the JWT rather than
   * derived from `authorRole` at read time — deriving it would silently
   * reattribute the whole thread the day somebody changes role.
   */
  authorSide: 'finance' | 'admin';
  body: string;
  createdAt: string;
  attachments?: Attachment[];
}

/** The brief's verbs (§14), as recorded on an amendment. */
export type FinanceAmendmentAction = 'edit' | 'amend' | 'overwrite' | 'delete';

export const FINANCE_AMENDMENT_ACTION_LABELS: Record<FinanceAmendmentAction, string> = {
  edit: 'Edit',
  amend: 'Amend',
  overwrite: 'Overwrite',
  delete: 'Delete',
};

/**
 * One correction an admin made to the books, and the query that justified it.
 *
 * Complements `FinanceAuditLog` rather than duplicating it. The trail answers
 * "who did what, when, from where" across the whole module; this answers the
 * narrower question an auditor asks out loud — "show me every correction ever
 * made to a finance record, with the reason and the query behind it" — which is
 * a report, not a filter over a JSON blob.
 */
export interface FinanceAmendment {
  id: string;
  ticketId: string;
  queryNo: string;
  referenceType: FinanceTicketReferenceType;
  referenceId: string | null;
  referenceNo: string;
  action: FinanceAmendmentAction;
  /** API (camelCase) field name, so the record reads like the screen that made it. */
  field: string;
  originalValue: string | null;
  newValue: string | null;
  /** Null when either side is not a number — a description change has no delta. */
  difference: number | null;
  reason: string;
  adminId: string | null;
  adminName: string;
  ipAddress: string | null;
  createdAt: string;
}

/**
 * A field an admin may amend on a referenced record, per record type.
 *
 * This list is a MIRROR of the `case` arms in `amend_finance_record()`
 * (migration 94) and, for a voucher and a transaction, of the fields
 * `amend_finance_record_fields()` accepts (migration 130) — it decides which
 * inputs the admin's correction form renders, and the function decides, again,
 * whether to honour what comes back. Adding a field
 * here without adding it there produces an input that 400s; the reverse produces
 * a capability nobody can reach. The database is the boundary; this is the form.
 *
 * Derived columns are absent on purpose. `netSalary`, `totalAmount` and the two
 * income shares each have a definition, and letting them be set directly would
 * produce a row that either fails its own CHECK or, worse, passes and is wrong.
 */
export interface FinanceAmendableField {
  key: string;
  label: string;
  /**
   * 'select' offers `options` rather than a free input (migration 120).
   * 'date' is `YYYY-MM-DD`; 'head' is a ledger head id of the record's own
   * type; 'branch' is a branch id, or blank for company-wide (migration 130).
   */
  kind: 'money' | 'text' | 'select' | 'date' | 'head' | 'branch';
  /** True when changing it re-posts the linked voucher (reversal + correction). */
  movesLedger: boolean;
  options?: readonly { value: string; label: string }[];
}

const FINANCE_PAYMENT_METHOD_OPTIONS = FINANCE_PAYMENT_METHODS.map((m) => ({
  value: m as string,
  label: FINANCE_PAYMENT_METHOD_LABELS[m] ?? m,
}));
const FINANCE_ACCOUNT_OPTIONS = FINANCE_ACCOUNTS.map((a) => ({ value: a as string, label: FINANCE_ACCOUNT_LABELS[a] }));

export const FINANCE_AMENDABLE_FIELDS: Record<FinanceTicketReferenceType, FinanceAmendableField[]> = {
  // A voucher and a transaction are correctable in every field but their type
  // (migration 130): all the changes of one correction are posted as ONE
  // reversal and ONE corrected entry. Income ↔ Expense is absent because the
  // type decides the side of the book; the category may move within its type.
  ledger_entry: [
    { key: 'amount', label: 'Amount', kind: 'money', movesLedger: true },
    { key: 'entryDate', label: 'Entry date', kind: 'date', movesLedger: true },
    { key: 'ledgerHeadId', label: 'Category', kind: 'head', movesLedger: true },
    { key: 'branchId', label: 'Branch', kind: 'branch', movesLedger: true },
    { key: 'paymentMethod', label: 'Payment method', kind: 'select', movesLedger: true, options: FINANCE_PAYMENT_METHOD_OPTIONS },
    { key: 'account', label: 'Account', kind: 'select', movesLedger: true, options: FINANCE_ACCOUNT_OPTIONS },
    { key: 'description', label: 'Description', kind: 'text', movesLedger: true },
  ],
  finance_transaction: [
    { key: 'amount', label: 'Amount', kind: 'money', movesLedger: true },
    { key: 'businessDate', label: 'Business date', kind: 'date', movesLedger: true },
    { key: 'ledgerHeadId', label: 'Category', kind: 'head', movesLedger: true },
    { key: 'branchId', label: 'Branch', kind: 'branch', movesLedger: true },
    { key: 'paymentMethod', label: 'Payment method', kind: 'select', movesLedger: true, options: FINANCE_PAYMENT_METHOD_OPTIONS },
    { key: 'account', label: 'Account', kind: 'select', movesLedger: true, options: FINANCE_ACCOUNT_OPTIONS },
    { key: 'description', label: 'Description', kind: 'text', movesLedger: true },
  ],
  salary_payment: [
    { key: 'grossSalary', label: 'Gross Salary', kind: 'money', movesLedger: true },
    { key: 'bonus', label: 'Bonus', kind: 'money', movesLedger: true },
    { key: 'deductions', label: 'Deductions', kind: 'money', movesLedger: true },
  ],
  employee_advance: [
    { key: 'advanceAmount', label: 'Advance', kind: 'money', movesLedger: true },
    { key: 'bonusAmount', label: 'Bonus', kind: 'money', movesLedger: true },
    { key: 'loanAmount', label: 'Loan', kind: 'money', movesLedger: true },
  ],
  partner_expense: [
    { key: 'amount', label: 'Amount', kind: 'money', movesLedger: true },
    { key: 'description', label: 'Description', kind: 'text', movesLedger: false },
  ],
  branch_share_payment: [
    { key: 'amount', label: 'Share Amount', kind: 'money', movesLedger: true },
    { key: 'bonus', label: 'Bonus', kind: 'money', movesLedger: true },
  ],
  income_approval: [
    { key: 'totalAmount', label: 'Total Income', kind: 'money', movesLedger: false },
    { key: 'branchExpenses', label: 'Branch Expenses', kind: 'money', movesLedger: false },
  ],
  /**
   * A sale is REFERENCABLE but not amendable from this desk (migration 96).
   *
   * Empty rather than absent: `Record<FinanceTicketReferenceType, …>` makes the
   * next reference type a compile error until somebody decides this question
   * for it, which is the point. Correcting a sale rewrites `order_items`,
   * recomputes the order's totals, moves the customer's spend and reconciles
   * branch stock — `edit_sale_items`, from the Support Center — and a second
   * route into that is a second thing to keep correct.
   */
  order: [],
  /**
   * A branch deposit (migrations 120, 121). The four figures re-post the
   * receipt of the slice they change when the deposit is approved; a pending
   * one is corrected in place and Finance approves the corrected figures. The
   * Total is absent: it is Cash + Easypaisa + Bank, recomputed in SQL. The
   * photo is not a field: it is evidence of the handover and is never rewritten.
   */
  cash_transfer: [
    { key: 'cashAmount', label: 'Cash', kind: 'money', movesLedger: true },
    { key: 'easypaisaAmount', label: 'Easypaisa', kind: 'money', movesLedger: true },
    { key: 'bankAmount', label: 'Bank', kind: 'money', movesLedger: true },
    { key: 'fuelCharges', label: 'Fuel Charges', kind: 'money', movesLedger: true },
    { key: 'note', label: 'Deposit note', kind: 'text', movesLedger: false },
  ],
};

/**
 * May the Help Desk change the record behind a query at all?
 *
 * One test, read by the UI (which button to offer), by the amend route and by
 * the delete-record route — so a reference that is informational stays
 * informational at every layer instead of at whichever ones remembered.
 *
 * A query with no reference answers `false` too: there is no record to touch.
 */
export function isFinanceRecordAmendable(
  referenceType: FinanceTicketReferenceType | null | undefined,
): boolean {
  if (!referenceType) return false;
  return (FINANCE_AMENDABLE_FIELDS[referenceType] ?? []).length > 0;
}

/**
 * The current value of an amendable field, read from the record as the API
 * returns it (camelCase). Mirrors what `amend_finance_record` reads as the
 * "original value", so the correction form shows — and sends back as
 * `expected` — the same figure the database will compare against.
 *
 * Only a ledger entry differs from a plain column read: it has no `amount`,
 * it has a debit and a credit, and its amount is whichever side is non-zero.
 */
export function financeAmendableValue(
  referenceType: FinanceTicketReferenceType,
  record: Record<string, unknown> | null | undefined,
  field: string,
): string {
  if (!record) return '';
  if (referenceType === 'ledger_entry' && field === 'amount') {
    const debit = Number(record['debit'] ?? 0);
    const credit = Number(record['credit'] ?? 0);
    return String(debit > 0 ? debit : credit);
  }
  const raw = record[field];
  return raw === null || raw === undefined ? '' : String(raw);
}

// ---------------------------------------------------------------------------
// Who may do what on the Help Desk
// ---------------------------------------------------------------------------

/**
 * The Help Desk's own permission axis.
 *
 *   report  — raise a query, reply to one, attach a document, mark info received
 *   respond — answer, assign, move the status, resolve, reject, close
 *   modify  — edit, amend, overwrite or delete the FINANCE RECORD behind it
 */
export type FinanceHelpDeskPermission = 'view' | 'report' | 'respond' | 'modify';

/**
 * ADMIN, and only Admin, may change the books through the Help Desk.
 *
 * This is the brief's §6/§21 stated once, in the one place both the UI and the
 * API read it from. `super_admin` is the whole of the admin side; every Finance
 * role — `finance_admin` included — is on the reporting side.
 *
 * That last part is a deliberate reversal of migration 60, which gave the queue
 * to `finance_admin`, and it is worth knowing why rather than discovering it: §3
 * of the brief says a query must not go to another Finance user first, and a
 * finance_admin is a Finance-module account. Its authority over the BOOKS
 * elsewhere — approving a voucher, posting an entry — is untouched by this; only
 * the Help Desk moved.
 *
 * Note what this function does NOT consult: `allowSuperAdminWrite`. That toggle
 * (Finance Settings, off by default) guards a super admin writing to finance
 * OUTSIDE this queue. The Help Desk is the sanctioned, audited channel for
 * exactly those corrections — every one of them carries a Query ID and an
 * amendment record — so gating it on a flag that ships off would leave every
 * query unanswerable on a fresh install.
 *
 * NOT A SECURITY BOUNDARY on the client. It decides which buttons render;
 * `requireFinanceHelpDeskAdmin()` on the API decides the same thing again from
 * the JWT, which is where the real answer lives.
 */
export function financeHelpDeskCan(
  role: UserRole | string | null | undefined,
  permission: FinanceHelpDeskPermission,
): boolean {
  if (role === 'super_admin') return true;
  if (!isFinanceRole(role)) return false;

  // A Read Only Auditor sees the queue and says nothing into it — the same
  // shape their access takes everywhere else in the module.
  if (role === 'finance_auditor') return permission === 'view';

  return permission === 'view' || permission === 'report';
}

/** Everyone who may open the Help Desk at all. */
export function canAccessFinanceHelpDesk(role: UserRole | string | null | undefined): boolean {
  return financeHelpDeskCan(role, 'view');
}

/** What GET /api/finance/tickets/lookup returns for a reference number. */
export interface FinanceTicketReferenceLookup {
  referenceType: FinanceTicketReferenceType;
  referenceId: string;
  referenceNo: string;
  label: string;
  snapshot: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Monthly Finance Dashboard (migration 128) — GET /api/finance/dashboard/monthly
// ---------------------------------------------------------------------------

/**
 * One (business date, branch) of production income and receipts. `branchId`
 * null = not attributed to a branch (an unassigned receipt). Every amount is a
 * server-side sum; see docs/finance-dashboard-audit.md for each source.
 */
export interface FinanceDashboardDay {
  date: string;
  branchId: string | null;
  /** Σ approved_qty × product price over Production-reviewed orders. */
  demand: number;
  /** Demand × the branch's company share %, rounded per order. */
  companyShare: number;
  /** Live ledger income on Company Share / Fuel heads + Cash Deposit postings. */
  received: number;
  /** Accepted production returns, qty × product price. */
  returns: number;
  /** Approved production (branch) discounts. */
  discount: number;
  orders: number;
  /** Delivered lines whose product has no price — valued at 0. */
  unpricedLines: number;
  receipts: number;
  returnCount: number;
  discountCount: number;
}

/** One (business date, branch, ledger head) of approved company expense. */
export interface FinanceDashboardLedgerRow {
  date: string;
  branchId: string | null;
  ledgerHeadId: string;
  /** The head's current Admin-defined name. */
  ledgerHeadName: string;
  /** credit − debit, so a reversal nets out. */
  amount: number;
  entries: number;
}

export interface FinanceDashboardMonthTrend {
  month: string;
  demand: number;
  companyShare: number;
  received: number;
  balance: number;
  returns: number;
  discount: number;
}

/** A branch's balance for the previous business month; null = no records that month. */
export interface FinanceDashboardPreviousBalance {
  branchId: string | null;
  balance: number | null;
}

export interface FinanceMonthlyDashboardSummary {
  demand: number;
  companyShare: number;
  received: number;
  /** companyShare − received. */
  balance: number;
  /** The previous month's balance for the same scope; null when it had no records. */
  lastMonthBalance: number | null;
  ledgerExpense: number;
  returns: number;
  discount: number;
  orders: number;
  receipts: number;
  ledgerEntries: number;
  returnCount: number;
  discountCount: number;
  unpricedLines: number;
  /** finance_ledger_totals over the same window — the ledger's own totals. */
  ledgerIncome: number;
  ledgerExpenseTotal: number;
  ledgerNet: number;
}

export interface FinanceMonthlyDashboard {
  month: string;
  previousMonth: string;
  from: string;
  to: string;
  branchId: string | null;
  businessDate: string;
  generatedAt: string;
  /** Every branch (Admin names), including inactive ones that still carry history. */
  branches: { id: string; name: string; isActive: boolean }[];
  summary: FinanceMonthlyDashboardSummary;
  days: FinanceDashboardDay[];
  ledger: FinanceDashboardLedgerRow[];
  previous: FinanceDashboardPreviousBalance[];
  /** The six business months ending at `month`, whole months, oldest first. */
  trend: FinanceDashboardMonthTrend[];
}

export const FINANCE_DASHBOARD_METRICS = ['demand', 'share', 'received', 'ledger', 'return', 'discount'] as const;
export type FinanceDashboardMetric = (typeof FINANCE_DASHBOARD_METRICS)[number];

/** One source record behind a dashboard figure. */
export interface FinanceDashboardRecord {
  id: string;
  /** Demand number, voucher number — whatever the source calls itself. */
  reference: string | null;
  date: string;
  branchId: string | null;
  branchName: string | null;
  source: string;
  detail: string | null;
  status: string;
  amount: number;
  createdBy: string | null;
  approvedBy: string | null;
}

export interface FinanceDashboardRecordsPage {
  total: number;
  /** Sum over every matching record, not just this page. */
  amount: number;
  page: number;
  pageSize: number;
  rows: FinanceDashboardRecord[];
}

// ---------------------------------------------------------------------------
// Pending approvals — GET /api/finance/pending-approvals
// ---------------------------------------------------------------------------

/** Which approval queue a pending document sits in — and so which screen decides it. */
export type FinancePendingApprovalKind = 'transaction' | 'partner_expense' | 'salary' | 'advance';

export const FINANCE_PENDING_APPROVAL_LABELS: Record<FinancePendingApprovalKind, string> = {
  transaction: 'Income / Expense',
  partner_expense: 'Partner Expense',
  salary: 'Salary',
  advance: 'Employee Advance',
};

/**
 * One document waiting for approval. These are NOT in the ledger yet — a
 * document posts its voucher when it is approved — which is why the Daily
 * Ledger lists them separately, above the book, rather than as rows in it.
 */
export interface FinancePendingApproval {
  kind: FinancePendingApprovalKind;
  id: string;
  refNo: string;
  /** `YYYY-MM-DD` — the document's own business date, however old. */
  date: string;
  description: string;
  amount: number;
  status: FinanceDocStatus;
  raisedBy: string | null;
}
