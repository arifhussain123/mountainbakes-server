import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { notify } from '../services/push.service';
import { businessDateStr, businessDaysAgoStr } from '../shared';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

// The branch demand items live in production_order_items now; pull the fields the
// dashboard aggregates need. PostgREST does not order an embedded resource on its
// own, but the overview is order-independent (everything is summed), so no
// per-item ordering is requested here.
const ORDER_WITH_ITEMS = 'business_date, branch_id, branch_name, status, was_changed, items:production_order_items(product_id, product_name, qty, approved_qty)';

interface OItem { product_id: string; product_name: string; qty: number; approved_qty?: number | null }
interface ODoc { business_date: string; branch_id: string; branch_name: string; status: string; was_changed?: boolean; items: OItem[] }

// GET /api/production/overview — dashboard cards + chart series for Production.
router.get('/overview', async (_req, res, next) => {
  try {
    const todayStr = businessDateStr();
    const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    const weekStartStr = businessDaysAgoStr((dow + 6) % 7); // Monday of this week
    const monthStartStr = `${todayStr.slice(0, 7)}-01`;
    const last7 = businessDaysAgoStr(6);
    const historyFrom = weekStartStr < monthStartStr ? weekStartStr : monthStartStr;
    const demandFrom = businessDaysAgoStr(179); // ~6 months for the monthly chart
    const dayFrom = businessDaysAgoStr(29); // 30-day daily/weekly window

    const [ordersRes, prodStockRes, prepHistRes, returnsRes, branchesRes, productsRes] = await Promise.all([
      supabaseAdmin.from('production_orders').select(ORDER_WITH_ITEMS).gte('business_date', demandFrom),
      supabaseAdmin.from('production_stock').select('balance'),
      supabaseAdmin.from('production_stock_history').select('type, delta, business_date').gte('business_date', historyFrom),
      supabaseAdmin.from('production_returns').select('qty, status').eq('business_date', todayStr),
      supabaseAdmin.from('branches').select('id', { count: 'exact', head: true }).eq('is_active', true),
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ]);
    for (const r of [ordersRes, prodStockRes, prepHistRes, returnsRes, branchesRes, productsRes]) {
      if (r.error) throw r.error;
    }

    const orders = (ordersRes.data ?? []) as unknown as ODoc[];
    const itemsQty = (o: ODoc) => (o.items ?? []).reduce((t, i) => t + (Number(i.qty) || 0), 0);

    const pending = orders.filter((o) => o.status === 'pending');
    const recentApproved = orders.filter((o) => o.status === 'approved' && o.business_date >= last7);

    const waitingOrders = pending.length;
    const approvedOrders = recentApproved.length;
    const deliveredOrders = approvedOrders; // Approve = Delivered
    const changedOrders = recentApproved.filter((o) => o.was_changed).length;
    const totalDemandQty = pending.reduce((s, o) => s + itemsQty(o), 0);

    let todayProduction = 0, weeklyProduction = 0, monthlyProduction = 0;
    for (const h of (prepHistRes.data ?? []) as { type: string; delta: number; business_date: string }[]) {
      if (h.type !== 'prepare') continue;
      const q = Math.abs(Number(h.delta) || 0);
      if (h.business_date === todayStr) todayProduction += q;
      if (h.business_date >= weekStartStr) weeklyProduction += q;
      if (h.business_date >= monthStartStr) monthlyProduction += q;
    }

    const availableProductionStock = ((prodStockRes.data ?? []) as { balance: number }[])
      .reduce((s, d) => s + Number(d.balance ?? 0), 0);
    const returnedProducts = ((returnsRes.data ?? []) as { qty: number; status: string }[])
      .filter((r) => r.status === 'accepted')
      .reduce((s, r) => s + Number(r.qty || 0), 0);

    // Chart aggregations
    const demandDayMap: Record<string, { qty: number; orders: number }> = {};
    const monthMap: Record<string, number> = {};
    const branchMap: Record<string, { branchId: string; branchName: string; qty: number }> = {};
    const productMap: Record<string, { productId: string; productName: string; qty: number }> = {};
    for (const o of orders) {
      const qty = itemsQty(o);
      if (o.business_date >= dayFrom) {
        if (!demandDayMap[o.business_date]) demandDayMap[o.business_date] = { qty: 0, orders: 0 };
        demandDayMap[o.business_date]!.qty += qty;
        demandDayMap[o.business_date]!.orders += 1;
      }
      const month = o.business_date.slice(0, 7);
      monthMap[month] = (monthMap[month] || 0) + qty;
      if (!branchMap[o.branch_id]) branchMap[o.branch_id] = { branchId: o.branch_id, branchName: o.branch_name, qty: 0 };
      branchMap[o.branch_id]!.qty += qty;
      for (const it of o.items ?? []) {
        if (!productMap[it.product_id]) productMap[it.product_id] = { productId: it.product_id, productName: it.product_name, qty: 0 };
        productMap[it.product_id]!.qty += Number(it.qty) || 0;
      }
    }

    res.json({
      cards: {
        waitingOrders, approvedOrders, deliveredOrders, changedOrders,
        returnedProducts, todayProduction, weeklyProduction, monthlyProduction,
        totalBranches: branchesRes.count ?? 0, totalProducts: productsRes.count ?? 0,
        totalDemandQty, availableProductionStock,
      },
      demandByDay: Object.entries(demandDayMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, qty: v.qty, orders: v.orders })),
      demandByMonth: Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([month, qty]) => ({ month, qty })),
      branchDemand: Object.values(branchMap).sort((a, b) => b.qty - a.qty),
      topProducts: Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 10),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/production/branch-stock — Product × Branch balance matrix.
router.get('/branch-stock', async (_req, res, next) => {
  try {
    const [stockRes, branchesRes, productsRes] = await Promise.all([
      supabaseAdmin.from('stock').select('branch_id, product_id, balance'),
      supabaseAdmin.from('branches').select('id, name').eq('is_active', true),
      supabaseAdmin.from('products').select('id, name').eq('is_active', true),
    ]);
    for (const r of [stockRes, branchesRes, productsRes]) {
      if (r.error) throw r.error;
    }

    const branches = ((branchesRes.data ?? []) as { id: string; name: string }[])
      .map((b) => ({ branchId: b.id, branchName: b.name }))
      .sort((a, b) => a.branchName.localeCompare(b.branchName));

    // productId -> branchId -> balance
    const balances: Record<string, Record<string, number>> = {};
    for (const s of (stockRes.data ?? []) as { branch_id: string; product_id: string; balance: number }[]) {
      (balances[s.product_id] ||= {})[s.branch_id] = Number(s.balance ?? 0);
    }

    const rows = ((productsRes.data ?? []) as { id: string; name: string }[])
      .map((p) => ({ productId: p.id, productName: p.name, byBranch: balances[p.id] || {} }))
      .sort((a, b) => a.productName.localeCompare(b.productName));

    res.json({ branches, rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/production/queue — all pending/preparing/ready orders grouped by branch
router.get('/queue', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('*, items:order_items(product_id, product_name, qty, unit_price, line_total, line_no)')
      .in('status', ['pending', 'preparing', 'ready'])
      .order('created_at', { ascending: true })
      .order('line_no', { referencedTable: 'order_items', ascending: true });
    if (error) throw error;

    type OrderDoc = { id: string; branchId: string; branchName: string; status: string; [k: string]: unknown };
    const orders = rowToApi<OrderDoc[]>(data ?? []);

    // Group by branch
    const byBranch: Record<string, OrderDoc[]> = {};
    for (const order of orders) {
      if (!byBranch[order.branchId]) byBranch[order.branchId] = [];
      byBranch[order.branchId]!.push(order);
    }

    // Stats
    const stats = {
      waitingCount: orders.filter((o) => o.status === 'pending').length,
      preparingCount: orders.filter((o) => o.status === 'preparing').length,
      readyCount: orders.filter((o) => o.status === 'ready').length,
      totalActive: orders.length,
    };

    res.json({ queue: byBranch, stats });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production/:id/status
router.put('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const { status } = req.body;

    if (!['preparing', 'ready', 'delivered'].includes(status)) {
      res.status(400).json({ error: 'Invalid production status' });
      return;
    }

    const id = req.params['id']!;
    // updated_at is maintained by the orders_touch trigger.
    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status })
      .eq('id', id)
      .select('order_number, branch_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Order not found' }); return; }

    if (status === 'ready') {
      await notify({
        type: 'order_ready',
        title: 'Order Ready',
        message: `Order ${data.order_number} is ready for delivery`,
        targetRole: 'branch_manager',
        branchId: data.branch_id,
        relatedId: id,
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
