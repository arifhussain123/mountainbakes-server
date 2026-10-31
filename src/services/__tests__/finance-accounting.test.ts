import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  BANK_CODE,
  buildAccountingBooks,
  CASH_CODE,
  EASYPAISA_CODE,
  RETAINED_CODE,
  type AccountingBooks,
  type BooksInput,
  type HeadRow,
  type SourceVoucher,
} from '../finance-accounting.service';
import { ACCOUNTING_SHEETS, accountingWorkbookFilename, exportAccountingWorkbook, safeText } from '../finance-accounting-export.service';
import type { FinanceReport, LoanEntry } from '../../shared';

/**
 * The accounting workbook's engine, on a book worked out by hand.
 *
 * Before the period (01 Oct): opening cash 100 000 and bank 50 000, a company
 * share of 20 000 in cash and electricity of 5 000 from the bank — so the
 * period opens with Cash 120 000, Bank 45 000, General Fund 150 000 and
 * retained earnings of 15 000.
 *
 * In the period (10–12 Oct): a 30 000 branch transfer paid 20 000 cash +
 * 6 000 Easypaisa + 4 000 bank, an Easypaisa collection of 2 000 booked to
 * Cash, 10 000 capital in the bank, salaries 8 000 cash, a partner withdrawal
 * 3 000 cash, a branch share payout 1 500 from the bank, and 700 of other
 * income reversed the next voucher. One voucher after the period end.
 */

const H = {
  open: { id: 'h-open', code: 'INC-OPENING', name: 'Opening Balance', type: 'income', groupName: 'Opening' },
  inv: { id: 'h-inv', code: 'INC-INVESTMENT', name: 'Investment', type: 'income', groupName: 'Capital' },
  cs: { id: 'h-cs', code: 'INC-COMPANY-SHARE', name: 'Company Share', type: 'income', groupName: 'Share Split' },
  ep: { id: 'h-ep', code: 'INC-EASYPAISA', name: 'Easypaisa Collection', type: 'income', groupName: 'Branch Collection' },
  other: { id: 'h-other', code: 'INC-OTHER', name: 'Other Income', type: 'income', groupName: 'Other' },
  sal: { id: 'h-sal', code: 'EXP-SALARIES', name: 'Salaries', type: 'expense', groupName: 'Payroll' },
  part: { id: 'h-part', code: 'EXP-PARTNER', name: 'Partner Withdrawals', type: 'expense', groupName: 'Partners' },
  payout: { id: 'h-payout', code: 'EXP-BRANCH-SHARE-PAYOUT', name: 'Branch Share Payout', type: 'expense', groupName: 'Partners' },
  elec: { id: 'h-elec', code: 'EXP-ELECTRICITY', name: 'Electricity', type: 'expense', groupName: 'Utilities' },
} satisfies Record<string, HeadRow>;
const HEADS: HeadRow[] = Object.values(H);

let seq = 0;
function v(
  voucherNo: string,
  entryDate: string,
  head: HeadRow,
  side: 'debit' | 'credit',
  amount: number,
  extra: Partial<SourceVoucher> = {},
): SourceVoucher {
  seq += 1;
  return {
    id: `id-${voucherNo}`,
    voucherNo,
    seq,
    entryDate,
    postedAt: `${entryDate}T06:00:00.000Z`,
    ledgerHeadId: head.id,
    ledgerHeadName: head.name,
    ledgerHeadType: head.type,
    branchId: null,
    branchName: null,
    description: `${head.name} ${voucherNo}`,
    debit: side === 'debit' ? amount : 0,
    credit: side === 'credit' ? amount : 0,
    account: 'cash',
    paymentMethod: 'cash',
    status: 'posted',
    sourceType: 'manual',
    sourceId: null,
    reversesEntryId: null,
    createdByName: 'Test Accountant',
    ...extra,
  };
}

function scenario(): BooksInput {
  seq = 0;
  return {
    from: '2026-10-10',
    to: '2026-10-12',
    branch: null,
    heads: HEADS,
    transfers: [{ id: 'T1', cash: 20000, easypaisa: 6000, bank: 4000 }],
    vouchers: [
      v('RV-1', '2026-10-01', H.open, 'debit', 100000, { sourceType: 'opening' }),
      v('RV-2', '2026-10-01', H.open, 'debit', 50000, { sourceType: 'opening', account: 'bank', paymentMethod: null }),
      v('RV-3', '2026-10-01', H.cs, 'debit', 20000, { sourceType: 'company_share', sourceId: 'A1' }),
      v('PV-1', '2026-10-01', H.elec, 'credit', 5000, { account: 'bank', paymentMethod: 'bank_transfer' }),
      v('RV-4', '2026-10-10', H.cs, 'debit', 30000, {
        sourceType: 'cash_transfer', sourceId: 'T1', paymentMethod: 'cash+easypaisa+bank_account', branchId: 'b1', branchName: 'Gulberg',
      }),
      v('RV-5', '2026-10-10', H.ep, 'debit', 2000, { paymentMethod: 'easypaisa' }),
      v('RV-6', '2026-10-11', H.inv, 'debit', 10000, { account: 'bank', paymentMethod: 'cheque' }),
      v('PV-2', '2026-10-11', H.sal, 'credit', 8000, { sourceType: 'salary', sourceId: 'S1' }),
      v('PV-3', '2026-10-11', H.part, 'credit', 3000, { sourceType: 'partner_expense', sourceId: 'P1' }),
      v('PV-4', '2026-10-11', H.payout, 'credit', 1500, { sourceType: 'branch_share_payout', sourceId: 'BP1', account: 'bank', paymentMethod: 'bank_transfer' }),
      v('RV-7', '2026-10-12', H.other, 'debit', 700, { status: 'reversed' }),
      v('PV-5', '2026-10-12', H.other, 'credit', 700, { sourceType: 'adjustment', sourceId: 'id-RV-7', reversesEntryId: 'id-RV-7' }),
      v('RV-8', '2026-10-13', H.cs, 'debit', 999),
    ],
  };
}

const rs = (n: number) => n * 100;
const balanceOf = (b: AccountingBooks, code: string) => b.balances.find((x) => x.account.code === code)!;
const check = (b: AccountingBooks, key: string) => b.checks.find((c) => c.key === key)!;

