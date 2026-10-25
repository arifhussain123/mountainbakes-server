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
  async function workbook(input: BooksInput) {
    const books = buildAccountingBooks(input);
    const buffer = await exportAccountingWorkbook(books, { generatedBy: 'accountant@mb.test', generatedAt: new Date('2026-10-12T10:00:00Z') });
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

  test('five sheets, in order', async () => {
    const { wb } = await workbook(scenario());
    assert.deepEqual(wb.worksheets.map((s) => s.name), [...ACCOUNTING_SHEETS]);
    assert.deepEqual([...ACCOUNTING_SHEETS], ['General Entries', 'Ledger', 'Trial Balance', 'Income Statement', 'Balance Sheet']);
  });

  test('General Entries: numeric debit/credit cells and a SUM total that equals the journal', async () => {
    const { wb } = await workbook(scenario());
    const ge = wb.getWorksheet('General Entries')!;
    const total = findRow(ge, 1, (v) => typeof v === 'string' && v.startsWith('TOTAL'))!;
    const dr = total.getCell(13).value as ExcelJS.CellFormulaValue;
    assert.match(dr.formula, /^SUM\(M7:M\d+\)$/);
    assert.equal(dr.result, 55900);
    assert.equal(resultOf(total.getCell(14).value), 55900);
    const sal = findRow(ge, 1, (v) => v === 'PV-2')!;
    assert.equal(typeof sal.getCell(13).value, 'number');
  });

  test('Ledger: Cash, Bank and General Fund columns and the closing balance', async () => {
    const { wb } = await workbook(scenario());
    const lg = wb.getWorksheet('Ledger')!;
    const header = lg.getRow(6).values as unknown[];
    for (const h of ['Cash', 'Bank', 'General Fund', 'DR', 'CR', 'Balance']) assert.ok(header.includes(h), h);
    const close = findRow(lg, 4, (v) => v === 'Closing balance carried forward')!;
    assert.equal(close.getCell(8).value, 129000);
    assert.equal(close.getCell(9).value, 57500 + 8000);
    assert.equal(close.getCell(10).value, 157000);
    assert.equal(close.getCell(13).value, 194500);
  });

  test('Trial Balance totals agree', async () => {
    const { wb } = await workbook(scenario());
    const tb = wb.getWorksheet('Trial Balance')!;
    const total = findRow(tb, 1, (v) => v === 'TOTAL')!;
    assert.equal(resultOf(total.getCell(9).value), resultOf(total.getCell(10).value));
  });

  test('Balance Sheet carries the validation checks', async () => {
    const { wb } = await workbook(scenario());
    const bs = wb.getWorksheet('Balance Sheet')!;
    assert.ok(findRow(bs, 1, (v) => v === 'Validation checks'));
    assert.ok(findRow(bs, 1, (v) => v === 'Assets = Liabilities + Equity'));
    assert.equal(findRow(bs, 1, (v) => v === 'Balance difference (assets − liabilities − equity)')!.getCell(3).value, 0);
  });

  test('an empty period still opens with all five sheets', async () => {
    const { wb } = await workbook({ vouchers: [], heads: HEADS, transfers: [], from: '2026-10-10', to: '2026-10-10', branch: null });
    assert.equal(wb.worksheets.length, 5);
  });

  test('text a spreadsheet would run as a formula is written as text', async () => {
    const input = scenario();
    input.vouchers.find((x) => x.voucherNo === 'PV-2')!.description = '=HYPERLINK("http://evil.test","x")';
    input.vouchers.find((x) => x.voucherNo === 'PV-3')!.branchName = '+cmd|calc';
    const { wb } = await workbook(input);
    const ge = wb.getWorksheet('General Entries')!;
    const row = findRow(ge, 1, (v) => v === 'PV-2')!;
    assert.equal(row.getCell(12).value, `'=HYPERLINK("http://evil.test","x")`);
    assert.equal(row.getCell(12).formula, undefined);
    assert.equal(findRow(ge, 1, (v) => v === 'PV-3')!.getCell(7).value, "'+cmd|calc");
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
