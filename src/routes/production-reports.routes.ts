import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
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

interface RItem { qty: number; approved_qty?: number | null; total_required_qty?: number | null; remaining_balance_qty?: number | null }
interface RDoc { branch_id: string; branch_name: string; business_date: string; status: string; approved_by_name?: string | null; items: RItem[] }

const ORDER_WITH_ITEMS =
  'branch_id, branch_name, business_date, status, approved_by_name, items:production_order_items(qty, approved_qty, total_required_qty, remaining_balance_qty)';

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
      const [stockRes, branchesRes, productsRes] = await Promise.all([
        supabaseAdmin.from('stock').select('branch_id, product_id, balance'),
        supabaseAdmin.from('branches').select('id, name').eq('is_active', true),
        supabaseAdmin.from('products').select('id, name').eq('is_active', true),
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
      const { data, error } = await supabaseAdmin.from('production_orders').select(ORDER_WITH_ITEMS).gte('business_date', fromStr);
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
      const { data, error } = await supabaseAdmin.from('production_orders').select(ORDER_WITH_ITEMS).gte('business_date', fromStr);
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
      const { data, error } = await supabaseAdmin
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
      const { data, error } = await supabaseAdmin
        .from('production_returns')
        .select('business_date, branch_name, product_name, qty, reason, status')
        .gte('business_date', fromStr);
      if (error) throw error;
      const returns = ((data ?? []) as { business_date: string; branch_name: string; product_name: string; qty: number; reason: string; status: string }[])
        .filter((r) => inRange(r.business_date));
      return {
        title: 'Returned Products',
        headers: ['Date', 'Branch', 'Product', 'Qty', 'Reason', 'Status'],
        rows: returns.map((r) => [r.business_date, r.branch_name, r.product_name, r.qty, r.reason, r.status]),
      };
    }
    case 'production-expenses': {
      const { data, error } = await supabaseAdmin
        .from('production_expenses')
        .select('business_date, category, description, amount, payment_method, supplier')
        .gte('business_date', fromStr);
      if (error) throw error;
      const expenses = ((data ?? []) as { business_date: string; category: string; description: string; amount: number; payment_method: string; supplier: string }[])
        .filter((e) => inRange(e.business_date));
      return {
        title: 'Production Expenses',
        headers: ['Date', 'Category', 'Description', 'Amount', 'Payment', 'Supplier'],
        rows: expenses.map((e) => [e.business_date, e.category, e.description, e.amount, e.payment_method, e.supplier || '']),
      };
    }
    case 'production':
    default: {
      // Prepared production by day.
      const { data, error } = await supabaseAdmin
        .from('production_stock_history')
        .select('type, delta, business_date')
        .gte('business_date', fromStr);
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