describe('journal', () => {
  const books = buildAccountingBooks(scenario());

  test('one balanced journal entry per in-period voucher; the voucher after the period is left out', () => {
    const inPeriod = books.journal.filter((j) => j.inPeriod);
    assert.deepEqual(inPeriod.map((j) => j.id), ['RV-4', 'RV-5', 'RV-6', 'PV-2', 'PV-3', 'PV-4', 'RV-7', 'PV-5']);
    assert.ok(!books.journal.some((j) => j.id === 'RV-8'));
    for (const j of books.journal) {
      const dr = j.lines.reduce((s, l) => s + l.debit, 0);
      const cr = j.lines.reduce((s, l) => s + l.credit, 0);
      assert.equal(dr, cr, j.id);
      assert.ok(j.balanced, j.id);
    }
  });

  test('a receipt debits the asset and credits the head; a payment the reverse', () => {
    const sal = books.journal.find((j) => j.id === 'PV-2')!;
    assert.deepEqual(
      sal.lines.map((l) => [l.accountCode, l.debit, l.credit]),
      [['EXP-SALARIES', rs(8000), 0], [CASH_CODE, 0, rs(8000)]],
    );
  });

  test('a mixed branch transfer is split into Cash, Easypaisa and Bank from its own channel amounts', () => {
    const t = books.journal.find((j) => j.id === 'RV-4')!;
    assert.deepEqual(
      t.lines.map((l) => [l.accountCode, l.debit, l.credit]),
      [[CASH_CODE, rs(20000), 0], [EASYPAISA_CODE, rs(6000), 0], [BANK_CODE, rs(4000), 0], ['INC-COMPANY-SHARE', 0, rs(30000)]],
    );
    assert.equal(check(books, 'transfer_split').level, 'pass');
  });

  test('an Easypaisa voucher booked to Cash is shown under Bank, and flagged', () => {
    const ep = books.journal.find((j) => j.id === 'RV-5')!;
    assert.equal(ep.lines[0]!.accountCode, EASYPAISA_CODE);
    const c = check(books, 'bank_channels');
    assert.equal(c.level, 'warn');
    assert.match(c.detail, /RV-5/);
  });

  test('a cheque keeps the account it was booked to', () => {
    assert.equal(books.journal.find((j) => j.id === 'RV-6')!.lines[0]!.accountCode, BANK_CODE);
  });

  test('a reversal mirrors the accounts of its original, and both stay', () => {
    const rev = books.journal.find((j) => j.id === 'PV-5')!;
    assert.deepEqual(rev.lines.map((l) => [l.accountCode, l.debit, l.credit]), [['INC-OTHER', rs(700), 0], [CASH_CODE, 0, rs(700)]]);
    assert.ok(books.journal.some((j) => j.id === 'RV-7'));
  });
});

describe('classification', () => {
  const books = buildAccountingBooks(scenario());

  test('opening balance, investment and partner withdrawals are General Fund; branch share payout is an expense', () => {
    assert.equal(books.accounts.get('INC-OPENING')!.classification, 'General Fund');
    assert.equal(books.accounts.get('INC-INVESTMENT')!.classification, 'General Fund');
    assert.equal(books.accounts.get('EXP-PARTNER')!.classification, 'General Fund');
    assert.equal(books.accounts.get('EXP-PARTNER')!.normal, 'debit');
    assert.equal(books.accounts.get('EXP-BRANCH-SHARE-PAYOUT')!.type, 'expense');
    assert.equal(books.accounts.get('INC-COMPANY-SHARE')!.type, 'revenue');
  });

  test('a voucher whose head is missing from the chart is classified by its type and flagged', () => {
    const input = scenario();
    input.vouchers.push(v('PV-9', '2026-10-12', { ...H.elec, id: 'h-gone', name: 'Old Head' }, 'credit', 100));
    const b = buildAccountingBooks(input);
    const j = b.journal.find((x) => x.id === 'PV-9')!;
    assert.equal(b.accounts.get(j.lines[0]!.accountCode)!.type, 'expense');
    assert.equal(check(b, 'classified').level, 'warn');
  });
});

