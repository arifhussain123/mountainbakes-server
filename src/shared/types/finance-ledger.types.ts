import type {
  EmployeeResignation,
  FinanceAccount,
  FinanceDocStatus,
  FinanceEmployee,
  PartnerTxnKind,
} from './finance.types';

/**
 * The two read-only year ledgers: Salary Ledger and Company Transaction
 * Details.
 *
 * Neither is stored. Every figure here is computed from source records on each
 * read, and a record counts only when it is posted (or locked), not deleted,
 * and its voucher is still in the book. See the views `salary_ledger_payments`
 * and `partner_ledger_transactions`.
 */

/**
 * What one month cell is.
 *
 *   paid    — at least one counted record; `amount` is their sum
 *   unpaid  — a month the employee was on the payroll for, already over, with
 *             no counted salary
 *   closed  — after the employee's resignation month
 *   none    — nothing counted, and nothing expected
 */
export type LedgerCellState = 'paid' | 'unpaid' | 'none' | 'closed';

export interface LedgerCell {
  /** 1–12. */
  month: number;
  amount: number;
  /** Counted records behind `amount`. */
  count: number;
  state: LedgerCellState;
  /** A counted salary for a month after the resignation month. */
  flagged: boolean;
  /** Draft or awaiting approval — never part of `amount`. */
  pendingCount: number;
}

export interface LedgerYearOption {
  year: number;
  hasRecords: boolean;
}

/** Why a record is not part of a ledger figure. */
export type LedgerExclusion =
  | 'draft'
  | 'pending'
  | 'approved_not_posted'
  | 'rejected'
  | 'voucher_removed';

export const LEDGER_EXCLUSION_LABELS: Record<LedgerExclusion, string> = {
  draft: 'Draft',
  pending: 'Pending',
  approved_not_posted: 'Approved, not posted',
  rejected: 'Rejected',
  voucher_removed: 'Voucher removed',
};

// ---------------------------------------------------------------------------
// Salary Ledger
// ---------------------------------------------------------------------------

export const SALARY_LEDGER_STATUS_FILTERS = ['all', 'active', 'resigned', 'unpaid', 'pending'] as const;
export type SalaryLedgerStatusFilter = (typeof SALARY_LEDGER_STATUS_FILTERS)[number];

export const SALARY_LEDGER_SORTS = ['code', 'name', 'total'] as const;
export type SalaryLedgerSort = (typeof SALARY_LEDGER_SORTS)[number];

export interface SalaryLedgerRow {
  /** The row's identity. One row per employee per year, whatever their name is. */
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  designation: string;
  joinedOn: string | null;
  isActive: boolean;
  resignation: EmployeeResignation | null;
  /** Always twelve, January first. */
  cells: LedgerCell[];
  total: number;
  unpaidMonths: number;
  flaggedMonths: number;
  hasPending: boolean;
}

/** The cards above the grid. Always the whole year, whatever is filtered. */
export interface SalaryLedgerSummary {
  totalApproved: number;
  paymentCount: number;
  employees: number;
  activeEmployees: number;
  resignedEmployees: number;
  unpaidEmployeeMonths: number;
  flaggedMonths: number;
}

export interface SalaryLedger {
  year: number;
  /** 'YYYY-MM' of the current business date. Months from here on are not "unpaid" yet. */
  currentMonth: string;
  years: LedgerYearOption[];
  departments: string[];
  summary: SalaryLedgerSummary;
  /** One page of the filtered rows. */
  rows: SalaryLedgerRow[];
  /** Filtered rows, all pages. */
  total: number;
  page: number;
  pageSize: number;
  /** Twelve totals over the filtered rows, all pages. */
  monthTotals: number[];
  yearTotal: number;
}

/** One payslip as the ledger sees it. */
export interface SalaryLedgerPayment {
  id: string;
  salaryNo: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  /** 'YYYY-MM'. */
  salaryMonth: string;
  year: number;
  month: number;
  status: FinanceDocStatus;
  grossSalary: number;
  bonus: number;
  deductions: number;
  netSalary: number;
  paymentDate: string | null;
  paymentMethod: string;
  account: FinanceAccount;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  voucherNo: string | null;
  counted: boolean;
  /** What this payslip contributes to its month — the voucher's amount, or 0. */
  countedAmount: number;
  exclusion: LedgerExclusion | null;
  afterResignation: boolean;
}

export interface SalaryLedgerPayments {
  payments: SalaryLedgerPayment[];
  /** Matching payslips, all pages. */
  total: number;
  /** Sum and number of the counted ones, all pages. */
  countedTotal: number;
  countedCount: number;
}

/** An employee's biodata as the resignation form and the detail drawer show it. */
export interface EmployeeProfile {
  employee: FinanceEmployee;
  /** Newest first, cancelled ones included. */
  resignations: EmployeeResignation[];
  lastApprovedSalary: { salaryNo: string; salaryMonth: string; amount: number } | null;
  allTimeApproved: number;
}

/** What recording a resignation leaves for someone to look at. */
export interface ResignationImpact {
  /** Payslips already approved for months after the resignation month. Kept, and flagged. */
  approvedAfter: { salaryNo: string; salaryMonth: string; amount: number }[];
  /** Payslips for later months still awaiting approval. They can no longer be approved. */
  pendingAfter: { salaryNo: string; salaryMonth: string; amount: number }[];
}

// ---------------------------------------------------------------------------
// Company Transaction Details
// ---------------------------------------------------------------------------

export const PARTNER_LEDGER_SORTS = ['code', 'name', 'total'] as const;
export type PartnerLedgerSort = (typeof PARTNER_LEDGER_SORTS)[number];

export interface PartnerLedgerRow {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  sharePct: number;
  isActive: boolean;
  cells: LedgerCell[];
  total: number;
  hasPending: boolean;
}

export interface PartnerLedgerSummary {
  yearTotal: number;
  transactionCount: number;
  partners: number;
  highestMonth: { month: number; amount: number } | null;
  /**
   * Counted transactions with no partner on record (rows older than the
   * partner master). Reported, not hidden — they belong to no row.
   */
  unassigned: { count: number; amount: number };
}

export interface PartnerLedger {
  year: number;
  years: LedgerYearOption[];
  txnKind: PartnerTxnKind | null;
  summary: PartnerLedgerSummary;
  rows: PartnerLedgerRow[];
  total: number;
  page: number;
  pageSize: number;
  monthTotals: number[];
  yearTotal: number;
}

export interface PartnerLedgerTransaction {
  id: string;
  expenseNo: string;
  partnerId: string | null;
  partnerCode: string | null;
  partnerName: string;
  txnKind: PartnerTxnKind;
  description: string;
  amount: number;
  businessDate: string;
  /** The date the voucher sits on — what decides the month. */
  ledgerDate: string;
  year: number;
  month: number;
  status: FinanceDocStatus;
  paymentMethod: string;
  account: FinanceAccount;
  notes: string | null;
  requestedByName: string;
  createdAt: string;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  voucherNo: string | null;
  counted: boolean;
  countedAmount: number;
  exclusion: LedgerExclusion | null;
}

export interface PartnerLedgerTransactions {
  transactions: PartnerLedgerTransaction[];
  total: number;
  countedTotal: number;
  countedCount: number;
}
