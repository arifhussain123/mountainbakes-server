# Finance approval workflow (Accountant → Finance Admin)

How a manual income or expense entry, and a branch cash deposit, moves from
the person who raises it to the person who approves it, and what the database
guarantees on the way. Shipped in migration
`20261028000001_finance_approval_workflow` (backend 4f291c5, frontend c940e4d).

## What existed before

| Concern | Where it lives |
|---|---|
| Roles | `financeCan()` in `src/shared/types/finance.types.ts`. `accountant` = view + create; `finance_manager` = + approve; `finance_admin` = + adjust, configure; `finance_auditor` = view. Super Admin views only unless `allowSuperAdminWrite`. |
| Income & Expense documents | table `finance_transactions` (`FTX-` numbers), service `src/services/finance-documents.service.ts`, routes `/api/finance/income/entries` in `src/routes/finance-income.routes.ts` |
| Statuses | enum `finance_doc_status`: `draft`, `pending_approval`, `approved`, `rejected`, `posted`, `locked` |
| Daily Ledger | table `ledger_entries`, written only by `public.post_finance_ledger_entry(...)` |
| PV / RV numbers | allocated inside `post_finance_ledger_entry` through `app.next_finance_number` (counters `finance_payment_voucher` → `PV-`, `finance_receipt_voucher` → `RV-`); `ledger_entries.voucher_no` is unique |
| Closed days | `finance_day_closings` — a closed date refuses new postings |
| Cash deposits | table `cash_transfers` (`CT-` numbers), raised by a branch (`/api/cash-transfers`), approved/rejected by finance (`/api/finance/cash-transfers`); approval posts an `RV-` |

Gaps found: no submitter/rejecter columns (a rejection overwrote
`approved_by`), no revision count, no history, approval and ledger posting were
two separate calls (a failure between them left an "approved" entry with no
ledger row), and a rejected deposit could not be corrected — only raised again
as a new `CT-`.

## What changed

### Database (one migration, additive, no data removed)

- `finance_transactions`: `submitted_by/_name/_at`, `rejected_by/_name/_at`,
  `updated_by/_name`, `approval_note`, `revision` (default 1). Existing
  rejected rows had their `approved_*` moved to `rejected_*`; existing
  submitted rows got `submitted_* = created_*`.
- Unique index on `finance_transactions.ledger_entry_id` — one entry, one
  posting.
- `cash_transfers`: `revision`, `resubmitted_at/_by/_by_name`.
- `finance_document_events` — append-only history (created, edited, submitted,
  rejected, resubmitted, approved, deleted) with before/after values, actor,
  actor role, remarks, revision and voucher. A trigger refuses UPDATE/DELETE.
  Rows are written by triggers on the two document tables, so every screen
  and every API path is recorded the same way.
- `app.finance_transaction_guard` — legal status transitions only; a rejection
  needs a reason; `posted` needs a ledger entry; `revision` goes up on
  rejected → pending.
- `public.approve_finance_transaction(p_id, p_actor_id, p_actor_name, p_note)`
  — locks the row (`FOR UPDATE`), checks it is `pending_approval`, refuses a
  closed day, calls `post_finance_ledger_entry` (which issues the PV/RV) and
  marks the entry `posted`, all in one transaction. Any failure rolls back
  the voucher number too.
- `public.resubmit_cash_transfer(...)` — corrects a rejected deposit's figures
  and note and returns the same `CT-` to `pending`; branch and date are not
  parameters, so they cannot change.

### API

| Endpoint | Who | What |
|---|---|---|
| `POST /api/finance/income/entries` | create | saves a draft, or submits at once |
| `PUT /api/finance/income/entries/:id` | create | edits a draft or rejected entry; `resubmit: true` sends a correction back |
| `POST …/:id/submit` | create | re-validates, stamps the submitter, → `pending_approval` |
| `POST …/:id/approve` | approve | `approve_finance_transaction` (409 if already decided or day closed) |
| `POST …/:id/reject` | approve | remarks required (min 3 chars), stamps the rejecter |
| `GET …/:id`, `GET …/:id/history`, `GET …/submitters` | view | single entry with voucher, its history, the queue's submitter filter |
| `GET /api/finance/income/entries` | view | list now carries `voucherNo` for posted rows |
| `POST /api/cash-transfers/:id/resubmit` | the deposit's branch | correct and resubmit a rejected deposit (idempotent by `clientOperationId`) |
| `GET /api/cash-transfers/:id/history`, `GET /api/finance/cash-transfers/:id/history` | branch / finance | deposit history |

Roles always come from the JWT; the client never supplies a status, voucher or
role.

### Screens

- **Income & Expense Entries** (accountant): View is the first column; Entry No
  shows the PV/RV once issued; Created By column; Status shows Finance Admin's
  remarks on rejected rows and the submission time on pending ones. View opens
  the entry with Edit / Submit for Approval (draft), Edit and Correct /
  Resubmit for Approval (rejected, remarks on top), the approval and voucher
  (posted), and the full history.
- **Pending Approvals** (`/finance-approvals`): the queue, oldest submission
  first, filterable by date, type, branch, submitter and status; View → Approve
  (with optional note) or Reject (remarks required).
- **Branch → Cash Transfer Details**: a rejected deposit shows Finance's remarks
  and "Correct & resubmit"; branch and date are shown, not editable.

## PV / RV behaviour

Numbers are issued only inside `approve_finance_transaction` (entries) or the
deposit approval, never on save, submit or reject. Income → `RV-`, expense →
`PV-`. The counter row is locked for the allocation and `voucher_no` is unique,
so concurrent approvals cannot share a number; a refused or failed approval
spends none.

## Tests

`src/services/__tests__/finance-approval-workflow.integration.test.ts`
(pglite, 19 tests): drafts unposted and unnumbered; submit; pending edits
refused; reject without remarks refused; correct + resubmit keeps the id and
bumps the revision; approval posts once with the corrected figures, and the
list and history show its voucher; retry posts nothing and spends no number; a
posting the ledger refuses rolls back with no number spent; a head closed after
submission fails cleanly; accountant, auditor and branch cannot approve;
cross-branch deposit access refused; deposit correction keeps branch
and date; history cannot be edited. Concurrency (two simultaneous approvals,
one wins) was checked against a real PostgreSQL 18.

## Known limits

- Salaries and partner expenses still approve and post in two steps.
- A resubmitted deposit is not re-counted against the branch's daily limit.
- The mobile app's finance screens do not show the new actions yet.
- Editing a posted entry is not possible; corrections go through a reversal on
  the Daily Ledger, as before.
