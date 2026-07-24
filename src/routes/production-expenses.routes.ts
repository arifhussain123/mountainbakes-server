import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateProductionExpenseSchema, businessDateStr, businessDaysAgoStr, businessRange } from '../shared';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

// GET /api/production-expenses — last 30 business days, most recent first
router.get('/', async (_req, res, next) => {
  try {
    // The cutoff is an indexed predicate (production_expenses_date_idx); this used
    // to fetch the entire collection and filter in memory.
    const { data, error } = await supabaseAdmin
      .from('production_expenses')
      .select('*')
      .gte('business_date', businessDaysAgoStr(29))
      .order('created_at', { ascending: false });
    if (error) throw error;

    // business_date → date to match the ProductionExpense API contract; expense_number
    // → expenseNumber flows via rowToApi automatically.
    const rows = rowToApi<Record<string, unknown>[]>(data ?? []);
    const expenses = rows.map(({ businessDate, ...rest }) => ({ ...rest, date: businessDate }));
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

    // One year-scoped read, then the narrower windows are derived from it —
    // matching the original, which made a single query and bucketed in memory.
    const { data, error } = await supabaseAdmin
      .from('production_expenses')
      .select('amount, category, business_date, created_at')
      .gte('created_at', year.fromISO)
      .lte('created_at', year.toISO);
    if (error) throw error;

    const expenses = (data ?? []) as {
      amount: number | string;
      category: string;
      business_date: string;
      created_at: string;
    }[];

    let today = 0, weekly = 0, monthly = 0, yearly = 0;
    const categoryMap: Record<string, number> = {};
    const trendMap: Record<string, number> = {};
    const trendFrom = businessDaysAgoStr(29);

    for (const e of expenses) {
      // numeric(14,2) can arrive as a string over PostgREST.
      const amt = Number(e.amount ?? 0);
      yearly += amt;
      // Today and the trend bucket on the stored business date; the weekly and
      // monthly windows compare timestamps — same split as the original.
      if (e.business_date === todayStr) today += amt;
      if (e.created_at >= week.fromISO && e.created_at <= week.toISO) weekly += amt;
      if (e.created_at >= month.fromISO && e.created_at <= month.toISO) {
        monthly += amt;
        categoryMap[e.category] = (categoryMap[e.category] || 0) + amt;
      }
      if (e.business_date >= trendFrom) trendMap[e.business_date] = (trendMap[e.business_date] || 0) + amt;
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

    // created_at comes from the column default — do not set it here.
    const { data, error } = await supabaseAdmin
      .from('production_expenses')
      .insert({
        category,
        description,
        amount,
        payment_method: paymentMethod,
        supplier: supplier || '',
        notes: notes || '',
        business_date: date || businessDateStr(),
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('id')
      .single();
    if (error) throw error;

    res.status(201).json({ id: data.id });
  } catch (err) {
    next(err);
  }
});
