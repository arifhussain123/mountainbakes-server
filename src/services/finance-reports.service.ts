import { dbFor } from '../db';
import {
  businessDateStr,
  businessDaysAgoStr,
  FINANCE_PAYMENT_METHOD_LABELS,
  FINANCE_REPORT_LABELS,
  LOAN_ENTRY_TYPE_LABELS,
  SYSTEM_LEDGER_HEAD_CODES,
  type FinanceReport,
  type FinanceReportColumn,
  type FinanceReportQueryInput,
  type FinanceReportType,
  type LedgerEntry,
} from '../shared';
import { rowToApi } from '../utils/case';
import { sortRows } from '../utils/sortRows';
import { withoutDeleted } from '../utils/softDelete';
import { getDayClosing } from './finance-ledger.service';
import { getLoanLedgerAll } from './finance-loans.service';
import { getLedgerHeadByCode, round2 } from './finance-settings.service';

const db = dbFor('finance-reports');

/**
 * The ten finance reports.
 *
 * All ten return the SAME shape (`FinanceReport`: columns + rows + totals +
 * summary). That is the whole design: the alternative is ten bespoke response
 * types, ten PDF writers and ten Excel writers — thirty places to fix a column,
 * and thirty chances for the PDF to disagree with the screen. Here the export
 * layer knows nothing about which report it is rendering, so PDF, Excel, CSV and
 * the on-screen table are guaranteed to show the same figures.
 *
 * Every report is derived on read from `ledger_entries` and the document tables.
 * Nothing is precomputed and stored, so a report can never drift from the book
 * it describes — the same principle as the stock and sales reporting elsewhere
 * in this system.
 */

const num = (v: unknown) => Number(v ?? 0);

/**
 * Hard cap on rows pulled into one report.
 *
 * Reports aggregate in Node (a faithful continuation of how reports.routes.ts
 * works), so an unbounded fetch is an unbounded memory read. 20 000 ledger rows
 * is several years of this business's posting volume; a report that hits the cap
 * says so in its subtitle rather than quietly showing a short total, because a
 * silently truncated financial report is the worst possible failure here.
 */
const ROW_CAP = 20_000;

/**
 * Report types whose row count scales with the number of underlying documents
 * in the period (one row per ledger entry / salary payment / partner expense /
 * share-approval), so a wide enough range can genuinely need paging.
 *
 * The other three types (income_statement, profit_loss, trial_balance)
 * aggregate into one row per ledger head — inherently bounded, small — and
 * never carry a `pagination` field.
 */
const PAGINATED_REPORT_TYPES = new Set<FinanceReportType>([
  'daily_cash_book',
  'general_ledger',
  'expense_report',
  'company_share',
  'branch_share',
  'salary',
  'partner_expense',
  'loan_ledger',
]);

/**
 * Slices `rows` to one page. Only called with the FULL filtered row set — the
 * builders above always compute `totals`/`summary` from every row first, so
 * paging afterwards here cannot skew a financial total.
 */
function paginateRows(
  rows: FinanceReport['rows'],
  q: FinanceReportQueryInput,
): { rows: FinanceReport['rows']; pagination: NonNullable<FinanceReport['pagination']> } {
  const pageSize = q.pageSize ?? 50;
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(q.page ?? 1, totalPages);
  const start = (page - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    pagination: { page, pageSize, total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1 },
  };
}

export async function buildFinanceReport(
  q: FinanceReportQueryInput,
  generatedBy: string,
  opts?: { paginate?: boolean },
): Promise<FinanceReport> {
  const { from, to } = defaultRange(q.type, q.from, q.to);

  const report = await (async (): Promise<FinanceReport> => {
    switch (q.type) {
      case 'daily_cash_book':
        return dailyCashBook(q, from, to, generatedBy);
      case 'general_ledger':
        return generalLedger(q, from, to, generatedBy);
      case 'income_statement':
        return headBreakdown(q, from, to, generatedBy, 'income');
      case 'expense_report':
        return expenseReport(q, from, to, generatedBy);
      case 'profit_loss':
        return profitAndLoss(q, from, to, generatedBy);
      case 'company_share':
      case 'branch_share':
        return shareReport(q, from, to, generatedBy);
      case 'salary':
        return salaryReport(q, from, to, generatedBy);
      case 'partner_expense':
        return partnerExpenseReport(q, from, to, generatedBy);
      case 'trial_balance':
        return trialBalance(q, from, to, generatedBy);
      case 'loan_ledger':
        return loanLedger(q, from, to, generatedBy);
      default: {
        // Exhaustiveness: adding a report type without a builder becomes a compile
        // error rather than an empty page in production.
        const never: never = q.type;
        throw new Error(`Unhandled report type: ${String(never)}`);
      }
    }
  })();

  const sorted = applyReportSort(report, q);

  // /export always calls with paginate: false — the exported file is the
  // document of record and must hold every row, not one page of it.
  if (opts?.paginate && PAGINATED_REPORT_TYPES.has(q.type)) {
    const { rows, pagination } = paginateRows(sorted.rows, q);
    return { ...sorted, rows, pagination };
  }
  return sorted;
}

