/**
 * The Production Dashboard's sections — Received Demand, Branch-wise, Repaired
 * Stock, Return Stock, Current Stock — and the period arithmetic they share
 * with the dashboard's headline cards.
 *
 * Shared because the server sums and the web app lays out, and the two have to
 * agree on what a period is and what each figure means. Every figure below is
 * aggregated in SQL (`production-dashboard.service.ts`); nothing here downloads
 * rows and adds them up.
 *
 * ─── Periods ─────────────────────────────────────────────────────────────────
 * Business dates (02:00 Karachi rollover), each compared with the same stretch
 * of the period before it: today with yesterday, Monday..today with last
 * Monday..the same weekday, the 1st..today with the 1st..the same day of last
 * month. Never a full previous week or month against a part of this one.
 *
 * ─── Definitions ─────────────────────────────────────────────────────────────
 * Demand        Σ `production_order_items.qty` on orders not cancelled, by the
 *               order's business date. Rejected orders stay in: they were asked
 *               for and not met.
 * Delivered     Σ `approved_qty` on orders that reached `verified` or
 *               `approved` — stock moves when the branch verifies, so an order
 *               only sent is not delivered yet.
 * Fulfilment    delivered ÷ demand, same orders, same period. Not capped.
 * Returned      Σ `production_returns.qty` with status `accepted`.
 * Return rate   returned ÷ delivered, same period and branch scope.
 * Repaired      returned units accepted with disposition `repaired`.
 * Repair rate   repaired ÷ returned.
 * Back to stock Σ Return Stock → Production Stock transfers. A transfer is not
 *               tied to the return it came from, so this is every transfer,
 *               whatever the goods' disposition.
 */

export type DashboardPeriod = 'today' | 'week' | 'month';
export const DASHBOARD_PERIODS: readonly DashboardPeriod[] = ['today', 'week', 'month'];

/** How a section's series is bucketed. `hour` keys are `YYYY-MM-DDTHH` (Karachi), `day` and `week` keys are `YYYY-MM-DD` (a week by its Monday). */
export type DashboardBucket = 'hour' | 'day' | 'week';

export interface DashboardWindow {
  period: DashboardPeriod;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
}