describe('balances and statements', () => {
  const books = buildAccountingBooks(scenario());

  test('opening balances come from everything before the period; P&L opens at zero', () => {
    assert.equal(balanceOf(books, CASH_CODE).opening, rs(120000));
    assert.equal(balanceOf(books, BANK_CODE).opening, rs(45000));
    assert.equal(balanceOf(books, 'INC-OPENING').opening, -rs(150000));
    assert.equal(balanceOf(books, RETAINED_CODE).opening, -rs(15000));
    assert.equal(balanceOf(books, 'INC-COMPANY-SHARE').opening, 0);
    assert.equal(balanceOf(books, 'EXP-ELECTRICITY').opening, 0);
  });

  test('closing Cash, Bank and Easypaisa', () => {
    assert.equal(balanceOf(books, CASH_CODE).closing, rs(129000));
    assert.equal(balanceOf(books, BANK_CODE).closing, rs(57500));
    assert.equal(balanceOf(books, EASYPAISA_CODE).closing, rs(8000));
  });

  test('trial balance balances in every column pair', () => {
    const t = books.trialBalance.totals;
    assert.equal(t.openingDebit, t.openingCredit);
    assert.equal(t.periodDebit, t.periodCredit);
    assert.equal(t.closingDebit, t.closingCredit);
    assert.equal(t.periodDebit, rs(30000 + 2000 + 10000 + 8000 + 3000 + 1500 + 700 + 700));
    assert.equal(check(books, 'tb_balanced').level, 'pass');
    assert.equal(check(books, 'ledger_tb').level, 'pass');
  });

  test('income statement: sales 32 000, operating expenses 9 500, net profit 22 500; capital is not revenue', () => {
    const is = books.incomeStatement;
    assert.equal(is.netProfit, rs(22500));
    assert.equal(is.totalExpenses, rs(9500));
    const labels = is.lines.map((l) => l.label);
    assert.ok(!labels.includes('Investment'));
    assert.ok(!labels.includes('Partner Withdrawals'));
    assert.equal(is.lines.find((l) => l.label === 'Gross sales revenue')!.amount, rs(32000));
    assert.equal(check(books, 'is_reconciles').level, 'pass');
  });

  test('balance sheet: assets 194 500 = General Fund 157 000 + retained 15 000 + profit 22 500', () => {
    const bs = books.balanceSheet;
    assert.equal(bs.totalAssets, rs(194500));
    assert.equal(bs.totalEquity, rs(194500));
    assert.equal(bs.difference, 0);
    assert.equal(bs.lines.find((l) => l.label === 'Total General Fund')!.amount, rs(157000));
    assert.equal(bs.lines.find((l) => l.label.startsWith('Retained earnings'))!.amount, rs(15000));
    assert.equal(check(books, 'bs_balanced').level, 'pass');
  });

  test('a period starting on the first day has everything in-period and no retained earnings', () => {
    const b = buildAccountingBooks({ ...scenario(), from: '2026-10-01' });
    assert.equal(balanceOf(b, RETAINED_CODE).opening, 0);
    assert.equal(b.balanceSheet.difference, 0);
    assert.equal(b.incomeStatement.netProfit, rs(22500 + 15000));
  });

  test('overall status is a warning, not a pass, while something needs review', () => {
    assert.equal(books.status.level, 'warn');
  });

  test('gross profit is shown, and marked as before an undetermined cost of goods sold', () => {
    const gp = books.incomeStatement.lines.find((l) => l.label.startsWith('Gross profit'))!;
    assert.equal(gp.amount, rs(32000));
    assert.match(gp.label, /not determined/);
  });

  test('statement lines carry their account codes', () => {
    assert.equal(books.incomeStatement.lines.find((l) => l.label === 'Salaries')!.code, 'EXP-SALARIES');
    assert.equal(books.balanceSheet.lines.find((l) => l.label === 'Cash in Hand')!.code, CASH_CODE);
    assert.equal(books.balanceSheet.lines.find((l) => l.label === 'Investment')!.code, 'INC-INVESTMENT');
  });

  test('the statements say what they are: provisional and incomplete, never verified', () => {
    assert.match(books.statementStatus.incomeStatement, /^Provisional, cash basis/);
    assert.match(books.statementStatus.balanceSheet, /^Balanced, but INCOMPLETE/);
    assert.match(books.statementStatus.balanceSheet, /opening balance recorded/);
  });

  test('with a critical exception both statements read NOT VERIFIED', () => {
    const input = scenario();
    input.vouchers.push(v('PV-7', '2026-10-12', H.elec, 'credit', 0));
    const b = buildAccountingBooks(input);
    assert.match(b.statementStatus.incomeStatement, /^NOT VERIFIED/);
    assert.match(b.statementStatus.balanceSheet, /^NOT VERIFIED/);
  });

  test('date boundaries: the day before the period is opening, the end date is in, the day after is out', () => {
    const input = scenario();
    input.vouchers.push(
      v('RV-B1', '2026-10-09', H.cs, 'debit', 100),
      v('RV-B2', '2026-10-12', H.cs, 'debit', 200),
      v('RV-B3', '2026-10-13', H.cs, 'debit', 400),
    );
    const b = buildAccountingBooks(input);
    const byId = (id: string) => b.journal.find((j) => j.id === id);
    assert.equal(byId('RV-B1')!.inPeriod, false);
    assert.equal(byId('RV-B2')!.inPeriod, true);
    assert.equal(byId('RV-B3'), undefined);
    assert.equal(balanceOf(b, RETAINED_CODE).opening, -rs(15000 + 100));
    assert.equal(balanceOf(b, CASH_CODE).closing, rs(129000 + 100 + 200));
  });
});

