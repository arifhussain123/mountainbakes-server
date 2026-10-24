# Demand Record Accounting — Audit (2026-10-24)

Phase 1 of the "Demand Record, Company Share & Running Balance" spec: what the
system does today, where it differs from the spec, and what must be decided
before any money logic changes. Nothing here has been changed yet.

References are `path:line` from the repository root. `BL` is
`backend/prisma/migrations/0_baseline/migration.sql`.

> The spec says "Supabase". The project no longer uses Supabase: the API is
> Express + Prisma on Railway Postgres, and schema changes are Prisma
> migrations in `backend/prisma/migrations/` (applied with
> `prisma migrate deploy`; the Railway build does not run them).

---

## 1. What exists today

### 1.1 Demand (production order) lifecycle

| Step | Who | Where | Effect |
|---|---|---|---|
| Create | branch_manager | `backend/src/routes/production-orders.routes.ts:118` | `pending`; `demand_number` from `next_demand_number()` (`DMD-000123`, counter row, UNIQUE — BL:5878, BL:10882); `unit_price` snapshotted from `products.price` (:164-191) |
| Review | super_admin, production_user | `:509` → `review_production_order` (BL:6820) | check-and-set `pending → awaiting_verification`; sets `approved_qty` |
| Verify | owning branch | `:928` → `verify_production_order` (BL:7479) | `awaiting_verification → verified`; **overwrites `approved_qty` with the branch's count**; added lines get no `unit_price` (BL:7546) |
| Final approve | super_admin, production_user | `:1070` | `verified → approved` |
| Cancel | branch | `:649` | `pending → cancelled` |

Order header and items are inserted by two separate calls with no wrapping
transaction (`:232-274`). The `Idempotency-Key` middleware is opt-in, and the
web app does not send it (`backend/src/middleware/idempotency.ts:103`).

### 1.2 The delivery slip's "previous order" balance

`getPreviousOrderBalance` (`backend/src/services/previous-balance.service.ts`) is
the only per-demand money calculation. It feeds the printed slip, the finance
Demand Detail dialog and the Collections export.

| Figure | Formula today | Ref |
|---|---|---|
| Delivered Value | Σ `approved_qty` × **current** `products.price` | :140-167 |
| Company Share | Delivered × current % (branch override, else global) | :254 |
| Less Returns | accepted returns created in (previous order, this order], × current price, **full value** | :180-207 |
| Less Discount | approved `branch_discounts` created in the same window, **full value** | :226-241 |
| Amount to Collect | Share − Returns − Discount (can be negative) | :255 |
| Payment Received | approved cash transfers in the window **plus the rest of those days' deposits** (display only) | :248, `cash-transfers.service.ts:505-568` |
| Remaining | `max(0, Collect − Payment)` | :273 |

Facts that matter for the spec:

- **Nothing is carried forward.** Each slip stands alone. An unpaid remainder,
  an overpayment or a negative Amount to Collect never reaches the next slip
  (stated in the code at :81-83).
- **No snapshots.** Prices and the % are read live at view time, so reprinting
  an old slip after a price or % change prints different money.
  `production_order_items.unit_price` exists but billing ignores it.
- **`verified` orders are skipped** as "the previous delivery" (:101, also in
  the Collections export). The finance dashboard does include `verified`
  (BL:1123). No comment explains the difference, so it looks like a bug.
- **Payments are not linked to a demand.** `cash_transfers` has no
  order/demand column. Because of the rest-of-day rule, one deposit can appear
  on two slips of the same day.
- **Discounts are linked to a demand** (`branch_discounts.production_order_id`,
  required) but are billed by time window, so a claim lands on whichever slip's
  window holds its `created_at`.
- **Returns are not linked to a demand.** They are billed by time window.

### 1.3 Company share percentage

- Global: `finance_settings.company_share_pct` (default 75, CHECK that company +
  branch = 100, BL:8618). Edited in Finance Settings
  (`frontend/src/components/finance/FinanceSettingsPage.tsx`) by finance_admin
  only (`requireFinance('configure')`, `backend/src/routes/finance.routes.ts:521`).
