import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { exportToPDF, exportToExcel, exportToCSV } from '../services/export.service';
import { businessRange, businessDateStr, type PaymentMethodBreakdown } from '../shared';
import { startOfMonth, endOfMonth, format } from 'date-fns';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'branch_manager'));

// Day/week/month/year boundaries follow the business day (rolls over at 2 AM Karachi).
function getDateRange(period: string, from?: string, to?: string) {
  if (period === 'daily' || period === 'weekly' || period === 'monthly' || period === 'yearly') {
    const r = businessRange(period);
    return { from: r.fromISO, to: r.toISO };
  }
  const m = businessRange('monthly');
  return { from: from || m.fromISO, to: to || m.toISO };
}

router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const period = String(req.query['period'] || 'monthly');
    const { from, to } = getDateRange(period, String(req.query['from'] || ''), String(req.query['to'] || ''));

    let query = adminDb.collection('orders')
      .where('createdAt', '>=', from)
      .where('createdAt', '<=', to) as FirebaseFirestore.Query;

    // Branch managers see their branch only
    if (req.user!.role === 'branch_manager') {
      query = query.where('branchId', '==', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.where('branchId', '==', req.query['branchId']);
    }

    const snapshot = await query.get();
    const orders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as unknown as Array<{
      status: string; grandTotal: number; branchId: string; branchName: string; paymentMethod: string; items: Array<{ productId: string; productName: string; categoryName: string; qty: number; lineTotal: number }>; createdAt: string;
    }>;

    const totalOrders = orders.length;
    const totalRevenue = orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.grandTotal, 0);
    const totalCancelled = orders.filter(o => o.status === 'cancelled').length;
    const totalPending = orders.filter(o => o.status === 'pending').length;

    // Daily aggregation
    const dayMap: Record<string, { totalOrders: number; totalRevenue: number; totalCancelled: number }> = {};
    for (const o of orders) {
      const day = businessDateStr(new Date(o.createdAt));
      if (!dayMap[day]) dayMap[day] = { totalOrders: 0, totalRevenue: 0, totalCancelled: 0 };
      dayMap[day]!.totalOrders++;
      if (o.status !== 'cancelled') dayMap[day]!.totalRevenue += o.grandTotal;
      if (o.status === 'cancelled') dayMap[day]!.totalCancelled++;
    }

    // Branch aggregation (admin only)
    const branchMap: Record<string, { branchId: string; branchName: string; totalOrders: number; totalRevenue: number }> = {};
    for (const o of orders.filter(o => o.status !== 'cancelled')) {
      if (!branchMap[o.branchId]) branchMap[o.branchId] = { branchId: o.branchId, branchName: o.branchName, totalOrders: 0, totalRevenue: 0 };
      branchMap[o.branchId]!.totalOrders++;
      branchMap[o.branchId]!.totalRevenue += o.grandTotal;
    }

    // Top products
    const productMap: Record<string, { productId: string; productName: string; categoryName: string; totalQty: number; totalRevenue: number }> = {};
    for (const o of orders.filter(o => o.status !== 'cancelled')) {
      for (const item of o.items) {
        if (!productMap[item.productId]) productMap[item.productId] = { productId: item.productId, productName: item.productName, categoryName: item.categoryName, totalQty: 0, totalRevenue: 0 };
        productMap[item.productId]!.totalQty += item.qty;
        productMap[item.productId]!.totalRevenue += item.lineTotal;
      }
    }

    // Payment-method breakdown (non-cancelled sales)
    const pmMap: Record<string, PaymentMethodBreakdown> = {};
    for (const o of orders.filter(o => o.status !== 'cancelled')) {
      const method = o.paymentMethod || 'cash';
      if (!pmMap[method]) pmMap[method] = { method, total: 0, count: 0 };
      pmMap[method]!.total += o.grandTotal;
      pmMap[method]!.count++;
    }

    // Expenses in range (branch-scoped when applicable)
    const scopeBranchId = req.user!.role === 'branch_manager'
      ? req.user!.branchId
      : (req.query['branchId'] as string | undefined) || null;

    let expenseData: Array<{ amount: number; createdAt: string; date?: string }> = [];
    if (scopeBranchId) {
      const eSnap = await adminDb.collection('expenses').where('branchId', '==', scopeBranchId).get();
      expenseData = eSnap.docs
        .map((d) => d.data() as { amount: number; createdAt: string; date?: string })
        .filter((e) => e.createdAt >= from && e.createdAt <= to);
    } else {
      const eSnap = await adminDb.collection('expenses')
        .where('createdAt', '>=', from).where('createdAt', '<=', to).get();
      expenseData = eSnap.docs.map((d) => d.data() as { amount: number; createdAt: string; date?: string });
    }
    const totalExpenses = expenseData.reduce((s, e) => s + Number(e.amount || 0), 0);
    const totalProfit = totalRevenue - totalExpenses;

    const expenseByDay: Record<string, number> = {};
    for (const e of expenseData) {
      const day = e.date || businessDateStr(new Date(e.createdAt));
      expenseByDay[day] = (expenseByDay[day] || 0) + Number(e.amount || 0);
    }

    // Merge order-days and expense-days for the sales-vs-expenses chart
    const allDays = new Set([...Object.keys(dayMap), ...Object.keys(expenseByDay)]);
    const dailyData = [...allDays].sort((a, b) => a.localeCompare(b)).map((date) => {
      const v = dayMap[date] || { totalOrders: 0, totalRevenue: 0, totalCancelled: 0 };
      const exp = expenseByDay[date] || 0;
      return { date, totalOrders: v.totalOrders, totalRevenue: v.totalRevenue, totalCancelled: v.totalCancelled, expenses: exp, profit: v.totalRevenue - exp };
    });

    // Branch budget (only when a single branch is in scope)
    let budget: { daily: number; weekly: number; monthly: number } | undefined;
    if (scopeBranchId) {
      const bDoc = await adminDb.collection('branches').doc(scopeBranchId).get();
      if (bDoc.exists) {
        const b = bDoc.data()!;
        budget = { daily: Number(b['dailyBudget'] || 0), weekly: Number(b['weeklyBudget'] || 0), monthly: Number(b['monthlyBudget'] || 0) };
      }
    }

    res.json({
      period, from, to,
      totalOrders,
      totalRevenue,
      totalCancelled,
      totalPending,
      averageOrderValue: totalOrders ? totalRevenue / (totalOrders - totalCancelled || 1) : 0,
      totalExpenses,
      totalProfit,
      dailyData,
      branchData: Object.values(branchMap).map(b => ({ ...b, averageOrderValue: b.totalOrders ? b.totalRevenue / b.totalOrders : 0 })),
      topProducts: Object.values(productMap).sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 10),
      paymentMethodBreakdown: Object.values(pmMap),
      budget,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/branch-comparison', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const from = String(req.query['from'] || startOfMonth(new Date()).toISOString());
    const to = String(req.query['to'] || endOfMonth(new Date()).toISOString());

    const snapshot = await adminDb.collection('orders')
      .where('createdAt', '>=', from)
      .where('createdAt', '<=', to)
      .where('status', '!=', 'cancelled')
      .get();

    const orders = snapshot.docs.map((d) => d.data() as { branchId: string; branchName: string; grandTotal: number });
    const branchMap: Record<string, { branchId: string; branchName: string; totalRevenue: number; totalOrders: number }> = {};

    for (const o of orders) {
      if (!branchMap[o.branchId]) branchMap[o.branchId] = { branchId: o.branchId, branchName: o.branchName, totalRevenue: 0, totalOrders: 0 };
      branchMap[o.branchId]!.totalRevenue += o.grandTotal;
      branchMap[o.branchId]!.totalOrders++;
    }

    res.json({ comparison: Object.values(branchMap), from, to });
  } catch (err) {
    next(err);
  }
});

