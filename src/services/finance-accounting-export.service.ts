import ExcelJS from 'exceljs';
import {
  BANK_CODE,
  CASH_CODE,
  EASYPAISA_CODE,
  rupees,
  type AccountingBooks,
  type CheckLevel,
  type JournalEntry,
  type StatementLine,
} from './finance-accounting.service';

/**
 * The Daily Ledger's Excel button: one workbook, five sheets, in this order —
 * General Entries, Ledger, Trial Balance, Income Statement, Balance Sheet.
 *
 * Every figure comes from `buildAccountingBooks`, which has already checked
 * them; this module only lays them out. Column totals are written as SUM
 * formulas WITH their verified result cached, so the file shows the right
 * figure in a viewer that does not recalculate, and an accountant who edits a
 * row in Excel sees the total follow.
 *
 * Brand colours as in finance-export.service.ts.
 */

export const ACCOUNTING_SHEETS = ['General Entries', 'Ledger', 'Trial Balance', 'Income Statement', 'Balance Sheet'] as const;

const ORANGE = 'FFF97316';
const INK = 'FF6B3B1E';
const MUTED = 'FF777777';
const BAND = 'FFFFF3E8';
/** Negatives in red brackets, as an accountant reads them. */
const MONEY = '#,##0.00;[Red](#,##0.00)';
const DATE = 'dd-mmm-yyyy';
const STAMP = 'dd-mmm-yyyy hh:mm';

const STATUS_FILL: Record<Exclude<CheckLevel, 'info'>, { fill: string; font: string }> = {
  pass: { fill: 'FFE8F5E9', font: 'FF1B5E20' },
  warn: { fill: 'FFFFF4E5', font: 'FF8A4B00' },
  fail: { fill: 'FFFDECEA', font: 'FFB71C1C' },
};
const CHECK_FONT: Record<CheckLevel, string> = { pass: 'FF1B5E20', warn: 'FF8A4B00', fail: 'FFB71C1C', info: MUTED };

const SOURCE_LABELS: Record<string, string> = {
  opening: 'Opening balance',
  manual: 'Income & expense',
  branch_income: 'Branch income',
  company_share: 'Company share',
  branch_share: 'Branch share',
  salary: 'Salary',
  employee_advance: 'Employee advance',
  partner_expense: 'Partner',
  adjustment: 'Adjustment',
  branch_share_payout: 'Branch share payout',
  branch_share_bonus: 'Branch bonus',
  cash_transfer: 'Branch cash transfer',
  vendor_payment: 'Supplier payment',
};

/**
 * Text that a spreadsheet would read as a formula (=, +, -, @, tab, CR at the
 * start) is prefixed with an apostrophe. Descriptions and branch names are
 * typed by people; a cell must never execute what someone typed.
 */
export function safeText(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** 'YYYY-MM-DD' as a real Excel date (UTC midnight, which ExcelJS writes as that calendar day). */
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
/** An instant as Karachi wall-clock time (UTC+5, no DST) for a date-time cell. */
const asKarachi = (iso: string) => new Date(Date.parse(iso) + 5 * 3_600_000);
const money = (p: number | null | undefined) => (p === null || p === undefined ? null : rupees(p));

interface Ctx {
  companyName: string;
  generatedBy: string;
  generatedAt: Date;
}

function period(books: AccountingBooks): string {
  return books.from === books.to ? books.from : `${books.from} to ${books.to}`;
}

export function accountingWorkbookFilename(books: AccountingBooks): string {
  const range = books.from === books.to ? books.from : `${books.from}_to_${books.to}`;
  const branch = books.branch ? `_${books.branch.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}` : '';
  return `Mountain_Bakes_Daily_Ledger_${range}${branch}.xlsx`;
}

function newSheet(wb: ExcelJS.Workbook, name: string, companyName: string, freezeRows: number) {
  return wb.addWorksheet(name, {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    },
    headerFooter: { oddFooter: `&L${companyName} — ${name}&RPage &P of &N` },
    views: [{ state: 'frozen', ySplit: freezeRows }],
  });
}