- Per branch: `branches.company_share_pct`, nullable = inherit, CHECK 0–100.
  Edited by super_admin in Branches (`backend/src/routes/branches.routes.ts:150`).
- Resolution: `resolveShareSplit` (`backend/src/shared/utils/share.ts:49`).
- **No history and no effective dates** (stated at
  `backend/src/services/daily-sale.service.ts:357`). Changes are audited in
  `finance_audit_logs` only.
- The only snapshot is on `finance_income_approvals.company_share_pct`, which
  belongs to the sales-income flow, not to demands.

The spec's Phase 2 requirements 1–3 and 7–8 are already met. Requirements 4–6
(snapshot per record, effective dates) are not.

### 1.4 Three different "company share" calculations

| Where | Base | Price | "Received" |
|---|---|---|---|
| Delivery slip / Collections export | delivered value | current | approved cash transfers (display only) |
| Finance monthly dashboard (`app.finance_order_values`, BL:1123; `finance_monthly_dashboard`, BL:5684) | delivered value (incl. `verified`) | current | INC-COMPANY-SHARE ledger income + cash transfers (BL:5728) |
| Income approvals (`finance_income_approvals`, `backend/src/services/finance-income.service.ts`) | branch **sales** (POS, excluding staff; optionally net of expenses) | n/a | posted to the general ledger |

The dashboard's balance is per window, and "last month" is that month alone, not
cumulative (`finance-monthly-dashboard.service.ts:139-151`).

### 1.5 Sales, ledgers, roles, tests

- Actual sales: `daily_sale_figures()` (BL:4398) = Σ POS `orders.grand_total`,
  excluding staff and cancelled, per branch per business day (02:00–02:00
  Karachi). **Sales have no link to a demand**, and a branch can receive
  several demands a day.
- Ledgers: `ledger_entries` is one book-wide running balance (advisory-locked,
  BL:6084), where `branch_id` is only a tag. **There is no per-branch account
  ledger and no branch opening balance.** The branch-share payable
  (`finance-branch-share.service.ts:83`) is money owed *to* the branch, all-time.
- Roles: super_admin, branch_manager, production_user, finance_admin,
  finance_manager, accountant, finance_auditor
  (`backend/src/shared/types/user.types.ts:27`). Finance permissions are at
  `backend/src/shared/types/finance.types.ts:66-100`.
- Tests: backend uses `node --import tsx --test` with pglite integration
  harnesses (`backend/src/db/testing.ts`), and frontend uses `vitest run`.
  `backend/src/services/__tests__/daily-sale-company-share.test.ts` compares a
  2-key object against a function that returns 4 keys. It looks like an
  existing failure (not yet run).

---

## 2. Spec vs today — discrepancies

| # | Spec | Today | Effect of adopting the spec |
|---|---|---|---|
| D1 | Share = (Delivered − Returns − Discount) × % | Share = Delivered × %, then Returns and Discount deducted at full value | Different money. For example 45,000 / 1,200 / 1,000 at 80% gives **34,240** under the spec and **33,800** today. The gap is (returns + discount) × (100 − %). |
| D2 | Historical prices | Current price | Past slips stop changing on reprint. Amounts differ from today's wherever prices moved. |
| D3 | % snapshotted per demand | Live % | Same as D2, for the percentage. |
| D4 | Closing = Previous + Share − Received, carried forward, negative allowed | No carry-forward; Remaining floored at 0 | New concept: an outstanding balance per branch. |
| D5 | Received = confirmed settlement | Cash transfers shown, never deducted; rest-of-day rule repeats deposits | Each deposit must be counted exactly once in a ledger. |
| D6 | Opening balance per branch | None | Needs a starting figure per branch at go-live. |
| D7 | Actual Sales per demand | Sales exist per branch per day only | Can be shown per business day, not per demand, without inventing an allocation. |
| D8 | Idempotent, transactional postings | Opt-in idempotency; order header and items not atomic | Ledger posting must be idempotent by source. |
| D9 | — | `verified` skipped in the slip chain | Should be fixed whichever way D1–D6 go. |

The spec's own sample says "Rs. 42,200 is a supplied settlement, not 80% of
sales". That matches today's separation: received money comes from cash
transfers, while share on sales comes from income approvals.

