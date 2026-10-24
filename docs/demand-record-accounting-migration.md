# Demand Record Accounting Restructure — Audit and Migration (2026-10-24)

The backend side of the "Demand Record accounting restructure" spec: what
exists, how the spec's fields map onto it, what was changed, what was tested,
and what is left. Frontend and POS print are not changed.

Read with `docs/demand-record-accounting-audit.md`, which documents the
Demand Record itself: its rules, derivation and API.

> The spec says "Supabase". The project no longer uses Supabase. The API is
> Express + Prisma on Railway Postgres, and schema changes are Prisma
> migrations in `prisma/migrations/`, applied with `prisma migrate deploy`.
> The Railway build does not apply them.

---

## 1. What exists (audit)

### 1.1 No stored Demand Record table — by design

The spec assumes a demand table that stores Delivered Value, Company Share,
Payment Received, Remaining, and so on. There isn't one. Those figures have
never been stored in this system:

| Old figure (Collections export / slip) | Where it really lives |
|---|---|
| Delivered Value | `production_order_items.approved_qty` × price, computed on read |
| Less Returns Qty / Less Returns | `production_returns` (accepted), computed on read |
| Less Discount | `branch_discounts` (approved), computed on read |
| Company Share, Amount to Collect, Remaining | computed on read by `getPreviousOrderBalance` (`services/previous-balance.service.ts`) |
| Payment Received | `cash_transfers` (approved), shown, never stored on a demand |

The spec's "old data" row (Alabad Branch, DMD-000246, Delivered 14,550 …
Remaining 9,413) is a line of the **Collections export**. That export is a
computed report, not a stored record. So there is no old column to migrate
from, and nothing to overwrite.

The **Demand Record** (`services/branch-account.service.ts`,
`shared/utils/branch-account.ts`, migration `20261024000001_branch_account_ledger`)
already derives the spec's structure from those source rows on every read.
It is the "equivalent transactional design" the spec allows (section 10). With
no stored balance there is no stale read and no lost update. Each source row
is counted once by construction, and a backdated correction flows through
every later balance by itself.

### 1.2 Field mapping (spec → backend)

| Spec field | Backend field (Demand Record row) | Source |
|---|---|---|
| Branch Name | `branchName` | `production_orders.branch_name` / `branches.name` |
| Date | `businessDate` | `production_orders.business_date` |
| Demand Number | `demandNumber` | `production_orders.demand_number` (unchanged, unique) |
| Total Demand Amount | `totalDemandAmount` (= `delivered`) | Σ approved_qty × line `unit_price`, else price on the demand's date |
| Return Amount | `returns` | accepted returns × price on the return's own date |
| (return quantity) | `returnsQty` | kept separate; never used as money |
| Discount | `discount` | approved discounts claimed against the demand |
| Demand | `demand` (= `gTotal`) | Total Demand Amount − Return Amount − Discount |
| Company Share | `companyShare` | Demand × the demand's frozen % ÷ 100 |
| Previous Balance | `previousBalance` | the branch's preceding row's Remaining (opening row first) |
| Amount Due | `amountDue` | Previous Balance + Company Share + Adjustments |
| Payment Received | `received` | approved, non-deleted `cash_transfers` in the row's window, each once |
| Remaining | `remaining` (= `closingBalance`) | Amount Due − Payment Received; negative = credit |

`demand`, `amountDue`, `remaining` and `totalDemandAmount` were added in this
change, beside the original names. The Demand Record page reads `gTotal` and
`closingBalance`, so they are kept: an additive API change, with no consumer
broken.

`Adjustments` are Finance's own append-only entries (opening balance,
corrections, reversals). They are 0 unless Finance posts one. They are
included in Amount Due, so an opening balance is part of "the preceding
balance" for a branch's first demand, as spec §4 (Formula 3) requires.

### 1.3 Admin company-share percentage

- **Global:** `finance_settings.company_share_pct`, edited by finance_admin.
- **Per branch:** `branches.company_share_pct`, nullable (inherit), edited by
  super_admin.
- Resolved by `app.resolve_company_share_pct(branch)`, the same rule the slip
  uses. Nothing is hard-coded. A missing or invalid global value falls back to
  the baseline's 75 (`finance_order_values`), as before.
- **Frozen per demand** in `production_order_share_snapshots` (append-only). A
  trigger writes it when a demand leaves `pending`, and the go-live writes it
  for older demands.
- **Limitation (spec §6.5):** no history of past % changes exists, so the
  go-live freezes older demands at the % that applies on the day it runs.
  That is the only % on record. If a branch's % was different in August or
  September, Finance corrects it with an adjustment.

