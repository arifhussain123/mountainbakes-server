# Centralized ledger business rules — architecture audit

Phase 1 of the "Centralized Ledger Business Rules" brief: what exists today,
which of the brief's requirements are already met, and the formula conflicts
that must be settled by the business owner before any code is written.
Written 2026-11-07.

No application code, schema or migration was changed. This document is the
deliverable.

## 1. Scope of this audit

Read: `backend/prisma/schema.prisma` (3,495 lines, 108 models), the baseline
and 17 later migrations, `backend/src/services` (61 services),
`backend/src/routes` (56 route files), and the three audits already in
`backend/docs`.

Not covered, and not claimed:

- **The live database.** Everything here comes from the committed schema and
  migrations. The brief's "verify existing data before migration" (§9) cannot
  be done from the repository — it needs a read-only connection to the
  production Supabase instance.
- **`frontend/` and `mobile/`.** Both are separate git repositories on their
  own feature branches (`discountViewChanges`, `whatsapp-purchasing`). They
  consume these APIs; no calculation was traced into them.

The three repositories are each on a different branch, so no single commit
describes the system as deployed.

## 2. What already exists

The brief's §1 asks that existing working logic not be replaced without
justification. Most of what it asks for is already built:

| Brief | Requirement | Status |
|---|---|---|
| §2 | Company Share / Return / Discount independent | Separate tables and separate `source_type` values |
| §3 | Centralized calculation service | `post_finance_ledger_entry` (DB function) is the single posting path; `finance_ledger_totals` the single totals path |
| §4 | Unique transaction IDs | `ledger_entries.voucher_no` unique and gapless, `seq` bigserial, `finance_transactions.txn_no` from `app.next_finance_number` |
| §4 | Prevent duplicate postings | `idempotency_keys` at the API layer; `finance_transactions.ledger_entry_id` unique, so one document posts at most one entry |
| §4 | Transaction date vs business date | `entry_date` is the business date (day starts at `BUSINESS_DAY_START_MINUTES`); `posted_at` is the clock time |
| §4 | Preserve original values on edit | `branch_discounts.original_amount`, `finance_transactions.revision`, `finance_amendments` |
| §4 | Complete audit trail | `audit_logs`, `finance_audit_logs`, and `created_by` / `approved_by` / `updated_by` / `deleted_by` with names snapshotted on the row |
| §4 | Reversal entries | `reverses_entry_id` / `reversed_by_entry_id`, with a unique partial index allowing **one** reversal per entry; deletes are soft (`deleted_at`) |
| §4 | Database transactions | Posting takes an advisory lock and computes the running balance atomically |
| §6 | Debit and credit balance | Every voucher derives one balanced journal entry on read; validated by 14 checks in `finance-accounting.service.ts` |
| §7 | Opening / closing / date-wise / branch-wise | `getLedgerSummary` and `finance_ledger_totals` |
| §8 | Automated tests | Three integration suites run the real migrations in PGlite and post through the real database function |

`ledger_entries` is a single-entry cash book with `account` = `cash | bank` on
every row. `finance_accounting.service.ts` derives a double-entry journal from
it on read rather than storing one — a deliberate decision, with its reasoning
recorded in `docs/daily-ledger-excel-audit.md` §3.

A note on naming, since it reads like duplication and is not:
`finance-ledger.service.ts` (singular) is the general ledger — heads, posting,
queries, day closing. `finance-ledgers.service.ts` (plural) is the salary and
partner sub-ledgers. Different responsibilities.

## 3. Finding 1 — two different Company Share formulas (blocking)

**Severity: high. This one moves money.** The system computes Company Share
two different ways, and both are called Company Share.

The **collection slip**, which is what the rider actually collects
(`src/services/previous-balance.service.ts:254`):

```
companyShareValue = Delivered × share%
amountToCollect   = companyShareValue − Returns − Discount
```

The **Demand Record receivable**, which is what the branch's balance records
(`docs/demand-record-accounting-audit.md:197`):