---

## 3. Proposed minimum design (pending decisions)

1. **One append-only branch account ledger** (new table, one Prisma
   migration): `branch_id`, `entry_type` (opening, demand_share, return,
   discount, payment, adjustment, reversal), `amount` (+ owed to company,
   − credit), `effective_at`, `source_type` + `source_id` with **UNIQUE
   (source_type, source_id, entry_type)** for idempotency, snapshots
   (`unit_price`s, `company_share_pct`), and created_by/at.
2. **Running balance derived, not stored**: Previous / Closing for each demand =
   ordered SUM over the branch's entries up to that point. Concurrent postings
   then cannot overwrite each other, and a backdated correction (a reversal plus
   a new entry) re-flows every later balance automatically, with history kept.
3. **Postings hooked into existing workflows**, in the same DB transaction as
   the status change: demand share at the chosen delivery step, accepted
   return, approved discount, approved cash transfer. A backfill script runs
   from the go-live date forward, as a rehearsal by default.
4. **Demand Record page** (frontend, finance roles plus a read-only branch
   view of its own records): list, filters, search, sort, pagination,
   details with source transactions, export, mobile cards.
5. **Slip and Collections export** read the same ledger, so every report
   agrees.
6. Tests for spec cases 1–10 on pglite, plus the existing suites.

Historical slips before go-live stay exactly as they are today.

## 4. Decisions (taken by the owner, 2026-10-24)

- **D1 share base:** the spec's rule, Company Share = G. Total × %.
- **D2/D3 snapshots:** prices and % are frozen from go-live.
- **D5 received:** approved cash transfers, each counted once.
- **D6 opening:** Finance enters each branch's opening balance.

## 5. What was built (backend)

The design in section 3 changed in one respect: the balance is **derived**
from the source records on every read, not posted to a ledger table. That is
the "equivalent transactional design" the spec allows, and it is simpler to
keep correct. No stored balance means no stale read and no lost update. Each
source row is counted once by construction, and a backdated correction
carries through every later balance by itself. Only Finance's own entries are
written, append-only.

**Migration** `prisma/migrations/20261024000001_branch_account_ledger`. It is
additive and changes no existing row.

- `production_order_share_snapshots`: the % frozen per demand. A trigger
  writes it as the demand leaves `pending`. It is append-only.
- `app.resolve_company_share_pct(branch)`: the same resolution as the slip.
- `finance_settings.account_ledger_start`: the go-live date (NULL = off).
- `branch_account_adjustments`: opening and adjustment entries, plus reversals.
  It is append-only. `request_id` is UNIQUE for idempotency, and a reversal
  must exactly cancel one live entry (trigger).
- Indexes for the per-branch time lookups.

