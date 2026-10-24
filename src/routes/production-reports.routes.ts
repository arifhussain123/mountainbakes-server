import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { businessDateStr, businessDaysAgoStr } from '../shared';
import { getProductionStockRows } from '../services/production-stock.service';
import { getReturnStockRows } from '../services/return-stock.service';
import { genericPDF, genericExcel, genericExcelMultiSheet, genericCSV } from '../services/production-export.service';
import { getPreviousOrderBalance } from '../services/previous-balance.service';
import { format } from 'date-fns';
import { sortRows } from '../utils/sortRows';

const db = dbFor('production-reports');

export const router = Router();

// Production-only reporting surface — deliberately separate from /api/reports
// (sales/financials), which Production users must not access.
router.use(authenticate, requireRole('super_admin', 'production_user'));

export type ProductionReportType =
  | 'production'
  | 'prepared-detail'
  | 'branch-demand'
  | 'approved-orders'
  | 'pending-balance'
  | 'returned-products'
  | 'production-stock'
  | 'branch-return-stock'
  | 'branch-stock'
  | 'collections';

/** Karachi date-string range for a named period (anchored to today). */
function periodDateRange(period: string): { fromStr: string; toStr: string } {
  const todayStr = businessDateStr();
  if (period === 'daily') return { fromStr: todayStr, toStr: todayStr };
  if (period === 'weekly') {
    const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay();
    return { fromStr: businessDaysAgoStr((dow + 6) % 7), toStr: todayStr };
  }
  if (period === 'yearly') return { fromStr: `${todayStr.slice(0, 4)}-01-01`, toStr: todayStr };
  // monthly (default)
  return { fromStr: `${todayStr.slice(0, 7)}-01`, toStr: todayStr };
}

/**
 * Ceiling on the prepare-ledger rows one "Prepared Items" read will pull. The
 * report aggregates in Node, so an unbounded window is an unbounded memory read;
 * 20 000 rows is roughly a year of every product being prepared every day.
 */
const PREPARED_ROW_CAP = 20_000;

/** Reports driven by an explicit from/to window instead of the period dropdown. */
function usesDateRange(report: string): boolean {
  return report === 'prepared-detail' || report === 'collections';
}

/**
 * Ceiling on the deliveries one Collections export will bill.
 *
 * Each row costs a `getPreviousOrderBalance` call — several queries apiece — so
 * this is a wall-clock bound, not a memory one. When it bites, the sheet says so
 * in a final row rather than just stopping: a truncated export that looks
 * complete is how a collection goes uncollected.
 */
const COLLECTIONS_ORDER_CAP = 750;

/** Resolve `tasks` at most `limit` at a time, preserving input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The explicit `from`/`to` window the date-wise reports run on. Both default to
 * today (the common case: "what did we prepare today?") and a reversed pair is
 * swapped rather than silently returning nothing.
 */
function explicitDateRange(from: unknown, to: unknown): { fromStr: string; toStr: string } {
  const todayStr = businessDateStr();
  const clean = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const a = clean(from) || clean(to) || todayStr;
  const b = clean(to) || clean(from) || todayStr;
  return a <= b ? { fromStr: a, toStr: b } : { fromStr: b, toStr: a };
}

interface RItem { qty: number; approved_qty?: number | null; total_required_qty?: number | null; remaining_balance_qty?: number | null }
interface RDoc { branch_id: string; branch_name: string; business_date: string; status: string; approved_by_name?: string | null; items: RItem[] }

const ORDER_WITH_ITEMS =
  'branch_id, branch_name, business_date, status, approved_by_name, items:production_order_items(qty, approved_qty, total_required_qty, remaining_balance_qty)';