### 1.4 Finance Dashboard income (before this change)

`finance_monthly_dashboard` (SQL), via `services/finance-monthly-dashboard.service.ts`:

| Column | Before |
|---|---|
| Demand Amount | gross: Σ approved_qty × **today's** product price, by demand date |
| Company Share | gross × the branch's **live** % |
| Received Amount | income-ledger receipts (INC-COMPANY-SHARE / INC-FUEL heads, plus cash-transfer postings) |
| Balance | computed in the frontend: Company Share − Received |
| Last Month Balance | last month's Company Share − Received alone, nothing carried |

The frontend's label is already "Demand Amount". It has never shown
"G. Total", so no label change was needed, and the frontend was not touched.

### 1.5 POS print

The slip's previous-order block comes from `getPreviousOrderBalance`. It is
untouched: not one line of `previous-balance.service.ts`, the print templates
or the print routes changed.

---

## 2. What was changed

### 2.1 Migration `20261024000002_demand_record_go_live`

It switches the Demand Record on "from the start of the web" (the owner's
choice, 2026-10-24), doing exactly what Finance's **Switch on** does
(`setLedgerStart`), and only if no go-live day is set yet:

1. `finance_settings.account_ledger_start` becomes the earlier of the first
   branch created and the first demand, as a Karachi business date. On the
   copy of production this came out as **2026-07-20**.
2. It freezes the % of every delivered demand from that day
   (`source = 'go_live'`).
3. It writes the Finance audit entry (`entity = 'branch_account'`, actor
   "system").

It is additive. The only existing value it changes is that one setting, which
goes from NULL to a date. It is idempotent: running it again does nothing.
**Recovery:** `update finance_settings set account_ledger_start = null`
switches the Demand Record off again. The snapshots and the audit entry are
append-only by design. They stay, and they are harmless while it is off.

### 2.2 Payment Received "migration"

**Nothing moved, on purpose.** Payment Received has only ever lived in
`cash_transfers`, one row per deposit, and the Demand Record reads it from
there. Copying it into a new column would create a second copy of every
payment, which is the double count spec §9 forbids. The reconciliation the
spec asks for was run instead (§4 below). It matched to the paisa.

### 2.3 Backend code

| File | Change |
|---|---|
| `src/shared/utils/branch-account.ts` | rows carry `totalDemandAmount`, `demand`, `amountDue`, `remaining`; totals carry `demand` |
| `src/services/branch-account.service.ts` | `getDemandRecordRows(branchId)`: every row from go-live, for reports |
| `src/services/finance-monthly-dashboard.service.ts` | income on the Demand Record's rules (below) |
| `prisma/migrations/20261024000002_demand_record_go_live/` | the go-live (§2.1) |
| `src/services/__tests__/demand-record-restructure.integration.test.ts` | tests (§3) |

**Finance Dashboard income, after this change.** These rules apply from the
go-live day. Days before it keep the old figures, and in practice there are
none.

| Column | After |
|---|---|
| Demand Amount | Σ Demand Record `demand` dated that day = Delivered − Returns − Discount |
| Company Share | Σ Demand Record `companyShare` = Demand × frozen % |
| Received Amount | unchanged (income ledger) |
| Balance | unchanged rule in the frontend: Company Share − Received |
| Last Month Balance | each branch's **Remaining carried into the month**: its last Demand Record row before the 1st. Receipts with no branch keep their old line. |

So **Last Month Balance + Company Share − Received** = what each branch owes at
the month's end. The drill-down lists behind Demand and Company Share come
from the same rows, so each list adds up to its figure. The API contract
(`FinanceMonthlyDashboard`, `FinanceDashboardRecordsPage`) is unchanged. Only
the values changed.

A return or discount is netted on the demand it is billed to, which is the
slip's own window. It is not netted on the day it happened. That is how the
Demand Record places them, and it keeps the dashboard and the Demand Record
in agreement.

---

## 3. Tests

`node --import tsx --test src/services/__tests__/demand-record-restructure.integration.test.ts`
runs on the real baseline tables and SQL functions, with both migrations
applied as `prisma migrate deploy` applies them. The data is the spec's worked
example. **9 / 9 pass:**

| Spec test | Result |
|---|---|
| A — first demand | Demand 42,800 · Share 34,240 · Due 34,240 · Remaining 6,240 ✔ |
| B — next demand | Previous 6,240 · Due 44,640 · Received 42,200 · Remaining 2,440 ✔ |
| C — % change | recorded demands keep 80%; a new demand freezes 70% and carries 2,440 ✔ |
| D — branches | Beta's 2,500 is not inherited by Aliabad ✔ |
| E — payments | Σ received = Σ approved transfers (75,200); one ledger entry per payment ✔ |
| F — Finance income | net Demand, share on it, Last Month Balance carried, drill-downs add up ✔ |
| G — POS print | the slip for DMD-000124 is identical before and after the migration ✔ |
| H / I — retries, safety | source rows byte-identical after; a re-run changes nothing ✔ |
| go-live | start = first branch day, every % frozen, one audit entry ✔ |

