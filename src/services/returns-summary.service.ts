import { getPrisma } from '../db';
import {
  buildReturnMonthSummary,
  buildReturnsSummary,
  businessMonthRange,
  monthToDateRange,
  type MonthlyReturnsSummary,
  type ProductionReturnMonthSummary,
  type ReturnMonthSqlRow,
  type ReturnsSummaryRow,
} from '../shared';

/**
 * The month-to-date Product Returns summary, summed in Postgres — and the same
 * per-row price for the returns tables, so a row's amount and the summary it
 * rolls up into can never disagree.
 *
 * One aggregate over `production_returns` grouped by branch × status × product
 * — never rows downloaded and added up here (a busy month is past the API's row
 * cap, and PostgREST-style aggregates are off). Each return row is priced by a
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
 * `scheduled` ones haven't yet; neither ever priced anything. A return row has
 * no price column of its own, so this is its recorded price as far as the
 * database can state one. See `shared/utils/returns-summary.ts` for what each
 * figure means.
 *
 * Branch scope is decided by the caller from the authenticated user, never by
 * this module: `branchId` null means every branch (Production), a uuid means
 * that branch only.
 */

/** `px.unit_price` for the row aliased `r`, with `products` joined as `p`. */
const UNIT_PRICE_LATERAL = `
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
`;

// `business_date` is a date column, so `between from and to` is the whole of
// both days — every return recorded today is in, whatever time it was saved.
const SUMMARY_SQL = `
  select r.branch_id::text                                    as "branchId",
         max(r.branch_name)                                   as "branchName",
         r.status::text                                       as "status",
         r.product_id::text                                   as "productId",
         max(r.product_name)                                  as "productName",
         max(p.sku)                                           as "productCode",
         count(*)::int                                        as "count",
         coalesce(sum(r.qty), 0)::float8                      as "qty",
         coalesce(sum(round(r.qty * px.unit_price, 2)), 0)::float8 as "amount",
         (count(*) filter (where px.unit_price is null))::int as "unpriced"
    from public.production_returns r
    left join public.products p on p.id = r.product_id
    ${UNIT_PRICE_LATERAL}
   where r.business_date between $1::date and $2::date
     and ($3::uuid is null or r.branch_id = $3::uuid)
   group by r.branch_id, r.status, r.product_id
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

const ROW_PRICING_SQL = `
  select r.id::text                                     as "id",
         p.sku                                          as "productCode",
         px.unit_price::float8                          as "unitPrice",
         round(r.qty * px.unit_price, 2)::float8        as "amount"
    from public.production_returns r
    left join public.products p on p.id = r.product_id
    ${UNIT_PRICE_LATERAL}
   where r.id = any($1::uuid[])
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

// Return Summary: one whole business month, per branch × product × reason
// text, rejected returns left out (see shared/utils/return-month-summary.ts).
// The reason is grouped on its trimmed, lower-cased text here; sorting those
// texts into reason buckets is the shared builder's job, so the SQL stays a
// plain aggregate.
const MONTH_SQL = `
  select r.branch_id::text                                    as "branchId",
         max(coalesce(r.branch_name, b.name))                 as "branchName",
         r.product_id::text                                   as "productId",
         max(coalesce(p.name, r.product_name))                as "productName",
         lower(btrim(coalesce(r.reason, '')))                 as "reason",
         count(*)::int                                        as "count",
         coalesce(sum(r.qty), 0)::float8                      as "qty",
         coalesce(sum(round(r.qty * px.unit_price, 2)), 0)::float8 as "amount",
         (count(*) filter (where px.unit_price is null))::int as "unpriced"
    from public.production_returns r
    left join public.products p on p.id = r.product_id
    left join public.branches b on b.id = r.branch_id
    ${UNIT_PRICE_LATERAL}
   where r.business_date between $1::date and $2::date
     and r.status::text <> 'rejected'
   group by r.branch_id, r.product_id, lower(btrim(coalesce(r.reason, '')))
`;

/** Every branch's returns for one business month ('YYYY-MM'), consolidated. The caller validates `month`. */
export async function getReturnMonthSummary(
  { month, now = new Date() }: { month: string; now?: Date },
): Promise<ProductionReturnMonthSummary> {
  const range = businessMonthRange(month);
  const rows = await getPrisma().$queryRawUnsafe<ReturnMonthSqlRow[]>(MONTH_SQL, range.from, range.to);
  return buildReturnMonthSummary(rows, month, now);
}

