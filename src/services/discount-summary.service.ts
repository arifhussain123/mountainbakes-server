import { getPrisma } from '../db';
import {
  buildDiscountSummary,
  monthToDateRange,
  type DiscountSummaryRow,
  type MonthlyDiscountSummary,
} from '../shared';

/**
 * The month-to-date Branch Discount summary, summed in Postgres.
 *
 * One aggregate over `branch_discounts` grouped by branch × status — never rows
 * downloaded and added up here (a busy month is past the API's row cap, and
 * PostgREST-style aggregates are off). No join, so no row can be multiplied.
 *
 * The window is the same one the returns summary uses (`monthToDateRange`):
 * `business_date` is a date column, so `between from and to` is the whole of
 * both days — every claim raised today is in, whatever time it was saved, and
 * nothing from the 1st of next month can reach in.
 *
 * Branch scope is decided by the caller from the authenticated user, never by
 * this module: `branchId` null means every branch, a uuid means that branch
 * only. See `shared/utils/discount-summary.ts` for what each figure means.
 */

const SUMMARY_SQL = `
  select d.branch_id::text                       as "branchId",
         coalesce(max(b.name), max(d.branch_name), 'Unknown branch') as "branchName",
         d.status::text                          as "status",
         count(*)::int                           as "count",
         coalesce(sum(d.amount), 0)::float8      as "amount"
    from public.branch_discounts d
    left join public.branches b on b.id = d.branch_id
   where d.business_date between $1::date and $2::date
     and ($3::uuid is null or d.branch_id = $3::uuid)
   group by d.branch_id, d.status
`;

/** Every active branch for the all-branch view; just the one, active or not, for a single branch. */
const BRANCHES_SQL = `
  select b.id::text as "id", b.name as "name"
    from public.branches b
   where ($1::uuid is null and b.is_active) or b.id = $1::uuid
   order by b.name
`;

export async function getMonthlyDiscountSummary(
  { branchId, now = new Date() }: { branchId: string | null; now?: Date },
): Promise<MonthlyDiscountSummary> {
  const range = monthToDateRange(now);
  const prisma = getPrisma();
  const [rows, branches] = await Promise.all([
    prisma.$queryRawUnsafe<DiscountSummaryRow[]>(SUMMARY_SQL, range.from, range.to, branchId),
    prisma.$queryRawUnsafe<{ id: string; name: string }[]>(BRANCHES_SQL, branchId),
  ]);
  return buildDiscountSummary(rows, branches, range);
}
