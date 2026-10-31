import { getPrisma } from '../db';
import {
  buildCashTransferSummary,
  monthToDateRange,
  type CashTransferSummaryRow,
  type MonthlyCashTransferSummary,
} from '../shared';

/**
 * The month-to-date Cash Transfer summary for one branch, summed in Postgres.
 *
 * One aggregate over `cash_transfers` grouped by status — never the branch's
 * rows downloaded and added up here, and never the table's current page. No
 * join, so no row can be multiplied.
 *
 * The window is the one the returns and discount summaries use
 * (`monthToDateRange`) unless the caller passes the page's Date filter as
 * `range` (see utils/summaryRange.ts): `business_date` is a date column, so `between from and
 * to` is the whole of both days. A transfer saved at 00:30 on the 1st carries
 * the previous business date (the day rolls over at 02:00), so it stays in the
 * month it was traded in — the same day the table shows it under.
 *
 * Soft-deleted rows are out, as they are out of every list. The branch is
 * decided by the route from the authenticated user, never by this module. See
 * `shared/utils/cash-transfer-summary.ts` for what each figure means.
 */

const SUMMARY_SQL = `
  select t.status::text                                          as "status",
         count(*)::int                                           as "transfers",
         coalesce(sum(t.amount), 0)::float8                      as "amount",
         (count(*) filter (where t.amount > 0))::int             as "amountCount",
         coalesce(sum(t.cash_amount), 0)::float8                 as "cash",
         (count(*) filter (where t.cash_amount > 0))::int        as "cashCount",
         coalesce(sum(t.easypaisa_amount), 0)::float8            as "easypaisa",
         (count(*) filter (where t.easypaisa_amount > 0))::int   as "easypaisaCount",
         coalesce(sum(t.bank_amount), 0)::float8                 as "bank",
         (count(*) filter (where t.bank_amount > 0))::int        as "bankCount",
         coalesce(sum(t.fuel_charges), 0)::float8                as "fuel",
         (count(*) filter (where t.fuel_charges > 0))::int       as "fuelCount"
    from public.cash_transfers t
   where t.branch_id = $3::uuid
     and t.business_date between $1::date and $2::date
     and t.deleted_at is null
   group by t.status
`;

export async function getMonthlyCashTransferSummary(
  { branchId, now = new Date(), range = monthToDateRange(now) }: { branchId: string; now?: Date; range?: { from: string; to: string } },
): Promise<MonthlyCashTransferSummary> {
  const rows = await getPrisma().$queryRawUnsafe<CashTransferSummaryRow[]>(SUMMARY_SQL, range.from, range.to, branchId);
  return buildCashTransferSummary(rows, range, branchId);
}