/** Build a titled, tabular report dataset for the given type + period. */
async function buildReport(
  report: string,
  period: string,
  range?: { fromStr: string; toStr: string },
  /** Scope to one branch. Empty/absent means every branch — the default. */
  branchId?: string,
): Promise<{
  title: string;
  headers: string[];
  rows: (string | number)[][];
  /**
   * Trailing rows that are not data — a TOTAL line, a footnote about rows
   * held back — and so must stay pinned at the end of the table rather than
   * being sorted in among the real rows. Only `prepared-detail` and
   * `collections` ever append these; every other report type is 0 (the
   * default at every call site that reads this field).
   */
  specialRowCount?: number;
  /**
   * Further tabs for the Excel export only, after the main sheet. PDF, CSV and
   * the JSON preview carry just the main table. Only `collections` sets it.
   */
  extraSheets?: { title: string; headers: string[]; rows: (string | number)[][] }[];
}> {
  // `prepared-detail` and `collections` are driven by an explicit from/to window
  // rather than the period dropdown; every other report still anchors to the
  // named period. See usesDateRange.
  const { fromStr, toStr } = range ?? periodDateRange(period);
  const inRange = (d: string) => d >= fromStr && d <= toStr;

  switch (report) {
    case 'prepared-detail': {
      // One line per PRODUCT over the window — the same item prepared on several
      // days collapses into a single row carrying the window's total, so a range
      // reads as "what did we make, and how much of it". Read straight off the
      // pool ledger rather than from getProductionStockRows, which can only
      // answer for a single date.
      //
      // Deltas are summed SIGNED: a day can hold several prep batches, and an
      // admin lowering "Prepared Today" appends a negative 'prepare' movement.
      // abs() here would report a correction as extra production.
      const { data, error } = await db
        .from('production_stock_history')
        .select('product_id, product_name, delta, business_date')
        .eq('type', 'prepare')
        .gte('business_date', fromStr)
        .lte('business_date', toStr)
        .order('business_date', { ascending: true })
        .range(0, PREPARED_ROW_CAP - 1);
      if (error) throw error;

      const movements = (data ?? []) as
        { product_id: string; product_name: string; delta: number | string; business_date: string }[];

      // Item code + category come off the catalogue — the ledger stores neither.
      const productIds = [...new Set(movements.map((m) => m.product_id))];
      const meta = new Map<string, { code: string; category: string }>();
      if (productIds.length > 0) {
        const { data: prods, error: prodErr } = await db
          .from('products')
          .select('id, stock_code, category_name')
          .in('id', productIds);
        if (prodErr) throw prodErr;
        for (const pr of (prods ?? []) as { id: string; stock_code: string | null; category_name: string | null }[]) {
          meta.set(pr.id, { code: pr.stock_code ?? '—', category: pr.category_name ?? '' });
        }
      }

      const byProduct = new Map<string, { productId: string; name: string; qty: number }>();
      for (const m of movements) {
        const cur = byProduct.get(m.product_id)
          ?? { productId: m.product_id, name: m.product_name, qty: 0 };
        cur.qty += Number(m.delta ?? 0);
        byProduct.set(m.product_id, cur);
      }

      // A product whose corrections cancel its batches netted to nothing over the
      // window and did not get prepared — dropping it keeps the sheet to real
      // production.
      const detail = [...byProduct.values()]
        .filter((r) => r.qty !== 0)
        .sort((a, b) => a.name.localeCompare(b.name));

      const body: (string | number)[][] = detail.map((r) => [
        meta.get(r.productId)?.code ?? '—',
        r.name,
        meta.get(r.productId)?.category ?? '',
        r.qty,
      ]);
      if (detail.length > 0) {
        body.push(['Total', '', '', detail.reduce((sum, r) => sum + r.qty, 0)]);
      }

      return {
        title: fromStr === toStr
          ? `Prepared Items — ${fromStr}`
          : `Prepared Items — ${fromStr} to ${toStr}`,
        headers: ['Item Code', 'Product', 'Category', 'Qty Prepared'],
        rows: body,
        specialRowCount: detail.length > 0 ? 1 : 0,
      };
    }
    case 'production-stock': {
      const rows = await getProductionStockRows();
      // The same nine columns, in the same order, as the Production Stock page —
      // exported from the SAME query, so the sheet and the screen cannot disagree.
      //
      // "From Returns" is what was explicitly TRANSFERRED in from Branch Return
      // Stock (plus the pre-migration-139 automatic credit on old days). Branch
      // Return Stock itself is a different inventory and has its own report.
      return {
        title: 'Production Stock',
        headers: [
          'Product', 'Opening Stock', 'Prepared Stock', 'Total Stock',
          'Branch Demand Stock', 'Sale', 'From Returns', 'Adjustment', 'Balance',
        ],
        rows: rows.map((r) => [
          r.productName,
          r.opening,
          r.preparedToday,
          r.totalStock,
          r.branchDemand,
          r.soldToday,
          r.returnTransferIn + r.returned,
          r.adjustment,
          r.balance,
        ]),
      };
    }
    case 'branch-return-stock': {
      // A separate inventory from Production Stock — never summed with it.
      const rows = await getReturnStockRows();
      return {
        title: 'Branch Return Stock',
        headers: ['Product', 'Opening', 'Returned Today', 'Transferred to Production', 'Return Stock'],
        rows: rows.map((r) => [r.productName, r.opening, r.returnedToday, r.transferredToday, r.balance]),
      };
    }
    case 'branch-stock': {
      const [stockRes, branchesRes, productsRes] = await Promise.all([
        db.from('stock').select('branch_id, product_id, balance'),
        db.from('branches').select('id, name').eq('is_active', true),
        db.from('products').select('id, name').eq('is_active', true),
      ]);
      for (const r of [stockRes, branchesRes, productsRes]) { if (r.error) throw r.error; }

      const branches = ((branchesRes.data ?? []) as { id: string; name: string }[])
        .map((b) => ({ id: b.id, name: b.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const balances: Record<string, Record<string, number>> = {};
      for (const s of (stockRes.data ?? []) as { branch_id: string; product_id: string; balance: number }[]) {
        (balances[s.product_id] ||= {})[s.branch_id] = Number(s.balance ?? 0);
      }
      const products = ((productsRes.data ?? []) as { id: string; name: string }[])
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        title: 'Branch Stock',
        headers: ['Product', ...branches.map((b) => b.name)],
        rows: products.map((p) => [p.name, ...branches.map((b) => balances[p.id]?.[b.id] ?? 0)]),
      };
    }
    case 'branch-demand': {
      // Every row counts here regardless of status, so a demand the branch
      // deleted has to be dropped at the query or it inflates that branch's
      // demand and order count.
      const { data, error } = await db
        .from('production_orders')
        .select(ORDER_WITH_ITEMS)
        .gte('business_date', fromStr)
        .lte('business_date', toStr)
        .neq('status', 'cancelled')
        .range(0, PREPARED_ROW_CAP - 1);
      if (error) throw error;
      const orders = ((data ?? []) as unknown as RDoc[]).filter((o) => inRange(o.business_date));
      const map: Record<string, { name: string; qty: number; required: number; pending: number; orders: number }> = {};
      for (const o of orders) {
        const items = o.items ?? [];
        const qty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
        const required = items.reduce((s, i) => s + Number(i.total_required_qty ?? i.qty ?? 0), 0);
        const pending = items.reduce((s, i) => s + Number(i.remaining_balance_qty ?? 0), 0);
        if (!map[o.branch_id]) map[o.branch_id] = { name: o.branch_name, qty: 0, required: 0, pending: 0, orders: 0 };
        map[o.branch_id]!.qty += qty;
        map[o.branch_id]!.required += required;
        map[o.branch_id]!.pending += pending;
        map[o.branch_id]!.orders += 1;
      }
      return {
        title: 'Branch Demand',
        headers: ['Branch', 'Total Demand Qty', 'Total Required', 'Pending Balance', 'Orders'],
        rows: Object.values(map).sort((a, b) => b.qty - a.qty).map((b) => [b.name, b.qty, b.required, b.pending, b.orders]),
      };
    }
    case 'approved-orders': {
      const { data, error } = await db
        .from('production_orders')
        .select(ORDER_WITH_ITEMS)
        .gte('business_date', fromStr)
        .lte('business_date', toStr)
        .range(0, PREPARED_ROW_CAP - 1);
      if (error) throw error;
      const orders = ((data ?? []) as unknown as RDoc[]).filter((o) => o.status === 'approved' && inRange(o.business_date));
      return {
        title: 'Approved Orders',
        headers: ['Date', 'Branch', 'Products', 'Total Required', 'Approved Qty', 'Pending', 'Approved By'],
        rows: orders.map((o) => {
          const items = o.items ?? [];
          return [
            o.business_date,
            o.branch_name,
            items.length,
            items.reduce((s, i) => s + Number(i.total_required_qty ?? i.qty), 0),
            items.reduce((s, i) => s + Number(i.approved_qty ?? i.qty), 0),
            items.reduce((s, i) => s + Number(i.remaining_balance_qty ?? 0), 0),
            o.approved_by_name || '',
          ];
        }),
      };
    }
    case 'pending-balance': {
      // Snapshot of outstanding carry-forward balances (not period-filtered).
      const { data, error } = await db
        .from('production_balances')
        .select('branch_name, product_name, pending_qty, updated_at');
      if (error) throw error;
      const rows = ((data ?? []) as { branch_name?: string; product_name: string; pending_qty: number; updated_at?: string }[])
        .filter((b) => Number(b.pending_qty ?? 0) > 0)
        .sort((a, b) => (a.branch_name ?? '').localeCompare(b.branch_name ?? '') || a.product_name.localeCompare(b.product_name));
      return {
        title: 'Pending Balance',
        headers: ['Branch', 'Product', 'Pending Qty', 'Updated'],
        rows: rows.map((r) => [r.branch_name ?? '', r.product_name, Number(r.pending_qty ?? 0), (r.updated_at ?? '').slice(0, 10)]),
      };
    }
    case 'returned-products': {
      const { data, error } = await db
        .from('production_returns')
        .select('business_date, branch_name, product_name, qty, reason, status')
        .gte('business_date', fromStr)
        .lte('business_date', toStr)
        .range(0, PREPARED_ROW_CAP - 1);
      if (error) throw error;
      const returns = ((data ?? []) as { business_date: string; branch_name: string; product_name: string; qty: number; reason: string; status: string }[])
        .filter((r) => inRange(r.business_date));
      return {
        title: 'Returned Products',
        headers: ['Date', 'Branch', 'Product', 'Qty', 'Reason', 'Status'],
        rows: returns.map((r) => [r.business_date, r.branch_name, r.product_name, r.qty, r.reason, r.status]),
      };
    }
    case 'collections': {
      // One row per DELIVERY, carrying what the branch owes for it — the same
      // figures the company copy of the next slip prints.
      //
      // Two things about the window are easy to get wrong. First, it filters the
      // delivery being BILLED, but those figures are keyed by that delivery's
      // SUCCESSOR (getPreviousOrderBalance walks backwards from an order to the
      // one before it), so the query must not stop at `toStr` — the successor of
      // the last delivery in the window usually falls outside it.
      //
      // Second, a delivery with no successor yet has never been billed on any
      // slip, so there is no figure to export for it. That is not this report
      // being lossy: the amount genuinely does not exist until the next delivery
      // fixes the window the returns and discounts are counted in. The final row
      // says how many were held back for that reason, so a short sheet is never
      // mistaken for a quiet day.
      let q = db
        .from('production_orders')
        .select('id, branch_id, branch_name, demand_number, business_date, submitted_at')
        .in('status', ['awaiting_verification', 'approved'])
        .gte('business_date', fromStr)
        .order('submitted_at', { ascending: true });
      if (branchId) q = q.eq('branch_id', branchId);
      const { data, error } = await q;
      if (error) throw error;

      type ORow = { id: string; branch_id: string; branch_name: string | null; demand_number: string; business_date: string; submitted_at: string };
      const all = (data ?? []) as ORow[];

      // Chained per branch: "the previous order" only means anything within one
      // branch's own sequence of deliveries.
      const byBranch = new Map<string, ORow[]>();
      for (const o of all) {
        const list = byBranch.get(o.branch_id);
        if (list) list.push(o); else byBranch.set(o.branch_id, [o]);
      }

      const billable: { billed: ORow; successorId: string }[] = [];
      let unbilled = 0;
      for (const list of byBranch.values()) {
        for (let i = 0; i < list.length; i++) {
          const billed = list[i]!;
          if (!inRange(billed.business_date)) continue;
          const successor = list[i + 1];
          if (!successor) { unbilled++; continue; }
          billable.push({ billed, successorId: successor.id });
        }
      }
      billable.sort(
        (a, b) =>
          (a.billed.branch_name ?? '').localeCompare(b.billed.branch_name ?? '') ||
          a.billed.business_date.localeCompare(b.billed.business_date),
      );

      const truncated = billable.length > COLLECTIONS_ORDER_CAP;
      const wanted = truncated ? billable.slice(0, COLLECTIONS_ORDER_CAP) : billable;

      // Modest concurrency: each balance is several round trips, and a month
      // across every branch run strictly serially is a minute of dead air.
      const balances = await mapWithConcurrency(wanted, 8, (b) => getPreviousOrderBalance(b.successorId));

      const rows: (string | number)[][] = [];
      const totals = { delivered: 0, share: 0, retQty: 0, returns: 0, discount: 0, collect: 0 };
      const receivedById = new Map<string, number>();
      // The By Branch sheet: the rows above summed per branch, the way a pivot
      // on Branch would sum them. Deposits are de-duplicated per branch for the
      // same reason as in the TOTAL.
      type BranchSum = { deliveries: number; delivered: number; share: number; retQty: number; returns: number; discount: number; collect: number; receivedById: Map<string, number> };
      const perBranch = new Map<string, BranchSum>();
      for (let i = 0; i < wanted.length; i++) {
        const bal = balances[i];
        // `previous` is the authoritative identity of the billed delivery — it is
        // what the slip printed. Taken from the balance rather than from our own
        // row so the label and the figures beside it can never disagree.
        if (!bal?.previous) continue;
        const retQty = bal.returnItems.reduce((a, r) => a + r.qty, 0);
        totals.delivered += bal.deliveredValue;
        totals.share += bal.companyShareValue;
        totals.retQty += retQty;
        totals.returns += bal.returnsValue;
        totals.discount += bal.discountsValue;
        totals.collect += bal.amountToCollect;
        // A day's deposits print on every slip of that day (see
        // paymentsReceivedInWindow), so two rows can carry the same transfer.
        // Each row shows what its slip shows; the TOTAL counts money once.
        for (const p of bal.paymentItems) receivedById.set(p.transferId, p.amount);
        const branchName = wanted[i]!.billed.branch_name ?? '';
        let sum = perBranch.get(branchName);
        if (!sum) {
          sum = { deliveries: 0, delivered: 0, share: 0, retQty: 0, returns: 0, discount: 0, collect: 0, receivedById: new Map() };
          perBranch.set(branchName, sum);
        }
        sum.deliveries++;
        sum.delivered += bal.deliveredValue;
        sum.share += bal.companyShareValue;
        sum.retQty += retQty;
        sum.returns += bal.returnsValue;
        sum.discount += bal.discountsValue;
        sum.collect += bal.amountToCollect;
        for (const p of bal.paymentItems) sum.receivedById.set(p.transferId, p.amount);
        rows.push([
          wanted[i]!.billed.branch_name ?? '',
          bal.previous.demandNumber,
          bal.previous.date,
          Math.round(bal.deliveredValue),
          Math.round(bal.companyShareValue),
          retQty,
          Math.round(bal.returnsValue),
          Math.round(bal.discountsValue),
          Math.round(bal.amountToCollect),
          Math.round(bal.paymentsReceivedValue),
          Math.round(bal.remainingBalance),
        ]);
      }

      // `billable` is sorted by branch name, so the map already iterates in
      // branch order. Remaining is per branch and floored at zero: one branch
      // paying ahead does not lower what another owes, so the grand total is
      // the column's sum rather than the main sheet's TOTAL (they differ only
      // when some branch has paid more than it owes).
      const branchRows: (string | number)[][] = [];
      const grand = { deliveries: 0, delivered: 0, share: 0, retQty: 0, returns: 0, discount: 0, collect: 0, received: 0, remaining: 0 };
      for (const [name, b] of perBranch) {
        const received = [...b.receivedById.values()].reduce((a, v) => a + v, 0);
        const remaining = Math.max(0, b.collect - received);
        grand.deliveries += b.deliveries;
        grand.delivered += Math.round(b.delivered);
        grand.share += Math.round(b.share);
        grand.retQty += b.retQty;
        grand.returns += Math.round(b.returns);
        grand.discount += Math.round(b.discount);
        grand.collect += Math.round(b.collect);
        grand.received += Math.round(received);
        grand.remaining += Math.round(remaining);
        branchRows.push([name, b.deliveries, Math.round(b.delivered), Math.round(b.share), b.retQty, Math.round(b.returns), Math.round(b.discount), Math.round(b.collect), Math.round(received), Math.round(remaining)]);
      }
      if (branchRows.length > 0) {
        branchRows.push(['GRAND TOTAL', grand.deliveries, grand.delivered, grand.share, grand.retQty, grand.returns, grand.discount, grand.collect, grand.received, grand.remaining]);
      }

      let specialRowCount = 0;
      if (rows.length > 0) {
        const received = [...receivedById.values()].reduce((a, v) => a + v, 0);
        // Derived from the two totals beside it rather than summed down the
        // column: the rows' own Remaining each net off a full day's deposits,
        // so adding them up would subtract a shared deposit more than once.
        const remaining = Math.max(0, totals.collect - received);
        rows.push(['TOTAL', '', '', Math.round(totals.delivered), Math.round(totals.share), totals.retQty, Math.round(totals.returns), Math.round(totals.discount), Math.round(totals.collect), Math.round(received), Math.round(remaining)]);
        specialRowCount++;
      }
      if (unbilled > 0) {
        rows.push([`${unbilled} delivery(s) in this window have no later delivery yet, so nothing has been billed for them.`, '', '', '', '', '', '', '', '', '', '']);
        specialRowCount++;
      }
      if (truncated) {
        rows.push([`Showing the first ${COLLECTIONS_ORDER_CAP} of ${billable.length} deliveries — narrow the date range or pick one branch.`, '', '', '', '', '', '', '', '', '', '']);
        specialRowCount++;
      }

      return {
        title: 'Collections',
        // Money is written as plain numbers, not "Rs. 37,600" — a spreadsheet
        // that cannot sum its own money column is a picture of a report. Zero
        // prints as 0 rather than the slip's em dash for the same reason.
        // Payment Received (approved cash transfers in the slip's window, plus
        // the rest of those days' deposits) and Remaining are appended AFTER
        // Amount to Collect, which is unchanged.
        headers: ['Branch', 'Previous Order', 'Date', 'Delivered Value', 'Company Share', 'Less Returns Qty', 'Less Returns', 'Less Discount', 'Amount to Collect', 'Payment Received', 'Remaining'],
        rows,
        specialRowCount,
        extraSheets: [{
          title: 'By Branch',
          headers: ['Branch', 'Deliveries', 'Delivered Value', 'Company Share', 'Less Returns Qty', 'Less Returns', 'Less Discount', 'Amount to Collect', 'Payment Received', 'Remaining'],
          rows: branchRows,
        }],
      };
    }
    case 'production':
    default: {
      // Prepared production by day.
      const { data, error } = await db
        .from('production_stock_history')
        .select('type, delta, business_date')
        .gte('business_date', fromStr)
        .lte('business_date', toStr)
        // Same reasoning as `prepared-detail` above: this aggregates in Node, so
        // an unbounded window is an unbounded memory read.
        .range(0, PREPARED_ROW_CAP - 1);
      if (error) throw error;
      const byDay: Record<string, number> = {};
      for (const h of (data ?? []) as { type: string; delta: number; business_date: string }[]) {
        if (h.type !== 'prepare' || !inRange(h.business_date)) continue;
        byDay[h.business_date] = (byDay[h.business_date] || 0) + Math.abs(Number(h.delta) || 0);
      }
      return {
        title: 'Production',
        headers: ['Date', 'Prepared Qty'],
        rows: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, qty]) => [date, qty]),
      };
    }
  }
}