/**
 * `sortBy` is validated against THIS report's own `columns` — the sortable
 * key set differs per report type (a cash book has `debit`/`credit`, a trial
 * balance doesn't), so there is no single global allowlist the way the Data
 * Engine has one. An unrecognized key (stale from a report-type switch, or
 * simply never sent) leaves `rows` exactly as its builder produced them —
 * every builder already has its own sensible default order.
 */
function applyReportSort(report: FinanceReport, q: FinanceReportQueryInput): FinanceReport {
  if (!q.sortBy) return report;
  const known = report.columns.some((c) => c.key === q.sortBy);
  if (!known) return report;
  const key = q.sortBy;
  const rows = sortRows(report.rows, (row) => row[key], q.sortDir ?? 'asc');
  return { ...report, rows };
}

/** A cash book defaults to today; everything else to the last 30 business days. */
function defaultRange(type: FinanceReportType, from?: string, to?: string): { from: string; to: string } {
  const today = businessDateStr();
  if (type === 'daily_cash_book') return { from: from ?? to ?? today, to: to ?? from ?? today };
  return { from: from ?? businessDaysAgoStr(29), to: to ?? today };
}

function shell(
  type: FinanceReportType,
  from: string,
  to: string,
  generatedBy: string,
  subtitle: string,
): Omit<FinanceReport, 'columns' | 'rows' | 'totals' | 'summary'> {
  return {
    type,
    title: FINANCE_REPORT_LABELS[type],
    subtitle,
    periodFrom: from,
    periodTo: to,
    generatedAt: new Date().toISOString(),
    generatedBy,
  };
}

function period(from: string, to: string): string {
  return from === to ? from : `${from} to ${to}`;
}

// ---------------------------------------------------------------------------
// Shared entry fetch
// ---------------------------------------------------------------------------

async function fetchEntries(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  extra?: { type?: 'income' | 'expense'; headIds?: string[] },
): Promise<{ entries: LedgerEntry[]; capped: boolean }> {
  // Paged: the db layer returns at most DB_MAX_ROWS (1000) rows per read
  // whatever range is asked for, so one `.range(0, ROW_CAP - 1)` came back
  // short at 1000 with no sign of it. A short page is therefore not the end —
  // only an empty one is. Rows already seen are skipped, so a voucher posted
  // between two pages cannot appear twice.
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  while (rows.length < ROW_CAP) {
    let query = withoutDeleted(
      db
        .from('ledger_entries')
        .select('*')
        .gte('entry_date', from)
        .lte('entry_date', to)
        .order('entry_date', { ascending: true })
        .order('seq', { ascending: true })
        .range(rows.length, ROW_CAP - 1),
    );

    if (q.branchId) query = query.eq('branch_id', q.branchId);
    if (q.ledgerHeadId) query = query.eq('ledger_head_id', q.ledgerHeadId);
    if (extra?.type) query = query.eq('ledger_head_type', extra.type);
    if (extra?.headIds) query = query.in('ledger_head_id', extra.headIds);

    const { data, error } = await query;
    if (error) throw error;
    const fresh = ((data ?? []) as Record<string, unknown>[]).filter((r) => !seen.has(r['id']));
    if (fresh.length === 0) break;
    for (const r of fresh) seen.add(r['id']);
    rows.push(...fresh);
  }

  const entries = rowToApi<LedgerEntry[]>(rows.slice(0, ROW_CAP)).map((e) => ({
    ...e,
    debit: num(e.debit),
    credit: num(e.credit),
    balance: num(e.balance),
  }));
  return { entries, capped: entries.length >= ROW_CAP };
}

function capNote(capped: boolean): string {
  return capped ? ` — TRUNCATED at ${ROW_CAP.toLocaleString()} rows; narrow the date range` : '';
}

