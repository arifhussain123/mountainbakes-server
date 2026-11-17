-- Refundable Loan Return — an Expense head so a Paid Payment in the loan
-- register can be classified as the return of a refundable loan rather than
-- lumped under Miscellaneous.
--
-- A Paid Payment (loan register) always classifies under an Expense head — the
-- head only labels the entry, it never decides the side (migration
-- 20261031000001_finance_loans). This is an ordinary, non-system head: it can be
-- renamed, hidden or reactivated from the Ledger Heads page like any other.
--
-- `on conflict (code) do nothing` so the migration is a no-op on a book that
-- already carries the head.
insert into public.ledger_heads (code, name, type, group_name, is_system, sort_order)
values ('EXP-REFUNDABLE-LOAN-RETURN', 'Refundable Loan Return', 'expense', 'Loans', false, 185)
on conflict (code) do nothing;
