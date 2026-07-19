import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { businessDateStr, CreateBranchReturnSchema, type StockAuditLog, type Product } from '../shared';
import { notify } from '../services/push.service';
import { returnIntoPool } from '../services/production-stock.service';
import { commitBranchReturn, computeStockRows, InsufficientStockError } from '../services/stock.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';

export const router = Router();

router.use(authenticate);

// GET /api/stock/audit — blocked-sale attempts (Admin: all; branch manager: own branch)
router.get('/audit', async (req: AuthRequest, res, next) => {
  try {
    let query = adminDb.collection('stock_audit_log') as FirebaseFirestore.Query;
    if (req.user!.role === 'branch_manager') {
      if (!req.user!.branchId) { res.status(400).json({ error: 'No branch assigned' }); return; }
      query = query.where('branchId', '==', req.user!.branchId);
    } else if (req.user!.role !== 'super_admin') {
      res.status(403).json({ error: 'Access denied' });
      return;
    } else if (req.query['branchId']) {
      query = query.where('branchId', '==', req.query['branchId']);
    }

    const snap = await query.get();
    const logs = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }) as StockAuditLog)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .slice(0, 200); // most recent 200

    res.json({ logs, total: logs.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/stock?date=YYYY-MM-DD — Opening/New/Sold/Balance per product for a branch (today by default)
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.user!.role === 'branch_manager'
      ? req.user!.branchId
      : (req.query['branchId'] as string | undefined) ?? null;

    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    const date = (req.query['date'] as string | undefined) || businessDateStr();
    const rows = await computeStockRows(branchId, date);
    res.json({ date, rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/stock/return — branch returns unsold/damaged stock to production.
// Applied immediately: branch balance ↓, production pool ↑ (Returned), and an
// accepted return record + real-time notification for the Production dashboard.
router.post('/return', requireRole('super_admin', 'branch_manager'), validate(CreateBranchReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.user!.role === 'branch_manager'
      ? req.user!.branchId
      : ((req.body as { branchId?: string }).branchId ?? null);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    const { productId, qty, reason } = req.body as { productId: string; qty: number; reason: string };

    await assertBusinessDayOpen(businessDateStr(), req.user!.role);

    const [branchDoc, productDoc] = await Promise.all([
      adminDb.collection('branches').doc(branchId).get(),
      adminDb.collection('products').doc(productId).get(),
    ]);
    if (!branchDoc.exists) { res.status(400).json({ error: 'Branch not found' }); return; }
    if (!productDoc.exists) { res.status(400).json({ error: 'Product not found' }); return; }

    const branchName = (branchDoc.data() as { name: string }).name;
    const productName = (productDoc.data() as Product).name;
    const now = new Date().toISOString();

    // Reserve the return-doc id up front so it is the shared refId across branch stock,
    // the production pool and the record — keeping every movement idempotent.
    const returnRef = adminDb.collection('production_returns').doc();

    // 1) Decrement branch stock (validates qty <= balance atomically).
    try {
      await commitBranchReturn({ branchId, productId, productName, qty, refId: returnRef.id });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        res.status(409).json({ error: 'Return quantity cannot be greater than available stock.', details: err.shortfalls });
        return;
      }
      throw err;
    }

    // 2) Add the units back into the central production pool (feeds "Returned").
    await returnIntoPool(returnRef.id, { productId, productName, qty });

    // 3) Record an accepted return so it surfaces on the Production Returns page.
    await returnRef.set({
      branchId,
      branchName,
      productId,
      productName,
      qty,
      reason: reason || '',
      status: 'accepted',
      source: 'branch',
      date: businessDateStr(),
      createdBy: req.user!.uid,
      createdByName: req.user!.email,
      createdAt: now,
      reviewedBy: req.user!.uid,
      reviewedByName: req.user!.email,
      reviewedAt: now,
    });

    // 4) Notify Production in real time.
    await notify({
      type: 'production_return',
      title: 'Stock Returned',
      message: `${qty} × ${productName} from ${branchName}`,
      targetRole: 'production_user',
      branchId,
      relatedId: returnRef.id,
    });

    res.status(201).json({ id: returnRef.id });
  } catch (err) {
    next(err);
  }
});