export interface ReturnRowPricing {
  productCode: string | null;
  /** Rs. per unit on the return's business date; null when no price exists anywhere. */
  unitPrice: number | null;
  /** qty × unitPrice, rounded to the paisa; null exactly when unitPrice is. */
  amount: number | null;
}

/** The price, line amount and product code for a page of return rows — one query, however many rows. */
export async function priceReturnRows(ids: string[]): Promise<Map<string, ReturnRowPricing>> {
  if (ids.length === 0) return new Map();
  const rows = await getPrisma().$queryRawUnsafe<({ id: string } & ReturnRowPricing)[]>(ROW_PRICING_SQL, ids);
  return new Map(rows.map(({ id, ...pricing }) => [id, pricing]));
}

// Collections reconciliation: the returns behind the Return Summary for a date
// range, plus every accepted return a Collections slip in that export deducted,
// each with both prices and the delivery whose slip deducts it.
//
// That delivery is found exactly as getPreviousOrderBalance bills: a return
// falls in the window (previous delivery, next delivery], so the slip that
// deducts it is the one of the first DELIVERED order of its branch submitted
// at or after it (`closingOrderId`), billing the delivered order just before it
// (`billedDate`). Null `closingOrderId` means no later delivery yet — it has
// not been deducted anywhere. Done in SQL so the boundaries compare at full
// timestamp precision.
//
// $4/$5 are the first billed and last closing order of the export: accepted
// returns between their timestamps are the only ones its slips can hold.
const COLLECTIONS_RECONCILIATION_SQL = `
  select r.id::text                                           as "id",
         r.branch_id::text                                    as "branchId",
         coalesce(r.branch_name, b.name)                      as "branchName",
         r.status::text                                       as "status",
         to_char(r.business_date, 'YYYY-MM-DD')               as "businessDate",
         coalesce(round(r.qty * px.unit_price, 2), 0)::float8 as "summaryAmount",
         (r.qty * coalesce(p.price, 0))::float8               as "slipAmount",
         s.id::text                                           as "closingOrderId",
         to_char(pv.business_date, 'YYYY-MM-DD')              as "billedDate"
    from public.production_returns r
    left join public.products p on p.id = r.product_id
    left join public.branches b on b.id = r.branch_id
    ${UNIT_PRICE_LATERAL}
    left join lateral (
      select o.id from public.production_orders o
       where o.branch_id = r.branch_id
         and o.status::text in ('awaiting_verification', 'approved')
         and o.submitted_at >= r.created_at
       order by o.submitted_at asc limit 1
    ) s on true
    left join lateral (
      select o.business_date from public.production_orders o
       where o.branch_id = r.branch_id
         and o.status::text in ('awaiting_verification', 'approved')
         and o.submitted_at < r.created_at
       order by o.submitted_at desc limit 1
    ) pv on true
   where ($3::uuid is null or r.branch_id = $3::uuid)
     and ((r.business_date between $1::date and $2::date and r.status::text <> 'rejected')
          or (r.status::text = 'accepted'
              and r.created_at > (select o.submitted_at from public.production_orders o where o.id = $4::uuid)
              and r.created_at <= (select o.submitted_at from public.production_orders o where o.id = $5::uuid)))
`;

export interface CollectionsReturnRow {
  id: string;
  branchId: string;
  branchName: string | null;
  status: string;
  businessDate: string;
  /** Priced as the Return Summary prices it — on the return's own date; 0 when unpriced. */
  summaryAmount: number;
  /** Priced as the slip prices it — today's `products.price`. */
  slipAmount: number;
  closingOrderId: string | null;
  billedDate: string | null;
}

export async function getCollectionsReturnRows(params: {
  from: string;
  to: string;
  branchId: string | null;
  firstBilledOrderId: string | null;
  lastClosingOrderId: string | null;
}): Promise<CollectionsReturnRow[]> {
  return getPrisma().$queryRawUnsafe<CollectionsReturnRow[]>(
    COLLECTIONS_RECONCILIATION_SQL,
    params.from,
    params.to,
    params.branchId,
    params.firstBilledOrderId,
    params.lastClosingOrderId,
  );
}