/** Rows 1–4: title, period and branch, generated, validation status. The next free row is 6. */
function letterhead(sheet: ExcelJS.Worksheet, title: string, books: AccountingBooks, ctx: Ctx, lastCol: number) {
  const line = (row: number, text: string, font: Partial<ExcelJS.Font>) => {
    sheet.mergeCells(row, 1, row, lastCol);
    const cell = sheet.getCell(row, 1);
    cell.value = safeText(text);
    cell.font = font;
    cell.alignment = { vertical: 'middle', wrapText: false };
    return cell;
  };
  line(1, `${ctx.companyName} — ${title}`, { bold: true, size: 14, color: { argb: INK } });
  line(
    2,
    `Period: ${period(books)}  ·  Branch: ${books.branch?.name ?? 'All branches'}  ·  Amounts in PKR (Rs)`,
    { size: 10, color: { argb: 'FF333333' } },
  );
  const stamp = new Date(ctx.generatedAt.getTime() + 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  line(3, `Generated ${stamp} (Pakistan time) by ${ctx.generatedBy}  ·  Source: posted Daily Ledger vouchers`, {
    size: 9,
    color: { argb: MUTED },
  });
  const tone = STATUS_FILL[books.status.level];
  const status = line(4, `Validation: ${books.status.text}`, { bold: true, size: 10, color: { argb: tone.font } });
  status.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tone.fill } };
  sheet.getRow(1).height = 22;
}

function headerRow(sheet: ExcelJS.Worksheet, row: number, labels: string[], rightFrom: number) {
  const r = sheet.getRow(row);
  labels.forEach((label, i) => {
    const cell = r.getCell(i + 1);
    cell.value = label;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ORANGE } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: i + 1 >= rightFrom ? 'right' : 'left', wrapText: true };
  });
  r.height = 22;
}

function setMoney(cell: ExcelJS.Cell, p: number | null | undefined, blankZero = false) {
  cell.value = p === null || p === undefined || (blankZero && p === 0) ? null : rupees(p);
  cell.numFmt = MONEY;
  cell.alignment = { horizontal: 'right' };
}

function setSum(cell: ExcelJS.Cell, col: string, first: number, last: number, result: number) {
  cell.value = last >= first ? { formula: `SUM(${col}${first}:${col}${last})`, result: rupees(result) } : rupees(result);
  cell.numFmt = MONEY;
  cell.alignment = { horizontal: 'right' };
}

function totalStyle(row: ExcelJS.Row, lastCol: number) {
  for (let c = 1; c <= lastCol; c += 1) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: INK } };
    cell.border = { top: { style: 'thin', color: { argb: ORANGE } }, bottom: { style: 'double', color: { argb: ORANGE } } };
  }
}

function widths(sheet: ExcelJS.Worksheet, ws: number[]) {
  ws.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
}

// ---------------------------------------------------------------------------

