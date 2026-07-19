import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { notify } from '../services/push.service';
import { businessDateStr, businessDaysAgoStr } from '../shared';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

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

    const [ordersSnap, prodStockSnap, prepHistSnap, returnsSnap, branchesSnap, productsSnap] = await Promise.all([
      adminDb.collection('production_orders').where('date', '>=', demandFrom).get(),
      adminDb.collection('production_stock').get(),
      adminDb.collection('production_stock_history').where('date', '>=', historyFrom).get(),
      adminDb.collection('production_returns').where('date', '==', todayStr).get(),
      adminDb.collection('branches').where('isActive', '==', true).get(),
      adminDb.collection('products').where('isActive', '==', true).get(),
    ]);

    type OItem = { productId: string; productName: string; qty: number; approvedQty?: number };
    type ODoc = { branchId: string; branchName: string; date: string; status: string; wasChanged?: boolean; items: OItem[] };
    const orders = ordersSnap.docs.map((d) => d.data() as ODoc);

    const pending = orders.filter((o) => o.status === 'pending');
    const recentApproved = orders.filter((o) => o.status === 'approved' && o.date >= last7);

    const waitingOrders = pending.length;
    const approvedOrders = recentApproved.length;
    const deliveredOrders = approvedOrders; // Approve = Delivered
    const changedOrders = recentApproved.filter((o) => o.wasChanged).length;
    const totalDemandQty = pending.reduce((s, o) => s + o.items.reduce((t, i) => t + (i.qty || 0), 0), 0);

    let todayProduction = 0, weeklyProduction = 0, monthlyProduction = 0;
    for (const doc of prepHistSnap.docs) {
      const h = doc.data() as { type: string; delta: number; date: string };
      if (h.type !== 'prepare') continue;
      const q = Math.abs(h.delta);
      if (h.date === todayStr) todayProduction += q;
      if (h.date >= weekStartStr) weeklyProduction += q;
      if (h.date >= monthStartStr) monthlyProduction += q;
    }

    const availableProductionStock = prodStockSnap.docs.reduce((s, d) => s + Number(d.data()['balance'] ?? 0), 0);
    const returnedProducts = returnsSnap.docs
      .map((d) => d.data() as { qty: number; status: string })
      .filter((r) => r.status === 'accepted')
      .reduce((s, r) => s + Number(r.qty || 0), 0);

    // Chart aggregations
    const demandDayMap: Record<string, { qty: number; orders: number }> = {};
    const monthMap: Record<string, number> = {};
    const branchMap: Record<string, { branchId: string; branchName: string; qty: number }> = {};
    const productMap: Record<string, { productId: string; productName: string; qty: number }> = {};
    for (const o of orders) {
      const qty = o.items.reduce((t, i) => t + (i.qty || 0), 0);
      if (o.date >= dayFrom) {
        if (!demandDayMap[o.date]) demandDayMap[o.date] = { qty: 0, orders: 0 };
        demandDayMap[o.date]!.qty += qty;
        demandDayMap[o.date]!.orders += 1;
      }
      const month = o.date.slice(0, 7);
      monthMap[month] = (monthMap[month] || 0) + qty;
      if (!branchMap[o.branchId]) branchMap[o.branchId] = { branchId: o.branchId, branchName: o.branchName, qty: 0 };
      branchMap[o.branchId]!.qty += qty;
      for (const it of o.items) {
        if (!productMap[it.productId]) productMap[it.productId] = { productId: it.productId, productName: it.productName, qty: 0 };
        productMap[it.productId]!.qty += it.qty || 0;
      }
    }

    res.json({
      cards: {
        waitingOrders, approvedOrders, deliveredOrders, changedOrders,
        returnedProducts, todayProduction, weeklyProduction, monthlyProduction,
        totalBranches: branchesSnap.size, totalProducts: productsSnap.size,
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
    const [stockSnap, branchesSnap, productsSnap] = await Promise.all([
      adminDb.collection('stock').get(),
      adminDb.collection('branches').where('isActive', '==', true).get(),
      adminDb.collection('products').where('isActive', '==', true).get(),
    ]);

    const branches = branchesSnap.docs
      .map((d) => ({ branchId: d.id, branchName: (d.data() as { name: string }).name }))
      .sort((a, b) => a.branchName.localeCompare(b.branchName));

    // productId -> branchId -> balance
    const balances: Record<string, Record<string, number>> = {};
    for (const doc of stockSnap.docs) {
      const s = doc.data() as { branchId: string; productId: string; balance: number };
      (balances[s.productId] ||= {})[s.branchId] = Number(s.balance ?? 0);
    }

    const rows = productsSnap.docs
      .map((d) => ({ productId: d.id, productName: (d.data() as { name: string }).name, byBranch: balances[d.id] || {} }))
      .sort((a, b) => a.productName.localeCompare(b.productName));

    res.json({ branches, rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/production/queue — all pending/preparing/ready orders grouped by branch
router.get('/queue', async (_req, res, next) => {
  try {
    const snapshot = await adminDb.collection('orders')
      .where('status', 'in', ['pending', 'preparing', 'ready'])
      .orderBy('createdAt', 'asc')
      .get();

    type OrderDoc = { id: string; branchId: string; branchName: string; status: string; [k: string]: unknown };
    const orders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as unknown as OrderDoc));

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

    const doc = await adminDb.collection('orders').doc(req.params['id']!).get();
    if (!doc.exists) { res.status(404).json({ error: 'Order not found' }); return; }

    const data = doc.data() as { orderNumber: string; branchId: string; status: string };
    const now = new Date().toISOString();

    await adminDb.collection('orders').doc(req.params['id']!).update({ status, updatedAt: now });

    if (status === 'ready') {
      await notify({
        type: 'order_ready',
        title: 'Order Ready',
        message: `Order ${data.orderNumber} is ready for delivery`,
        targetRole: 'branch_manager',
        branchId: data.branchId,
        relatedId: req.params['id'],
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