export const isDashboardPeriod = (v: unknown): v is DashboardPeriod =>
  typeof v === 'string' && (DASHBOARD_PERIODS as readonly string[]).includes(v);

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` shifted by whole months, the day clamped to the target month's length. */
export function shiftMonthsStr(dateStr: string, months: number, day?: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day ?? d, last));
  return first.toISOString().slice(0, 10);
}

/** Monday of the week `dateStr` falls in. */
export function mondayOf(dateStr: string): string {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return addDays(dateStr, -((dow + 6) % 7));
}

/** The period ending on business date `today`, beside the same stretch of the one before it. */
export function dashboardWindow(period: DashboardPeriod, today: string): DashboardWindow {
  if (period === 'today') {
    const y = addDays(today, -1);
    return { period, from: today, to: today, prevFrom: y, prevTo: y };
  }
  if (period === 'month') {
    const from = `${today.slice(0, 7)}-01`;
    return { period, from, to: today, prevFrom: shiftMonthsStr(from, -1), prevTo: shiftMonthsStr(today, -1) };
  }
  const from = mondayOf(today);
  return { period, from, to: today, prevFrom: addDays(from, -7), prevTo: addDays(today, -7) };
}

/** Today is one business day, so it is drawn by the hour; a month of days is too dense for stacked columns, so those go by week. */
export function seriesBucket(period: DashboardPeriod, opts: { weeklyForMonth?: boolean } = {}): DashboardBucket {
  if (period === 'today') return 'hour';
  return period === 'month' && opts.weeklyForMonth ? 'week' : 'day';
}

/**
 * Every bucket key of a window, in order, so a series has no gaps where nothing
 * happened. Hours are not enumerable from dates alone (the business day runs
 * past midnight), so for `hour` the keys present in `seen` are filled between
 * the first and the last.
 */
export function bucketKeys(win: Pick<DashboardWindow, 'from' | 'to'>, bucket: DashboardBucket, seen: readonly string[] = []): string[] {
  if (bucket === 'hour') {
    if (seen.length === 0) return [];
    const sorted = [...seen].sort();
    const toMs = (k: string) => Date.parse(`${k}:00:00Z`);
    const out: string[] = [];
    for (let t = toMs(sorted[0]!); t <= toMs(sorted[sorted.length - 1]!); t += 3_600_000) {
      out.push(new Date(t).toISOString().slice(0, 13));
    }
    return out;
  }
  const out: string[] = [];
  for (let d = bucket === 'week' ? mondayOf(win.from) : win.from; d <= win.to; d = addDays(d, bucket === 'week' ? 7 : 1)) {
    out.push(d);
  }
  return out;
}

/** A change against the previous period: `%` for counts, percentage points for figures that are already a rate. */
export interface DashboardDelta { value: number; unit: '%' | 'pts' }

/** % change, or null when there is nothing to compare with (the previous figure was zero). */
export function pctDelta(cur: number, prev: number): DashboardDelta | null {
  if (!prev) return null;
  return { value: round1(((cur - prev) / prev) * 100), unit: '%' };
}

/** Point difference between two rates; null when either side has no rate. */
export function ptsDelta(cur: number | null, prev: number | null): DashboardDelta | null {
  if (cur === null || prev === null) return null;
  return { value: round1(cur - prev), unit: 'pts' };
}

/** num ÷ den as a percentage, one decimal; null when there is nothing to divide by. */
export function ratePct(num: number, den: number): number | null {
  return den > 0 ? round1((num / den) * 100) : null;
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Every section answers in this one shape. */
export interface DashboardSection<K extends string, S, B> {
  window: DashboardWindow;
  bucket: DashboardBucket;
  kpis: Record<K, number | null>;
  /** The same figures for the previous window. */
  previous: Record<K, number | null>;
  /** Change against `previous`, per KPI; null where it cannot be stated. */
  comparePrevious: Record<K, DashboardDelta | null>;
  series: S[];
  breakdown: B;
  generatedAt: string;
}

// ─── 1. Received Demand ───────────────────────────────────────────────────────

/** Order statuses as the demand chart stacks them. `pending` is waiting on Production; `awaiting_verification` has been sent. */
export const DEMAND_STATUSES = ['pending', 'awaiting_verification', 'verified', 'approved', 'rejected'] as const;
export type DemandStatus = (typeof DEMAND_STATUSES)[number];

export const DEMAND_STATUS_LABELS: Record<DemandStatus, string> = {
  pending: 'Waiting',
  awaiting_verification: 'Sent',
  verified: 'Verified',
  approved: 'Delivered',
  rejected: 'Rejected',
};

export type ReceivedDemandKpi = 'units' | 'orders' | 'avgUnits' | 'pendingVerification' | 'rejected';

export interface ReceivedDemandPoint {
  bucket: string;
  units: number;
  orders: number;
  byStatus: Record<DemandStatus, { units: number; orders: number }>;
}

export interface ReceivedDemandBreakdown {
  topProducts: { productId: string | null; productName: string; units: number }[];
}

export type ReceivedDemandSection = DashboardSection<ReceivedDemandKpi, ReceivedDemandPoint, ReceivedDemandBreakdown>;

/** One SQL row: a window's orders of one status. */
export interface DemandTotalsRow { cur: boolean; status: string; orders: number; units: number }
/** One SQL row: the current window's orders of one status in one bucket. */
export interface DemandSeriesRow { bucket: string; status: string; orders: number; units: number }

const emptyByStatus = () => Object.fromEntries(DEMAND_STATUSES.map((s) => [s, { units: 0, orders: 0 }])) as ReceivedDemandPoint['byStatus'];
const isDemandStatus = (s: string): s is DemandStatus => (DEMAND_STATUSES as readonly string[]).includes(s);

export function buildReceivedDemand(
  win: DashboardWindow,
  bucket: DashboardBucket,
  totals: DemandTotalsRow[],
  seriesRows: DemandSeriesRow[],
  topProducts: ReceivedDemandBreakdown['topProducts'],
  generatedAt: string,
): ReceivedDemandSection {
  const kpisFor = (cur: boolean): Record<ReceivedDemandKpi, number | null> => {
    const rows = totals.filter((r) => r.cur === cur);
    const units = rows.reduce((s, r) => s + Number(r.units), 0);
    const orders = rows.reduce((s, r) => s + Number(r.orders), 0);
    const of = (status: DemandStatus) => rows.filter((r) => r.status === status).reduce((s, r) => s + Number(r.orders), 0);
    return {
      units,
      orders,
      avgUnits: orders > 0 ? round1(units / orders) : null,
      pendingVerification: of('awaiting_verification'),
      rejected: of('rejected'),
    };
  };
  const kpis = kpisFor(true);
  const previous = kpisFor(false);

  const byBucket = new Map<string, ReceivedDemandPoint>();
  for (const key of bucketKeys(win, bucket, seriesRows.map((r) => r.bucket))) {
    byBucket.set(key, { bucket: key, units: 0, orders: 0, byStatus: emptyByStatus() });
  }
  for (const r of seriesRows) {
    if (!isDemandStatus(r.status)) continue;
    const p = byBucket.get(r.bucket);
    if (!p) continue;
    p.byStatus[r.status].units += Number(r.units);
    p.byStatus[r.status].orders += Number(r.orders);
    p.units += Number(r.units);
    p.orders += Number(r.orders);
  }

  return {
    window: win,
    bucket,
    kpis,
    previous,
    comparePrevious: {
      units: pctDelta(kpis.units ?? 0, previous.units ?? 0),
      orders: pctDelta(kpis.orders ?? 0, previous.orders ?? 0),
      avgUnits: kpis.avgUnits !== null && previous.avgUnits !== null ? pctDelta(kpis.avgUnits, previous.avgUnits) : null,
      pendingVerification: pctDelta(kpis.pendingVerification ?? 0, previous.pendingVerification ?? 0),
      rejected: pctDelta(kpis.rejected ?? 0, previous.rejected ?? 0),
    },
    series: [...byBucket.values()],
    breakdown: { topProducts },
    generatedAt,
  };
}

// ─── 2. Branch-wise ──────────────────────────────────────────────────────────

export type BranchSummaryKpi = 'activeBranches' | 'branchesWithDemand' | 'demanded' | 'delivered' | 'fulfilment';

export interface BranchSummaryRow {
  branchId: string;
  branchName: string;
  demanded: number;
  delivered: number;
  returned: number;
  /** delivered ÷ demanded, %; null with no demand. */
  fulfilment: number | null;
  /** Latest demand this branch ever submitted (not cancelled), ISO; null if never. */
  lastSubmittedAt: string | null;
  /** Demand per bucket of the period, in `bucketKeys` order. */
  spark: number[];
}

export type BranchSummarySection = DashboardSection<BranchSummaryKpi, BranchSummaryRow, { sparkKeys: string[] }>;

/** One SQL row per active branch: both windows side by side. */
export interface BranchTotalsRow {
  branchId: string; branchName: string; lastSubmittedAt: string | Date | null;
  demanded: number; delivered: number; returned: number;
  prevDemanded: number; prevDelivered: number;
}
export interface BranchSparkRow { branchId: string; bucket: string; units: number }

export function buildBranchSummary(
  win: DashboardWindow,
  bucket: DashboardBucket,
  totals: BranchTotalsRow[],
  sparkRows: BranchSparkRow[],
  generatedAt: string,
): BranchSummarySection {
  const keys = bucketKeys(win, bucket, sparkRows.map((r) => r.bucket));
  const index = new Map(keys.map((k, i) => [k, i]));
  const sparks = new Map<string, number[]>();
  for (const r of sparkRows) {
    const i = index.get(r.bucket);
    if (i === undefined) continue;
    const arr = sparks.get(r.branchId) ?? sparks.set(r.branchId, keys.map(() => 0)).get(r.branchId)!;
    arr[i]! += Number(r.units);
  }

  const series: BranchSummaryRow[] = totals
    .map((b) => {
      const demanded = Number(b.demanded);
      const delivered = Number(b.delivered);
      return {
        branchId: b.branchId,
        branchName: b.branchName,
        demanded,
        delivered,
        returned: Number(b.returned),
        fulfilment: ratePct(delivered, demanded),
        lastSubmittedAt: b.lastSubmittedAt === null ? null : new Date(b.lastSubmittedAt).toISOString(),
        spark: sparks.get(b.branchId) ?? keys.map(() => 0),
      };
    })
    // Highest demand first; the idle ones after, by name, so the order is stable.
    .sort((a, b) => b.demanded - a.demanded || a.branchName.localeCompare(b.branchName));

  const sum = (k: keyof BranchTotalsRow) => totals.reduce((s, b) => s + Number(b[k]), 0);
  const kpis = {
    activeBranches: totals.length,
    branchesWithDemand: totals.filter((b) => Number(b.demanded) > 0).length,
    demanded: sum('demanded'),
    delivered: sum('delivered'),
    fulfilment: ratePct(sum('delivered'), sum('demanded')),
  };
  const previous = {
    activeBranches: totals.length,
    branchesWithDemand: totals.filter((b) => Number(b.prevDemanded) > 0).length,
    demanded: sum('prevDemanded'),
    delivered: sum('prevDelivered'),
    fulfilment: ratePct(sum('prevDelivered'), sum('prevDemanded')),
  };
  return {
    window: win,
    bucket,
    kpis,
    previous,
    comparePrevious: {
      // Active branches is not a period figure, so it has no change to show.
      activeBranches: null,
      branchesWithDemand: pctDelta(kpis.branchesWithDemand, previous.branchesWithDemand),
      demanded: pctDelta(kpis.demanded, previous.demanded),
      delivered: pctDelta(kpis.delivered, previous.delivered),
      fulfilment: ptsDelta(kpis.fulfilment, previous.fulfilment),
    },
    series,
    breakdown: { sparkKeys: keys },
    generatedAt,
  };
}

// ─── 3. Repaired Stock ───────────────────────────────────────────────────────

export type RepairedStockKpi = 'repaired' | 'repairRate' | 'backToStock';

export interface RepairedStockPoint { bucket: string; repaired: number; returned: number }

export interface ProductUnits { productId: string | null; productName: string; units: number }

export interface RepairedStockBreakdown {
  topProducts: ProductUnits[];
  /** The most-repaired product this period; null when nothing was repaired. */
  topProduct: ProductUnits | null;
}

export type RepairedStockSection = DashboardSection<RepairedStockKpi, RepairedStockPoint, RepairedStockBreakdown>;

export interface RepairedTotalsRow { cur: boolean; returned: number; repaired: number; backToStock: number }
export interface RepairedSeriesRow { bucket: string; returned: number; repaired: number }

export function buildRepairedStock(
  win: DashboardWindow,
  bucket: DashboardBucket,
  totals: RepairedTotalsRow[],
  seriesRows: RepairedSeriesRow[],
  topProducts: ProductUnits[],
  generatedAt: string,
): RepairedStockSection {
  const pick = (cur: boolean) => {
    const r = totals.find((t) => t.cur === cur);
    const returned = Number(r?.returned ?? 0);
    const repaired = Number(r?.repaired ?? 0);
    return { repaired, repairRate: ratePct(repaired, returned), backToStock: Number(r?.backToStock ?? 0) };
  };
  const kpis = pick(true);
  const previous = pick(false);
  const byKey = new Map(seriesRows.map((r) => [r.bucket, r]));
  return {
    window: win,
    bucket,
    kpis,
    previous,
    comparePrevious: {
      repaired: pctDelta(kpis.repaired, previous.repaired),
      repairRate: ptsDelta(kpis.repairRate, previous.repairRate),
      backToStock: pctDelta(kpis.backToStock, previous.backToStock),
    },
    series: bucketKeys(win, bucket, seriesRows.map((r) => r.bucket)).map((k) => ({
      bucket: k,
      repaired: Number(byKey.get(k)?.repaired ?? 0),
      returned: Number(byKey.get(k)?.returned ?? 0),
    })),
    breakdown: { topProducts, topProduct: topProducts[0] ?? null },
    generatedAt,
  };
}

// ─── 4. Return Stock ─────────────────────────────────────────────────────────

export type ReturnStockKpi = 'returned' | 'returnRate' | 'onHand';

export interface ReturnStockPoint { bucket: string; returned: number }

/**
 * Why goods came back. `production_returns.reason` is free text ("Expired",
 * "Exp", "Expeir", "damage/expired", often blank), so it is sorted by keyword.
 * First match wins, in this order: "damage/expired" counts as expired, the
 * condition that decides whether it can ever be sold.
 */
export const RETURN_REASONS = ['expired', 'damaged', 'unsold', 'other', 'none'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  expired: 'Expired',
  damaged: 'Damaged',
  unsold: 'Unsold',
  other: 'Other',
  none: 'Not given',
};

const REASON_KEYWORDS: [Exclude<ReturnReason, 'other' | 'none'>, RegExp][] = [
  // "exp" alone is how most of them are typed, and every misspelling seen starts with it.
  ['expired', /\bexp|expir|stale|\bdate\b|\bold\b|fung|\bmou?ld/],
  ['damaged', /damag|broke|crush|spoil|leak|torn|melt|burn|spill|defect|squash/],
  ['unsold', /unsold|not sold|left ?over|excess|extra|surplus|over ?stock|no sale|return(ed)? back/],
];

export function returnReasonBucket(reason: string | null | undefined): ReturnReason {
  const t = (reason ?? '').trim().toLowerCase();
  if (!t || t === '-' || t === 'n/a' || t === 'na') return 'none';
  for (const [bucket, re] of REASON_KEYWORDS) if (re.test(t)) return bucket;
  return 'other';
}

/** One SQL row: the current window's returned units under one reason text. */
export interface ReturnReasonRow { reason: string | null; units: number }

export interface ReturnStockBreakdown {
  /** Returned units by reason bucket, every bucket present, in `RETURN_REASONS` order. */
  byReason: { reason: ReturnReason; label: string; units: number }[];
  /** Every branch in scope with its returned units, highest first; zero rows included. */
  byBranch: { branchId: string; branchName: string; units: number }[];
  topBranch: { branchId: string; branchName: string; units: number } | null;
  topProduct: ProductUnits | null;
  /** Branch × the period's five most-returned products. */
  heat: {
    products: { productId: string | null; productName: string }[];
    rows: { branchId: string; branchName: string; values: number[] }[];
  };
}

export type ReturnStockSection = DashboardSection<ReturnStockKpi, ReturnStockPoint, ReturnStockBreakdown>;

export interface ReturnTotalsRow { cur: boolean; returned: number; delivered: number }
export interface ReturnSeriesRow { bucket: string; returned: number }
export interface ReturnBranchProductRow { branchId: string; branchName: string; productId: string | null; productName: string | null; units: number }

/** How many products the Return Stock heatmap shows. */
export const RETURN_HEAT_PRODUCTS = 5;

export function buildReturnStock(
  win: DashboardWindow,
  bucket: DashboardBucket,
  totals: ReturnTotalsRow[],
  seriesRows: ReturnSeriesRow[],
  /** Every branch in scope × product, current window; a branch with nothing returned comes as one row with a null product. */
  cells: ReturnBranchProductRow[],
  reasons: ReturnReasonRow[],
  onHand: number,
  generatedAt: string,
): ReturnStockSection {
  const byReasonMap = new Map<ReturnReason, number>(RETURN_REASONS.map((r) => [r, 0]));
  for (const r of reasons) {
    const k = returnReasonBucket(r.reason);
    byReasonMap.set(k, (byReasonMap.get(k) ?? 0) + Number(r.units));
  }
  const pick = (cur: boolean) => {
    const r = totals.find((t) => t.cur === cur);
    const returned = Number(r?.returned ?? 0);
    return { returned, returnRate: ratePct(returned, Number(r?.delivered ?? 0)) };
  };
  const cur = pick(true);
  const prev = pick(false);

  const branches = new Map<string, { branchId: string; branchName: string; units: number }>();
  const products = new Map<string, ProductUnits>();
  for (const c of cells) {
    const b = branches.get(c.branchId) ?? branches.set(c.branchId, { branchId: c.branchId, branchName: c.branchName, units: 0 }).get(c.branchId)!;
    b.units += Number(c.units);
    if (c.productName === null) continue;
    const key = c.productId ?? `name:${c.productName}`;
    const p = products.get(key) ?? products.set(key, { productId: c.productId, productName: c.productName, units: 0 }).get(key)!;
    p.units += Number(c.units);
  }
  const byBranch = [...branches.values()].sort((a, b) => b.units - a.units || a.branchName.localeCompare(b.branchName));
  const ranked = [...products.values()].filter((p) => p.units > 0).sort((a, b) => b.units - a.units || a.productName.localeCompare(b.productName));
  const heatProducts = ranked.slice(0, RETURN_HEAT_PRODUCTS);
  const heatRows = byBranch.map((b) => ({
    branchId: b.branchId,
    branchName: b.branchName,
    values: heatProducts.map((p) => cells
      .filter((c) => c.branchId === b.branchId && c.productName !== null && (c.productId ?? `name:${c.productName}`) === (p.productId ?? `name:${p.productName}`))
      .reduce((s, c) => s + Number(c.units), 0)),
  }));

  const byKey = new Map(seriesRows.map((r) => [r.bucket, Number(r.returned)]));
  return {
    window: win,
    bucket,
    // On hand is stock right now, not a period figure: it is the same on both sides.
    kpis: { ...cur, onHand },
    previous: { ...prev, onHand },
    comparePrevious: {
      returned: pctDelta(cur.returned, prev.returned),
      returnRate: ptsDelta(cur.returnRate, prev.returnRate),
      onHand: null,
    },
    series: bucketKeys(win, bucket, seriesRows.map((r) => r.bucket)).map((k) => ({ bucket: k, returned: byKey.get(k) ?? 0 })),
    breakdown: {
      byReason: RETURN_REASONS.map((r) => ({ reason: r, label: RETURN_REASON_LABELS[r], units: byReasonMap.get(r) ?? 0 })),
      byBranch,
      topBranch: byBranch[0] && byBranch[0].units > 0 ? byBranch[0] : null,
      topProduct: ranked[0] ?? null,
      heat: { products: heatProducts.map(({ productId, productName }) => ({ productId, productName })), rows: heatRows },
    },
    generatedAt,
  };
}

// ─── 5. Current Stock ────────────────────────────────────────────────────────

export type StockState = 'ok' | 'low' | 'out';

export interface CurrentStockRow {
  productId: string;
  productName: string;
  /** Available in the central pool: balance less what branches have been promised. Can be negative. */
  production: number;
  /** On branch shelves (one branch when filtered). */
  branch: number;
  /** What is physically there: each side counted from zero, never below. */
  total: number;
  state: StockState;
}

export interface CurrentStockSection {
  kpis: Record<'production' | 'branch' | 'inStock' | 'low' | 'out', number>;
  series: CurrentStockRow[];
  breakdown: { threshold: number; products: number };
  branchId: string | null;
  generatedAt: string;
}

export interface CurrentStockSqlRow { productId: string; productName: string; production: number; branch: number }

/** Low below `threshold` (the shared LOW_STOCK_THRESHOLD), out at nothing. */
export function stockState(total: number, threshold: number): StockState {
  if (total <= 0) return 'out';
  return total < threshold ? 'low' : 'ok';
}

export function buildCurrentStock(rows: CurrentStockSqlRow[], threshold: number, branchId: string | null, generatedAt: string): CurrentStockSection {
  const series = rows
    .map((r) => {
      const production = Number(r.production);
      const branch = Number(r.branch);
      const total = Math.max(production, 0) + Math.max(branch, 0);
      return { productId: r.productId, productName: r.productName, production, branch, total, state: stockState(total, threshold) };
    })
    .sort((a, b) => b.total - a.total || a.productName.localeCompare(b.productName));
  return {
    kpis: {
      // Summed as the Production Stock page sums it: a promised-but-unmade
      // shortfall on one product is netted against stock of another.
      production: series.reduce((s, r) => s + r.production, 0),
      branch: series.reduce((s, r) => s + r.branch, 0),
      inStock: series.filter((r) => r.state !== 'out').length,
      low: series.filter((r) => r.state === 'low').length,
      out: series.filter((r) => r.state === 'out').length,
    },
    series,
    breakdown: { threshold, products: series.length },
    branchId,
    generatedAt,
  };
}
