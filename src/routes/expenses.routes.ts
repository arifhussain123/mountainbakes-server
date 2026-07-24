import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateExpenseSchema, businessDateStr, businessDaysAgoStr } from '../shared';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate);

// GET /api/expenses — last 7 business days, branch-scoped
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    // The 7-day cutoff is a real indexed predicate now (expenses_branch_date_idx);
    // it used to fetch every expense for the branch and filter in memory.
    let query = supabaseAdmin
      .from('expenses')
      .select('*')
      .gte('business_date', businessDaysAgoStr(6)) // inclusive last 7 business days
      .order('created_at', { ascending: false });

    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    // DB column is business_date; the API contract (Expense) exposes it as `date`.
    // rowToApi only camelCases keys, so remap businessDate → date here (mirrors the
    // production-orders route). expense_number → expenseNumber flows automatically.
    const rows = rowToApi<Record<string, unknown>[]>(data ?? []);
    const expenses = rows.map(({ businessDate, ...rest }) => ({ ...rest, date: businessDate }));
    res.json({ expenses, total: expenses.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/expenses — record a shop expense for the acting branch
router.post('/', requireRole('super_admin', 'branch_manager'), validate(CreateExpenseSchema), async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.user!.branchId;
    if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }

    const { category, description, paymentMethod, amount, remarks, date } = req.body;
    const businessDate = date || businessDateStr();
    await assertBusinessDayOpen(businessDate, req.user!.role);

    // created_at comes from the column default — do not set it here.
    const { data, error } = await supabaseAdmin
      .from('expenses')
      .insert({
        branch_id: branchId,
        branch_name: req.user!.branchName || '',
        business_date: businessDate,
        category,
        description,
        payment_method: paymentMethod,
        amount,
        remarks: remarks || '',
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
