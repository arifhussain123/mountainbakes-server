import { getPrisma } from '../db';
import {
  LOW_STOCK_THRESHOLD,
  buildBranchSummary,
  buildCurrentStock,
  buildReceivedDemand,
  buildRepairedStock,
  buildReturnStock,
  dashboardWindow,
  seriesBucket,
  type BranchSparkRow,
  type BranchSummarySection,
  type BranchTotalsRow,
  type CurrentStockSection,
  type CurrentStockSqlRow,
  type DashboardBucket,
  type DashboardPeriod,
  type DemandSeriesRow,
  type DemandTotalsRow,
  type ProductUnits,
  type ReceivedDemandSection,
  type RepairedSeriesRow,
  type RepairedStockSection,
  type RepairedTotalsRow,
  type ReturnBranchProductRow,
  type ReturnReasonRow,
  type ReturnSeriesRow,
  type ReturnStockSection,
  type ReturnTotalsRow,
} from '../shared';

/**
 * The Production Dashboard's sections, summed in Postgres. Each section is a
 * handful of GROUP BY queries over its own window — never rows downloaded and
 * added up here: a month of stock movements is already past the API's row cap
 * (see `preparedTotals`, which exists because of exactly that).
 *
 * What every figure means is written once, in `shared/utils/production-dashboard.ts`.
 *
 * Every period statement opens with the same `args` row, so each of the six
 * parameters is typed once and every one is used, whichever the statement
 * needs:
 *   from_d, to_d, prev_from, prev_to   business dates, inclusive
 *   branch                             uuid, or null for every branch
 *   bucket                             'hour' | 'day' | 'week'
 * `cur` is `business_date >= from_d`: the previous window always ends before
 * the current one starts.
 */

const ARGS = `
  args as (
    select $1::date as from_d, $2::date as to_d, $3::date as prev_from, $4::date as prev_to,
           $5::uuid as branch, $6::text as bucket
  )`;

/** A series bucket key for a row with a business date and a timestamp, as `shared` names them. */
const bucketSql = (dateCol: string, tsCol: string) => `
  case a.bucket
    when 'hour' then to_char(${tsCol} at time zone 'Asia/Karachi', 'YYYY-MM-DD"T"HH24')
    when 'week' then to_char(date_trunc('week', ${dateCol})::date, 'YYYY-MM-DD')
    else to_char(${dateCol}, 'YYYY-MM-DD')
  end`;

const IN_EITHER_WINDOW = (col: string) => `(${col} between a.from_d and a.to_d or ${col} between a.prev_from and a.prev_to)`;
const IN_CURRENT_WINDOW = (col: string) => `${col} between a.from_d and a.to_d`;
const IN_BRANCH = (col: string) => `(a.branch is null or ${col} = a.branch)`;

// ─── 1. Received Demand ──────────────────────────────────────────────────────

const DEMAND_TOTALS_SQL = `
  with ${ARGS}
  select (o.business_date >= a.from_d)                as "cur",
         o.status::text                               as "status",
         count(distinct o.id)::int                    as "orders",
         coalesce(sum(i.qty), 0)::float8              as "units"
    from public.production_orders o
    left join public.production_order_items i on i.production_order_id = o.id
    cross join args a
   where ${IN_EITHER_WINDOW('o.business_date')}
     and o.status <> 'cancelled'
     and ${IN_BRANCH('o.branch_id')}
   group by 1, 2
`;

const DEMAND_SERIES_SQL = `
  with ${ARGS}
  select ${bucketSql('o.business_date', 'o.submitted_at')} as "bucket",
         o.status::text                               as "status",
         count(distinct o.id)::int                    as "orders",
         coalesce(sum(i.qty), 0)::float8              as "units"
    from public.production_orders o
    left join public.production_order_items i on i.production_order_id = o.id
    cross join args a
   where ${IN_CURRENT_WINDOW('o.business_date')}
     and o.status <> 'cancelled'
     and ${IN_BRANCH('o.branch_id')}
   group by 1, 2
`;