/**
 * The only two report types whose row count is one-per-record (a demand order,
 * a return) rather than aggregated to one-per-branch/date/product — every other
 * type stays small by construction, so paginating it would just be UI for no
 * reason. `/export` never consults this: the exported file is the document of
 * record and must hold every (capped) row, not one screen's worth.
 */
const PAGINATED_PRODUCTION_REPORT_TYPES = new Set(['approved-orders', 'returned-products']);

// GET /api/production-reports/summary?report=&period=&from=&to=&page=&pageSize= — JSON preview
router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const report = String(req.query['report'] || 'production');
    const period = String(req.query['period'] || 'monthly');
    const range = usesDateRange(report) ? explicitDateRange(req.query['from'], req.query['to']) : undefined;
    const branchId = typeof req.query['branchId'] === 'string' ? req.query['branchId'] : '';
    // Extra Excel tabs are for the file, not the on-screen preview.
    const { extraSheets: _extraSheets, ...data } = await buildReport(report, period, range, branchId);

    // Column-INDEX sort, not a key — these rows are positional arrays with no
    // per-cell name (unlike the keyed Finance Reports). A trailing TOTAL/
    // footnote row (see `specialRowCount`) is held back so it can't be sorted
    // in among the data, then reattached at the end.
    const sortCol = Math.trunc(Number(req.query['sortCol']));
    const sortDir = req.query['sortDir'] === 'asc' ? 'asc' : 'desc';
    if (Number.isInteger(sortCol) && sortCol >= 0 && sortCol < data.headers.length) {
      const specialCount = Math.min(data.specialRowCount ?? 0, data.rows.length);
      const cutoff = data.rows.length - specialCount;
      const dataRows = data.rows.slice(0, cutoff);
      const specialRows = data.rows.slice(cutoff);
      const sample = dataRows.find((r) => r[sortCol] != null)?.[sortCol];
      const accessor = (row: (string | number)[]) => (typeof sample === 'number' ? Number(row[sortCol]) : row[sortCol]);
      data.rows = [...sortRows(dataRows, accessor, sortDir), ...specialRows];
    }

    if (!PAGINATED_PRODUCTION_REPORT_TYPES.has(report)) {
      res.json(data);
      return;
    }

    const pageSize = Math.min(500, Math.max(1, Math.trunc(Number(req.query['pageSize'])) || 50));
    const total = data.rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Math.trunc(Number(req.query['page'])) || 1), totalPages);
    const start = (page - 1) * pageSize;
    res.json({
      ...data,
      rows: data.rows.slice(start, start + pageSize),
      pagination: { page, pageSize, total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1 },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-reports/export?report=&period=&from=&to=&type=pdf|excel|csv
router.get('/export', async (req: AuthRequest, res, next) => {
  try {
    const report = String(req.query['report'] || 'production');
    const period = String(req.query['period'] || 'monthly');
    const exportType = String(req.query['type'] || 'excel');
    const range = usesDateRange(report) ? explicitDateRange(req.query['from'], req.query['to']) : undefined;
    const branchId = typeof req.query['branchId'] === 'string' ? req.query['branchId'] : '';
    const { title, headers, rows, extraSheets } = await buildReport(report, period, range, branchId);
    // A range report names the window it covers, so two exports taken the same
    // day for different windows don't land on the same filename.
    const dateLabel = range
      ? (range.fromStr === range.toStr ? range.fromStr : `${range.fromStr}_to_${range.toStr}`)
      : format(new Date(), 'yyyy-MM-dd');
    const filename = `mountain-bakes-${report}-${dateLabel}`;

    if (exportType === 'pdf') {
      const buffer = await genericPDF(title, headers, rows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
      res.send(buffer);
    } else if (exportType === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(genericCSV(headers, rows));
    } else {
      const buffer = extraSheets?.length
        ? await genericExcelMultiSheet([{ title, headers, rows }, ...extraSheets])
        : await genericExcel(title, headers, rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
    }
  } catch (err) {
    next(err);
  }
});
