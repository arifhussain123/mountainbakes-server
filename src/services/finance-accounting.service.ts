import { z } from 'zod';
import { dbFor } from '../db';
import { businessDateStr, SYSTEM_LEDGER_HEAD_CODES } from '../shared';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';

const db = dbFor('finance-accounting');

/**
 * The Daily Ledger's accounting workbook: General Entries, Ledger, Trial
 * Balance, Income Statement and Balance Sheet, derived ON READ from the posted
 * cash book.
 *
 * The finance ledger is a single-entry cash book: every voucher moves one
 * account (cash or bank) against one ledger head, debit for a receipt and
 * credit for a payment (see postEntry). That is already both halves of a
 * double entry, so each voucher becomes exactly ONE journal entry here:
 *
 *   receipt  →  DR Cash/Bank           CR <head account>
 *   payment  →  DR <head account>      CR Cash/Bank
 *
 * Nothing is written. A journal entry is identified by its voucher number,
 * which the database already keeps unique, so a voucher cannot be posted
 * twice and exporting again cannot add a record — there is no posting step to
 * repeat. Every figure is recomputed from `ledger_entries` on each export, the
 * same principle as finance-reports.service.ts.
 *
 * Amounts are carried in paisa (integers) throughout, so "total debit equals
 * total credit" is an exact comparison rather than a float tolerance.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The columns of a posted voucher this module reads. */
export interface SourceVoucher {
  id: string;
  voucherNo: string;
  seq: number;
  entryDate: string;
  postedAt: string | null;
  ledgerHeadId: string | null;
  ledgerHeadName: string;
  ledgerHeadType: 'income' | 'expense';
  branchId: string | null;
  branchName: string | null;
  description: string;
  debit: number;
  credit: number;
  account: 'cash' | 'bank';
  paymentMethod: string | null;
  status: string;
  sourceType: string;
  sourceId: string | null;
  reversesEntryId: string | null;
}

export interface HeadRow {
  id: string;
  code: string;
  name: string;
  type: 'income' | 'expense';
  groupName: string | null;
}

/** A branch cash transfer's channel amounts (migration 121), in rupees. */
export interface TransferChannels {
  id: string;
  cash: number;
  easypaisa: number;
  bank: number;
}

