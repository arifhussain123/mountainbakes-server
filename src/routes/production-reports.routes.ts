import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { businessDateStr, businessDaysAgoStr } from '../shared';
import { getProductionStockRows } from '../services/production-stock.service';
import { genericPDF, genericExcel, genericCSV } from '../services/production-export.service';
import { format } from 'date-fns';

export const router = Router();

// Production-only reporting surface — deliberately separate from /api/reports
// (sales/financials), which Production users must not access.
router.use(authenticate, requireRole('super_admin', 'production_user'));

export type ProductionReportType =
  | 'production'
  | 'branch-demand'
  | 'approved-orders'
  | 'pending-balance'
  | 'returned-products'
  | 'production-stock'
  | 'branch-stock'
  | 'production-expenses';

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

type OItem = { productId: string; productName: string; qty: number; approvedQty?: number; previousBalanceQty?: number; totalRequiredQty?: number; remainingBalanceQty?: number };
type ODoc = { branchId: string; branchName: string; date: string; status: string; approvedByName?: string; wasChanged?: boolean; items: OItem[] };

/** Build a titled, tabular report dataset for the given type + period. */
async function buildReport(
  report: string,
  period: string,
): Promise<{ title: string; headers: string[]; rows: (string | number)[][] }> {
  const { fromStr, toStr } = periodDateRange(period);
  const inRange = (d: string) => d >= fromStr && d <= toStr;

  switch (report) {
    case 'production-stock': {
      const rows = await getProductionStockRows();
      return {
        title: 'Production Stock',
        headers: ['Product', 'Prepared Today', 'Total Stock', 'Approved Qty', 'Balance', 'Returned'],
        rows: rows.map((r) => [r.productName, r.preparedToday, r.totalStock, r.approvedQty, r.balance, r.returned]),
      };
    }
    case 'branch-stock': {
      const [stockSnap, branchesSnap, productsSnap] = await Promise.all([
        adminDb.collection('stock').get(),
        adminDb.collection('branches').where('isActive', '==', true).get(),
        adminDb.collection('products').where('isActive', '==', true).get(),
      ]);
      const branches = branchesSnap.docs
        .map((d) => ({ id: d.id, name: (d.data() as { name: string }).name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const balances: Record<string, Record<string, number>> = {};
      for (const doc of stockSnap.docs) {
        const s = doc.data() as { branchId: string; productId: string; balance: number };
        (balances[s.productId] ||= {})[s.branchId] = Number(s.balance ?? 0);
      }
      const products = productsSnap.docs
        .map((d) => ({ id: d.id, name: (d.data() as { name: string }).name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        title: 'Branch Stock',
        headers: ['Product', ...branches.map((b) => b.name)],
        rows: products.map((p) => [p.name, ...branches.map((b) => balances[p.id]?.[b.id] ?? 0)]),
      };
    }
    case 'branch-demand': {
      const snap = await adminDb.collection('production_orders').where('date', '>=', fromStr).get();
      const orders = snap.docs.map((d) => d.data() as ODoc).filter((o) => inRange(o.date));
      const map: Record<string, { name: string; qty: number; required: number; pending: number; orders: number }> = {};
      for (const o of orders) {
        const qty = o.items.reduce((s, i) => s + (i.qty || 0), 0);
        const required = o.items.reduce((s, i) => s + (i.totalRequiredQty ?? i.qty ?? 0), 0);
        const pending = o.items.reduce((s, i) => s + (i.remainingBalanceQty ?? 0), 0);
        if (!map[o.branchId]) map[o.branchId] = { name: o.branchName, qty: 0, required: 0, pending: 0, orders: 0 };
        map[o.branchId]!.qty += qty;
        map[o.branchId]!.required += required;
        map[o.branchId]!.pending += pending;
        map[o.branchId]!.orders += 1;
      }
      return {
        title: 'Branch Demand',
        headers: ['Branch', 'Total Demand Qty', 'Total Required', 'Pending Balance', 'Orders'],
        rows: Object.values(map).sort((a, b) => b.qty - a.qty).map((b) => [b.name, b.qty, b.required, b.pending, b.orders]),
      };
    }
    case 'approved-orders': {
      const snap = await adminDb.collection('production_orders').where('date', '>=', fromStr).get();
      const orders = snap.docs.map((d) => d.data() as ODoc).filter((o) => o.status === 'approved' && inRange(o.date));
      return {
        title: 'Approved Orders',
        headers: ['Date', 'Branch', 'Products', 'Total Required', 'Approved Qty', 'Pending', 'Approved By'],
        rows: orders.map((o) => [
          o.date,
          o.branchName,
          o.items.length,
          o.items.reduce((s, i) => s + (i.totalRequiredQty ?? i.qty), 0),
          o.items.reduce((s, i) => s + (i.approvedQty ?? i.qty), 0),
          o.items.reduce((s, i) => s + (i.remainingBalanceQty ?? 0), 0),
          o.approvedByName || '',
        ]),
      };
    }
    case 'pending-balance': {
      // Snapshot of outstanding carry-forward balances (not period-filtered).
      const snap = await adminDb.collection('production_balances').get();
      const rows = snap.docs
        .map((d) => d.data() as { branchName?: string; productName: string; pendingQty: number; updatedAt?: string })
        .filter((b) => Number(b.pendingQty ?? 0) > 0)
        .sort((a, b) => (a.branchName ?? '').localeCompare(b.branchName ?? '') || a.productName.localeCompare(b.productName));
      return {
        title: 'Pending Balance',
        headers: ['Branch', 'Product', 'Pending Qty', 'Updated'],
        rows: rows.map((r) => [r.branchName ?? '', r.productName, Number(r.pendingQty ?? 0), (r.updatedAt ?? '').slice(0, 10)]),
      };
    }
    case 'returned-products': {
      const snap = await adminDb.collection('production_returns').where('date', '>=', fromStr).get();
      const returns = snap.docs
        .map((d) => d.data() as { date: string; branchName: string; productName: string; qty: number; reason: string; status: string })
        .filter((r) => inRange(r.date));
      return {
        title: 'Returned Products',
        headers: ['Date', 'Branch', 'Product', 'Qty', 'Reason', 'Status'],
        rows: returns.map((r) => [r.date, r.branchName, r.productName, r.qty, r.reason, r.status]),
      };
    }
    case 'production-expenses': {
      const snap = await adminDb.collection('production_expenses').where('date', '>=', fromStr).get();
      const expenses = snap.docs
        .map((d) => d.data() as { date: string; category: string; description: string; amount: number; paymentMethod: string; supplier: string })
        .filter((e) => inRange(e.date));
      return {
        title: 'Production Expenses',
        headers: ['Date', 'Category', 'Description', 'Amount', 'Payment', 'Supplier'],
        rows: expenses.map((e) => [e.date, e.category, e.description, e.amount, e.paymentMethod, e.supplier || '']),
      };
    }
    case 'production':
    default: {
      // Prepared production by day.
      const snap = await adminDb.collection('production_stock_history').where('date', '>=', fromStr).get();
      const byDay: Record<string, number> = {};
      for (const doc of snap.docs) {
        const h = doc.data() as { type: string; delta: number; date: string };
        if (h.type !== 'prepare' || !inRange(h.date)) continue;
        byDay[h.date] = (byDay[h.date] || 0) + Math.abs(h.delta);
      }
      return {
        title: 'Production',
        headers: ['Date', 'Prepared Qty'],
        rows: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, qty]) => [date, qty]),
      };
    }
  }
}

// GET /api/production-reports/summary?report=&period= — JSON preview
router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const report = String(req.query['report'] || 'production');
    const period = String(req.query['period'] || 'monthly');
    const data = await buildReport(report, period);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/production-reports/export?report=&period=&type=pdf|excel|csv
router.get('/export', async (req: AuthRequest, res, next) => {
  try {
    const report = String(req.query['report'] || 'production');
    const period = String(req.query['period'] || 'monthly');
    const exportType = String(req.query['type'] || 'excel');
    const { title, headers, rows } = await buildReport(report, period);
    const dateLabel = format(new Date(), 'yyyy-MM-dd');
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
      const buffer = await genericExcel(title, headers, rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
    }
  } catch (err) {
    next(err);
  }
});
