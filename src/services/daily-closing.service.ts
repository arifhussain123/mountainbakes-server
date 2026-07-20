import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  businessDaysAgoStr,
  businessDayBounds,
  type ClosureTrigger,
  type DailyClosure,
  type SalesSummary,
  type ExpenseSummary,
  type ProductionSummary,
  type StockSnapshotBranch,
  type PaymentMethod,
} from '../shared';
import { getAppSettings } from './settings.service';
import { computeStockRows } from './stock.service';

const CLOSURES = 'business_day_closures';
const RUNNING_TTL_MS = 10 * 60 * 1000; // a 'running' claim older than this is treated as crashed

export interface CloseResult {
  businessDate: string;
  status: 'success' | 'failed' | 'skipped';
  reason?: string;
}

interface CloseOptions {
  trigger: ClosureTrigger;
  /** Defaults to the business day that just ended (yesterday's business date). */
  businessDate?: string;
  /** Email of the admin for a manual run; ignored for the scheduler. */
  actor?: string;
}

/**
 * Map a `business_day_closures` row (snake_case, with JSONB summary columns) to
 * the camelCase `DailyClosure` API shape.
 *
 * NOTE: the summary columns are passed through untouched — they are NOT run
 * through the generic snakeToCamel converter, because their inner maps are keyed
 * by payment method (`bank_account`) and by free-text expense category. Running
 * the converter over those would rename `bank_account` → `bankAccount` and
 * corrupt the archive.
 */
