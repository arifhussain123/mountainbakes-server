import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateExpenseSchema, businessDateStr, businessDaysAgoStr } from '../shared';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';

export const router = Router();

router.use(authenticate);

// GET /api/expenses — last 7 days, branch-scoped
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    let query = adminDb.collection('expenses') as FirebaseFirestore.Query;
    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.where('branchId', '==', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.where('branchId', '==', req.query['branchId']);
    }

    const snapshot = await query.get();
    const cutoff = businessDaysAgoStr(6);
    const expenses = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
      .filter((e) => String(e['date'] ?? '') >= cutoff)
      .sort((a, b) => String(b['createdAt'] ?? '').localeCompare(String(a['createdAt'] ?? '')));

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

    const { description, paymentMethod, amount, remarks, date } = req.body;
    const businessDate = date || businessDateStr();
    await assertBusinessDayOpen(businessDate, req.user!.role);
    const now = new Date().toISOString();

    const ref = await adminDb.collection('expenses').add({
      branchId,
      branchName: req.user!.branchName || '',
      date: businessDate,
      description,
      paymentMethod,
      amount,
      remarks: remarks || '',
      createdBy: req.user!.uid,
      createdByName: req.user!.email,
      createdAt: now,
    });

    res.status(201).json({ id: ref.id });
  } catch (err) {
    next(err);
  }
});