**Rules** (`src/shared/utils/branch-account.ts`, mirrored in the frontend):

    Delivered       = Σ approved_qty × (line unit_price, else price on the demand's date)
    Returns         = Σ accepted qty × price on the return's own date (Return Summary rule)
    G. Total        = Delivered − Returns − Discount
    Company Share   = G. Total × frozen % ÷ 100
    Share on Sales  = POS sales × % (shown, never used as received)
    Closing         = Previous + Company Share + Adjustments − Received   (negative = credit)

Placement: each record goes in the row of the branch's latest demand
submitted before it, the slip's own window. The exception is a discount, which
goes to the demand it was claimed against. A row runs until the next demand,
so one period's closing balance equals the next period's opening balance.
`verified` demands are counted (D9 does not apply here).

**API** `/api/finance/branch-account` (`src/routes/finance-branch-account.routes.ts`):

| Method | Path | Permission |
|---|---|---|
| GET | `/settings` | view |
| PUT | `/settings` `{startDate}` | configure (finance_admin) |
| GET | `/?branchId&from&to&search&sortDir&page&pageSize` | view |
| GET | `/detail?branchId&orderId` (no orderId: opening row) | view |
| GET | `/adjustments?branchId` | view |
| POST | `/adjustments` `{requestId, branchId, kind, amount, businessDate?, reason}` | approve |
| POST | `/adjustments/:id/reverse` `{requestId, reason}` | approve |

Every write is recorded in `finance_audit_logs` (entity `branch_account`).

**Not changed:** the delivery slip and the finance dashboard still bill as
described in section 1. Switching them to these rules changes what riders
collect, so it is a separate step for the owner to approve.

**Collections export (Production Orders → Export, and the mobile admin
export), switched by the owner on 2026-10-24:** once the Demand Record is on,
`report=collections` is built from `getDemandRecordPeriod` — the same rows as
the page. Sheets: Collections, By Branch, one tab per branch. Since the
owner's layout of 2026-10-24 (later that day) the columns are the page's:
Date | Demand No. | Branch | Delivered | Return | Discount | G. Total |
Co. Share | Share % | Received | Previous | Closing | Closing Status
(OUTSTANDING > 0, SETTLED = 0, CREDIT < 0), rows by date then demand number,
and a bold TOTAL of the six activity columns. Cells stay numeric; Excel
formats show `01 Oct 2026`, `Rs. 45,000`, `-Rs. 2,000`, and a dash for a zero
Return or Discount. Adjustments have no column (none were posted when the
layout was set); a row with one still carries it in Closing, as the page does.
Actual Sales is left out, because production users can download this export and
do not see sales. Before go-live it keeps the slip figures and says so in its
last line. Tests: `collections-export.integration.test.ts`.

**Tests**

- `src/services/__tests__/branch-account.test.ts`: spec cases 1–5 plus
  rounding and totals (9 pass).
- `src/services/__tests__/branch-account.integration.test.ts`: real baseline
  tables, the migration and the routes, covering spec cases 6–10, placement of
  every record kind, View Details, period carry-over and validation (11 pass).
- Real Postgres 18, with the full baseline and every migration applied:
  10 concurrent openings for one branch gave 1 accepted and 9 refused, and the
  same request sent 10 times at once gave 1 posting and 9 replays.
- Existing suites: services 597/600, db 21/21 and routes 4/4 pass. The 3
  failures are the pre-existing `daily-sale-company-share.test.ts` mismatch
  noted in section 1.5.

## 6. What was built (frontend)

Finance → **Demand Record** (`/finance-demand-record`,
`frontend/src/components/finance/DemandRecordPage.tsx`):

- **Before go-live:** an explanation, and a "Switch on" control for the go-live
  day (finance_admin).
- **Table:** Date, Demand Number, Branch, Delivered, Actual Sales, Return,
  Discount, G. Total, Share %, Company Share, Share Received, Adjustments,
  Previous Balance, Closing Balance. A negative closing is shown as a
  "credit", zero as "settled", and the open last row is marked. Phones show
  each row as a card.
- **Controls:** branch, from/to and search filters; date sorting both ways;
  pagination; loading, empty, error and retry states.
- **Period totals:** opening and closing are taken once per branch, with the
  identity Opening + Share + Adjustments − Received = Closing printed under
  them. A balance-by-branch list follows.
- **Export:** CSV of every row in the filter, plus totals.
- **View Details:** the calculation, and every record behind each figure:
  delivered lines with their price source, returns, discounts, transfers with
  their numbers, Finance entries, and POS sales with the share on them.
- **Opening & adjustments:** list, new entry (with a request id per form, so a
  retry posts once) and reverse.

Money uses the Finance module's two-decimal format (`Rs. 34,240.00`), like
every other Finance screen.

## 7. Not done / follow-ups

- **Slip and dashboard** still use today's rules (the Collections export was
  switched, see section 5). Moving
  them to the Demand Record's rules changes what riders collect, so it needs
  the owner's go-ahead.
- **Spec fields not shown:** Created/Updated By/At per demand and a single
  "settlement reference" are not columns. The source records' own references
  (transfer and voucher numbers, who entered an adjustment) are in View
  Details.
- **Demand create is not atomic** (header and items are separate calls), and
  the web app does not send an Idempotency-Key. This is unchanged. The Demand
  Record cannot double-count either way.
- **`verified` orders** are still skipped by the slip's previous-order lookup
  (D9).
- **`daily-sale-company-share.test.ts`** still fails as it did before this
  work.