// Grouped by product_id alone, as migration 112 does: a deleted product's
// lines (product_id null) collapse into one entry, not one per name snapshot.
const DEMAND_TOP_PRODUCTS_SQL = `
  with ${ARGS}
  select i.product_id::text                           as "productId",
         max(i.product_name)                          as "productName",
         sum(i.qty)::float8                           as "units"
    from public.production_orders o
    join public.production_order_items i on i.production_order_id = o.id
    cross join args a
   where ${IN_CURRENT_WINDOW('o.business_date')}
     and o.status <> 'cancelled'
     and ${IN_BRANCH('o.branch_id')}
   group by i.product_id
   order by 3 desc, 2
   limit 5
`;

// ─── 2. Branch-wise ──────────────────────────────────────────────────────────

// Every active branch, whether or not it asked for anything — an idle branch is
// part of the answer. Demand and delivered come from the same order lines, so
// fulfilment can never compare two different sets of orders.
const BRANCH_TOTALS_SQL = `
  with ${ARGS},
  lines as (
    select o.branch_id, (o.business_date >= a.from_d) as cur, i.qty,
           case when o.status in ('verified', 'approved') then coalesce(i.approved_qty, 0) else 0 end as delivered
      from public.production_orders o
      join public.production_order_items i on i.production_order_id = o.id
      cross join args a
     where ${IN_EITHER_WINDOW('o.business_date')}
       and o.status <> 'cancelled'
  ),
  demand as (
    select branch_id,
           coalesce(sum(qty) filter (where cur), 0)             as demanded,
           coalesce(sum(delivered) filter (where cur), 0)       as delivered,
           coalesce(sum(qty) filter (where not cur), 0)         as prev_demanded,
           coalesce(sum(delivered) filter (where not cur), 0)   as prev_delivered
      from lines group by branch_id
  ),
  returned as (
    select branch_id, sum(qty) as returned
      from public.production_returns
      cross join args a
     where status = 'accepted' and ${IN_CURRENT_WINDOW('business_date')}
     group by branch_id
  ),
  last_sub as (
    select branch_id, max(submitted_at) as at
      from public.production_orders
     where status <> 'cancelled'
     group by branch_id
  )
  select b.id::text                                   as "branchId",
         b.name                                       as "branchName",
         -- An ISO string made here, in UTC: a bare timestamptz is rendered in the
         -- session's time zone and the driver may drop the offset on the way out.
         to_char(ls.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastSubmittedAt",
         coalesce(d.demanded, 0)::float8              as "demanded",
         coalesce(d.delivered, 0)::float8             as "delivered",
         coalesce(r.returned, 0)::float8              as "returned",
         coalesce(d.prev_demanded, 0)::float8         as "prevDemanded",
         coalesce(d.prev_delivered, 0)::float8        as "prevDelivered"
    from public.branches b
    left join demand d   on d.branch_id = b.id
    left join returned r on r.branch_id = b.id
    left join last_sub ls on ls.branch_id = b.id
   where b.is_active
   order by b.name
`;

const BRANCH_SPARK_SQL = `
  with ${ARGS}
  select o.branch_id::text                            as "branchId",
         ${bucketSql('o.business_date', 'o.submitted_at')} as "bucket",
         coalesce(sum(i.qty), 0)::float8              as "units"
    from public.production_orders o
    join public.production_order_items i on i.production_order_id = o.id
    cross join args a
   where ${IN_CURRENT_WINDOW('o.business_date')}
     and o.status <> 'cancelled'
   group by 1, 2
`;

// ─── 3. Repaired Stock ───────────────────────────────────────────────────────