export interface BooksInput {
  /** Every live voucher dated on or before `to` (prior period included). */
  vouchers: SourceVoucher[];
  heads: HeadRow[];
  transfers: TransferChannels[];
  from: string;
  to: string;
  branch: { id: string; name: string } | null;
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
/** The Ledger sheet's three money columns an account rolls up into. */
export type LedgerColumn = 'cash' | 'bank' | 'generalFund';

export interface Account {
  code: string;
  name: string;
  type: AccountType;
  /** What the account's balance is read as — an asset or expense is debit-normal. */
  normal: 'debit' | 'credit';
  /** Shown in the workbook: Cash, Bank, General Fund, Revenue, Expense, Retained Earnings. */
  classification: string;
  column: LedgerColumn | null;
  /** The ledger head's group (Branch Collection, Utilities, …), for the income statement. */
  group: string | null;
  sort: number;
}

export const CASH_CODE = 'AST-CASH';
export const BANK_CODE = 'AST-BANK';
export const EASYPAISA_CODE = 'AST-BANK-EASYPAISA';
export const RETAINED_CODE = 'EQ-RETAINED-EARNINGS';

const ASSET_ACCOUNTS: Record<string, Account> = {
  [CASH_CODE]: {
    code: CASH_CODE, name: 'Cash in Hand', type: 'asset', normal: 'debit',
    classification: 'Cash', column: 'cash', group: null, sort: 10,
  },
  [BANK_CODE]: {
    code: BANK_CODE, name: 'Bank — Bank Account', type: 'asset', normal: 'debit',
    classification: 'Bank', column: 'bank', group: null, sort: 20,
  },
  [EASYPAISA_CODE]: {
    code: EASYPAISA_CODE, name: 'Bank — Easypaisa', type: 'asset', normal: 'debit',
    classification: 'Bank', column: 'bank', group: null, sort: 21,
  },
};

const RETAINED_ACCOUNT: Account = {
  code: RETAINED_CODE, name: 'Retained Earnings (brought forward)', type: 'equity', normal: 'credit',
  classification: 'Retained Earnings', column: null, group: null, sort: 390,
};

/** Ledger heads whose group marks them as sales collections on the income statement. */
const SALES_GROUPS = new Set(['Branch Collection', 'Share Split']);
/** The expense group posted by corrections, shown as Other Expenses rather than operating cost. */
const CORRECTION_GROUP = 'Corrections';

/**
 * Payment methods that put money in a bank, whatever account the voucher was
 * booked to. Easypaisa is a bank-type wallet and goes to its own Bank
 * sub-account. Cheque is deliberately absent: a cheque received can sit in the
 * cash box until it is banked, so the stored account is trusted for it.
 */
const BANK_METHODS = new Set(['bank_transfer', 'bank_account']);

const CHANNEL_LABELS: Record<string, string> = {
  cash: 'Cash',
  easypaisa: 'Easypaisa',
  bank_transfer: 'Bank Transfer',
  bank_account: 'Bank Account',
  cheque: 'Cheque',
  foodpanda: 'Foodpanda',
  online: 'Online',
  other: 'Other',
};

export function channelLabel(method: string | null | undefined): string {
  if (!method) return '';
  return method
    .split('+')
    .map((m) => CHANNEL_LABELS[m.trim().toLowerCase()] ?? m.trim())
    .join(' + ');
}

/**
 * The account on the other side of a voucher, from its ledger head.
 *
 * Income and expense heads are revenue and expense — the book's own
 * classification. Three are not P&L at all and go to the General Fund
 * (owners' equity) instead: the opening balance, capital introduced
 * ("Investment", group Capital) and partner withdrawals. Partner withdrawals
 * are matched by CODE only: the Partners group also holds Branch Share Payout,
 * which is a real expense.
 */
function headAccount(v: SourceVoucher, head: HeadRow | undefined): { account: Account; mapped: boolean } {
  const code = head?.code ?? null;
  const group = head?.groupName ?? null;
  const name = head?.name ?? v.ledgerHeadName;
  const accountCode = code ?? `HEAD-${(v.ledgerHeadId ?? v.ledgerHeadName).slice(0, 8).toUpperCase()}`;
  const base = { code: accountCode, name, group, mapped: Boolean(head) };

  if (v.sourceType === 'opening' || code === SYSTEM_LEDGER_HEAD_CODES.OPENING_BALANCE || group === 'Opening') {
    return {
      mapped: base.mapped,
      account: { ...base, type: 'equity', normal: 'credit', classification: 'General Fund', column: 'generalFund', sort: 300 },
    };
  }
  if (code === 'INC-INVESTMENT' || group === 'Capital') {
    return {
      mapped: base.mapped,
      account: { ...base, type: 'equity', normal: 'credit', classification: 'General Fund', column: 'generalFund', sort: 310 },
    };
  }
  if (code === SYSTEM_LEDGER_HEAD_CODES.PARTNER_WITHDRAWAL) {
    return {
      mapped: base.mapped,
      account: { ...base, type: 'equity', normal: 'debit', classification: 'General Fund', column: 'generalFund', sort: 320 },
    };
  }
  if (v.ledgerHeadType === 'income') {
    return {
      mapped: base.mapped,
      account: { ...base, type: 'revenue', normal: 'credit', classification: 'Revenue', column: null, sort: 400 },
    };
  }
  return {
    mapped: base.mapped,
    account: { ...base, type: 'expense', normal: 'debit', classification: 'Expense', column: null, sort: 500 },
  };
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface JournalLine {
  accountCode: string;
  /** Paisa. */
  debit: number;
  credit: number;
  channel: string;
}

export interface JournalEntry {
  /** The voucher number — unique in the database, so unique here. */
  id: string;
  voucher: SourceVoucher;
  inPeriod: boolean;
  lines: JournalLine[];
  balanced: boolean;
}

export interface AccountBalance {
  account: Account;
  /** Signed debit-minus-credit before `from`, paisa. Zero for P&L accounts (rolled into retained earnings). */
  opening: number;
  periodDebit: number;
  periodCredit: number;
  /** Signed debit-minus-credit at `to`, paisa. */
  closing: number;
}

export type CheckLevel = 'pass' | 'warn' | 'fail' | 'info';

export interface ValidationCheck {
  key: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface StatementLine {
  label: string;
  /** Paisa; null for a heading or a line that is not recorded. */
  amount: number | null;
  kind: 'heading' | 'item' | 'subtotal' | 'total' | 'note';
  indent?: number;
}

export interface AccountingBooks {
  from: string;
  to: string;
  branch: { id: string; name: string } | null;
  accounts: Map<string, Account>;
  /** Every entry on or before `to`; the workbook prints the in-period ones. */
  journal: JournalEntry[];
  balances: AccountBalance[];
  trialBalance: {
    rows: AccountBalance[];
    totals: { openingDebit: number; openingCredit: number; periodDebit: number; periodCredit: number; closingDebit: number; closingCredit: number };
  };
  incomeStatement: { lines: StatementLine[]; netProfit: number; totalRevenue: number; totalExpenses: number };
  balanceSheet: { lines: StatementLine[]; totalAssets: number; totalLiabilities: number; totalEquity: number; difference: number };
  checks: ValidationCheck[];
  limitations: string[];
  status: { level: Exclude<CheckLevel, 'info'>; text: string };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export const paisa = (rupees: number): number => Math.round(Number(rupees || 0) * 100);
/** `+ 0` turns a negated zero (-0) into 0, so no cell or comparison ever sees it. */
export const rupees = (p: number): number => p / 100 + 0;

function fmt(p: number): string {
  return `Rs ${(p / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const byDateThenSeq = (a: SourceVoucher, b: SourceVoucher) =>
  a.entryDate.localeCompare(b.entryDate) || a.seq - b.seq;

/** The asset side of a voucher: which of Cash / Bank / Easypaisa, and how much of each (paisa). */
interface AssetSlice { code: string; amount: number; channel: string }

export function buildAccountingBooks(input: BooksInput): AccountingBooks {
  const { from, to, branch } = input;
  const heads = new Map(input.heads.map((h) => [h.id, h]));
  const transfers = new Map(input.transfers.map((t) => [t.id, t]));
  const accounts = new Map<string, Account>();
  const checks: ValidationCheck[] = [];

  // ── 1. The posting set: dated on/before `to`, each voucher once ────────────
  const seen = new Set<string>();
  const duplicateVouchers: string[] = [];
  const vouchers: SourceVoucher[] = [];
  for (const v of [...input.vouchers].sort(byDateThenSeq)) {
    if (v.entryDate > to) continue;
    const key = v.voucherNo || v.id;
    if (seen.has(key) || seen.has(v.id)) {
      duplicateVouchers.push(key);
      continue;
    }
    seen.add(key);
    seen.add(v.id);
    vouchers.push(v);
  }

  // ── 2. Journal entries ────────────────────────────────────────────────────
  const unmappedHeads = new Set<string>();
  const reclassified: { voucherNo: string; amount: number; method: string }[] = [];
  const splitFailures: string[] = [];
  const splitDone: string[] = [];
  const invalid: string[] = [];
  const unbalanced: string[] = [];
  /** A split decided for an original voucher, mirrored by its reversal. */
  const splitsByVoucherId = new Map<string, AssetSlice[]>();

  const assetSlices = (v: SourceVoucher, amount: number): AssetSlice[] => {
    const method = (v.paymentMethod ?? '').trim().toLowerCase();

    // A reversal moves the same accounts its original moved, in reverse.
    if (v.reversesEntryId) {
      const original = splitsByVoucherId.get(v.reversesEntryId);
      if (original && original.reduce((s, x) => s + x.amount, 0) === amount) return original;
    }

    // A branch cash transfer can carry cash, Easypaisa and bank in one
    // voucher, booked to whichever account holds most (cash_transfer_slices).
    // Its own channel amounts put each part where it really went.
    if (v.sourceType === 'cash_transfer' && v.sourceId && method.includes('+')) {
      const t = transfers.get(v.sourceId);
      if (t && paisa(t.cash) + paisa(t.easypaisa) + paisa(t.bank) === amount) {
        splitDone.push(v.voucherNo);
        return [
          { code: CASH_CODE, amount: paisa(t.cash), channel: 'Cash' },
          { code: EASYPAISA_CODE, amount: paisa(t.easypaisa), channel: 'Easypaisa' },
          { code: BANK_CODE, amount: paisa(t.bank), channel: 'Bank Account' },
        ].filter((s) => s.amount > 0);
      }
      splitFailures.push(v.voucherNo);
    }

    let code: string;
    if (method === 'easypaisa') code = EASYPAISA_CODE;
    else if (BANK_METHODS.has(method)) code = BANK_CODE;
    else code = v.account === 'bank' ? BANK_CODE : CASH_CODE;

    if (code !== CASH_CODE && v.account === 'cash') {
      reclassified.push({ voucherNo: v.voucherNo, amount, method });
    }
    return [{ code, amount, channel: channelLabel(v.paymentMethod) || (code === CASH_CODE ? 'Cash' : '') }];
  };

  const journal: JournalEntry[] = [];
  for (const v of vouchers) {
    const debit = paisa(v.debit);
    const credit = paisa(v.credit);
    const { account: contra, mapped } = headAccount(v, v.ledgerHeadId ? heads.get(v.ledgerHeadId) : undefined);
    if (!mapped) unmappedHeads.add(`${v.ledgerHeadName} (${v.voucherNo})`);
    if (!accounts.has(contra.code)) accounts.set(contra.code, contra);

    const lines: JournalLine[] = [];
    if (debit < 0 || credit < 0 || (debit === 0 && credit === 0)) {
      invalid.push(v.voucherNo);
    } else {
      // A voucher normally has one side only; both are handled so a corrected
      // voucher carrying both is still journalled in full rather than dropped.
      if (debit > 0) {
        const slices = assetSlices(v, debit);
        for (const s of slices) lines.push({ accountCode: s.code, debit: s.amount, credit: 0, channel: s.channel });
        lines.push({ accountCode: contra.code, debit: 0, credit: debit, channel: '' });
        splitsByVoucherId.set(v.id, slices);
      }
      if (credit > 0) {
        const slices = assetSlices(v, credit);
        lines.push({ accountCode: contra.code, debit: credit, credit: 0, channel: '' });
        for (const s of slices) lines.push({ accountCode: s.code, debit: 0, credit: s.amount, channel: s.channel });
        splitsByVoucherId.set(v.id, slices);
      }
    }
    for (const l of lines) {
      if (!accounts.has(l.accountCode)) accounts.set(l.accountCode, ASSET_ACCOUNTS[l.accountCode]!);
    }

    const dr = lines.reduce((s, l) => s + l.debit, 0);
    const cr = lines.reduce((s, l) => s + l.credit, 0);
    const balanced = lines.length > 0 && dr === cr;
    if (lines.length > 0 && !balanced) unbalanced.push(v.voucherNo);
    journal.push({ id: v.voucherNo, voucher: v, inPeriod: v.entryDate >= from, lines, balanced });
  }

  // Cash and Bank always appear, even on an empty day, so the statements have
  // their rows.
  for (const code of [CASH_CODE, BANK_CODE, EASYPAISA_CODE]) {
    if (!accounts.has(code)) accounts.set(code, ASSET_ACCOUNTS[code]!);
  }

  // ── 3. Balances ───────────────────────────────────────────────────────────
  const bal = new Map<string, AccountBalance>();
  for (const a of accounts.values()) {
    bal.set(a.code, { account: a, opening: 0, periodDebit: 0, periodCredit: 0, closing: 0 });
  }
  let priorProfit = 0; // credit-positive
  for (const je of journal) {
    for (const l of je.lines) {
      const b = bal.get(l.accountCode)!;
      const isPnl = b.account.type === 'revenue' || b.account.type === 'expense';
      if (je.inPeriod) {
        b.periodDebit += l.debit;
        b.periodCredit += l.credit;
      } else if (isPnl) {
        // Profit earned before the period is carried as retained earnings, so
        // the income statement accounts open the period at zero.
        priorProfit += l.credit - l.debit;
      } else {
        b.opening += l.debit - l.credit;
      }
    }
  }
  accounts.set(RETAINED_CODE, RETAINED_ACCOUNT);
  bal.set(RETAINED_CODE, { account: RETAINED_ACCOUNT, opening: 0 - priorProfit, periodDebit: 0, periodCredit: 0, closing: 0 });
  for (const b of bal.values()) b.closing = b.opening + b.periodDebit - b.periodCredit;

  const sortAccounts = (a: Account, b: Account) => a.sort - b.sort || a.code.localeCompare(b.code);
  const balances = [...bal.values()].sort((a, b) => sortAccounts(a.account, b.account));

  // ── 4. Trial balance ──────────────────────────────────────────────────────
  const isAsset = (code: string) => code in ASSET_ACCOUNTS;
  const tbRows = balances.filter(
    (b) => isAsset(b.account.code) || b.opening !== 0 || b.periodDebit !== 0 || b.periodCredit !== 0,
  );
  const sumPos = (xs: number[]) => xs.reduce((s, x) => s + Math.max(x, 0), 0);
  const sumNeg = (xs: number[]) => xs.reduce((s, x) => s + Math.max(-x, 0), 0);
  const tbTotals = {
    openingDebit: sumPos(tbRows.map((r) => r.opening)),
    openingCredit: sumNeg(tbRows.map((r) => r.opening)),
    periodDebit: tbRows.reduce((s, r) => s + r.periodDebit, 0),
    periodCredit: tbRows.reduce((s, r) => s + r.periodCredit, 0),
    closingDebit: sumPos(tbRows.map((r) => r.closing)),
    closingCredit: sumNeg(tbRows.map((r) => r.closing)),
  };

  // ── 5. Income statement ───────────────────────────────────────────────────
  const pnl = balances.filter((b) => b.account.type === 'revenue' || b.account.type === 'expense');
  const revenueOf = (b: AccountBalance) => b.periodCredit - b.periodDebit;
  const expenseOf = (b: AccountBalance) => b.periodDebit - b.periodCredit;
  const active = (b: AccountBalance) => b.periodDebit !== 0 || b.periodCredit !== 0;

  const sales = pnl.filter((b) => b.account.type === 'revenue' && SALES_GROUPS.has(b.account.group ?? '') && active(b));
  const otherIncome = pnl.filter((b) => b.account.type === 'revenue' && !SALES_GROUPS.has(b.account.group ?? '') && active(b));
  const opex = pnl.filter((b) => b.account.type === 'expense' && b.account.group !== CORRECTION_GROUP && active(b));
  const otherExp = pnl.filter((b) => b.account.type === 'expense' && b.account.group === CORRECTION_GROUP && active(b));
  const sum = (xs: AccountBalance[], f: (b: AccountBalance) => number) => xs.reduce((s, b) => s + f(b), 0);

  const salesTotal = sum(sales, revenueOf);
  const otherIncomeTotal = sum(otherIncome, revenueOf);
  const opexTotal = sum(opex, expenseOf);
  const otherExpTotal = sum(otherExp, expenseOf);
  const netProfit = salesTotal + otherIncomeTotal - opexTotal - otherExpTotal;

  const isLines: StatementLine[] = [
    { label: 'Revenue', amount: null, kind: 'heading' },
    { label: 'Sales revenue — branch collections', amount: null, kind: 'heading', indent: 1 },
    ...sales.map((b) => ({ label: b.account.name, amount: revenueOf(b), kind: 'item' as const, indent: 2 })),
    { label: 'Gross sales revenue', amount: salesTotal, kind: 'subtotal', indent: 1 },
    { label: 'Less: sales returns and refunds — not recorded in the finance ledger (collections arrive net)', amount: null, kind: 'note', indent: 1 },
    { label: 'Less: discounts — not recorded in the finance ledger (collections arrive net)', amount: null, kind: 'note', indent: 1 },
    { label: 'Net revenue', amount: salesTotal, kind: 'total' },
    { label: 'Cost of goods sold — not determined: the ledger holds no inventory valuation; purchases are expensed below as booked', amount: null, kind: 'note' },
    { label: 'Operating expenses', amount: null, kind: 'heading' },
  ];
  const opexGroups = new Map<string, AccountBalance[]>();
  for (const b of opex) {
    const g = b.account.group ?? 'Other';
    opexGroups.set(g, [...(opexGroups.get(g) ?? []), b]);
  }
  for (const [g, rows] of [...opexGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    isLines.push({ label: g, amount: null, kind: 'heading', indent: 1 });
    for (const b of rows) isLines.push({ label: b.account.name, amount: expenseOf(b), kind: 'item', indent: 2 });
  }
  isLines.push(
    { label: 'Total operating expenses', amount: opexTotal, kind: 'subtotal' },
    { label: 'Other income', amount: null, kind: 'heading' },
    ...otherIncome.map((b) => ({ label: b.account.name, amount: revenueOf(b), kind: 'item' as const, indent: 1 })),
    { label: 'Total other income', amount: otherIncomeTotal, kind: 'subtotal' },
    { label: 'Other expenses', amount: null, kind: 'heading' },
    ...otherExp.map((b) => ({ label: b.account.name, amount: expenseOf(b), kind: 'item' as const, indent: 1 })),
    { label: 'Total other expenses', amount: otherExpTotal, kind: 'subtotal' },
    { label: netProfit >= 0 ? 'Net profit (cash basis, provisional)' : 'Net loss (cash basis, provisional)', amount: netProfit, kind: 'total' },
  );

  // ── 6. Balance sheet ──────────────────────────────────────────────────────
  const closingOf = (code: string) => bal.get(code)?.closing ?? 0;
  const cash = closingOf(CASH_CODE);
  const bank = closingOf(BANK_CODE);
  const easypaisa = closingOf(EASYPAISA_CODE);
  const totalAssets = cash + bank + easypaisa;
  const fundRows = balances.filter((b) => b.account.classification === 'General Fund' && b.closing !== 0);
  const generalFund = fundRows.reduce((s, b) => s - b.closing, 0);
  const retained = 0 - closingOf(RETAINED_CODE);
  const totalLiabilities = 0;
  const totalEquity = generalFund + retained + netProfit;
  const difference = totalAssets - (totalLiabilities + totalEquity);

  const bsLines: StatementLine[] = [
    { label: 'Assets', amount: null, kind: 'heading' },
    { label: 'Cash in Hand', amount: cash, kind: 'item', indent: 1 },
    { label: 'Bank', amount: bank + easypaisa, kind: 'item', indent: 1 },
    { label: 'Bank Account', amount: bank, kind: 'item', indent: 2 },
    { label: 'Easypaisa (included in Bank)', amount: easypaisa, kind: 'item', indent: 2 },
    { label: 'Accounts receivable — not recorded in the finance ledger', amount: null, kind: 'note', indent: 1 },
    { label: 'Inventory — not recorded (no reliable valuation in the ledger)', amount: null, kind: 'note', indent: 1 },
    { label: 'Total assets', amount: totalAssets, kind: 'total' },
    { label: 'Liabilities', amount: null, kind: 'heading' },
    { label: 'Accounts payable, loans and other liabilities — not recorded in the finance ledger', amount: null, kind: 'note', indent: 1 },
    { label: 'Total liabilities', amount: totalLiabilities, kind: 'total' },
    { label: 'Equity', amount: null, kind: 'heading' },
    { label: 'General Fund', amount: null, kind: 'heading', indent: 1 },
    ...fundRows.map((b) => ({ label: b.account.name, amount: 0 - b.closing, kind: 'item' as const, indent: 2 })),
    { label: 'Total General Fund', amount: generalFund, kind: 'subtotal', indent: 1 },
    { label: `Retained earnings brought forward (profit before ${from})`, amount: retained, kind: 'item', indent: 1 },
    { label: 'Current period profit / (loss) — from the Income Statement', amount: netProfit, kind: 'item', indent: 1 },
    { label: 'Total equity', amount: totalEquity, kind: 'total' },
    { label: 'Total liabilities and equity', amount: totalLiabilities + totalEquity, kind: 'total' },
    { label: 'Balance difference (assets − liabilities − equity)', amount: difference, kind: 'total' },
  ];

  // ── 7. Reconciliation ─────────────────────────────────────────────────────
  // The ledger is re-run line by line, independently of the balance map above,
  // and every account's closing figure must land on the trial balance's.
  const ledgerClosing = new Map<string, number>();
  for (const b of balances) ledgerClosing.set(b.account.code, b.opening);
  for (const je of journal) {
    if (!je.inPeriod) continue;
    for (const l of je.lines) ledgerClosing.set(l.accountCode, (ledgerClosing.get(l.accountCode) ?? 0) + l.debit - l.credit);
  }
  const ledgerMismatch = balances.filter((b) => (ledgerClosing.get(b.account.code) ?? 0) !== b.closing);

  const pnlFromTb = pnl.reduce((s, b) => s + b.periodCredit - b.periodDebit, 0);
  const periodJournal = journal.filter((j) => j.inPeriod);
  const journalDr = periodJournal.reduce((s, j) => s + j.lines.reduce((t, l) => t + l.debit, 0), 0);
  const journalCr = periodJournal.reduce((s, j) => s + j.lines.reduce((t, l) => t + l.credit, 0), 0);

  // Possible double counting a person introduced: a manual voucher re-keying
  // money a branch posting already brought in (same head, day and amount).
  // Both are real postings, so both stay in every figure — this only flags them.
  const branchKeys = new Set(
    vouchers
      .filter((v) => ['branch_income', 'company_share', 'branch_share', 'cash_transfer'].includes(v.sourceType))
      .map((v) => `${v.ledgerHeadId}|${v.entryDate}|${paisa(v.debit || v.credit)}`),
  );
  const rekeyed = periodJournal
    .filter((j) => j.voucher.sourceType === 'manual' && branchKeys.has(`${j.voucher.ledgerHeadId}|${j.voucher.entryDate}|${paisa(j.voucher.debit || j.voucher.credit)}`))
    .map((j) => j.id);

  // One source document posting the same head and account more than once,
  // with neither side reversed — the shape a double posting would have.
  const sourceCount = new Map<string, string[]>();
  for (const j of journal) {
    const v = j.voucher;
    if (!v.sourceId || v.reversesEntryId || v.status === 'reversed' || v.sourceType === 'adjustment') continue;
    const k = `${v.sourceType}|${v.sourceId}|${v.ledgerHeadId}|${v.account}`;
    sourceCount.set(k, [...(sourceCount.get(k) ?? []), j.id]);
  }
  const repeatedSources = [...sourceCount.values()].filter((ids) => ids.length > 1);

  const hasOpening = vouchers.some((v) => v.sourceType === 'opening' || heads.get(v.ledgerHeadId ?? '')?.code === SYSTEM_LEDGER_HEAD_CODES.OPENING_BALANCE);
  const firstDate = vouchers[0]?.entryDate ?? null;

  const list = (xs: string[], n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));

  checks.push(
    unbalanced.length || invalid.length
      ? {
          key: 'journal_balanced', label: 'Every journal entry balances', level: 'fail',
          detail: [
            unbalanced.length ? `Unbalanced: ${list(unbalanced)}.` : '',
            invalid.length ? `Invalid amounts (zero or negative), shown without lines: ${list(invalid)}.` : '',
          ].filter(Boolean).join(' '),
        }
      : { key: 'journal_balanced', label: 'Every journal entry balances', level: 'pass', detail: `${periodJournal.length} entries in the period; debit equals credit on each.` },
    journalDr === journalCr
      ? { key: 'journal_totals', label: 'Journal debits equal credits', level: 'pass', detail: `${fmt(journalDr)} on each side.` }
      : { key: 'journal_totals', label: 'Journal debits equal credits', level: 'fail', detail: `Debit ${fmt(journalDr)} vs credit ${fmt(journalCr)}.` },
    duplicateVouchers.length
      ? { key: 'unique_vouchers', label: 'Each voucher posted once', level: 'fail', detail: `Voucher numbers repeated in the posting set (later copies left out): ${list(duplicateVouchers)}.` }
      : { key: 'unique_vouchers', label: 'Each voucher posted once', level: 'pass', detail: 'Every journal entry is keyed by its voucher number, which the database keeps unique. Exporting writes nothing.' },
    repeatedSources.length
      ? { key: 'source_once', label: 'Each source document posted once', level: 'warn', detail: `Same source, head and account posted more than once: ${list(repeatedSources.map((ids) => ids.join(' / ')))}. Kept in every figure; review whether one is a double posting.` }
      : { key: 'source_once', label: 'Each source document posted once', level: 'pass', detail: 'No source document posts the same head and account twice.' },
    rekeyed.length
      ? { key: 'manual_rekey', label: 'No manual re-keying of branch collections', level: 'warn', detail: `Manual vouchers with the same head, date and amount as a branch posting: ${list(rekeyed)}. Both are posted and both are counted.` }
      : { key: 'manual_rekey', label: 'No manual re-keying of branch collections', level: 'pass', detail: 'No manual voucher duplicates a branch posting.' },
    reclassified.length
      ? {
          key: 'bank_channels', label: 'Easypaisa and bank receipts under Bank', level: 'warn',
          detail: `${reclassified.length} voucher(s) booked to Cash were paid by ${[...new Set(reclassified.map((r) => channelLabel(r.method)))].join(', ')} and are shown under Bank here (${fmt(reclassified.reduce((s, r) => s + r.amount, 0))}): ${list(reclassified.map((r) => r.voucherNo))}. The app's Cash in Hand still counts them as cash.`,
        }
      : { key: 'bank_channels', label: 'Easypaisa and bank receipts under Bank', level: 'pass', detail: 'Every Easypaisa and bank-transfer voucher is booked to Bank.' },
    splitFailures.length
      ? { key: 'transfer_split', label: 'Mixed branch transfers split by channel', level: 'warn', detail: `The channel amounts no longer add up to the voucher, so the whole amount stays on its booked account: ${list(splitFailures)}.` }
      : { key: 'transfer_split', label: 'Mixed branch transfers split by channel', level: 'pass', detail: splitDone.length ? `${splitDone.length} voucher(s) split into Cash / Easypaisa / Bank from the transfer's own amounts.` : 'No mixed-channel transfers.' },
    ledgerMismatch.length
      ? { key: 'ledger_tb', label: 'Ledger reconciles to the trial balance', level: 'fail', detail: `Closing balance differs for: ${list(ledgerMismatch.map((b) => b.account.code))}.` }
      : { key: 'ledger_tb', label: 'Ledger reconciles to the trial balance', level: 'pass', detail: 'Each account\'s ledger closing balance equals its trial balance closing balance.' },
    tbTotals.closingDebit === tbTotals.closingCredit && tbTotals.openingDebit === tbTotals.openingCredit && tbTotals.periodDebit === tbTotals.periodCredit
      ? { key: 'tb_balanced', label: 'Trial balance balances', level: 'pass', detail: `Closing debit and credit ${fmt(tbTotals.closingDebit)}.` }
      : {
          key: 'tb_balanced', label: 'Trial balance balances', level: 'fail',
          detail: `Opening ${fmt(tbTotals.openingDebit)} / ${fmt(tbTotals.openingCredit)}, period ${fmt(tbTotals.periodDebit)} / ${fmt(tbTotals.periodCredit)}, closing ${fmt(tbTotals.closingDebit)} / ${fmt(tbTotals.closingCredit)}.`,
        },
    pnlFromTb === netProfit
      ? { key: 'is_reconciles', label: 'Income statement agrees with the revenue and expense accounts', level: 'pass', detail: `Net result ${fmt(netProfit)}.` }
      : { key: 'is_reconciles', label: 'Income statement agrees with the revenue and expense accounts', level: 'fail', detail: `Statement ${fmt(netProfit)} vs accounts ${fmt(pnlFromTb)}.` },
    difference === 0
      ? { key: 'bs_balanced', label: 'Assets = Liabilities + Equity', level: 'pass', detail: `${fmt(totalAssets)} on both sides.` }
      : { key: 'bs_balanced', label: 'Assets = Liabilities + Equity', level: 'fail', detail: `Difference ${fmt(difference)}.` },
    hasOpening
      ? { key: 'opening', label: 'Opening balances recorded', level: 'pass', detail: 'The book holds an opening-balance posting.' }
      : {
          key: 'opening', label: 'Opening balances recorded', level: 'warn',
          detail: firstDate
            ? `No opening-balance voucher in ${branch ? 'this branch\'s' : 'the'} book: balances assume it started at zero on ${firstDate}.`
            : 'No vouchers on or before the end of the period, and no opening balance.',
        },
    cash < 0 || bank < 0 || easypaisa < 0
      ? { key: 'negative_cash', label: 'No negative cash or bank balance', level: 'warn', detail: `Closing Cash ${fmt(cash)}, Bank ${fmt(bank)}, Easypaisa ${fmt(easypaisa)}. A negative balance means a receipt is missing or a payment is on the wrong account.` }
      : { key: 'negative_cash', label: 'No negative cash or bank balance', level: 'pass', detail: 'Cash and bank close at zero or above.' },
    unmappedHeads.size
      ? { key: 'classified', label: 'Every voucher has a classified account', level: 'warn', detail: `Ledger head not found in the chart, classified by its income/expense type: ${list([...unmappedHeads])}.` }
      : { key: 'classified', label: 'Every voucher has a classified account', level: 'pass', detail: 'Every head is in the chart of accounts.' },
  );
  if (branch) {
    checks.push({
      key: 'branch_scope', label: 'Branch filter', level: 'warn',
      detail: `Only vouchers tagged to ${branch.name} are included, in all five sheets. Company-level vouchers (opening balance, salaries, partner withdrawals, untagged expenses) carry no branch and are left out, so the balance sheet is a partial view.`,
    });
  }

  const limitations = [
    'Cash basis: revenue is recognised when branch collections are approved into the finance ledger; POS sales, discounts and refunds are recorded in the branch sales module and arrive here net.',
    'Cost of goods sold is not determined: the finance ledger holds no inventory valuation, so raw materials, packaging and production purchases are operating expenses as booked.',
    'Receivables, inventory, payables, loans and fixed assets are not recorded in the finance ledger, so the balance sheet holds cash, bank and owners\' equity only.',
    'General Fund = opening balances, capital introduced (Investment) and partner withdrawals (including partner advances). Branch Share Payout stays an expense.',
    'Employee advances are booked under Salaries as expenses; their recovery through payroll deductions is not a separate posting, so no advances receivable is kept.',
    'Branch-income bank slices combine Easypaisa and bank receipts and are shown under Bank — Bank Account.',
    'Reversed vouchers and their reversing entries both remain, netting to zero, as posted. Deleted vouchers are excluded.',
    'Other on-screen filters (ledger head, type, account, status, amount, search) are not applied: a statement filtered by head or account cannot balance.',
  ];

  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const status: AccountingBooks['status'] = fails
    ? { level: 'fail', text: `NOT RECONCILED — ${fails} critical exception(s), ${warns} warning(s). See the checks on the Balance Sheet sheet.` }
    : warns
      ? { level: 'warn', text: `Reconciled, with ${warns} warning(s) to review. See the checks on the Balance Sheet sheet.` }
      : { level: 'pass', text: 'Reconciled — every check passed.' };

  return {
    from,
    to,
    branch,
    accounts,
    journal,
    balances,
    trialBalance: { rows: tbRows, totals: tbTotals },
    incomeStatement: { lines: isLines, netProfit, totalRevenue: salesTotal + otherIncomeTotal, totalExpenses: opexTotal + otherExpTotal },
    balanceSheet: { lines: bsLines, totalAssets, totalLiabilities, totalEquity, difference },
    checks,
    limitations,
    status,
  };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

export const AccountingWorkbookQuerySchema = z
  .object({
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    branchId: z.string().uuid('Unknown branch').optional(),
  })
  .transform((q) => {
    const today = businessDateStr();
    return { from: q.from ?? q.to ?? today, to: q.to ?? q.from ?? today, branchId: q.branchId };
  })
  .refine((q) => q.from <= q.to, { message: 'The start date is after the end date' });

export type AccountingWorkbookQuery = z.infer<typeof AccountingWorkbookQuerySchema>;

/**
 * Rows asked for per round trip. The db layer may return fewer (it caps every
 * read at DB_MAX_ROWS), so a short page is NOT taken to mean the end — only an
 * empty one is.
 */
const PAGE = 1000;
/** Ids per `in (...)` lookup. */
const ID_CHUNK = 100;
/** A workbook bigger than this is not something Excel will open usefully. */
const MAX_VOUCHERS = 200_000;

/** A `date` column as 'YYYY-MM-DD', whether the driver hands back a string or a Date. */
function dateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

const VOUCHER_COLUMNS =
  'id, voucher_no, seq, entry_date, posted_at, ledger_head_id, ledger_head_name, ledger_head_type, branch_id, ' +
  'branch_name, description, debit, credit, account, payment_method, status, source_type, source_id, reverses_entry_id';

/**
 * Every live voucher on or before `to` — the period AND everything before it,
 * because the opening balances are the sum of all prior postings.
 *
 * Paged by `seq` (keyset, not offset), so a voucher posted while the export is
 * reading can neither be skipped nor read twice.
 */
async function loadVouchers(to: string, branchId?: string): Promise<SourceVoucher[]> {
  const out: SourceVoucher[] = [];
  let after = 0;
  for (;;) {
    let query = withoutDeleted(
      db
        .from('ledger_entries')
        .select(VOUCHER_COLUMNS)
        .lte('entry_date', to)
        .gt('seq', after)
        .order('seq', { ascending: true })
        .limit(PAGE),
    );
    if (branchId) query = query.eq('branch_id', branchId);
    const { data, error } = await query;
    if (error) throw error;
    const rows = rowToApi<SourceVoucher[]>(data ?? []);
    for (const r of rows) {
      out.push({
        ...r,
        entryDate: dateOnly(r.entryDate),
        postedAt: r.postedAt ? new Date(r.postedAt as unknown as string).toISOString() : null,
        seq: Number(r.seq),
        debit: Number(r.debit ?? 0),
        credit: Number(r.credit ?? 0),
      });
    }
    if (out.length > MAX_VOUCHERS) {
      throw Object.assign(new Error('Too many vouchers for one workbook — choose a branch or an earlier end date.'), { status: 413 });
    }
    if (rows.length === 0) break;
    after = Number(rows[rows.length - 1]!.seq);
  }
  return out;
}

async function loadTransfers(ids: string[]): Promise<TransferChannels[]> {
  const out: TransferChannels[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from('cash_transfers')
      .select('id, cash_amount, easypaisa_amount, bank_amount')
      .in('id', ids.slice(i, i + ID_CHUNK));
    if (error) throw error;
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      out.push({
        id: String(r['id']),
        cash: Number(r['cash_amount'] ?? 0),
        easypaisa: Number(r['easypaisa_amount'] ?? 0),
        bank: Number(r['bank_amount'] ?? 0),
      });
    }
  }
  return out;
}

/** The whole chart of ledger heads, inactive ones included — an old voucher can use a retired head. */
async function loadHeads(): Promise<HeadRow[]> {
  const out: HeadRow[] = [];
  for (;;) {
    const { data, error } = await db
      .from('ledger_heads')
      .select('id, code, name, type, group_name')
      .order('code', { ascending: true })
      .range(out.length, out.length + PAGE - 1);
    if (error) throw error;
    const rows = rowToApi<HeadRow[]>(data ?? []);
    if (rows.length === 0) break;
    out.push(...rows);
  }
  return out;
}

export async function loadAccountingBooks(q: AccountingWorkbookQuery): Promise<AccountingBooks> {
  let branch: { id: string; name: string } | null = null;
  if (q.branchId) {
    const { data, error } = await db.from('branches').select('id, name').eq('id', q.branchId).maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('Branch not found'), { status: 404 });
    branch = { id: String(data['id']), name: String(data['name']) };
  }

  const [vouchers, heads] = await Promise.all([loadVouchers(q.to, q.branchId), loadHeads()]);

  const transferIds = [
    ...new Set(vouchers.filter((v) => v.sourceType === 'cash_transfer' && v.sourceId).map((v) => v.sourceId!)),
  ];
  const transfers = transferIds.length ? await loadTransfers(transferIds) : [];

  return buildAccountingBooks({
    vouchers,
    heads,
    transfers,
    from: q.from,
    to: q.to,
    branch,
  });
}
