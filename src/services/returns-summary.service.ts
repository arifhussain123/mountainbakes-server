import { getPrisma } from '../db';
import {
  buildReturnsSummary,
  monthToDateRange,
  type MonthlyReturnsSummary,
  type ReturnsSummaryRow,
} from '../shared';

/**
 * The month-to-date Product Returns summary, summed in Postgres.
 *
 * One aggregate over `production_returns` grouped by branch × status — never
 * rows downloaded and added up here (a busy month is past the API's row cap,
 * and PostgREST-style aggregates are off). Each return row is priced by a
 * scalar `limit 1` lookup, not a join, so no row can be multiplied by a
 * fan-out; `products` is joined on its primary key for the same reason.
 *
 * The unit price is the one in force on the return's `business_date`:
 *   1. the newest APPLIED price change (`status = 'active'`) effective on or
 *      before that date → its `new_price`;
 *   2. else the earliest applied change effective after it → its `old_price`
 *      (the price the product carried before its first change);
 *   3. else `products.price` — a product whose price has never changed.
 * `superseded` rows are scheduled changes that never took effect, and
 * `scheduled` ones haven't yet; neither ever priced anything. See
 * `shared/utils/returns-summary.ts` for what each figure means.
 *
 * Branch scope is decided by the caller from the authenticated user, never by
 * this function: `branchId` null means every branch (Production), a uuid means
 * that branch only.
 */

const SUMMARY_SQL = `
  select r.branch_id::text                                    as "branchId",
         max(r.branch_name)                                   as "branchName",
         r.status::text                                       as "status",
         count(*)::int                                        as "count",
         coalesce(sum(r.qty), 0)::float8                      as "qty",
         coalesce(sum(round(r.qty * px.unit_price, 2)), 0)::float8 as "amount",
         (count(*) filter (where px.unit_price is null))::int as "unpriced"
    from public.production_returns r
    left join public.products p on p.id = r.product_id
    cross join lateral (
      select coalesce(
        (select h.new_price from public.product_price_history h
          where h.product_id = r.product_id and h.status::text = 'active'
            and h.effective_date <= r.business_date
          order by h.effective_date desc, h.version_number desc
          limit 1),
        (select h.old_price from public.product_price_history h
          where h.product_id = r.product_id and h.status::text = 'active'
            and h.effective_date > r.business_date
          order by h.effective_date asc, h.version_number asc
          limit 1),
        p.price
      ) as unit_price
    ) px
   where r.business_date between $1::date and $2::date
     and ($3::uuid is null or r.branch_id = $3::uuid)
   group by r.branch_id, r.status
`;

/**
 * Production's view lists every active branch (so a branch with nothing
 * returned still shows, at zero); a single-branch view lists just that one,
 * active or not.
 */
const BRANCHES_SQL = `
  select b.id::text as "id", b.name as "name"
    from public.branches b
   where ($1::uuid is null and b.is_active) or b.id = $1::uuid
   order by b.name
`;

export async function getMonthlyReturnsSummary(
  { branchId, now = new Date() }: { branchId: string | null; now?: Date },
): Promise<MonthlyReturnsSummary> {
  const range = monthToDateRange(now);
  const prisma = getPrisma();
  const [rows, branches] = await Promise.all([
    prisma.$queryRawUnsafe<ReturnsSummaryRow[]>(SUMMARY_SQL, range.from, range.to, branchId),
    prisma.$queryRawUnsafe<{ id: string; name: string }[]>(BRANCHES_SQL, branchId),
  ]);
  return buildReturnsSummary(rows, branches, range);
}