// `disposition::text` rather than the enum literal, so this reads the same on a
// database that has not yet been given the 'repaired' value: it is simply zero.
const REPAIRED_TOTALS_SQL = `
  with ${ARGS},
  r as (
    select (business_date >= a.from_d) as cur, qty, disposition::text = 'repaired' as repaired
      from public.production_returns
      cross join args a
     where status = 'accepted' and ${IN_EITHER_WINDOW('business_date')}
       and ${IN_BRANCH('branch_id')}
  ),
  moved as (
    -- Return Stock is one pool with no branch, and a transfer out of it records
    -- none, so this is company-wide whatever the branch filter (the section says so).
    select (business_date >= a.from_d) as cur, abs(delta) as qty
      from public.return_stock_history
      cross join args a
     where type = 'transfer_out' and ${IN_EITHER_WINDOW('business_date')}
  ),
  sides as (select true as cur union all select false)
  select s.cur                                                                      as "cur",
         coalesce((select sum(qty) from r where r.cur = s.cur), 0)::float8          as "returned",
         coalesce((select sum(qty) from r where r.cur = s.cur and r.repaired), 0)::float8 as "repaired",
         coalesce((select sum(qty) from moved m where m.cur = s.cur), 0)::float8    as "backToStock"
    from sides s
`;

const REPAIRED_SERIES_SQL = `
  with ${ARGS}
  select ${bucketSql('business_date', 'created_at')}  as "bucket",
         sum(qty)::float8                             as "returned",
         coalesce(sum(qty) filter (where disposition::text = 'repaired'), 0)::float8 as "repaired"
    from public.production_returns
    cross join args a
   where status = 'accepted' and ${IN_CURRENT_WINDOW('business_date')}
     and ${IN_BRANCH('branch_id')}
   group by 1
`;

const REPAIRED_TOP_PRODUCTS_SQL = `
  with ${ARGS}
  select product_id::text                             as "productId",
         max(product_name)                            as "productName",
         sum(qty)::float8                             as "units"
    from public.production_returns
    cross join args a
   where status = 'accepted' and disposition::text = 'repaired'
     and ${IN_CURRENT_WINDOW('business_date')}
     and ${IN_BRANCH('branch_id')}
   group by product_id
   order by 3 desc, 2
   limit 10
`;

// ─── 4. Return Stock ─────────────────────────────────────────────────────────

const RETURN_TOTALS_SQL = `
  with ${ARGS},
  ret as (
    select (business_date >= a.from_d) as cur, qty
      from public.production_returns
      cross join args a
     where status = 'accepted' and ${IN_EITHER_WINDOW('business_date')}
       and ${IN_BRANCH('branch_id')}
  ),
  del as (
    select (o.business_date >= a.from_d) as cur, coalesce(i.approved_qty, 0) as qty
      from public.production_orders o
      join public.production_order_items i on i.production_order_id = o.id
      cross join args a
     where o.status in ('verified', 'approved') and ${IN_EITHER_WINDOW('o.business_date')}
       and ${IN_BRANCH('o.branch_id')}
  ),
  sides as (select true as cur union all select false)
  select s.cur                                                                   as "cur",
         coalesce((select sum(qty) from ret where ret.cur = s.cur), 0)::float8   as "returned",
         coalesce((select sum(qty) from del where del.cur = s.cur), 0)::float8   as "delivered"
    from sides s
`;

const RETURN_SERIES_SQL = `
  with ${ARGS}
  select ${bucketSql('business_date', 'created_at')}  as "bucket",
         sum(qty)::float8                             as "returned"
    from public.production_returns
    cross join args a
   where status = 'accepted' and ${IN_CURRENT_WINDOW('business_date')}
     and ${IN_BRANCH('branch_id')}
   group by 1
`;