function rowToClosure(row: Record<string, unknown>): DailyClosure {
  return {
    businessDate: row['business_date'] as string,
    status: row['status'] as DailyClosure['status'],
    trigger: row['trigger'] as ClosureTrigger,
    closedBy: (row['closed_by'] as string) ?? '',
    autoStockClosing: Boolean(row['auto_stock_closing']),
    salesSummary: (row['sales_summary'] as SalesSummary | null) ?? null,
    expenseSummary: (row['expense_summary'] as ExpenseSummary | null) ?? null,
    productionExpenseSummary: (row['production_expense_summary'] as ExpenseSummary | null) ?? null,
    productionSummary: (row['production_summary'] as ProductionSummary | null) ?? null,
    stockSnapshot: (row['stock_snapshot'] as StockSnapshotBranch[] | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    startedAt: row['started_at'] as string,
    closedAt: (row['closed_at'] as string | null) ?? null,
    durationMs: (row['duration_ms'] as number | null) ?? null,
  };
}

/**
 * Run the end-of-day closing for a business date. Idempotent: guarded by a
 * `business_day_closures` row (PK = the business date) so a duplicate scheduler
 * tick or manual retry is a no-op once a day has closed successfully. Because the
 * stock/sales layer is derived (balances persist, reports compute on-read), this
 * job's real work is to (a) snapshot + archive the day, (b) lock it, and (c)
 * record the audit.
 */
export async function runDailyClosing(opts: CloseOptions): Promise<CloseResult> {
  const businessDate = opts.businessDate ?? businessDaysAgoStr(1);
  const closedBy = opts.trigger === 'scheduler' ? 'System Scheduler' : (opts.actor || 'Admin');

  const settings = await getAppSettings();
  // The scheduler respects the Auto Close toggle; a manual admin run always proceeds.
  if (opts.trigger === 'scheduler' && !settings.autoCloseBusiness) {
    return { businessDate, status: 'skipped', reason: 'autoCloseBusiness is off' };
  }
  const autoStockClosing = settings.autoStockClosing;

  // ── Claim the lock (once-per-day + concurrency guard) ──
  // The read-check-write happens atomically inside claim_business_day_closure
  // (migration 17); PostgREST cannot make it atomic from here.
  const startedAt = new Date().toISOString();
  const { data: claim, error: claimErr } = await supabaseAdmin.rpc('claim_business_day_closure', {
    p_business_date: businessDate,
    p_trigger: opts.trigger,
    p_closed_by: closedBy,
    p_auto_stock_closing: autoStockClosing,
    p_stale_ms: RUNNING_TTL_MS,
  });
  if (claimErr) throw claimErr;

  if (claim !== 'claimed') {
    const reason = claim === 'already_closed' ? 'already closed' : 'closing already in progress';
    return { businessDate, status: 'skipped', reason };
  }

  // ── Compute the archive (with a small retry for transient DB errors) ──
  try {
    const { salesSummary, expenseSummary, productionExpenseSummary, productionSummary, stockSnapshot } =
      await withRetry(() => buildArchive(businessDate, autoStockClosing), 3);

    const closedAt = new Date().toISOString();
    const { error: doneErr } = await supabaseAdmin
      .from(CLOSURES)
      .update({
        status: 'success',
        sales_summary: salesSummary,
        expense_summary: expenseSummary,
        production_expense_summary: productionExpenseSummary,
        production_summary: productionSummary,
        stock_snapshot: stockSnapshot,
        error: null,
        closed_at: closedAt,
        duration_ms: Date.now() - new Date(startedAt).getTime(),
      })
      .eq('business_date', businessDate);
    if (doneErr) throw doneErr;

    console.log(`[daily-closing] Closed business day ${businessDate} (${closedBy}).`);
    return { businessDate, status: 'success' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: record the failure on the lock row, but never let a failed
    // status-write mask the original error.
    const { error: failErr } = await supabaseAdmin
      .from(CLOSURES)
      .update({ status: 'failed', error: message, closed_at: new Date().toISOString() })
      .eq('business_date', businessDate);
    if (failErr) console.error(`[daily-closing] could not record failure for ${businessDate}:`, failErr.message);
    console.error(`[daily-closing] FAILED to close ${businessDate}:`, message);
    return { businessDate, status: 'failed', reason: message };
  }
}

/** Build every summary + the per-branch stock snapshot for a business date. */
async function buildArchive(businessDate: string, autoStockClosing: boolean): Promise<{
  salesSummary: SalesSummary;
  expenseSummary: ExpenseSummary;
  productionExpenseSummary: ExpenseSummary;
  productionSummary: ProductionSummary;
  stockSnapshot: StockSnapshotBranch[] | null;
}> {
  const { fromISO, toISO } = businessDayBounds(businessDate);

  const [orders, expenses, prodExpenses, prodOrders, returns, balances, branches] = await Promise.all([
    // Orders are dated by created_at with INCLUSIVE bounds — see migration 03.
    supabaseAdmin
      .from('orders')
      .select('status, grand_total, discount_total, tax_amount, payment_method')
      .gte('created_at', fromISO)
      .lte('created_at', toISO),
    supabaseAdmin.from('expenses').select('amount, payment_method, description').eq('business_date', businessDate),
    supabaseAdmin.from('production_expenses').select('amount, payment_method, category').eq('business_date', businessDate),
    supabaseAdmin
      .from('production_orders')
      .select('status, items:production_order_items(qty, approved_qty)')
      .eq('business_date', businessDate),
    supabaseAdmin.from('production_returns').select('qty, status').eq('business_date', businessDate),
    supabaseAdmin.from('production_balances').select('pending_qty'),
    supabaseAdmin.from('branches').select('id, name').eq('is_active', true),
  ]);

  for (const r of [orders, expenses, prodExpenses, prodOrders, returns, balances, branches]) {
    if (r.error) throw r.error;
  }

  // ── Sales (non-cancelled) ──
  const emptyPm: Record<PaymentMethod, number> = { cash: 0, easypaisa: 0, foodpanda: 0, bank_account: 0 };
  const sales: SalesSummary = {
    totalSales: 0, totalOrders: 0, byPaymentMethod: { ...emptyPm }, totalDiscounts: 0, governmentTax: 0, netSales: 0,
  };
  for (const o of (orders.data ?? []) as {
    status: string; grand_total: number; discount_total: number; tax_amount: number; payment_method: PaymentMethod;
  }[]) {
    if (o.status === 'cancelled') continue;
    sales.totalOrders += 1;
    sales.totalSales += Number(o.grand_total || 0);
    sales.totalDiscounts += Number(o.discount_total || 0);
    sales.governmentTax += Number(o.tax_amount || 0);
    const pm = (o.payment_method || 'cash') as PaymentMethod;
    sales.byPaymentMethod[pm] = (sales.byPaymentMethod[pm] || 0) + Number(o.grand_total || 0);
  }
  sales.netSales = sales.totalSales - sales.totalDiscounts - sales.governmentTax;

  // ── Shop expenses (no category field → group by description) ──
  const expenseSummary = summariseExpenses(
    (expenses.data ?? []) as { amount: number; payment_method: string; description?: string }[],
    (e) => e.description || 'Uncategorised',
  );

  // ── Production expenses (have a category) ──
  const productionExpenseSummary = summariseExpenses(
    (prodExpenses.data ?? []) as { amount: number; payment_method: string; category?: string }[],
    (e) => e.category || 'Uncategorised',
  );

  // ── Production ──
  type OItem = { qty?: number; approved_qty?: number };
  const prodOrderRows = (prodOrders.data ?? []) as { status: string; items: OItem[] }[];
  const production: ProductionSummary = {
    ordersClosed: prodOrderRows.filter((o) => o.status === 'approved').length,
    ordersPending: prodOrderRows.filter((o) => o.status === 'pending').length,
    approvedQty: prodOrderRows
      .filter((o) => o.status === 'approved')
      .reduce((s, o) => s + (o.items ?? []).reduce((t, i) => t + Number(i.approved_qty ?? i.qty ?? 0), 0), 0),
    returnedQty: ((returns.data ?? []) as { qty: number; status: string }[])
      .filter((r) => r.status === 'accepted')
      .reduce((s, r) => s + Number(r.qty || 0), 0),
    pendingBalanceQty: ((balances.data ?? []) as { pending_qty: number }[])
      .reduce((s, b) => s + Number(b.pending_qty ?? 0), 0),
  };

  // ── Branch stock snapshot (carry-forward is automatic; this is the immutable archive) ──
  let stockSnapshot: StockSnapshotBranch[] | null = null;
  if (autoStockClosing) {
    const branchRows = (branches.data ?? []) as { id: string; name: string }[];
    stockSnapshot = await Promise.all(
      branchRows.map(async (b) => ({
        branchId: b.id,
        branchName: b.name,
        rows: await computeStockRows(b.id, businessDate),
      })),
    );
  }

  return { salesSummary: sales, expenseSummary, productionExpenseSummary, productionSummary: production, stockSnapshot };
}

/** Roll up a set of expense rows into total + by-category + by-payment-method. */
function summariseExpenses<T extends { amount: number; payment_method: string }>(
  rows: T[],
  categoryOf: (row: T) => string,
): ExpenseSummary {
  const summary: ExpenseSummary = { total: 0, byCategory: {}, byPaymentMethod: {} };
  for (const r of rows) {
    const amt = Number(r.amount || 0);
    summary.total += amt;
    const cat = categoryOf(r);
    summary.byCategory[cat] = (summary.byCategory[cat] || 0) + amt;
    const pm = r.payment_method || 'cash';
    summary.byPaymentMethod[pm] = (summary.byPaymentMethod[pm] || 0) + amt;
  }
  return summary;
}

/** Retry an async op up to `attempts` times with linear backoff — for transient DB blips. */
async function withRetry<T>(op: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw lastErr;
}

/**
 * Whether a business date is closed (locked). Super Admin bypasses the lock;
 * everyone else is blocked from writing to a day that has been closed.
 */
export async function isBusinessDayClosed(businessDate: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from(CLOSURES)
    .select('status')
    .eq('business_date', businessDate)
    .maybeSingle();
  if (error) throw error;
  return data?.status === 'success';
}

/** List closure/audit records, most recent first (default last 30 business days). */
export async function listClosures(days = 30): Promise<DailyClosure[]> {
  const since = businessDaysAgoStr(days - 1);
  const { data, error } = await supabaseAdmin
    .from(CLOSURES)
    .select('*')
    .gte('business_date', since)
    .order('business_date', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(rowToClosure);
}

/** The currently-open business date (for callers that need "today" in business terms). */
export function currentBusinessDate(): string {
  return businessDateStr();
}