```
G. Total        = Delivered − Returns − Discount
Company Share   = G. Total × frozen share% ÷ 100
Closing         = Previous + Company Share + Adjustments − Received
```

The slip takes the percentage of the **gross** delivery and then deducts the
returns and discount in **full**. The Demand Record deducts them **first** and
takes the percentage of the **net**. Worked through, on one delivery at 75%:

| | Delivered | Returns + Discount | Company Share | Collected / recorded |
|---|---|---|---|---|
| Collection slip | 100,000 | 10,000 | 75,000 | **65,000** |
| Demand Record | 100,000 | 10,000 | 67,500 | **67,500** |

The rider collects 65,000; the branch's balance is reduced by 67,500. The gap
is 2,500 — **25% of every return and discount**, i.e. the company's share of
it. Under the slip the company absorbs the whole return; under the Demand
Record the branch absorbs 75% of it.

This is not a rounding difference and it does not self-correct. It accrues
once per delivery, in the same direction every time, and shows up later as a
branch balance that will not reconcile against cash actually collected.

Both formulas are deliberate and documented. The slip's comment states the
intent plainly: "Both deductions come off the company's share. A discount
reduces what the rider collects exactly as a return does." Neither is
obviously the error, so **which one is correct is a business decision, not an
engineering one.**

## 4. Finding 2 — the two tracks also value goods differently

A second, independent source of the same drift.

- The slip values both delivered goods and returns at **current**
  `products.price` (`previous-balance.service.ts`, the note on the valuation
  basis).
- The Demand Record uses **frozen** prices and a **frozen** share percentage
  (`production_order_share_snapshots.company_share_pct`, written by a trigger).

So a price change after delivery moves the slip's figure and not the record's.
The code already flags this as unresolved: `production_order_items.unit_price`
is snapshotted "precisely so a later price change cannot rewrite what an order
was worth", but the slip does not read it, and the comment says changing that
"would move `companyShareValue` and `amountToCollect`, i.e. money actually
collected, so it is not changed as a side effect of adding a field."

That judgement was right. It is still outstanding.

## 5. Finding 3 — the ledger summary combines cash and bank

`getLedgerSummary` (`src/services/finance-ledger.service.ts:427`) returns one
balance across both accounts:

```
balance = openingBalance + totalReceived − totalExpense
```

It never passes `p_account`, so cash and bank are summed together. The Daily
Ledger business-rules spec requires them kept apart and explicitly forbids a
combined figure from replacing them.

The fix is small and low-risk: `finance_ledger_totals` already **accepts**
`p_account` (`prisma/migrations/0_baseline/migration.sql:5641`). Separate
balances need only the caller to ask for them. See Finding 4 first.

## 6. Finding 4 — `opening_balance` ignores every filter

In `finance_ledger_totals`, the three period figures honour all eleven
parameters, but the opening balance does not:

```sql
else coalesce((select sum(debit - credit) from ledger_entries
                where entry_date < p_from and deleted_at is null), 0)
```

No `p_branch_id`, no `p_account`, no `p_type`. It returns the whole company's
opening balance whatever was asked for.

Today this is masked: `getLedgerSummary` recomputes the opening balance with a
second filtered call when a branch is given, and the company-wide path is
unfiltered anyway, so it happens to be right. But the moment Finding 3 is
fixed by passing `p_account`, the opening balance silently becomes the
**combined** cash-and-bank figure while the period movements are per-account —
producing a cash closing balance inflated by the bank's opening balance.

**Fix Finding 4 before Finding 3, not after.** This is the trap in the only
part of the brief that looked like a safe quick win.

## 7. Finding 5 — returns are quantities, not money

`production_returns` has `qty Decimal(14,3)` and no amount column. Discounts
are money (`branch_discounts.amount Decimal(14,2)`); returns are not. The
slip's comment records the asymmetry: "No price lookup, unlike returns: a
claim IS an amount."

Any ledger column showing Return as money therefore depends on a valuation
rule — and that rule is exactly what Finding 2 is about. A "Return" money
column cannot be implemented until the price basis is approved.

