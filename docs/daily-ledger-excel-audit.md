# Daily Ledger Excel — accounting workbook audit

What the Daily Ledger's **Excel** button produces, where every figure comes
from, and what the finance ledger cannot tell us. Written 2026-10-25.

## 1. What the button does

`DailyLedgerPage` (frontend) → `downloadLedgerWorkbook()` (`frontend/src/lib/finance.ts`)
→ `GET /api/finance/reports/accounting-workbook?from&to&branchId`
(`src/routes/finance-reports.routes.ts`, finance permission `view`) →
`Mountain_Bakes_Daily_Ledger_<from>[_to_<to>][_<branch>].xlsx`.

Sheets, in order:

| # | Sheet | Source |
|---|-------|--------|
| 1 | Daily Cash Book | The sheet the button always produced: `buildFinanceReport({type:'daily_cash_book'})` written by `addFinanceReportSheet` (`finance-export.service.ts`), unchanged. |
| 2 | General Entries | One journal entry per posted voucher (`finance-accounting.service.ts`). |
| 3 | Ledger | The general ledger, account by account, from the journal lines. |
| 4 | Trial Balance | Opening / period / closing per account as at `to`. |
| 5 | Income Statement | Revenue and expense accounts over the period. |
| 6 | Balance Sheet | Asset and equity balances as at `to`, then every validation check and the basis of preparation. |

Only the period and the branch apply. The screen's other filters (head, type,
account, status, amount, search) are not passed, because a statement narrowed
by head or account cannot balance. The PDF button is unchanged. Nothing about
the screen changed: no accounting tab, page, column or card was added to the
frontend, and the figures exist only in the file.

## 2. The existing data model

The finance ledger is **`ledger_entries`**, a single-entry cash book:

- One row per voucher (`voucher_no` unique, `RV-`/`PV-`, gapless). Rows are
  posted only through `post_finance_ledger_entry`, which takes an advisory
  lock and computes the running `balance` atomically.
- `account` is `cash` or `bank` (enum `finance_account`). `payment_method` is
  free text: cash, easypaisa, bank_transfer, cheque, foodpanda, online, other,
  or `cash+easypaisa+bank_account` for a mixed branch transfer.
- `ledger_head_id` / `ledger_head_type` (income | expense). `debit` is a
  receipt and `credit` a payment (`postEntry` decides the side from the head).
- `source_type` + `source_id` point to the authorising document:
  opening, manual (`finance_transactions`), branch_income, company_share,
  branch_share, salary, employee_advance, partner_expense, adjustment,
  branch_share_payout, branch_share_bonus, cash_transfer, vendor_payment.
- `status` is posted | locked | reversed. A reversal is a new voucher
  (`reverses_entry_id`), and the original stays. A delete is soft
  (`deleted_at`), and the balances after it are recomputed.
- `entry_date` is the **business date** (the business day starts at
  `BUSINESS_DAY_START_MINUTES`, not midnight; see `shared/utils/timezone.ts`).

`ledger_heads` is the chart: `code`, `name`, `type`, `group_name`
(Branch Collection, Share Split, Opening, Capital, Payroll, Partners,
Utilities, Operations, Company, Growth, Logistics, Assets, Corrections, Other).

`cash_transfers` holds each branch handover's `cash_amount`,
`easypaisa_amount` and `bank_amount`. Its approval posts ONE voucher booked to
whichever account holds most (`app.cash_transfer_slices`).

There is **no journal table, no debit/credit pair per transaction, no
receivables, payables, inventory valuation or fixed-asset register** in the
finance ledger. POS sales, discounts and refunds live in the branch sales
module and reach finance as collections (cash transfers / branch income).

## 3. Double entry — design decision

Each voucher already names both sides of a double entry: the Cash/Bank account
it moved, and the ledger head it moved against. So:

```
receipt (debit)  →  DR Cash / Bank / Easypaisa      CR <head account>
payment (credit) →  DR <head account>               CR Cash / Bank / Easypaisa
```

Every voucher becomes exactly one balanced journal entry, keyed by its
`voucher_no`. **The journal is derived on read, not stored.** No migration was
added. Reasons:

- **Nothing is invented.** Both legs come from columns the posting function
  wrote atomically. No balancing line is added anywhere.
- **No duplicates are possible.** The key is the database-unique voucher
  number, and an export writes nothing, so repeated or concurrent exports
  cannot post twice.
- **It cannot drift from the book.** A stored journal would need every posting
  path (13 source types, edit-in-place, delete, reversal, re-date) to write it
  too, and could fall out of step. Deriving it each time cannot.

A stored journal (`journal_entries` / `journal_lines` with a unique
`source_voucher_id`) is the next step only if finance starts recording things
the cash book cannot hold: accruals, receivables, payables or stock valuation.

## 4. Account mapping

| Account | Code | Rule |
|---------|------|------|
| Cash in Hand | `AST-CASH` | `account = cash`, unless the payment method is a bank method |
| Bank — Bank Account | `AST-BANK` | `account = bank`, or method `bank_transfer` / `bank_account` |
| Bank — Easypaisa | `AST-BANK-EASYPAISA` | method `easypaisa` (shown under Bank) |
| General Fund — opening | head code (`INC-OPENING`) | `source_type = opening`, code `INC-OPENING` or group Opening |
| General Fund — capital | head code (`INC-INVESTMENT`) | code `INC-INVESTMENT` or group Capital |
| General Fund — withdrawals | `EXP-PARTNER` | by code only (the Partners group also holds Branch Share Payout, a real expense) |
| Revenue | head code | every other income head |
| Expense | head code | every other expense head |
| Retained Earnings b/f | `EQ-RETAINED-EARNINGS` | revenue − expense before `from` |

Further rules:

- **Mixed branch transfer:** split into Cash / Easypaisa / Bank from the
  transfer's own amounts when they add up to the voucher. Otherwise the voucher
  stays on its booked account and is flagged.
- **Reversal:** moves the same accounts as its original, in reverse.
- **Cheque:** keeps its booked account, because a received cheque can sit in
  the cash box.

Income statement sections:

- **Sales revenue:** heads in the Branch Collection and Share Split groups.
- **Other income:** every other revenue head.
- **Operating expenses:** grouped by head group.
- **Other expenses:** the Corrections group.
- **Gross profit:** equals net revenue, because cost of goods sold is not
  determined.

## 4b. Branch outstanding balances (Finance → Demand Record)

Added 2026-10-25. Source: `getDemandRecordForAccounts` in
`branch-account.service.ts`, which returns the same rows the Demand Record page
shows (`loadAccounts`), Finance's entries, the deposits the page counts as
Received, and the page's Balance by Branch for the same period and branch.

**Direction.** The Demand Record's closing balance is Company Share +
Adjustments − Received.

- **Positive balance:** the branch owes Mountain Bakes. It is an **asset**
  (Branch receivable — <branch>).
- **Negative balance:** a credit the branch paid ahead, owed back to it. It is
  a **liability** (Branch credit balances).

**Accrual, without double counting.** The cash book already posts every
approved deposit as Company Share income. In the workbook only (nothing stored
changes):