describe('exceptions are reported, never hidden', () => {
  test('an empty book still produces balanced, zero statements and says no opening balance exists', () => {
    const b = buildAccountingBooks({ vouchers: [], heads: HEADS, transfers: [], from: '2026-10-10', to: '2026-10-10', branch: null });
    assert.equal(b.journal.length, 0);
    assert.equal(b.balanceSheet.difference, 0);
    assert.equal(b.trialBalance.totals.closingDebit, 0);
    assert.equal(check(b, 'opening').level, 'warn');
    assert.deepEqual(b.trialBalance.rows.map((r) => r.account.code), [CASH_CODE, BANK_CODE, EASYPAISA_CODE]);
  });

  test('a voucher number appearing twice is posted once and the duplicate is a failure', () => {
    const input = scenario();
    input.vouchers.push({ ...input.vouchers.find((x) => x.voucherNo === 'PV-2')!, id: 'id-copy', seq: 99 });
    const b = buildAccountingBooks(input);
    assert.equal(b.journal.filter((j) => j.id === 'PV-2').length, 1);
    assert.equal(check(b, 'unique_vouchers').level, 'fail');
    assert.equal(b.status.level, 'fail');
    assert.equal(b.balanceSheet.difference, 0);
  });

  test('one source posting the same head twice is flagged but both are counted', () => {
    const input = scenario();
    input.vouchers.push(v('PV-6', '2026-10-12', H.sal, 'credit', 8000, { sourceType: 'salary', sourceId: 'S1' }));
    const b = buildAccountingBooks(input);
    assert.equal(check(b, 'source_once').level, 'warn');
    assert.equal(balanceOf(b, 'EXP-SALARIES').periodDebit, rs(16000));
  });

  test('a manual voucher re-keying a branch collection is flagged and kept', () => {
    const input = scenario();
    input.vouchers.push(v('RV-9', '2026-10-10', H.cs, 'debit', 30000));
    const b = buildAccountingBooks(input);
    assert.equal(check(b, 'manual_rekey').level, 'warn');
    assert.ok(b.journal.some((j) => j.id === 'RV-9'));
  });

  test('a zero-amount voucher is shown as invalid, not dropped, and fails validation', () => {
    const input = scenario();
    input.vouchers.push(v('PV-7', '2026-10-12', H.elec, 'credit', 0));
    const b = buildAccountingBooks(input);
    const j = b.journal.find((x) => x.id === 'PV-7')!;
    assert.equal(j.lines.length, 0);
    assert.equal(j.balanced, false);
    assert.equal(check(b, 'journal_balanced').level, 'fail');
  });

  test('a transfer whose channels no longer add up stays on its booked account and is flagged', () => {
    const input = scenario();
    input.transfers = [{ id: 'T1', cash: 20000, easypaisa: 6000, bank: 1 }];
    const b = buildAccountingBooks(input);
    const t = b.journal.find((j) => j.id === 'RV-4')!;
    assert.deepEqual(t.lines.map((l) => l.accountCode), [CASH_CODE, 'INC-COMPANY-SHARE']);
    assert.equal(check(b, 'transfer_split').level, 'warn');
  });

  test('a migration-121 transfer — cash on its own voucher, Easypaisa + bank on another — splits without a warning', () => {
    const input = scenario();
    input.transfers.push({ id: 'T2', cash: 5000, easypaisa: 1500, bank: 2500 });
    input.vouchers.push(
      v('RV-21', '2026-10-11', H.cs, 'debit', 5000, { sourceType: 'cash_transfer', sourceId: 'T2', paymentMethod: 'cash' }),
      v('RV-22', '2026-10-11', H.cs, 'debit', 4000, {
        sourceType: 'cash_transfer', sourceId: 'T2', account: 'bank', paymentMethod: 'easypaisa+bank_account',
      }),
    );
    const b = buildAccountingBooks(input);
    assert.equal(check(b, 'transfer_split').level, 'pass');
    assert.deepEqual(
      b.journal.find((j) => j.id === 'RV-22')!.lines.map((l) => [l.accountCode, l.debit]),
      [[EASYPAISA_CODE, rs(1500)], [BANK_CODE, rs(2500)], ['INC-COMPANY-SHARE', 0]],
    );
    assert.deepEqual(b.journal.find((j) => j.id === 'RV-21')!.lines[0]!.accountCode, CASH_CODE);
  });

  test('a negative cash balance is flagged', () => {
    const input = scenario();
    input.vouchers.push(v('PV-8', '2026-10-12', H.elec, 'credit', 500000));
    assert.equal(check(buildAccountingBooks(input), 'negative_cash').level, 'warn');
  });

  test('a branch filter is stated as a partial view', () => {
    const b = buildAccountingBooks({ ...scenario(), branch: { id: 'b1', name: 'Gulberg' } });
    assert.equal(check(b, 'branch_scope').level, 'warn');
  });

  test('building twice gives the same books — an export changes nothing', () => {
    const a = buildAccountingBooks(scenario());
    const b = buildAccountingBooks(scenario());
    assert.deepEqual(a.journal.map((j) => [j.id, j.lines]), b.journal.map((j) => [j.id, j.lines]));
    assert.deepEqual(a.trialBalance, b.trialBalance);
  });
});