Concurrency and duplicate submissions (Test H's other half) are covered by
`branch-account.integration.test.ts`, Tests 6 and 7 (11 / 11 pass). Ten
concurrent openings gave 1 accepted and 9 refused; the same request sent ten
times gave 1 posting and 9 replays. The unit rules are in
`branch-account.test.ts` (9 / 9).

Full services suite: **606 / 609**. The 3 failures are the pre-existing
`daily-sale-company-share.test.ts` mismatch recorded in the earlier audit
(§1.5 there), which this change does not touch.

---

## 4. Rehearsal on a copy of production (spec Test I)

This morning's backup of the live database (`pg_dump`, 10:57, 107 tables) was
restored into a local Postgres 18. Both migrations were applied, and the real
services were run against it:

- **Source tables:** demands (273), items (5,463), returns (289), discounts
  (91), cash transfers (79) and ledger entries (1,066) have identical row
  counts and identical checksums before and after.
- **Go-live:** start 2026-07-20. 265 delivered demands were frozen. 1 audit
  entry was written. A second run changed nothing.
- **POS print:** `getPreviousOrderBalance` returned the identical result for
  all 265 delivered demands, before and after.
- **Formulas:** they hold on all 267 rows (265 demands and 2 opening rows):
  Demand = Delivered − Returns − Discount, Due = Previous + Share +
  Adjustments, Remaining = Due − Received.
- **Payments:** Demand Record Payment Received = **Rs. 1,391,239.50** = the 74
  approved cash transfers since go-live. Each was counted once.
- **Totals since go-live:** Delivered 7,016,330 · Returns 167,900 · Discount
  56,067 · Demand 6,792,363 · Company Share 5,044,267.25.

### Discrepancy found — needs Finance before go-live

**No deposit was recorded before 2026-09-25.** The first approved cash
transfer is dated that day.

| Period | Demands | Company Share | Payment Received recorded |
|---|---|---|---|
| 2026-07-20 – 2026-09-24 | 177 | Rs. 3,517,500 | **Rs. 0** |
| 2026-09-25 onward | 88 | Rs. 1,526,768 | Rs. 1,391,240 |

So every branch's Remaining includes its whole share from before 25 Sep, about
Rs. 3.5 million across branches. On the copy, October's dashboard showed a
**Last Month Balance of Rs. 3,553,137.25**. Under the formulas that figure is
correct for the data. It is not real money owed if branches paid before deposits were
recorded in the app. Historical values are not altered to hide it (spec §7).

Finance closes the gap with one **adjustment per branch** (Finance → Demand
Record → Opening & adjustments: "received before 25 Sep 2026"). An adjustment
is append-only and audited, and it flows into every later balance by itself.

---

## 5. Deployment steps (not yet done)

1. Back up the Railway database (`pg_dump -Fc` of `RAILWAY_DB_URL`).
2. `DIRECT_DATABASE_URL="$RAILWAY_DB_URL" prisma migrate deploy` applies
   `20261024000002_demand_record_go_live`. The owner approves this, since it
   switches the Demand Record on in Finance.
3. Push the backend to `intigration/railway`; Railway deploys it.
4. Check: the start date is set, the snapshot count equals the delivered
   demands, Finance → Demand Record shows rows, the October dashboard's Demand
   Amount is the net figure, and a POS slip prints as before.
5. Finance posts the pre-25-Sep adjustments (§4).

The order matters only loosely. The new backend runs safely before the
migration: while the Demand Record is off, the dashboard keeps its old
figures.

## 6. Unresolved risks

- **Pre-25-Sep balances** (§4) until Finance posts adjustments.
- **Today's % for old demands** (§1.3). There is no record of past % changes.
- **Received on the dashboard vs the Demand Record.** The dashboard's Received
  is the income ledger, which also includes manual INC-COMPANY-SHARE /
  INC-FUEL entries. The Demand Record counts approved cash transfers. They are
  equal while nobody posts manual income entries; a manual entry would show on
  the dashboard but not in Remaining. This was left as it was, because the
  spec says to keep Received.
- **Balance column** on the dashboard is still the frontend's
  Company Share − Received for the period, without the carried balance (a
  frontend rule). The carried part is in Last Month Balance beside it.