| Record | Journal |
|---|---|
| Delivered demand (`DMD-…`, its business date) | DR Branch receivable / CR Company Share — demands (the page's G. Total × frozen %) |
| Deposit the Demand Record counts as Received (its cash voucher) | DR Cash/Bank / CR **Branch receivable** (in place of Company Share income). The fuel charge stays income. |
| Finance opening entry | DR Branch receivable / CR Branch dues brought forward (equity: earned before the record began) |
| Finance adjustment | DR/CR Branch receivable against Demand Record adjustments (revenue) |
| Reversal | The opposite of what it reverses |

- **Not received under the record:** deposits it does not count (before its
  start, or before a branch's first demand) stay income when received, as
  before.
- **Pending demands:** cancelled and pending demands, and pending, rejected or
  deleted transfers, are never in the Demand Record, so they are never here.
- **Ties to the page:** each branch's receivable is the page's own formula,
  line by line.

**Reconciliation.** The Balance Sheet sheet lists every branch with its
balance in the books, the page's balance and the difference, plus the
overall net total. The check "Branch balances agree with the Demand Record
page" passes when every line agrees. The two can differ for one known
reason: the page keeps a branch's last row open, so a deposit or return made
after the reporting date still lands in it, while the books count a deposit
on its own date. As at today the two agree. As at an earlier date a later
payment shows as a difference, and the check names it. "Each Demand Record
deposit is in the ledger once" compares each transfer with its voucher.
"Company share recognised once" flags a sales-income share posting for a
branch whose demands already accrue Company Share.

**Payments against the wrong branch or demand.** A deposit settles the
branch of its transfer (the source document), even if its voucher is tagged
to another branch. Deposits are not linked to a single demand in this system;
the page places them by time.

## 5. Validation (printed on the Balance Sheet sheet; never forced)

Every journal entry balances · journal DR = CR · each voucher once ·
each source document posted once · no manual re-keying of a branch collection ·
Easypaisa/bank under Bank (reclassifications listed) · mixed transfers split ·
ledger = trial balance per account · trial balance balances in all three column
pairs · income statement = revenue − expense accounts · assets = liabilities +
equity · opening balance present · no negative cash/bank · every head in the
chart · branch filter = partial view.

Each check is PASS, WARN or FAIL. The status line on every sheet reports the
worst result. The Income Statement and Balance Sheet carry their own status:

- **NOT VERIFIED** when any check fails.
- **Provisional, cash basis** for the Income Statement otherwise.
- **Balanced, but INCOMPLETE** for the Balance Sheet otherwise.

Neither statement is ever labelled verified, because the ledger has no
receivables, payables, inventory or accruals. Invalid vouchers (zero or
negative) appear in General Entries marked INVALID. Nothing is dropped.

## 6. Known gaps

- Cash basis except branch Company Share (accrual, from the Demand Record's
  start): no cost of goods sold, other accruals, payables, loans, inventory or
  fixed assets. Equipment is expensed as booked.
- Employee advances post under Salaries. Their recovery through payroll
  deductions is not a separate posting, so no advances receivable is kept.
- Branch-income bank slices combine Easypaisa and bank receipts, so they show
  under Bank — Bank Account.
- A voucher paid by Easypaisa but booked to Cash is shown under Bank in the
  workbook, while the app's Cash in Hand still counts it. The check lists each
  one.
- A branch-filtered workbook leaves out company-level vouchers (opening
  balance, salaries, partner withdrawals). The branch check says so.

## 7. Related fix

The db layer returns at most `DB_MAX_ROWS` (default 1000) rows per read, so
`fetchEntries` in `finance-reports.service.ts` silently stopped at 1000
vouchers while its "TRUNCATED at 20,000" note never fired. It now pages until
an empty page, which corrects every finance report built on it, including the
Daily Cash Book sheet in this workbook.

## 8. Tests

- `src/services/__tests__/finance-accounting.test.ts`: the engine on a book
  worked out by hand (journal, splits, reclassification, reversal, opening
  balances, date boundaries, trial balance, statements, statuses, every
  exception), plus the workbook read back (sheet order, cash book first,
  numeric cells, SUM totals, formula injection, file name).
- `src/services/__tests__/finance-accounting.integration.test.ts`: real
  baseline schema in PGlite, vouchers posted by the real
  `post_finance_ledger_entry`, the real route, and `DB_MAX_ROWS=3`. It covers
  401/403/400/404, all six sheets, every voucher across pages, the Easypaisa
  split, the balance sheet equation, branch filtering, repeated exports
  writing nothing, and the empty period.
- `src/services/__tests__/finance-accounting-demand.integration.test.ts`:
  the Demand Record switched on (real migration, % frozen by the real trigger,
  deposits posted by the real posting function, opening entry through the real
  route). The workbook's branch balances are compared with the page's own
  endpoint, and the suite also covers partial and full payment, an earlier
  reporting date, the branch filter, cancelled and pending records, repeated
  exports, and a branch manager refused.
- `frontend/src/lib/__tests__/ledger-workbook.test.ts`: the button's request
  and file name.

## 9. Deploying

No migration. Deploy the backend (push to `intigration/railway`), then the
web app. Either can go first: until the web app is deployed, the old button
keeps calling the old endpoint, which is unchanged.