describe('workbook', () => {
  async function workbook(input: BooksInput, cashBook?: FinanceReport) {
    const books = buildAccountingBooks(input);
    const buffer = await exportAccountingWorkbook(books, {
      generatedBy: 'accountant@mb.test', generatedAt: new Date('2026-10-12T10:00:00Z'), cashBook,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return { books, wb };
  }
  const findRow = (sheet: ExcelJS.Worksheet, col: number, pred: (v: unknown) => boolean): ExcelJS.Row | undefined => {
    let found: ExcelJS.Row | undefined;
    sheet.eachRow((row) => {
      if (!found && pred(row.getCell(col).value)) found = row;
    });
    return found;
  };
  const resultOf = (v: ExcelJS.CellValue) => (v && typeof v === 'object' && 'result' in v ? v.result : v);

  test('six accounting sheets, in order', async () => {
    const { wb } = await workbook(scenario());
    assert.deepEqual(wb.worksheets.map((s) => s.name), [...ACCOUNTING_SHEETS]);
    assert.deepEqual([...ACCOUNTING_SHEETS], ['General Entries', 'Ledger', 'Trial Balance', 'Income Statement', 'Balance Sheet', 'Loan Ledger']);
  });

  test('the existing cash book sheet stays first, unchanged, ahead of the six', async () => {
    const cashBook: FinanceReport = {
      type: 'daily_cash_book', title: 'Daily Cash Book', subtitle: 'Cash book for 2026-10-10 to 2026-10-12',
      periodFrom: '2026-10-10', periodTo: '2026-10-12', generatedAt: '2026-10-12T10:00:00Z', generatedBy: 'accountant@mb.test',
      columns: [
        { key: 'voucherNo', label: 'Voucher No', width: 14 },
        { key: 'debit', label: 'Debit', format: 'money', align: 'right', width: 14 },
      ],
      rows: [{ voucherNo: 'RV-4', debit: 30000 }],
      totals: { debit: 30000 },
      summary: [],
    };
    const { wb } = await workbook(scenario(), cashBook);
    assert.deepEqual(wb.worksheets.map((s) => s.name), ['Daily Cash Book', ...ACCOUNTING_SHEETS]);
    const cb = wb.getWorksheet('Daily Cash Book')!;
    assert.ok(findRow(cb, 1, (v) => v === 'RV-4'));
  });

  test('General Entries: numeric debit/credit cells and a SUM total that equals the journal', async () => {
    const { wb } = await workbook(scenario());
    const ge = wb.getWorksheet('General Entries')!;
    const total = findRow(ge, 1, (v) => typeof v === 'string' && v.startsWith('TOTAL'))!;
    const dr = total.getCell(6).value as ExcelJS.CellFormulaValue;
    assert.match(dr.formula, /^SUM\(F7:F\d+\)$/);
    assert.equal(dr.result, 55900);
    assert.equal(resultOf(total.getCell(7).value), 55900);
    const sal = findRow(ge, 1, (v) => v === 'PV-2')!;
    assert.equal(sal.getCell(4).value, 'Salaries');
    assert.equal(typeof sal.getCell(6).value, 'number');
  });

  test('only the kept columns are on each sheet', async () => {
    const { wb } = await workbook(scenario());
    const head = (name: string) => (wb.getWorksheet(name)!.getRow(6).values as unknown[]).filter((v) => v !== undefined && v !== '');
    assert.deepEqual(head('General Entries'), ['Entry ID', 'Business Date', 'Branch', 'Account Name', 'Narration', 'Debit (DR)', 'Credit (CR)']);
    assert.deepEqual(head('Ledger'), [
      'Account Name', 'Classification', 'Date', 'Transaction Reference', 'Description', 'Contra Account', 'Branch', 'Debit', 'Credit', 'Running Balance',
    ]);
    assert.deepEqual(head('Trial Balance'), [
      'Account Name', 'Classification', 'Normal Balance', 'Opening Debit', 'Opening Credit', 'Period Debit', 'Period Credit', 'Closing Debit', 'Closing Credit',
    ]);
    assert.deepEqual(head('Income Statement'), ['For the period 2026-10-10 to 2026-10-12', 'Amount (Rs)', 'Total (Rs)']);
    assert.deepEqual(head('Balance Sheet'), ['As at 2026-10-12', 'Amount (Rs)', 'Total (Rs)']);
    // And no account code is printed anywhere on the five sheets.
    for (const name of ACCOUNTING_SHEETS) {
      wb.getWorksheet(name)!.eachRow((row) => {
        row.eachCell((cell) => assert.ok(!/^(AST|EQ|INC|EXP)-/.test(String(cell.value ?? '')), `${name}: ${String(cell.value)}`));
      });
    }
  });

  test('an unbalanced entry is marked in its narration', async () => {
    const input = scenario();
    const books = buildAccountingBooks(input);
    const je = books.journal.find((j) => j.id === 'PV-2')!;
    je.lines[0]!.debit += 1;
    je.balanced = false;
    const buffer = await exportAccountingWorkbook(books, { generatedBy: 'x' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const row = findRow(wb.getWorksheet('General Entries')!, 1, (v) => v === 'PV-2')!;
    assert.match(String(row.getCell(5).value), /^UNBALANCED — /);
  });

  test('Ledger: grouped by account, running in each account\'s normal direction, closing on the trial balance', async () => {
    const { wb } = await workbook(scenario());
    const lg = wb.getWorksheet('Ledger')!;
    const closing = (name: string) => {
      let out: unknown;
      lg.eachRow((row) => {
        if (row.getCell(1).value === name && String(row.getCell(5).value).startsWith('Closing balance')) out = row.getCell(10).value;
      });
      return out;
    };
    assert.equal(closing('Cash in Hand'), 129000);
    assert.equal(closing('Bank — Bank Account'), 57500);
    assert.equal(closing('Bank — Easypaisa'), 8000);
    assert.equal(closing('Opening Balance'), 150000); // credit-normal: a positive General Fund
    assert.equal(closing('Partner Withdrawals'), 3000); // withdrawals, debit-normal
    assert.equal(closing('Salaries'), 8000);
    // Cash's own lines, in date order: the transfer's cash part first.
    const cashRefs: unknown[] = [];
    lg.eachRow((row, n) => {
      if (n > 6 && row.getCell(1).value === 'Cash in Hand' && row.getCell(4).value) cashRefs.push(row.getCell(4).value);
    });
    assert.deepEqual(cashRefs, ['RV-4', 'PV-2', 'PV-3', 'RV-7', 'PV-5']);
  });

  test('Trial Balance totals agree', async () => {
    const { wb } = await workbook(scenario());
    const tb = wb.getWorksheet('Trial Balance')!;
    const total = findRow(tb, 1, (v) => v === 'TOTAL')!;
    assert.equal(resultOf(total.getCell(8).value), resultOf(total.getCell(9).value));
  });

  test('Balance Sheet carries the validation checks', async () => {
    const { wb } = await workbook(scenario());
    const bs = wb.getWorksheet('Balance Sheet')!;
    assert.ok(findRow(bs, 1, (v) => v === 'Validation checks'));
    assert.ok(findRow(bs, 1, (v) => v === 'Assets = Liabilities + Equity'));
    assert.equal(findRow(bs, 1, (v) => v === 'Balance check (assets − liabilities − equity)')!.getCell(3).value, 0);
    assert.equal(findRow(bs, 1, (v) => v === 'Total assets')!.getCell(3).value, 194500);
    assert.equal(findRow(bs, 1, (v) => v === 'Bank — Easypaisa (included in Bank)')!.getCell(2).value, 8000);
    assert.match(String(bs.getCell(5, 1).value), /^Statement status: Balanced, but INCOMPLETE/);
  });

  test('an empty period still opens with all six sheets', async () => {
    const { wb } = await workbook({ vouchers: [], heads: HEADS, transfers: [], from: '2026-10-10', to: '2026-10-10', branch: null });
    assert.equal(wb.worksheets.length, 6);
  });

  test('loans: a memorandum under Liabilities and the Loan Ledger sheet, outside every total', async () => {
    // The loan spec's §18 client: loans 100 000 + 50 000 + 25 000, paid 30 000 + 20 000.
    const entry = (n: number, entryType: LoanEntry['entryType'], debit: number, credit: number, balance: number): LoanEntry => ({
      id: `l${n}`, voucherNo: `LN-00000${n}`, seq: n, clientId: 'c1', clientCode: 'LC-000001', clientName: 'Ali Traders',
      companyName: null, entryType, ledgerHeadId: 'h', ledgerHeadName: 'Loans', branchId: null, branchName: null,
      businessDate: `2026-10-1${n - 1}`, amount: debit || credit, debit, credit, balance, paymentMethod: credit ? 'cash' : null,
      description: `entry ${n}`, note: null, status: 'posted', cancelReason: null, cancelledByName: null, cancelledAt: null,
      createdByName: 'x', createdAt: '2026-10-10T00:00:00Z',
    });
    const entries = [
      entry(1, 'refundable_loan', 100000, 0, 100000),
      entry(2, 'receivable_loan', 50000, 0, 150000),
      entry(3, 'paid_payment', 0, 30000, 120000),
    ];
    const input = scenario();
    const plain = buildAccountingBooks(input);
    input.loans = {
      clients: [{
        clientId: 'c1', clientCode: 'LC-000001', clientName: 'Ali Traders', companyName: null, isActive: true,
        totalRefundable: 125000, totalReceivable: 50000, totalDebit: 175000, totalCredit: 50000, balance: 125000, entryCount: 5,
      }],
      ledger: {
        from: '2026-10-10', to: '2026-10-12', openingBalance: 0, totalDebit: 150000, totalCredit: 30000, closingBalance: 125000,
        total: 3, limit: 3, offset: 0, entries,
      },
    };
    const books = buildAccountingBooks(input);

    // Nothing in the books moves.
    assert.equal(books.balanceSheet.totalLiabilities, plain.balanceSheet.totalLiabilities);
    assert.equal(books.balanceSheet.difference, plain.balanceSheet.difference);
    assert.equal(books.incomeStatement.netProfit, plain.incomeStatement.netProfit);
    assert.equal(books.loans!.totalOutstanding, 12_500_000);

    const { wb } = await workbook(input);
    const bs = wb.getWorksheet('Balance Sheet')!;
    assert.ok(findRow(bs, 1, (v) => String(v).startsWith('Refundable & Receivable Loans — separate loan register')));
    assert.equal(findRow(bs, 1, (v) => v === 'LC-000001 — Ali Traders')!.getCell(2).value, 125000);
    assert.equal(findRow(bs, 1, (v) => String(v).startsWith('Total loans outstanding'))!.getCell(3).value, 125000);
    assert.equal(findRow(bs, 1, (v) => v === 'Balance check (assets − liabilities − equity)')!.getCell(3).value, 0);
    assert.ok(!findRow(bs, 1, (v) => String(v).startsWith('Loans and other liabilities')));

    const ll = wb.getWorksheet('Loan Ledger')!;
    assert.equal(findRow(ll, 2, (v) => v === 'LN-000003')!.getCell(10).value, 120000);
    assert.equal(findRow(ll, 1, (v) => String(v).startsWith('Closing balance'))!.getCell(10).value, 125000);
    const clientTotal = findRow(ll, 1, (v) => String(v).startsWith('Total outstanding'))!;
    assert.equal((clientTotal.getCell(6).value as { result: number }).result, 175000);
    assert.equal((clientTotal.getCell(7).value as { result: number }).result, 50000);
    assert.equal((clientTotal.getCell(8).value as { result: number }).result, 125000);
  });

  test('text a spreadsheet would run as a formula is written as text', async () => {
    const input = scenario();
    input.vouchers.find((x) => x.voucherNo === 'PV-2')!.description = '=HYPERLINK("http://evil.test","x")';
    input.vouchers.find((x) => x.voucherNo === 'PV-3')!.branchName = '+cmd|calc';
    const { wb } = await workbook(input);
    const ge = wb.getWorksheet('General Entries')!;
    const row = findRow(ge, 1, (v) => v === 'PV-2')!;
    assert.equal(row.getCell(5).value, `'=HYPERLINK("http://evil.test","x")`);
    assert.equal(row.getCell(5).formula, undefined);
    assert.equal(findRow(ge, 1, (v) => v === 'PV-3')!.getCell(3).value, "'+cmd|calc");
    assert.equal(safeText('-5'), "'-5");
    assert.equal(safeText('Flour'), 'Flour');
  });

  test('file name follows the period and branch', () => {
    const b = buildAccountingBooks(scenario());
    assert.equal(accountingWorkbookFilename(b), 'Mountain_Bakes_Daily_Ledger_2026-10-10_to_2026-10-12.xlsx');
    const one = buildAccountingBooks({ ...scenario(), from: '2026-10-12', branch: { id: 'b1', name: 'DHA Phase 5' } });
    assert.equal(accountingWorkbookFilename(one), 'Mountain_Bakes_Daily_Ledger_2026-10-12_DHA_Phase_5.xlsx');
  });
});

/**
 * The Demand Record carried into the books, on a book worked out by hand.
 * Demand Record start 01 Oct; the workbook covers 10–12 Oct.
 *
 *   Alpha  opening +1,000 (01 Oct); DA1 05 Oct share 5,000 (before the period);
 *          DA2 11 Oct share 6,000; adjustment −500 (12 Oct); deposits TA1 4,000
 *          (11 Oct) and TA2 3,000 (12 Oct); DA3 13 Oct (after the period)
 *          → 1,000 + 5,000 + 6,000 − 500 − 7,000 = 4,500 owed
 *   Beta   opening +200 then reversed; DB1 10 Oct 5,000; deposit TB1 5,000 → 0
 *   Gamma  DC1 10 Oct 4,000; deposit TC1 9,000 → −5,000, a credit
 *   Delta  DD1 12 Oct 2,500; nothing paid → 2,500 owed
 *
 *   Outside the record: TX 2,000 (before Alpha's first demand) and a 300 fuel
 *   charge stay income; cash opening 100,000; salaries 1,000.
 */
describe('Demand Record outstanding balances', () => {
  const HD = {
    open: H.open, cs: H.cs, sal: H.sal,
    fuel: { id: 'h-fuel', code: 'INC-FUEL', name: 'Fuel', type: 'income', groupName: 'Other' } as HeadRow,
  };
  const A = { id: 'ba', name: 'Alpha' };
  const B = { id: 'bb', name: 'Beta' };
  const C = { id: 'bc', name: 'Gamma' };
  const D = { id: 'bd', name: 'Delta' };
  const tv = (no: string, date: string, transferId: string, br: { id: string; name: string }, amount: number, head: HeadRow = HD.cs) =>
    v(no, date, head, 'debit', amount, { sourceType: 'cash_transfer', sourceId: transferId, branchId: br.id, branchName: br.name });
  const demand = (n: string, br: { id: string; name: string }, date: string, share: number) =>
    ({ orderId: `o-${n}`, demandNumber: n, branchId: br.id, branchName: br.name, businessDate: date, gTotal: share * 1.25, sharePct: 80, companyShare: share });

  function drScenario(): BooksInput {
    seq = 0;
    return {
      from: '2026-10-10', to: '2026-10-12', branch: null,
      heads: [...HEADS, HD.fuel], transfers: [],
      vouchers: [
        v('RV-O', '2026-10-01', HD.open, 'debit', 100000, { sourceType: 'opening' }),
        tv('RV-A1', '2026-10-11', 'TA1', A, 4000),
        tv('RV-F', '2026-10-11', 'TA1', A, 300, HD.fuel),
        tv('RV-A2', '2026-10-12', 'TA2', A, 3000),
        tv('RV-B1', '2026-10-11', 'TB1', B, 5000),
        tv('RV-C1', '2026-10-11', 'TC1', C, 9000),
        tv('RV-X', '2026-10-11', 'TX', A, 2000),
        v('PV-S', '2026-10-12', HD.sal, 'credit', 1000, { sourceType: 'salary', sourceId: 'S9' }),
      ],
      demandRecord: {
        start: '2026-10-01',
        demands: [
          demand('DA1', A, '2026-10-05', 5000), demand('DA2', A, '2026-10-11', 6000), demand('DA3', A, '2026-10-13', 999),
          demand('DB1', B, '2026-10-10', 5000), demand('DC1', C, '2026-10-10', 4000), demand('DD1', D, '2026-10-12', 2500),
        ],
        adjustments: [
          { id: 'adj-a-open', branchId: A.id, branchName: A.name, kind: 'opening', amount: 1000, businessDate: '2026-10-01', reason: 'Dues at start', reversalOf: null },
          { id: 'adj-a-adj', branchId: A.id, branchName: A.name, kind: 'adjustment', amount: -500, businessDate: '2026-10-12', reason: 'Spoilt stock', reversalOf: null },
          { id: 'adj-b-open', branchId: B.id, branchName: B.name, kind: 'opening', amount: 200, businessDate: '2026-10-01', reason: 'Entered by mistake', reversalOf: null },
          { id: 'adj-b-rev', branchId: B.id, branchName: B.name, kind: 'reversal', amount: -200, businessDate: '2026-10-02', reason: 'Undo', reversalOf: 'adj-b-open' },
        ],
        receivedTransfers: [
          { id: 'TA1', transferNo: 'CT-1', branchId: A.id, branchName: A.name, amount: 4000, businessDate: '2026-10-11' },
          { id: 'TA2', transferNo: 'CT-2', branchId: A.id, branchName: A.name, amount: 3000, businessDate: '2026-10-12' },
          { id: 'TB1', transferNo: 'CT-3', branchId: B.id, branchName: B.name, amount: 5000, businessDate: '2026-10-11' },
          { id: 'TC1', transferNo: 'CT-4', branchId: C.id, branchName: C.name, amount: 9000, businessDate: '2026-10-11' },
        ],
        pageBalances: [
          { branchId: A.id, branchName: A.name, closingBalance: 4500 },
          { branchId: B.id, branchName: B.name, closingBalance: 0 },
          { branchId: C.id, branchName: C.name, closingBalance: -5000 },
          { branchId: D.id, branchName: D.name, closingBalance: 2500 },
        ],
      },
    };
  }
  const ar = (b: AccountingBooks, br: { id: string }) => b.balances.find((x) => x.account.code === `AR-BRANCH-${br.id}`);
  const books = buildAccountingBooks(drScenario());

  test('1. an unpaid demand stays outstanding in full', () => {
    assert.equal(ar(books, D)!.closing, rs(2500));
  });

  test('2. a fully paid demand leaves the branch settled at zero, and is still listed', () => {
    assert.equal(ar(books, B)!.closing, 0);
    assert.deepEqual(books.branchBalances!.find((x) => x.branchId === B.id), { branchId: B.id, branchName: 'Beta', balance: 0, page: 0 });
  });

  test('3. several partial payments each reduce what is owed', () => {
    const a = ar(books, A)!;
    assert.equal(a.opening, rs(1000 + 5000));
    assert.equal(a.periodDebit, rs(6000));
    assert.equal(a.periodCredit, rs(500 + 4000 + 3000));
    assert.equal(a.closing, rs(4500));
  });

  test('4. branches with different balances: owed ones are assets, a credit is a liability', () => {
    const bs = books.balanceSheet;
    const line = (label: string) => bs.lines.find((l) => l.label === label);
    assert.equal(line('Alpha')!.amount, rs(4500));
    assert.equal(line('Delta')!.amount, rs(2500));
    assert.equal(line('Total branch receivables')!.amount, rs(7000));
    // Owed branches are flagged; a credit (Gamma) and the subtotal are not.
    assert.equal(line('Alpha')!.alert, true);
    assert.equal(line('Delta')!.alert, true);
    assert.equal(line('Gamma')!.alert, undefined);
    assert.equal(line('Total branch receivables')!.alert, undefined);
    assert.equal(line('Gamma')!.amount, rs(5000));
    assert.equal(line('Total branch credit balances')!.amount, rs(5000));
    assert.equal(bs.totalLiabilities, rs(5000));
    assert.equal(bs.totalAssets, rs(122300 + 7000));
  });

  test('a deposit settles the receivable instead of being income again; its fuel charge stays income', () => {
    const j = books.journal.find((x) => x.id === 'RV-A1')!;
    assert.deepEqual(j.lines.map((l) => [l.accountCode, l.debit, l.credit]), [[CASH_CODE, rs(4000), 0], [`AR-BRANCH-${A.id}`, 0, rs(4000)]]);
    assert.equal(books.journal.find((x) => x.id === 'RV-F')!.lines[1]!.accountCode, 'INC-FUEL');
    // Company Share income on the cash vouchers is only the deposit outside the record.
    assert.equal(balanceOf(books, 'INC-COMPANY-SHARE').periodCredit, rs(2000));
    assert.equal(balanceOf(books, 'INC-DEMAND-SHARE').periodCredit, rs(6000 + 5000 + 4000 + 2500));
  });

  test('each demand is one balanced entry keyed by its demand number; one after the period is left out', () => {
    const da2 = books.journal.find((x) => x.id === 'DA2')!;
    assert.deepEqual(da2.lines.map((l) => [l.accountCode, l.debit, l.credit]), [[`AR-BRANCH-${A.id}`, rs(6000), 0], ['INC-DEMAND-SHARE', 0, rs(6000)]]);
    assert.equal(books.journal.filter((x) => x.id === 'DA2').length, 1);
    assert.equal(books.journal.find((x) => x.id === 'DA3'), undefined);
  });

  test('5. a deposit tagged to the wrong branch still settles the branch its transfer belongs to', () => {
    const input = drScenario();
    const wrong = input.vouchers.find((x) => x.voucherNo === 'RV-A2')!;
    wrong.branchId = B.id;
    wrong.branchName = B.name;
    const b = buildAccountingBooks(input);
    assert.equal(ar(b, A)!.closing, rs(4500));
    assert.equal(ar(b, B)!.closing, 0);
  });

  test('6. a reversed opening balance nets to nothing; a deposit the record does not count stays income', () => {
    assert.equal(balanceOf(books, 'EQ-BRANCH-OPENING').closing, -rs(1000)); // Alpha's 1,000 only
    const x = books.journal.find((j) => j.id === 'RV-X')!;
    assert.equal(x.lines[1]!.accountCode, 'INC-COMPANY-SHARE');
  });

  test('8. the period: earlier demands are the opening balance and retained earnings, later ones are out', () => {
    assert.equal(balanceOf(books, RETAINED_CODE).opening, -rs(5000)); // DA1's share, earned before 10 Oct
    assert.ok(!books.journal.some((j) => j.id === 'DA1' && j.inPeriod));
    const b = buildAccountingBooks({ ...drScenario(), to: '2026-10-11' });
    assert.equal(ar(b, A)!.closing, rs(1000 + 5000 + 6000 - 4000));
    assert.equal(ar(b, D), undefined);
  });

  test('9. the balances reconcile with the Demand Record page, and a difference is reported', () => {
    assert.equal(check(books, 'demand_page').level, 'pass', check(books, 'demand_page').detail);
    assert.equal(check(books, 'demand_receipts').level, 'pass', check(books, 'demand_receipts').detail);
    const input = drScenario();
    input.demandRecord!.pageBalances[0]!.closingBalance = 1500; // the page put a later deposit in Alpha's last row
    const b = buildAccountingBooks(input);
    assert.equal(check(b, 'demand_page').level, 'warn');
    assert.match(check(b, 'demand_page').detail, /Alpha \(books Rs 4,500\.00, page Rs 1,500\.00\)/);
  });

  test('10. debits equal credits everywhere and the balance sheet balances', () => {
    const t = books.trialBalance.totals;
    assert.equal(t.periodDebit, t.periodCredit);
    assert.equal(t.closingDebit, t.closingCredit);
    assert.equal(t.openingDebit, t.openingCredit);
    assert.equal(books.balanceSheet.difference, 0);
    assert.equal(books.incomeStatement.netProfit, rs(6000 + 5000 + 4000 + 2500 - 500 + 2000 + 300 - 1000));
    assert.equal(check(books, 'journal_balanced').level, 'pass');
    assert.equal(check(books, 'ledger_tb').level, 'pass');
  });

  test('a deposit whose voucher differs from the transfer is reported', () => {
    const input = drScenario();
    input.vouchers.find((x) => x.voucherNo === 'RV-A2')!.debit = 2500;
    const b = buildAccountingBooks(input);
    assert.equal(check(b, 'demand_receipts').level, 'warn');
    assert.match(check(b, 'demand_receipts').detail, /CT-2/);
    assert.equal(b.balanceSheet.difference, 0);
  });

  test('a sales-income share posting for a branch on the Demand Record is flagged as possibly counted twice', () => {
    const input = drScenario();
    input.vouchers.push(v('RV-I', '2026-10-11', HD.cs, 'debit', 700, { sourceType: 'company_share', sourceId: 'AP1', branchId: A.id, branchName: A.name }));
    assert.equal(check(buildAccountingBooks(input), 'share_twice').level, 'warn');
    assert.equal(check(books, 'share_twice').level, 'pass');
  });

  test('7. building twice gives the same books', () => {
    const a = buildAccountingBooks(drScenario());
    const b = buildAccountingBooks(drScenario());
    assert.deepEqual(a.journal.map((j) => [j.id, j.lines]), b.journal.map((j) => [j.id, j.lines]));
    assert.deepEqual(a.branchBalances, b.branchBalances);
  });

  test('with the Demand Record off, receivables are absent and say so', () => {
    const b = buildAccountingBooks({ ...drScenario(), demandRecord: null });
    assert.equal(b.branchBalances, null);
    assert.equal(check(b, 'demand_record').level, 'info');
    assert.ok(b.balanceSheet.lines.some((l) => l.label.startsWith('Accounts receivable — the Demand Record is not switched on')));
  });

  test('the Balance Sheet sheet lists each branch beside the page, with the overall total', async () => {
    const buffer = await exportAccountingWorkbook(books, { generatedBy: 'x' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const bs = wb.getWorksheet('Balance Sheet')!;
    const rows: unknown[][] = [];
    bs.eachRow((row) => rows.push([row.getCell(1).value, row.getCell(2).value, row.getCell(3).value, row.getCell(4).value]));
    const start = rows.findIndex((r) => String(r[0]).startsWith('Branch outstanding balances'));
    assert.ok(start > 0);
    assert.deepEqual(rows[start + 1], ['Branch', 'Balance sheet', 'Demand Record page', null]);
    assert.deepEqual(rows.slice(start + 2, start + 6), [
      ['Alpha', 4500, 4500, null], ['Beta', 0, 0, null], ['Delta', 2500, 2500, null], ['Gamma', -5000, -5000, null],
    ]);
    // On the statement, each owed branch's name and amount are red and bold.
    let alpha: ExcelJS.Row | undefined;
    bs.eachRow((row, n) => {
      if (!alpha && n < start && row.getCell(1).value === 'Alpha') alpha = row;
    });
    for (const c of [1, 2]) {
      assert.equal(alpha!.getCell(c).font?.bold, true);
      assert.equal(alpha!.getCell(c).font?.color?.argb, 'FFB71C1C');
    }
    const total = rows[start + 6]!;
    assert.equal(total[0], 'Overall outstanding (net of branch credits)');
    assert.equal((total[1] as ExcelJS.CellFormulaValue).result, 2000);
  });
});
