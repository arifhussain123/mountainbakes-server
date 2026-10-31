/**
 * Refundable & Receivable Loans — a client-wise loan register kept beside the
 * finance ledger, never inside it (migration 20261031000001_finance_loans).
 *
 * Loans (refundable and receivable) DEBIT the register; payments CREDIT it.
 * Balance = debit − credit, run in posting order (business date, then seq).
 * Nothing here is General Ledger income or expense.
 */

import type { Attachment } from './attachment.types';

export const LOAN_ENTRY_TYPES = ['paid_payment', 'refundable_loan', 'receivable_loan'] as const;
export type LoanEntryType = (typeof LOAN_ENTRY_TYPES)[number];

export const LOAN_ENTRY_TYPE_LABELS: Record<LoanEntryType, string> = {
  paid_payment: 'Paid Payment',
  refundable_loan: 'Refundable Loan',
  receivable_loan: 'Receivable Loan',
};

/** Which ledger-head list each entry type classifies under. The side is fixed by the type, not the head. */
export const LOAN_ENTRY_HEAD_TYPE: Record<LoanEntryType, 'income' | 'expense'> = {
  paid_payment: 'expense',
  refundable_loan: 'expense',
  receivable_loan: 'income',
};

export const LOAN_ENTRY_STATUSES = ['posted', 'cancelled'] as const;
export type LoanEntryStatus = (typeof LOAN_ENTRY_STATUSES)[number];

export interface LoanClient {
  id: string;
  clientCode: string;
  companyName: string | null;
  clientName: string;
  mobileNumber: string | null;
  whatsappNumber: string | null;
  address: string | null;
  note: string | null;
  isActive: boolean;
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Posted totals for one client. `balance` = totalDebit − totalCredit. */
export interface LoanClientBalance {
  clientId: string;
  clientCode: string;
  clientName: string;
  companyName: string | null;
  isActive: boolean;
  totalRefundable: number;
  totalReceivable: number;
  totalDebit: number;
  totalCredit: number;
  balance: number;
  entryCount: number;
}

/** A client row on the Detail of Clients table: details plus its balances. */
export type LoanClientWithBalance = LoanClient & Omit<LoanClientBalance, 'clientId' | 'clientCode' | 'clientName' | 'companyName' | 'isActive'>;

export interface LoanEntry {
  id: string;
  voucherNo: string;
  seq: number;
  clientId: string;
  clientCode: string;
  clientName: string;
  companyName: string | null;
  entryType: LoanEntryType;
  ledgerHeadId: string;
  ledgerHeadName: string;
  branchId: string | null;
  branchName: string | null;
  businessDate: string;
  amount: number;
  debit: number;
  credit: number;
  /** Running balance after this row. A cancelled row carries the balance before it. */
  balance: number;
  paymentMethod: string | null;
  description: string;
  note: string | null;
  status: LoanEntryStatus;
  cancelReason: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
  createdByName: string | null;
  createdAt: string;
  attachments?: Attachment[];
}

export interface LoanLedgerPage {
  from: string;
  to: string;
  /** Posted debit − credit of the filtered set before `from`. */
  openingBalance: number;
  /** Posted rows in the window only. */
  totalDebit: number;
  totalCredit: number;
  /** openingBalance + totalDebit − totalCredit — the last row's balance. */
  closingBalance: number;
  total: number;
  limit: number;
  offset: number;
  entries: LoanEntry[];
}

export interface LoanClientDetail {
  client: LoanClient;
  balance: LoanClientBalance;
}