// ---------------------------------------------------------------------------
// 1. Daily Cash Book
// ---------------------------------------------------------------------------

async function dailyCashBook(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  const [{ entries, capped }, opening] = await Promise.all([fetchEntries(q, from, to), getDayClosing(from)]);

  const columns: FinanceReportColumn[] = [
    { key: 'entryDate', label: 'Date', format: 'date', width: 14 },
    { key: 'voucherNo', label: 'Voucher No', width: 14 },
    { key: 'ledgerHeadName', label: 'Ledger Head', width: 24 },
    { key: 'description', label: 'Description', width: 38 },
    { key: 'branchName', label: 'Branch', width: 18 },
    { key: 'debit', label: 'Debit', format: 'money', align: 'right', width: 14 },
    { key: 'credit', label: 'Credit', format: 'money', align: 'right', width: 14 },
    { key: 'balance', label: 'Balance', format: 'money', align: 'right', width: 16 },
    { key: 'status', label: 'Status', width: 12, pdfOmit: true, excelOmit: true },
    { key: 'approvedByName', label: 'Approved By', width: 22, pdfOmit: true, excelOmit: true },
  ];

  const totalDebit = round2(entries.reduce((s, e) => s + e.debit, 0));
  const totalCredit = round2(entries.reduce((s, e) => s + e.credit, 0));

  return {
    ...shell('daily_cash_book', from, to, by, `Cash book for ${period(from, to)}${capNote(capped)}`),
    columns,
    rows: entries.map((e) => ({
      entryDate: e.entryDate,
      voucherNo: e.voucherNo,
      ledgerHeadName: e.ledgerHeadName,
      description: e.description,
      branchName: e.branchName ?? '—',
      debit: e.debit || null,
      credit: e.credit || null,
      balance: e.balance,
      status: e.status,
      approvedByName: e.approvedByName ?? '—',
    })),
    totals: { debit: totalDebit, credit: totalCredit },
    summary: [
      { label: 'Opening Balance', value: opening.openingBalance, format: 'money' },
      { label: 'Total Receipts', value: totalDebit, format: 'money' },
      { label: 'Total Payments', value: totalCredit, format: 'money' },
      { label: 'Closing Balance', value: round2(opening.openingBalance + totalDebit - totalCredit), format: 'money' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Refundable & Receivable Loans — the loan register, not the finance ledger
// ---------------------------------------------------------------------------

/**
 * The Loan Ledger as a report, so the existing /export renders its PDF and
 * Excel. Read from finance_loan_ledger — the same function the screen uses — so
 * the opening, totals and every running balance match the page exactly.
 * The first row is the opening balance brought forward.
 */
async function loanLedger(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  const book = await getLoanLedgerAll({
    from,
    to,
    clientId: q.clientId,
    branchId: q.branchId,
    entryType: q.loanEntryType,
    ledgerHeadId: q.ledgerHeadId,
    paymentMethod: q.paymentMethod,
    status: q.loanStatus,
    search: q.search,
  });

  const columns: FinanceReportColumn[] = [
    { key: 'businessDate', label: 'Date', format: 'date', width: 12 },
    { key: 'voucherNo', label: 'Voucher No', width: 12 },
    { key: 'entryType', label: 'Entry Type', width: 14 },
    { key: 'clientName', label: 'Client', width: 20 },
    { key: 'ledgerHeadName', label: 'Ledger Head', width: 18 },
    { key: 'description', label: 'Description', width: 30 },
    { key: 'branchName', label: 'Branch', width: 14 },
    { key: 'paymentMethod', label: 'Payment Method', width: 12, pdfOmit: true },
    { key: 'debit', label: 'Debit', format: 'money', align: 'right', width: 13 },
    { key: 'credit', label: 'Credit', format: 'money', align: 'right', width: 13 },
    { key: 'balance', label: 'Balance', format: 'money', align: 'right', width: 14 },
    { key: 'status', label: 'Status', width: 10 },
  ];

  const client = q.clientId ? book.entries.find((e) => e.clientId === q.clientId) : undefined;
  const clientLabel = q.clientId ? client?.clientName ?? 'Selected client' : 'All clients';

  return {
    ...shell('loan_ledger', from, to, by, `${clientLabel} · ${period(from, to)} · separate loan register, not in the General Ledger`),
    columns,
    rows: [
      {
        businessDate: from,
        voucherNo: '',
        entryType: '',
        clientName: '',
        ledgerHeadName: '',
        description: 'Opening balance brought forward',
        branchName: '',
        paymentMethod: '',
        debit: null,
        credit: null,
        balance: book.openingBalance,
        status: '',
      },
      ...book.entries.map((e) => ({
        businessDate: e.businessDate,
        voucherNo: e.voucherNo,
        entryType: LOAN_ENTRY_TYPE_LABELS[e.entryType],
        clientName: e.clientName,
        ledgerHeadName: e.ledgerHeadName,
        description: e.status === 'cancelled' ? `${e.description} (cancelled: ${e.cancelReason ?? ''})` : e.description,
        branchName: e.branchName ?? '—',
        paymentMethod: e.paymentMethod ? FINANCE_PAYMENT_METHOD_LABELS[e.paymentMethod] ?? e.paymentMethod : '—',
        // A cancelled row shows its amount nowhere: it is in no total.
        debit: e.status === 'posted' ? e.debit || null : null,
        credit: e.status === 'posted' ? e.credit || null : null,
        balance: e.balance,
        status: e.status === 'posted' ? 'Posted' : 'Cancelled',
      })),
    ],
    totals: { debit: book.totalDebit, credit: book.totalCredit },
    summary: [
      { label: 'Opening Balance', value: book.openingBalance, format: 'money' },
      { label: 'Total Loan Payment', value: book.totalDebit, format: 'money' },
      { label: 'Loan Paid', value: book.totalCredit, format: 'money' },
      { label: 'Closing Balance', value: book.closingBalance, format: 'money' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. General Ledger — every entry, grouped by head
// ---------------------------------------------------------------------------

async function generalLedger(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  const { entries, capped } = await fetchEntries(q, from, to);

  // Sorted by head so the report reads as one account after another, which is
  // what "general ledger" means to an accountant — the date-ordered view is the
  // cash book above.
  const sorted = [...entries].sort(
    (a, b) =>
      a.ledgerHeadType.localeCompare(b.ledgerHeadType) ||
      a.ledgerHeadName.localeCompare(b.ledgerHeadName) ||
      a.entryDate.localeCompare(b.entryDate) ||
      a.seq - b.seq,
  );

  // A per-account running balance, reset at each head. This is the column an
  // accountant reads down to see what one account did over the period; the
  // ledger's own `balance` is the BOOK balance and would be meaningless here.
  let currentHead = '';
  let runningForHead = 0;
  const rows = sorted.map((e) => {
    if (e.ledgerHeadName !== currentHead) {
      currentHead = e.ledgerHeadName;
      runningForHead = 0;
    }
    runningForHead = round2(runningForHead + e.debit - e.credit);
    return {
      ledgerHeadName: e.ledgerHeadName,
      ledgerHeadType: e.ledgerHeadType,
      entryDate: e.entryDate,
      voucherNo: e.voucherNo,
      description: e.description,
      branchName: e.branchName ?? '—',
      debit: e.debit || null,
      credit: e.credit || null,
      headBalance: runningForHead,
    };
  });

  return {
    ...shell('general_ledger', from, to, by, `All accounts, ${period(from, to)}${capNote(capped)}`),
    columns: [
      { key: 'ledgerHeadName', label: 'Ledger Head', width: 26 },
      { key: 'ledgerHeadType', label: 'Type', width: 10 },
      { key: 'entryDate', label: 'Date', format: 'date', width: 14 },
      { key: 'voucherNo', label: 'Voucher No', width: 14 },
      { key: 'description', label: 'Description', width: 40 },
      { key: 'branchName', label: 'Branch', width: 18 },
      { key: 'debit', label: 'Debit', format: 'money', align: 'right', width: 14 },
      { key: 'credit', label: 'Credit', format: 'money', align: 'right', width: 14 },
      { key: 'headBalance', label: 'Account Balance', format: 'money', align: 'right', width: 16 },
    ],
    rows,
    totals: {
      debit: round2(entries.reduce((s, e) => s + e.debit, 0)),
      credit: round2(entries.reduce((s, e) => s + e.credit, 0)),
    },
    summary: [
      { label: 'Accounts', value: new Set(entries.map((e) => e.ledgerHeadName)).size, format: 'number' },
      { label: 'Entries', value: entries.length, format: 'number' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. Income Statement — income by head
// ---------------------------------------------------------------------------

async function headBreakdown(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
  side: 'income' | 'expense',
): Promise<FinanceReport> {
  const { entries, capped } = await fetchEntries(q, from, to, { type: side });

  const byHead = new Map<string, { name: string; amount: number; count: number }>();
  for (const e of entries) {
    const key = e.ledgerHeadName;
    const cur = byHead.get(key) ?? { name: key, amount: 0, count: 0 };
    cur.amount += side === 'income' ? e.debit : e.credit;
    cur.count += 1;
    byHead.set(key, cur);
  }

  const total = round2([...byHead.values()].reduce((s, h) => s + h.amount, 0));
  const rows = [...byHead.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((h) => ({
      ledgerHeadName: h.name,
      entries: h.count,
      amount: round2(h.amount),
      // Zero total means an empty report; guarding here keeps a division by zero
      // out of every row rather than rendering NaN%.
      share: total > 0 ? round2((h.amount / total) * 100) : 0,
    }));

  return {
    ...shell(
      side === 'income' ? 'income_statement' : 'expense_report',
      from,
      to,
      by,
      `${side === 'income' ? 'Income' : 'Expenses'} by ledger head, ${period(from, to)}${capNote(capped)}`,
    ),
    columns: [
      { key: 'ledgerHeadName', label: 'Ledger Head', width: 34 },
      { key: 'entries', label: 'Entries', format: 'number', align: 'right', width: 12 },
      { key: 'amount', label: 'Amount', format: 'money', align: 'right', width: 18 },
      { key: 'share', label: '% of Total', format: 'number', align: 'right', width: 14 },
    ],
    rows,
    totals: { amount: total },
    summary: [
      { label: side === 'income' ? 'Total Income' : 'Total Expenses', value: total, format: 'money' },
      { label: 'Heads Used', value: rows.length, format: 'number' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. Expense Report — line by line, not just the rollup
// ---------------------------------------------------------------------------

async function expenseReport(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  const { entries, capped } = await fetchEntries(q, from, to, { type: 'expense' });
  const total = round2(entries.reduce((s, e) => s + e.credit, 0));

  return {
    ...shell('expense_report', from, to, by, `Every expense voucher, ${period(from, to)}${capNote(capped)}`),
    columns: [
      { key: 'entryDate', label: 'Date', format: 'date', width: 14 },
      { key: 'voucherNo', label: 'Voucher No', width: 14 },
      { key: 'ledgerHeadName', label: 'Expense Head', width: 26 },
      { key: 'description', label: 'Description', width: 42 },
      { key: 'branchName', label: 'Branch', width: 18 },
      { key: 'paymentMethod', label: 'Payment', width: 16 },
      { key: 'account', label: 'Account', width: 12 },
      { key: 'amount', label: 'Amount', format: 'money', align: 'right', width: 16 },
      { key: 'approvedByName', label: 'Approved By', width: 22 },
    ],
    rows: entries.map((e) => ({
      entryDate: e.entryDate,
      voucherNo: e.voucherNo,
      ledgerHeadName: e.ledgerHeadName,
      description: e.description,
      branchName: e.branchName ?? '—',
      paymentMethod: e.paymentMethod ?? '—',
      account: e.account,
      amount: e.credit,
      approvedByName: e.approvedByName ?? '—',
    })),
    totals: { amount: total },
    summary: [
      { label: 'Total Expenses', value: total, format: 'money' },
      { label: 'Vouchers', value: entries.length, format: 'number' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 5. Profit & Loss
// ---------------------------------------------------------------------------

async function profitAndLoss(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  const { entries, capped } = await fetchEntries(q, from, to);

  const groups = new Map<string, { section: string; head: string; amount: number }>();
  for (const e of entries) {
    const section = e.ledgerHeadType === 'income' ? 'Income' : 'Expenses';
    const key = `${section}|${e.ledgerHeadName}`;
    const cur = groups.get(key) ?? { section, head: e.ledgerHeadName, amount: 0 };
    cur.amount += e.ledgerHeadType === 'income' ? e.debit : e.credit;
    groups.set(key, cur);
  }

  const income = round2([...groups.values()].filter((g) => g.section === 'Income').reduce((s, g) => s + g.amount, 0));
  const expenses = round2([...groups.values()].filter((g) => g.section === 'Expenses').reduce((s, g) => s + g.amount, 0));

  const rows = [...groups.values()]
    // Income block first, then expenses, each ordered by size — the shape a P&L
    // is read in.
    .sort((a, b) => (a.section === b.section ? b.amount - a.amount : a.section === 'Income' ? -1 : 1))
    .map((g) => ({ section: g.section, ledgerHeadName: g.head, amount: round2(g.amount) }));

  return {
    ...shell('profit_loss', from, to, by, `Profit and loss, ${period(from, to)}${capNote(capped)}`),
    columns: [
      { key: 'section', label: 'Section', width: 14 },
      { key: 'ledgerHeadName', label: 'Ledger Head', width: 38 },
      { key: 'amount', label: 'Amount', format: 'money', align: 'right', width: 18 },
    ],
    rows,
    totals: { amount: round2(income - expenses) },
    summary: [
      { label: 'Total Income', value: income, format: 'money' },
      { label: 'Total Expenses', value: expenses, format: 'money' },
      { label: 'Net Profit', value: round2(income - expenses), format: 'money' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 6/7. Company & Branch Share
// ---------------------------------------------------------------------------

/**
 * Read from `finance_income_approvals`, not from the ledger.
 *
 * The approval row is where the split was DECIDED, and it carries the gross, the
 * percentage snapshot and both shares side by side — which is what makes the
 * report auditable. The ledger holds the same money but split again by account
 * (cash / bank), so reconstructing "what percentage was applied to what gross"
 * from it would mean re-deriving a number that was already recorded.
 */
async function shareReport(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  const isCompany = q.type === 'company_share';

  let query = withoutDeleted(
    db
      .from('finance_income_approvals')
      .select('*')
      .eq('status', 'approved')
      .gte('business_date', from)
      .lte('business_date', to)
      .order('business_date', { ascending: true })
      .order('branch_name', { ascending: true })
      .range(0, ROW_CAP - 1),
  );
  if (q.branchId) query = query.eq('branch_id', q.branchId);

  const { data, error } = await query;
  if (error) throw error;
  const rowsRaw = (data ?? []) as Record<string, unknown>[];

  const shareKey = isCompany ? 'company_share' : 'branch_share';
  const pctKey = isCompany ? 'company_share_pct' : 'branch_share_pct';
  const total = round2(rowsRaw.reduce((s, r) => s + num(r[shareKey]), 0));
  const gross = round2(rowsRaw.reduce((s, r) => s + num(r['total_amount']), 0));

  return {
    ...shell(
      q.type,
      from,
      to,
      by,
      `${isCompany ? 'Company' : 'Branch'} share of approved branch income, ${period(from, to)}`,
    ),
    columns: [
      { key: 'businessDate', label: 'Date', format: 'date', width: 14 },
      { key: 'referenceNo', label: 'Reference', width: 14 },
      { key: 'branchName', label: 'Branch', width: 24 },
      { key: 'totalAmount', label: 'Gross Collection', format: 'money', align: 'right', width: 18 },
      { key: 'branchExpenses', label: 'Branch Expenses', format: 'money', align: 'right', width: 18 },
      { key: 'sharePct', label: 'Share %', format: 'number', align: 'right', width: 12 },
      { key: 'share', label: isCompany ? 'Company Share' : 'Branch Share', format: 'money', align: 'right', width: 18 },
      { key: 'approvedByName', label: 'Approved By', width: 22 },
    ],
    rows: rowsRaw.map((r) => ({
      businessDate: r['business_date'] as string,
      referenceNo: r['reference_no'] as string,
      branchName: r['branch_name'] as string,
      totalAmount: num(r['total_amount']),
      branchExpenses: num(r['branch_expenses']),
      sharePct: num(r[pctKey]),
      share: num(r[shareKey]),
      approvedByName: (r['approved_by_name'] as string) ?? '—',
    })),
    totals: { totalAmount: gross, share: total },
    summary: [
      { label: 'Gross Collection', value: gross, format: 'money' },
      { label: isCompany ? 'Company Share' : 'Branch Share', value: total, format: 'money' },
      { label: 'Days Approved', value: rowsRaw.length, format: 'number' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 8. Salary Report
// ---------------------------------------------------------------------------

async function salaryReport(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  let query = withoutDeleted(
    db
      .from('salary_payments')
      .select('*')
      .neq('status', 'rejected')
      .order('salary_month', { ascending: true })
      .order('employee_name', { ascending: true })
      .range(0, ROW_CAP - 1),
  );

  // Filter by salary month when given; otherwise by the date the money moved,
  // which is the axis the ledger and the P&L use.
  if (q.salaryMonth) query = query.eq('salary_month', q.salaryMonth);
  else query = query.gte('payment_date', from).lte('payment_date', to);
  if (q.employeeId) query = query.eq('employee_id', q.employeeId);
  // Case-insensitive: department is free text, so a pre-normalization row
  // (or a direct DB write) can still differ only by case from the dropdown's
  // canonical value.
  if (q.department) query = query.ilike('department', q.department);

  const { data, error } = await query;
  if (error) throw error;
  const rowsRaw = (data ?? []) as Record<string, unknown>[];

  const net = round2(rowsRaw.reduce((s, r) => s + num(r['net_salary']), 0));

  return {
    ...shell(
      'salary',
      from,
      to,
      by,
      q.salaryMonth ? `Payroll for ${q.salaryMonth}` : `Payroll paid ${period(from, to)}`,
    ),
    columns: [
      { key: 'salaryNo', label: 'Salary No', width: 14 },
      { key: 'employeeName', label: 'Employee', width: 26 },
      { key: 'department', label: 'Department', width: 18 },
      { key: 'designation', label: 'Designation', width: 20 },
      { key: 'salaryMonth', label: 'Month', width: 12 },
      { key: 'grossSalary', label: 'Salary', format: 'money', align: 'right', width: 14 },
      { key: 'bonus', label: 'Bonus', format: 'money', align: 'right', width: 12 },
      { key: 'deductions', label: 'Deduction', format: 'money', align: 'right', width: 14 },
      { key: 'netSalary', label: 'Net Salary', format: 'money', align: 'right', width: 16 },
      { key: 'paymentDate', label: 'Paid On', format: 'date', width: 14 },
      { key: 'status', label: 'Status', width: 14 },
    ],
    rows: rowsRaw.map((r) => ({
      salaryNo: r['salary_no'] as string,
      employeeName: r['employee_name'] as string,
      department: r['department'] as string,
      designation: r['designation'] as string,
      salaryMonth: r['salary_month'] as string,
      grossSalary: num(r['gross_salary']),
      bonus: num(r['bonus']),
      deductions: num(r['deductions']),
      netSalary: num(r['net_salary']),
      paymentDate: (r['payment_date'] as string) ?? '—',
      status: r['status'] as string,
    })),
    totals: {
      grossSalary: round2(rowsRaw.reduce((s, r) => s + num(r['gross_salary']), 0)),
      bonus: round2(rowsRaw.reduce((s, r) => s + num(r['bonus']), 0)),
      deductions: round2(rowsRaw.reduce((s, r) => s + num(r['deductions']), 0)),
      netSalary: net,
    },
    summary: [
      { label: 'Total Net Payroll', value: net, format: 'money' },
      { label: 'Payslips', value: rowsRaw.length, format: 'number' },
      { label: 'Employees', value: new Set(rowsRaw.map((r) => r['employee_id'])).size, format: 'number' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 9. Partner Expense Report
// ---------------------------------------------------------------------------

async function partnerExpenseReport(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  let query = withoutDeleted(
    db
      .from('partner_expenses')
      .select('*')
      .neq('status', 'rejected')
      .gte('business_date', from)
      .lte('business_date', to)
      .order('business_date', { ascending: true })
      .order('partner_name', { ascending: true })
      .range(0, ROW_CAP - 1),
  );
  if (q.partnerName) query = query.eq('partner_name', q.partnerName);

  const { data, error } = await query;
  if (error) throw error;
  const rowsRaw = (data ?? []) as Record<string, unknown>[];
  const total = round2(rowsRaw.reduce((s, r) => s + num(r['amount']), 0));

  return {
    ...shell('partner_expense', from, to, by, `Partner expenses, ${period(from, to)}`),
    columns: [
      { key: 'businessDate', label: 'Date', format: 'date', width: 14 },
      { key: 'expenseNo', label: 'Expense No', width: 14 },
      { key: 'partnerName', label: 'Partner', width: 24 },
      { key: 'ledgerHeadName', label: 'Expense Head', width: 24 },
      { key: 'description', label: 'Description', width: 36 },
      { key: 'paymentMethod', label: 'Payment', width: 16 },
      { key: 'amount', label: 'Amount', format: 'money', align: 'right', width: 16 },
      { key: 'requestedByName', label: 'Requested By', width: 22 },
      { key: 'approvedByName', label: 'Approved By', width: 22 },
      { key: 'status', label: 'Status', width: 14 },
    ],
    rows: rowsRaw.map((r) => ({
      businessDate: r['business_date'] as string,
      expenseNo: r['expense_no'] as string,
      partnerName: r['partner_name'] as string,
      ledgerHeadName: r['ledger_head_name'] as string,
      description: r['description'] as string,
      paymentMethod: r['payment_method'] as string,
      amount: num(r['amount']),
      requestedByName: (r['requested_by_name'] as string) || '—',
      approvedByName: (r['approved_by_name'] as string) ?? '—',
      status: r['status'] as string,
    })),
    totals: { amount: total },
    summary: [
      { label: 'Total Partner Expenses', value: total, format: 'money' },
      { label: 'Partners', value: new Set(rowsRaw.map((r) => r['partner_name'])).size, format: 'number' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 10. Trial Balance
// ---------------------------------------------------------------------------

/**
 * A trial balance over a SINGLE-ENTRY cash book.
 *
 * Worth being explicit, because an accountant will check: this system records
 * receipts and payments, not double entry, so the head totals alone do not
 * balance — their difference is exactly the cash and bank the business is
 * holding. The closing Cash & Bank position is therefore added as the
 * contra row, which is what makes the two columns agree. The subtitle says so on
 * every copy, so nobody has to take the footer on trust.
 */
async function trialBalance(
  q: FinanceReportQueryInput,
  from: string,
  to: string,
  by: string,
): Promise<FinanceReport> {
  const { entries, capped } = await fetchEntries(q, from, to);
  const opening = await getDayClosing(from);

  const heads = new Map<string, { name: string; type: string; debit: number; credit: number }>();
  for (const e of entries) {
    const cur = heads.get(e.ledgerHeadName) ?? {
      name: e.ledgerHeadName,
      type: e.ledgerHeadType,
      debit: 0,
      credit: 0,
    };
    cur.debit += e.debit;
    cur.credit += e.credit;
    heads.set(e.ledgerHeadName, cur);
  }

  const rows = [...heads.values()]
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    .map((h) => ({
      ledgerHeadName: h.name,
      ledgerHeadType: h.type,
      debit: round2(h.debit) || null,
      credit: round2(h.credit) || null,
    }));

  const headDebit = round2(entries.reduce((s, e) => s + e.debit, 0));
  const headCredit = round2(entries.reduce((s, e) => s + e.credit, 0));
  const closing = round2(opening.openingBalance + headDebit - headCredit);

  // The contra row. A positive closing balance is an asset the business holds,
  // so it sits on the credit side to balance the receipts recorded as debits.
  rows.push({
    ledgerHeadName: `Cash & Bank Balance (closing ${to})`,
    ledgerHeadType: 'balance',
    debit: closing < 0 ? round2(Math.abs(closing)) : null,
    credit: closing >= 0 ? closing : null,
  });
  if (opening.openingBalance !== 0) {
    rows.unshift({
      ledgerHeadName: `Opening Balance (${from})`,
      ledgerHeadType: 'balance',
      debit: opening.openingBalance > 0 ? round2(opening.openingBalance) : null,
      credit: opening.openingBalance < 0 ? round2(Math.abs(opening.openingBalance)) : null,
    });
  }

  const totalDebit = round2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0));
  const totalCredit = round2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0));

  return {
    ...shell(
      'trial_balance',
      from,
      to,
      by,
      `${period(from, to)} — single-entry cash book; the Cash & Bank row is the ` +
        `contra that balances the two columns${capNote(capped)}`,
    ),
    columns: [
      { key: 'ledgerHeadName', label: 'Ledger Head', width: 40 },
      { key: 'ledgerHeadType', label: 'Type', width: 12 },
      { key: 'debit', label: 'Debit', format: 'money', align: 'right', width: 18 },
      { key: 'credit', label: 'Credit', format: 'money', align: 'right', width: 18 },
    ],
    rows,
    totals: { debit: totalDebit, credit: totalCredit },
    summary: [
      { label: 'Total Debit', value: totalDebit, format: 'money' },
      { label: 'Total Credit', value: totalCredit, format: 'money' },
      { label: 'Difference', value: round2(totalDebit - totalCredit), format: 'money' },
    ],
  };
}

/** Exported for the dashboard's share cards, which reuse the same head lookup. */
export async function shareHeadIds(): Promise<{ company: string; branch: string }> {
  const [c, b] = await Promise.all([
    getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.COMPANY_SHARE),
    getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.BRANCH_SHARE),
  ]);
  return { company: c.id, branch: b.id };
}