export async function exportAccountingWorkbook(
  books: AccountingBooks,
  opts: { companyName?: string; generatedBy: string; generatedAt?: Date },
): Promise<Buffer> {
  const ctx: Ctx = {
    companyName: opts.companyName || 'Mountain Bakes',
    generatedBy: opts.generatedBy,
    generatedAt: opts.generatedAt ?? new Date(),
  };
  const wb = new ExcelJS.Workbook();
  wb.creator = `${ctx.companyName} — Finance Ledger`;
  wb.title = `Daily Ledger — accounting workbook, ${period(books)}`;
  wb.created = ctx.generatedAt;

  const voucherById = new Map(books.journal.map((j) => [j.voucher.id, j.voucher.voucherNo]));
  const accountName = (code: string) => books.accounts.get(code)?.name ?? code;
  const periodJournal = books.journal.filter((j) => j.inPeriod);

  generalEntries(wb, books, ctx, periodJournal, voucherById, accountName);
  ledger(wb, books, ctx, periodJournal, accountName);
  trialBalance(wb, books, ctx);
  statement(wb, 'Income Statement', books, ctx, books.incomeStatement.lines, 'For the period');
  balanceSheet(wb, books, ctx);

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

function sourceRef(j: JournalEntry, voucherById: Map<string, string>): string {
  const v = j.voucher;
  if (v.reversesEntryId) return `Reverses ${voucherById.get(v.reversesEntryId) ?? v.reversesEntryId}`;
  return v.sourceId ? `${v.sourceType}:${v.sourceId}` : '';
}

// ── 1. General Entries ──────────────────────────────────────────────────────

function generalEntries(
  wb: ExcelJS.Workbook,
  books: AccountingBooks,
  ctx: Ctx,
  journal: JournalEntry[],
  voucherById: Map<string, string>,
  accountName: (code: string) => string,
) {
  const HEAD = 6;
  const sheet = newSheet(wb, 'General Entries', ctx.companyName, HEAD);
  const labels = [
    'Entry ID', 'Line', 'Business Date', 'Posted At', 'Source Type', 'Source Reference', 'Branch',
    'Account Code', 'Account Name', 'Classification', 'Channel', 'Description', 'Debit (DR)', 'Credit (CR)', 'Status',
  ];
  widths(sheet, [14, 6, 13, 17, 18, 30, 18, 22, 30, 15, 14, 44, 15, 15, 10]);
  letterhead(sheet, 'General Entries (journal)', books, ctx, labels.length);
  headerRow(sheet, HEAD, labels, 13);
  sheet.getColumn(13).alignment = { horizontal: 'right' };

  let row = HEAD;
  let dr = 0;
  let cr = 0;
  let band = false;
  for (const j of journal) {
    const v = j.voucher;
    const lines = j.lines.length > 0 ? j.lines : [null];
    band = !band;
    lines.forEach((l, i) => {
      row += 1;
      const r = sheet.getRow(row);
      r.getCell(1).value = safeText(j.id);
      r.getCell(2).value = i + 1;
      r.getCell(3).value = asDate(v.entryDate);
      r.getCell(3).numFmt = DATE;
      if (v.postedAt) {
        r.getCell(4).value = asKarachi(v.postedAt);
        r.getCell(4).numFmt = STAMP;
      }
      r.getCell(5).value = SOURCE_LABELS[v.sourceType] ?? v.sourceType;
      r.getCell(6).value = safeText(sourceRef(j, voucherById));
      r.getCell(7).value = safeText(v.branchName ?? '');
      if (l) {
        const acc = books.accounts.get(l.accountCode);
        r.getCell(8).value = safeText(l.accountCode);
        r.getCell(9).value = safeText(accountName(l.accountCode));
        r.getCell(10).value = acc?.classification ?? '';
        r.getCell(11).value = safeText(l.channel);
        setMoney(r.getCell(13), l.debit, true);
        setMoney(r.getCell(14), l.credit, true);
        dr += l.debit;
        cr += l.credit;
      } else {
        r.getCell(9).value = 'INVALID — no journal lines (zero or negative amount)';
        r.getCell(9).font = { bold: true, color: { argb: 'FFB71C1C' } };
      }
      r.getCell(12).value = safeText(v.description);
      r.getCell(12).alignment = { wrapText: true, vertical: 'top' };
      r.getCell(15).value = j.balanced ? v.status : 'UNBALANCED';
      if (!j.balanced) r.getCell(15).font = { bold: true, color: { argb: 'FFB71C1C' } };
      if (band) {
        for (let c = 1; c <= labels.length; c += 1) {
          r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
        }
      }
    });
  }
  const last = row;
  if (last > HEAD) sheet.autoFilter = { from: { row: HEAD, column: 1 }, to: { row: last, column: labels.length } };

  row += 1;
  const total = sheet.getRow(row);
  total.getCell(1).value = journal.length === 0 ? 'TOTAL — no vouchers in this period' : `TOTAL — ${journal.length} journal entries`;
  setSum(total.getCell(13), 'M', HEAD + 1, last, dr);
  setSum(total.getCell(14), 'N', HEAD + 1, last, cr);
  totalStyle(total, labels.length);
  row += 1;
  const diff = sheet.getRow(row);
  diff.getCell(1).value = 'Difference (DR − CR)';
  diff.getCell(13).value = { formula: `M${row - 1}-N${row - 1}`, result: rupees(dr - cr) };
  diff.getCell(13).numFmt = MONEY;
  diff.getCell(1).font = { bold: true, color: { argb: INK } };
  sheet.pageSetup.printTitlesRow = `${HEAD}:${HEAD}`;
}

// ── 2. Ledger ───────────────────────────────────────────────────────────────

function ledger(
  wb: ExcelJS.Workbook,
  books: AccountingBooks,
  ctx: Ctx,
  journal: JournalEntry[],
  accountName: (code: string) => string,
) {
  const HEAD = 6;
  const sheet = newSheet(wb, 'Ledger', ctx.companyName, HEAD);
  const labels = [
    'Date', 'Reference ID', 'Source', 'Description', 'Account', 'Channel', 'Branch',
    'Cash', 'Bank', 'General Fund', 'DR', 'CR', 'Balance',
  ];
  const COLS = labels.length;
  widths(sheet, [13, 15, 18, 42, 30, 16, 16, 15, 15, 15, 15, 15, 16]);
  letterhead(sheet, 'Ledger (Cash · Bank · General Fund)', books, ctx, COLS);
  headerRow(sheet, HEAD, labels, 8);

  const accounts = books.accounts;
  const isBank = (code: string) => code === BANK_CODE || code === EASYPAISA_CODE;
  const isFund = (code: string) => accounts.get(code)?.column === 'generalFund';
  const opening = (code: string) => books.balances.find((b) => b.account.code === code)?.opening ?? 0;
  const closing = (code: string) => books.balances.find((b) => b.account.code === code)?.closing ?? 0;
  const fundCodes = books.balances.filter((b) => b.account.column === 'generalFund').map((b) => b.account.code);
  const fundOpen = fundCodes.reduce((s, c) => s - opening(c), 0);
  const fundClose = fundCodes.reduce((s, c) => s - closing(c), 0);
  const cashOpen = opening(CASH_CODE);
  const bankOpen = opening(BANK_CODE) + opening(EASYPAISA_CODE);

  let row = HEAD + 1;
  const ob = sheet.getRow(row);
  ob.getCell(1).value = asDate(books.from);
  ob.getCell(1).numFmt = DATE;
  ob.getCell(4).value = 'Opening balance brought forward';
  setMoney(ob.getCell(8), cashOpen);
  setMoney(ob.getCell(9), bankOpen);
  setMoney(ob.getCell(10), fundOpen);
  setMoney(ob.getCell(13), cashOpen + bankOpen);
  for (let c = 1; c <= COLS; c += 1) {
    ob.getCell(c).font = { bold: true, color: { argb: INK } };
    ob.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
  }

  // Each row is one journal entry: Cash and Bank as the signed movement of
  // each (+ in, − out), General Fund as the movement of owners' equity
  // (+ capital in, − withdrawn), DR/CR as the receipt or payment, and Balance
  // as Cash + Bank after the entry — the cash book's own running balance.
  let balance = cashOpen + bankOpen;
  const first = row + 1;
  let tCash = 0, tBank = 0, tFund = 0, tDr = 0, tCr = 0;
  for (const j of journal) {
    row += 1;
    const v = j.voucher;
    let cash = 0, bank = 0, fund = 0, dr = 0, cr = 0;
    const contra: string[] = [];
    const channels = new Set<string>();
    for (const l of j.lines) {
      const asset = l.accountCode === CASH_CODE || isBank(l.accountCode);
      if (l.accountCode === CASH_CODE) cash += l.debit - l.credit;
      if (isBank(l.accountCode)) bank += l.debit - l.credit;
      if (isFund(l.accountCode)) fund += l.credit - l.debit;
      if (asset) {
        dr += l.debit;
        cr += l.credit;
        if (l.channel) channels.add(l.channel);
      } else {
        contra.push(accountName(l.accountCode));
      }
    }
    balance += cash + bank;
    tCash += cash; tBank += bank; tFund += fund; tDr += dr; tCr += cr;

    const r = sheet.getRow(row);
    r.getCell(1).value = asDate(v.entryDate);
    r.getCell(1).numFmt = DATE;
    r.getCell(2).value = safeText(j.id);
    r.getCell(3).value = SOURCE_LABELS[v.sourceType] ?? v.sourceType;
    r.getCell(4).value = safeText(v.description);
    r.getCell(4).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(5).value = safeText([...new Set(contra)].join(', '));
    r.getCell(6).value = safeText([...channels].join(' + '));
    r.getCell(7).value = safeText(v.branchName ?? '');
    setMoney(r.getCell(8), cash, true);
    setMoney(r.getCell(9), bank, true);
    setMoney(r.getCell(10), fund, true);
    setMoney(r.getCell(11), dr, true);
    setMoney(r.getCell(12), cr, true);
    setMoney(r.getCell(13), balance);
  }
  const last = row;
  sheet.autoFilter = { from: { row: HEAD, column: 1 }, to: { row: Math.max(last, HEAD + 1), column: COLS } };

  row += 1;
  const tot = sheet.getRow(row);
  tot.getCell(4).value = 'Period movement';
  setSum(tot.getCell(8), 'H', first, last, tCash);
  setSum(tot.getCell(9), 'I', first, last, tBank);
  setSum(tot.getCell(10), 'J', first, last, tFund);
  setSum(tot.getCell(11), 'K', first, last, tDr);
  setSum(tot.getCell(12), 'L', first, last, tCr);
  totalStyle(tot, COLS);

  row += 1;
  const cb = sheet.getRow(row);
  cb.getCell(1).value = asDate(books.to);
  cb.getCell(1).numFmt = DATE;
  cb.getCell(4).value = 'Closing balance carried forward';
  setMoney(cb.getCell(8), closing(CASH_CODE));
  setMoney(cb.getCell(9), closing(BANK_CODE) + closing(EASYPAISA_CODE));
  setMoney(cb.getCell(10), fundClose);
  setMoney(cb.getCell(13), balance);
  totalStyle(cb, COLS);

  row += 1;
  const ep = sheet.getRow(row);
  ep.getCell(4).value = `of which Bank — Easypaisa: opening ${rupees(opening(EASYPAISA_CODE)).toFixed(2)}, closing ${rupees(closing(EASYPAISA_CODE)).toFixed(2)}`;
  ep.getCell(4).font = { italic: true, size: 9, color: { argb: MUTED } };

  // ── Account ledgers: each account on its own, in its normal direction ────
  row += 2;
  sheet.mergeCells(row, 1, row, COLS);
  const t = sheet.getCell(row, 1);
  t.value = 'Account ledgers — opening, movements and closing for each account (balance in the account\'s normal direction)';
  t.font = { bold: true, size: 12, color: { argb: INK } };
  row += 1;
  const subLabels = ['Date', 'Reference ID', 'Source', 'Description', 'Contra Account', 'Channel', 'Branch', '', '', '', 'DR', 'CR', 'Balance'];
  headerRow(sheet, row, subLabels, 8);

  for (const b of books.trialBalance.rows) {
    const code = b.account.code;
    const sign = b.account.normal === 'debit' ? 1 : -1;
    row += 2;
    sheet.mergeCells(row, 1, row, COLS);
    const h = sheet.getCell(row, 1);
    h.value = safeText(`${code} · ${b.account.name} · ${b.account.classification} · normal balance ${b.account.normal}`);
    h.font = { bold: true, color: { argb: INK } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };

    row += 1;
    const o = sheet.getRow(row);
    o.getCell(1).value = asDate(books.from);
    o.getCell(1).numFmt = DATE;
    o.getCell(4).value = b.account.type === 'revenue' || b.account.type === 'expense'
      ? 'Opening balance (income statement accounts open the period at zero)'
      : 'Opening balance';
    setMoney(o.getCell(13), sign * b.opening);

    let running = sign * b.opening;
    for (const j of journal) {
      for (const l of j.lines) {
        if (l.accountCode !== code) continue;
        row += 1;
        running += sign * (l.debit - l.credit);
        const r = sheet.getRow(row);
        r.getCell(1).value = asDate(j.voucher.entryDate);
        r.getCell(1).numFmt = DATE;
        r.getCell(2).value = safeText(j.id);
        r.getCell(3).value = SOURCE_LABELS[j.voucher.sourceType] ?? j.voucher.sourceType;
        r.getCell(4).value = safeText(j.voucher.description);
        r.getCell(4).alignment = { wrapText: true, vertical: 'top' };
        r.getCell(5).value = safeText(
          [...new Set(j.lines.filter((x) => x.accountCode !== code).map((x) => accountName(x.accountCode)))].join(', '),
        );
        r.getCell(6).value = safeText(l.channel);
        r.getCell(7).value = safeText(j.voucher.branchName ?? '');
        setMoney(r.getCell(11), l.debit, true);
        setMoney(r.getCell(12), l.credit, true);
        setMoney(r.getCell(13), running);
      }
    }
    row += 1;
    const c = sheet.getRow(row);
    c.getCell(1).value = asDate(books.to);
    c.getCell(1).numFmt = DATE;
    c.getCell(4).value = 'Closing balance';
    setMoney(c.getCell(11), b.periodDebit);
    setMoney(c.getCell(12), b.periodCredit);
    setMoney(c.getCell(13), sign * b.closing);
    totalStyle(c, COLS);
  }
  sheet.pageSetup.printTitlesRow = `${HEAD}:${HEAD}`;
}

// ── 3. Trial Balance ────────────────────────────────────────────────────────

function trialBalance(wb: ExcelJS.Workbook, books: AccountingBooks, ctx: Ctx) {
  const HEAD = 6;
  const sheet = newSheet(wb, 'Trial Balance', ctx.companyName, HEAD);
  const labels = [
    'Account Code', 'Account Name', 'Classification', 'Normal Balance',
    'Opening Debit', 'Opening Credit', 'Period Debit', 'Period Credit', 'Closing Debit', 'Closing Credit',
  ];
  widths(sheet, [24, 36, 18, 10, 16, 16, 16, 16, 16, 16]);
  letterhead(sheet, `Trial Balance as at ${books.to}`, books, ctx, labels.length);
  headerRow(sheet, HEAD, labels, 5);

  let row = HEAD;
  for (const b of books.trialBalance.rows) {
    row += 1;
    const r = sheet.getRow(row);
    r.getCell(1).value = safeText(b.account.code);
    r.getCell(2).value = safeText(b.account.name);
    r.getCell(3).value = b.account.classification;
    r.getCell(4).value = b.account.normal === 'debit' ? 'Debit' : 'Credit';
    setMoney(r.getCell(5), Math.max(b.opening, 0), true);
    setMoney(r.getCell(6), Math.max(-b.opening, 0), true);
    setMoney(r.getCell(7), b.periodDebit, true);
    setMoney(r.getCell(8), b.periodCredit, true);
    setMoney(r.getCell(9), Math.max(b.closing, 0), true);
    setMoney(r.getCell(10), Math.max(-b.closing, 0), true);
  }
  const last = row;
  sheet.autoFilter = { from: { row: HEAD, column: 1 }, to: { row: Math.max(last, HEAD + 1), column: labels.length } };

  const t = books.trialBalance.totals;
  row += 1;
  const tot = sheet.getRow(row);
  tot.getCell(1).value = 'TOTAL';
  (['E', 'F', 'G', 'H', 'I', 'J'] as const).forEach((col, i) => {
    const v = [t.openingDebit, t.openingCredit, t.periodDebit, t.periodCredit, t.closingDebit, t.closingCredit][i]!;
    setSum(tot.getCell(5 + i), col, HEAD + 1, last, v);
  });
  totalStyle(tot, labels.length);

  row += 1;
  const diff = sheet.getRow(row);
  diff.getCell(1).value = 'Difference (Debit − Credit)';
  diff.getCell(1).font = { bold: true, color: { argb: INK } };
  const pairs: [string, string, number][] = [
    ['E', 'F', t.openingDebit - t.openingCredit],
    ['G', 'H', t.periodDebit - t.periodCredit],
    ['I', 'J', t.closingDebit - t.closingCredit],
  ];
  pairs.forEach(([a, b2, v], i) => {
    const cell = diff.getCell(5 + i * 2);
    cell.value = { formula: `${a}${row - 1}-${b2}${row - 1}`, result: rupees(v) };
    cell.numFmt = MONEY;
  });

  row += 2;
  const notes = [
    `Revenue and expense accounts open the period at zero; profit earned before ${books.from} is carried in Retained Earnings (brought forward).`,
    'Easypaisa is a Bank sub-account (Bank — Easypaisa); Bank in the Ledger and on the Balance Sheet is Bank Account + Easypaisa.',
    ...books.checks.filter((c) => ['ledger_tb', 'tb_balanced'].includes(c.key)).map((c) => `${c.label}: ${c.level.toUpperCase()} — ${c.detail}`),
  ];
  for (const n of notes) {
    sheet.mergeCells(row, 1, row, labels.length);
    const cell = sheet.getCell(row, 1);
    cell.value = safeText(n);
    cell.font = { italic: true, size: 9, color: { argb: MUTED } };
    row += 1;
  }
  sheet.pageSetup.printTitlesRow = `${HEAD}:${HEAD}`;
}

// ── 4/5. Statements ─────────────────────────────────────────────────────────

/** Label in A, items in B, subtotals and totals in C. Returns the next free row. */
function statement(
  wb: ExcelJS.Workbook,
  name: string,
  books: AccountingBooks,
  ctx: Ctx,
  lines: StatementLine[],
  heading: string,
  extraCols: number[] = [],
): { sheet: ExcelJS.Worksheet; row: number } {
  const lastCol = 3 + extraCols.length;
  const sheet = newSheet(wb, name, ctx.companyName, 6);
  widths(sheet, [70, 18, 18, ...extraCols]);
  letterhead(sheet, name, books, ctx, lastCol);
  headerRow(sheet, 6, [heading === 'As at' ? `As at ${books.to}` : `${heading} ${period(books)}`, 'Rs', 'Rs'], 2);

  let row = 6;
  for (const l of lines) {
    row += 1;
    const r = sheet.getRow(row);
    const label = r.getCell(1);
    label.value = safeText(l.label);
    label.alignment = { indent: (l.indent ?? 0) * 2, wrapText: true };
    if (l.kind === 'heading') label.font = { bold: true, color: { argb: INK } };
    if (l.kind === 'note') {
      label.font = { italic: true, size: 9, color: { argb: MUTED } };
      r.getCell(2).value = 'n/a';
      r.getCell(2).alignment = { horizontal: 'right' };
      r.getCell(2).font = { italic: true, size: 9, color: { argb: MUTED } };
    }
    if (l.kind === 'item') setMoney(r.getCell(2), l.amount ?? 0);
    if (l.kind === 'subtotal') {
      setMoney(r.getCell(3), l.amount ?? 0);
      label.font = { bold: true };
      r.getCell(3).border = { top: { style: 'thin', color: { argb: ORANGE } } };
    }
    if (l.kind === 'total') {
      setMoney(r.getCell(3), l.amount ?? 0);
      totalStyle(r, 3);
    }
  }
  sheet.pageSetup.orientation = 'portrait';
  return { sheet, row };
}

function balanceSheet(wb: ExcelJS.Workbook, books: AccountingBooks, ctx: Ctx) {
  const { sheet, row: end } = statement(wb, 'Balance Sheet', books, ctx, books.balanceSheet.lines, 'As at', [90]);
  let row = end + 2;

  sheet.mergeCells(row, 1, row, 4);
  const t = sheet.getCell(row, 1);
  t.value = 'Validation checks';
  t.font = { bold: true, size: 12, color: { argb: INK } };
  row += 1;
  headerRow(sheet, row, ['Check', 'Result', 'Detail', ''], 99);
  sheet.mergeCells(row, 3, row, 4);
  for (const c of books.checks) {
    row += 1;
    const r = sheet.getRow(row);
    r.getCell(1).value = c.label;
    r.getCell(2).value = c.level.toUpperCase();
    r.getCell(2).font = { bold: true, color: { argb: CHECK_FONT[c.level] } };
    sheet.mergeCells(row, 3, row, 4);
    r.getCell(3).value = safeText(c.detail);
    r.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    r.height = Math.min(120, 15 * Math.ceil(c.detail.length / 100));
  }

  row += 2;
  sheet.mergeCells(row, 1, row, 4);
  const lt = sheet.getCell(row, 1);
  lt.value = 'Basis of preparation and limitations';
  lt.font = { bold: true, size: 12, color: { argb: INK } };
  for (const l of books.limitations) {
    row += 1;
    sheet.mergeCells(row, 1, row, 4);
    const cell = sheet.getCell(row, 1);
    cell.value = safeText(`•  ${l}`);
    cell.alignment = { wrapText: true, vertical: 'top' };
    cell.font = { size: 9 };
    sheet.getRow(row).height = Math.min(60, 14 * Math.ceil(l.length / 150));
  }
}
