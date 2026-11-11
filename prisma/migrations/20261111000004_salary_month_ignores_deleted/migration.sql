-- A deleted payslip no longer blocks a new one for the same employee and month
-- (owner, 2026-11-11).
--
-- salary_payments_employee_month_idx makes paying the same person twice for one
-- month impossible, but it skipped only rejected payslips. A payslip deleted
-- through a Finance Query is a soft delete (deleted_at), so it still held the
-- month: re-entering Abdul Jabbar's 2026-09 salary after deleting it failed with
-- "already has a salary record for 2026-09". Deleted payslips are now skipped
-- the same way rejected ones are; a live payslip still blocks a second one.

drop index public.salary_payments_employee_month_idx;

create unique index salary_payments_employee_month_idx
  on public.salary_payments (employee_id, salary_month)
  where status <> 'rejected'::public.finance_doc_status and deleted_at is null;
