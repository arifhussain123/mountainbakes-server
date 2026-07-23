-- 29: shop expenses gain a real `category` column.
--
-- `expenses` (migration 03) never had one, so BOTH closing paths faked it by
-- grouping on `description` (closing-report.service.ts, daily-closing.service.ts
-- — the latter says so in a comment). Every distinct free-text description became
-- its own "category", which made the shop expense breakdown noise.
--
-- Shape mirrors `production_expenses.category` exactly: plain `text not null`,
-- no enum, no check, no FK. The vocabulary lives in the app
-- (`shared/schemas/expense.schemas.ts` → EXPENSE_CATEGORIES) so it can change
-- without a migration and without invalidating historical rows.
--
-- No index: both closing services filter by branch_id / business_date (already
-- covered by expenses_branch_date_idx / expenses_date_idx) and group in JS, so
-- an index on category would be dead weight — same as production_expenses.

-- The default is only a backfill device for rows that predate this column. It is
-- non-volatile, so ADD COLUMN is a metadata-only change and never rewrites the
-- table. It is dropped immediately: every writer supplies an explicit category
-- via CreateExpenseSchema, and a missing one should fail loudly (23502) rather
-- than silently accumulate as 'Other'.
alter table expenses
  add column category text not null default 'Other';

alter table expenses
  alter column category drop default;