// Every branch in scope × product. A branch with nothing returned still comes
// back, as one row with a null product, so it is listed at zero.
const RETURN_CELLS_SQL = `
  with ${ARGS}
  select b.id::text                                   as "branchId",
         b.name                                       as "branchName",
         r.product_id::text                           as "productId",
         max(r.product_name)                          as "productName",
         coalesce(sum(r.qty), 0)::float8              as "units"
    from public.branches b
    cross join args a
    left join public.production_returns r
      on r.branch_id = b.id and r.status = 'accepted' and ${IN_CURRENT_WINDOW('r.business_date')}
   where ((a.branch is null and b.is_active) or b.id = a.branch)
   group by b.id, b.name, r.product_id
`;

// Grouped by the reason text in SQL — a few dozen distinct spellings, not rows;
// shared/utils/production-dashboard.ts sorts them into buckets by keyword.
const RETURN_REASONS_SQL = `
  with ${ARGS}
  select nullif(lower(btrim(reason)), '')             as "reason",
         sum(qty)::float8                             as "units"
    from public.production_returns
    cross join args a
   where status = 'accepted' and ${IN_CURRENT_WINDOW('business_date')}
     and ${IN_BRANCH('branch_id')}
   group by 1
`;

const RETURN_ON_HAND_SQL = `select coalesce(sum(balance), 0)::float8 as "onHand" from public.return_stock`;

// ─── 5. Current Stock ────────────────────────────────────────────────────────

// Production stock is AVAILABLE, not the raw pool balance — the same SQL
// definition (migration 90) the counter sale, the Production Stock page and the
// dashboard's own card use. Branch stock is one branch's shelf, or every one's.
const CURRENT_STOCK_SQL = `
  select p.id::text                                   as "productId",
         p.name                                       as "productName",
         coalesce(av.available, 0)::float8            as "production",
         coalesce((select sum(s.balance) from public.stock s
                    where s.product_id = p.id and ($1::uuid is null or s.branch_id = $1::uuid)), 0)::float8 as "branch"
    from public.products p
    left join public.production_stock_availability() av on av.product_id = p.id
   where p.is_active and not p.is_special
`;

// ─── Headline cards ──────────────────────────────────────────────────────────

/**
 * Units prepared today, this week and this month, from the same ledger rows
 * (`type = 'prepare'`, |delta|) production_dashboard_week counts as `produced`.
 *
 * Was: every movement since the 1st selected through the query builder and
 * summed in Node. The builder caps a read at 1,000 rows and the month had
 * passed that, so this week's rows were cut off and the cards read 0 while the
 * Produced card beside them, summed in SQL, read the real figure.
 */
const PREPARED_TOTALS_SQL = `
  select coalesce(sum(abs(delta)) filter (where business_date = $1::date), 0)::float8  as "today",
         coalesce(sum(abs(delta)) filter (where business_date >= $2::date), 0)::float8 as "week",
         coalesce(sum(abs(delta)) filter (where business_date >= $3::date), 0)::float8 as "month"
    from public.production_stock_history
   where type = 'prepare'
     and business_date between least($2::date, $3::date) and $1::date
`;

// ─── Runners ─────────────────────────────────────────────────────────────────

interface SectionArgs { period: DashboardPeriod; today: string; branchId: string | null }

function params(win: { from: string; to: string; prevFrom: string; prevTo: string }, branchId: string | null, bucket: DashboardBucket) {
  return [win.from, win.to, win.prevFrom, win.prevTo, branchId, bucket] as const;
}

export async function getReceivedDemand({ period, today, branchId }: SectionArgs): Promise<ReceivedDemandSection> {
  const win = dashboardWindow(period, today);
  const bucket = seriesBucket(period, { weeklyForMonth: true });
  const p = params(win, branchId, bucket);
  const prisma = getPrisma();
  const [totals, series, top] = await Promise.all([
    prisma.$queryRawUnsafe<DemandTotalsRow[]>(DEMAND_TOTALS_SQL, ...p),
    prisma.$queryRawUnsafe<DemandSeriesRow[]>(DEMAND_SERIES_SQL, ...p),
    prisma.$queryRawUnsafe<ProductUnits[]>(DEMAND_TOP_PRODUCTS_SQL, ...p),
  ]);
  return buildReceivedDemand(win, bucket, totals, series, top.map(asProductUnits), new Date().toISOString());
}