## 8. Conflicts with the Daily Ledger business-rules spec

The earlier Daily Ledger specification and the existing system disagree on
three points. The spec forbids calculations the system performs today and
relies on for cash collection.

| Spec rule | Existing system | Resolution needed |
|---|---|---|
| "Do not calculate Company Share − Return − Discount" | The collection slip does exactly this (`:255`) and the rider collects on it | Which track is authoritative? The slip cannot simply be switched off; it is the document the branch settles against |
| Production figures never combined into a net figure | Demand Record nets them *before* the percentage (`G. Total`) | Both tracks combine them, in different orders. Neither matches the spec as written |
| Negative balance carried forward, presentation unapproved | Already built, with direction semantics: positive = branch receivable (asset), negative = "Branch credit balances" (liability) | The spec's open item is already answered by the implementation. Confirm the implemented meaning is the intended one |

The spec also treats three items as undefined that the system has in fact
settled, and which should be recorded as decided rather than re-opened:

- **Company Share method** — `branches.company_share_pct`, falling back to
  `finance_settings.company_share_pct` (default 75), frozen per demand by
  trigger.
- **Received allocation** — not by oldest-outstanding and not by business
  date: "Deposits are not linked to a single demand in this system; the page
  places them by time" (`docs/daily-ledger-excel-audit.md` §4b).
- **Cash and bank sources** — `finance_account` on every entry, plus
  `cash_transfers.cash_amount / easypaisa_amount / bank_amount`, booked by
  `app.cash_transfer_slices` to whichever account holds most.

## 9. Requires business approval — do not implement

Per the brief's closing instruction, these are documented rather than assumed.
Each changes money already collected or already recorded.

1. **Which Company Share formula is authoritative** (Finding 1): percentage of
   gross with full deduction, or percentage of net. Equivalently: who bears a
   return and a discount, the company or the branch?
2. **Whether the two tracks should be reconciled retrospectively** or only
   from a go-live date. Retrospective restatement changes historical branch
   balances, which §9 of the brief forbids touching without approval.
3. **The valuation basis** (Finding 2): current price or snapshotted
   `unit_price`, for delivered goods and for returns, in each track.
4. **Whether a Return money figure is wanted at all** (Finding 5), and at
   which price.
5. **Whether the collection slip's `amountToCollect` may keep deducting**
   returns and discounts, given the Daily Ledger spec forbids it.
6. **Whether a stored journal is wanted.** The journal is derived on read
   today, deliberately. It is only needed if finance starts recording
   accruals, receivables, payables or stock valuation — see
   `docs/daily-ledger-excel-audit.md` §3.

## 10. Safe to implement now, in this order

These need no new accounting rule. Nothing here changes a posted figure.

1. **Fix `opening_balance` in `finance_ledger_totals`** to honour its
   parameters (Finding 4). New migration; the function is `LANGUAGE sql
   STABLE`, so this is a replace, not a data change. Regression test: a branch
   with entries before the window, filtered by account.
2. **Separate cash and bank** in `getLedgerSummary` and the dashboard
   (Finding 3), keeping any combined figure clearly labelled as informational
   and never in place of the two.
3. **A reconciliation report** comparing, per branch and per delivery, the
   slip's `amountToCollect` against the Demand Record's movement, with the
   difference attributed to the formula gap and to the price basis separately.
   This quantifies Findings 1 and 2 on real data and is what the business
   owner needs in order to answer §9.1. It reads only.
4. **Name the two tracks apart in code and UI** — e.g. "Share to collect"
   versus "Share receivable" — so the next reader does not assume one number.

Step 3 is the one worth doing first: it turns the decision in §9.1 from a
judgement call into a figure.

## 11. Not done

Deliverables 3 to 7 of the brief (migrations, centralized service, API
integration, test results, reconciliation report) are not started. Items 1 and
2 of §10 are small and ready; the rest depend on §9.

No test was run as part of this audit, and no existing behaviour was verified
against the live database.