router.get('/export', async (req: AuthRequest, res, next) => {
  try {
    const exportType = String(req.query['type'] || 'excel');
    const period = String(req.query['period'] || 'monthly');
    const { from, to } = getDateRange(period, String(req.query['from'] || ''), String(req.query['to'] || ''));

    let query = adminDb.collection('orders')
      .where('createdAt', '>=', from)
      .where('createdAt', '<=', to) as FirebaseFirestore.Query;

    if (req.user!.role === 'branch_manager') query = query.where('branchId', '==', req.user!.branchId);
    else if (req.query['branchId']) query = query.where('branchId', '==', req.query['branchId']);

    const snapshot = await query.get();
    const orders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as unknown as Parameters<typeof exportToPDF>[0];

    const dateLabel = format(new Date(), 'yyyy-MM-dd');

    if (exportType === 'pdf') {
      const buffer = await exportToPDF(orders);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="mountain-bakes-report-${dateLabel}.pdf"`);
      res.send(buffer);
    } else if (exportType === 'csv') {
      const csv = exportToCSV(orders);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="mountain-bakes-report-${dateLabel}.csv"`);
      res.send(csv);
    } else {
      const buffer = await exportToExcel(orders);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="mountain-bakes-report-${dateLabel}.xlsx"`);
      res.send(buffer);
    }
  } catch (err) {
    next(err);
  }
});
