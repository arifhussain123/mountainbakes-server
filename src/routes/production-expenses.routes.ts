import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateProductionExpenseSchema, businessDateStr, businessDaysAgoStr, businessRange } from '../shared';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

// GET /api/production-expenses — last 30 days, most recent first
router.get('/', async (_req, res, next) => {
  try {
    const snapshot = await adminDb.collection('production_expenses').get();
    const cutoff = businessDaysAgoStr(29);
    const expenses = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
      .filter((e) => String(e['date'] ?? '') >= cutoff)
      .sort((a, b) => String(b['createdAt'] ?? '').localeCompare(String(a['createdAt'] ?? '')));
    res.json({ expenses, total: expenses.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-expenses/summary — today/weekly/monthly/yearly totals + charts
router.get('/summary', async (_req, res, next) => {
  try {
    const todayStr = businessDateStr();
    const week = businessRange('weekly');
    const month = businessRange('monthly');
    const year = businessRange('yearly');

    const snapshot = await adminDb.collection('production_expenses')
      .where('createdAt', '>=', year.fromISO)
      .where('createdAt', '<=', year.toISO)
      .get();

    const expenses = snapshot.docs.map((d) => d.data() as { amount: number; createdAt: string; date: string; category: string });

    let today = 0, weekly = 0, monthly = 0, yearly = 0;
    const categoryMap: Record<string, number> = {};
    const trendMap: Record<string, number> = {};
    const trendFrom = businessDaysAgoStr(29);

    for (const e of expenses) {
      const amt = Number(e.amount || 0);
      yearly += amt;
      if (e.date === todayStr) today += amt;
      if (e.createdAt >= week.fromISO && e.createdAt <= week.toISO) weekly += amt;
      if (e.createdAt >= month.fromISO && e.createdAt <= month.toISO) {
        monthly += amt;
        categoryMap[e.category] = (categoryMap[e.category] || 0) + amt;
      }
      if (e.date >= trendFrom) trendMap[e.date] = (trendMap[e.date] || 0) + amt;
    }

    res.json({
      today, weekly, monthly, yearly,
      byCategory: Object.entries(categoryMap).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
      trend: Object.entries(trendMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-expenses — record a production expense
router.post('/', validate(CreateProductionExpenseSchema), async (req: AuthRequest, res, next) => {
  try {
    const { category, description, amount, paymentMethod, supplier, notes, date } = req.body;
    const now = new Date().toISOString();

    const ref = await adminDb.collection('production_expenses').add({
      category,
      description,
      amount,
      paymentMethod,
      supplier: supplier || '',
      notes: notes || '',
      date: date || businessDateStr(),
      createdBy: req.user!.uid,
      createdByName: req.user!.email,
      createdAt: now,
    });

    res.status(201).json({ id: ref.id });
  } catch (err) {
    next(err);
  }
});
