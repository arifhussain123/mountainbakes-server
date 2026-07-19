import { adminDb } from '../config/firebase';
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
 * Run the end-of-day closing for a business date. Idempotent: guarded by a
 * `business_day_closures/{date}` lock doc so a duplicate scheduler tick or manual
 * retry is a no-op once a day has closed successfully. Because the stock/sales
 * layer is derived (balances persist, reports compute on-read), this job's real
 * work is to (a) snapshot + archive the day, (b) lock it, and (c) record the audit.
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
  const ref = adminDb.collection(CLOSURES).doc(businessDate);
  const startedAt = new Date().toISOString();
  const claim = await adminDb.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) {
      const d = doc.data() as DailyClosure;
      if (d.status === 'success') return { ok: false, reason: 'already closed' };
      if (d.status === 'running' && Date.now() - new Date(d.startedAt).getTime() < RUNNING_TTL_MS) {
        return { ok: false, reason: 'closing already in progress' };
      }
    }
    tx.set(ref, {
      businessDate,
      status: 'running',
      trigger: opts.trigger,
      closedBy,
      autoStockClosing,
      salesSummary: null,
      expenseSummary: null,
      productionExpenseSummary: null,
      productionSummary: null,
      stockSnapshot: null,
      error: null,
      startedAt,
      closedAt: null,
      durationMs: null,
    } satisfies DailyClosure);
    return { ok: true };
  });

  if (!claim.ok) return { businessDate, status: 'skipped', reason: claim.reason };

  // ── Compute the archive (with a small retry for transient Firestore errors) ──
  try {
    const { salesSummary, expenseSummary, productionExpenseSummary, productionSummary, stockSnapshot } =
      await withRetry(() => buildArchive(businessDate, autoStockClosing), 3);

    const closedAt = new Date().toISOString();
    await ref.set(
      {
        status: 'success',
        salesSummary,
        expenseSummary,
        productionExpenseSummary,
        productionSummary,
        stockSnapshot,
        error: null,
        closedAt,
        durationMs: Date.now() - new Date(startedAt).getTime(),
      },
      { merge: true },
    );
    console.log(`[daily-closing] Closed business day ${businessDate} (${closedBy}).`);
    return { businessDate, status: 'success' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ref.set(
      { status: 'failed', error: message, closedAt: new Date().toISOString() },
      { merge: true },
    ).catch(() => undefined);
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

  const [ordersSnap, expensesSnap, prodExpensesSnap, prodOrdersSnap, returnsSnap, balancesSnap, branchesSnap] =
    await Promise.all([
      adminDb.collection('orders').where('createdAt', '>=', fromISO).where('createdAt', '<=', toISO).get(),
      adminDb.collection('expenses').where('date', '==', businessDate).get(),
      adminDb.collection('production_expenses').where('date', '==', businessDate).get(),
      adminDb.collection('production_orders').where('date', '==', businessDate).get(),
      adminDb.collection('production_returns').where('date', '==', businessDate).get(),
      adminDb.collection('production_balances').get(),
      adminDb.collection('branches').where('isActive', '==', true).get(),
    ]);

  // ── Sales (non-cancelled) ──
  const emptyPm: Record<PaymentMethod, number> = { cash: 0, easypaisa: 0, foodpanda: 0, bank_account: 0 };
  const sales: SalesSummary = {
    totalSales: 0, totalOrders: 0, byPaymentMethod: { ...emptyPm }, totalDiscounts: 0, governmentTax: 0, netSales: 0,
  };
  for (const d of ordersSnap.docs) {
    const o = d.data() as { status: string; grandTotal: number; discountTotal: number; taxAmount: number; paymentMethod: PaymentMethod };
    if (o.status === 'cancelled') continue;
    sales.totalOrders += 1;
    sales.totalSales += Number(o.grandTotal || 0);
    sales.totalDiscounts += Number(o.discountTotal || 0);
    sales.governmentTax += Number(o.taxAmount || 0);
    const pm = (o.paymentMethod || 'cash') as PaymentMethod;
    sales.byPaymentMethod[pm] = (sales.byPaymentMethod[pm] || 0) + Number(o.grandTotal || 0);
  }
  sales.netSales = sales.totalSales - sales.totalDiscounts - sales.governmentTax;

  // ── Shop expenses (no category field → group by description) ──
  const expenseSummary = summariseExpenses(
    expensesSnap.docs.map((d) => d.data() as { amount: number; paymentMethod: string; description?: string }),
    (e) => e.description || 'Uncategorised',
  );

  // ── Production expenses (have a category) ──
  const productionExpenseSummary = summariseExpenses(
    prodExpensesSnap.docs.map((d) => d.data() as { amount: number; paymentMethod: string; category?: string }),
    (e) => e.category || 'Uncategorised',
  );

  // ── Production ──
  type OItem = { qty?: number; approvedQty?: number };
  const prodOrders = prodOrdersSnap.docs.map((d) => d.data() as { status: string; items: OItem[] });
  const production: ProductionSummary = {
    ordersClosed: prodOrders.filter((o) => o.status === 'approved').length,
    ordersPending: prodOrders.filter((o) => o.status === 'pending').length,
    approvedQty: prodOrders
      .filter((o) => o.status === 'approved')
      .reduce((s, o) => s + o.items.reduce((t, i) => t + Number(i.approvedQty ?? i.qty ?? 0), 0), 0),
    returnedQty: returnsSnap.docs
      .map((d) => d.data() as { qty: number; status: string })
      .filter((r) => r.status === 'accepted')
      .reduce((s, r) => s + Number(r.qty || 0), 0),
    pendingBalanceQty: balancesSnap.docs.reduce((s, d) => s + Number(d.data()['pendingQty'] ?? 0), 0),
  };

  // ── Branch stock snapshot (carry-forward is automatic; this is the immutable archive) ──
  let stockSnapshot: StockSnapshotBranch[] | null = null;
  if (autoStockClosing) {
    const branches = branchesSnap.docs.map((d) => ({ id: d.id, name: (d.data() as { name: string }).name }));
    stockSnapshot = await Promise.all(
      branches.map(async (b) => ({
        branchId: b.id,
        branchName: b.name,
        rows: await computeStockRows(b.id, businessDate),
      })),
    );
  }

  return { salesSummary: sales, expenseSummary, productionExpenseSummary, productionSummary: production, stockSnapshot };
}

/** Roll up a set of expense rows into total + by-category + by-payment-method. */
function summariseExpenses<T extends { amount: number; paymentMethod: string }>(
  rows: T[],
  categoryOf: (row: T) => string,
): ExpenseSummary {
  const summary: ExpenseSummary = { total: 0, byCategory: {}, byPaymentMethod: {} };
  for (const r of rows) {
    const amt = Number(r.amount || 0);
    summary.total += amt;
    const cat = categoryOf(r);
    summary.byCategory[cat] = (summary.byCategory[cat] || 0) + amt;
    const pm = r.paymentMethod || 'cash';
    summary.byPaymentMethod[pm] = (summary.byPaymentMethod[pm] || 0) + amt;
  }
  return summary;
}

/** Retry an async op up to `attempts` times with linear backoff — for transient Firestore blips. */
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
  const doc = await adminDb.collection(CLOSURES).doc(businessDate).get();
  return doc.exists && (doc.data() as DailyClosure).status === 'success';
}

/** List closure/audit records, most recent first (default last 30 business days). */
export async function listClosures(days = 30): Promise<DailyClosure[]> {
  const since = businessDaysAgoStr(days - 1);
  const snap = await adminDb.collection(CLOSURES).get();
  return snap.docs
    .map((d) => d.data() as DailyClosure)
    .filter((c) => c.businessDate >= since)
    .sort((a, b) => b.businessDate.localeCompare(a.businessDate));
}

/** The currently-open business date (for callers that need "today" in business terms). */
export function currentBusinessDate(): string {
  return businessDateStr();
}