export async function getBranchSummary({ period, today }: Omit<SectionArgs, 'branchId'>): Promise<BranchSummarySection> {
  const win = dashboardWindow(period, today);
  const bucket = seriesBucket(period);
  const p = params(win, null, bucket);
  const prisma = getPrisma();
  const [totals, spark] = await Promise.all([
    prisma.$queryRawUnsafe<BranchTotalsRow[]>(BRANCH_TOTALS_SQL, ...p),
    prisma.$queryRawUnsafe<BranchSparkRow[]>(BRANCH_SPARK_SQL, ...p),
  ]);
  return buildBranchSummary(win, bucket, totals, spark, new Date().toISOString());
}

export async function getRepairedStock({ period, today, branchId }: SectionArgs): Promise<RepairedStockSection> {
  const win = dashboardWindow(period, today);
  const bucket = seriesBucket(period);
  const p = params(win, branchId, bucket);
  const prisma = getPrisma();
  const [totals, series, top] = await Promise.all([
    prisma.$queryRawUnsafe<RepairedTotalsRow[]>(REPAIRED_TOTALS_SQL, ...p),
    prisma.$queryRawUnsafe<RepairedSeriesRow[]>(REPAIRED_SERIES_SQL, ...p),
    prisma.$queryRawUnsafe<ProductUnits[]>(REPAIRED_TOP_PRODUCTS_SQL, ...p),
  ]);
  return buildRepairedStock(win, bucket, totals, series, top.map(asProductUnits), new Date().toISOString());
}

export async function getReturnStock({ period, today, branchId }: SectionArgs): Promise<ReturnStockSection> {
  const win = dashboardWindow(period, today);
  const bucket = seriesBucket(period);
  const p = params(win, branchId, bucket);
  const prisma = getPrisma();
  const [totals, series, cells, reasons, onHand] = await Promise.all([
    prisma.$queryRawUnsafe<ReturnTotalsRow[]>(RETURN_TOTALS_SQL, ...p),
    prisma.$queryRawUnsafe<ReturnSeriesRow[]>(RETURN_SERIES_SQL, ...p),
    prisma.$queryRawUnsafe<ReturnBranchProductRow[]>(RETURN_CELLS_SQL, ...p),
    prisma.$queryRawUnsafe<ReturnReasonRow[]>(RETURN_REASONS_SQL, ...p),
    prisma.$queryRawUnsafe<{ onHand: number }[]>(RETURN_ON_HAND_SQL),
  ]);
  return buildReturnStock(win, bucket, totals, series, cells, reasons, Number(onHand[0]?.onHand ?? 0), new Date().toISOString());
}

export async function getCurrentStock({ branchId }: { branchId: string | null }): Promise<CurrentStockSection> {
  const rows = await getPrisma().$queryRawUnsafe<CurrentStockSqlRow[]>(CURRENT_STOCK_SQL, branchId);
  return buildCurrentStock(rows, LOW_STOCK_THRESHOLD, branchId, new Date().toISOString());
}

export async function getPreparedTotals(
  { today, weekStart, monthStart }: { today: string; weekStart: string; monthStart: string },
): Promise<{ today: number; week: number; month: number }> {
  const [row] = await getPrisma().$queryRawUnsafe<{ today: number; week: number; month: number }[]>(
    PREPARED_TOTALS_SQL, today, weekStart, monthStart,
  );
  return { today: Number(row?.today ?? 0), week: Number(row?.week ?? 0), month: Number(row?.month ?? 0) };
}

function asProductUnits(r: ProductUnits): ProductUnits {
  return { productId: r.productId, productName: r.productName ?? 'Unknown product', units: Number(r.units) };
}
