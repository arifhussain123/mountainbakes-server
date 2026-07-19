import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateProductionReturnSchema,
  ReviewProductionReturnSchema,
  businessDateStr,
  businessDaysAgoStr,
  type Product,
} from '../shared';
import { notify } from '../services/push.service';
import { returnIntoPool } from '../services/production-stock.service';
import { applyStockMovement } from '../services/stock.service';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

// GET /api/production-returns — last 30 days, most recent first
router.get('/', async (_req, res, next) => {
  try {
    const snapshot = await adminDb.collection('production_returns').get();
    const cutoff = businessDaysAgoStr(29);
    const returns = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
      .filter((r) => String(r['date'] ?? '') >= cutoff)
      .sort((a, b) => String(b['createdAt'] ?? '').localeCompare(String(a['createdAt'] ?? '')));
    res.json({ returns, total: returns.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-returns — Production records a branch return (pending review)
router.post('/', validate(CreateProductionReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, productId, qty, reason } = req.body as { branchId: string; productId: string; qty: number; reason: string };

    const [branchDoc, productDoc] = await Promise.all([
      adminDb.collection('branches').doc(branchId).get(),
      adminDb.collection('products').doc(productId).get(),
    ]);
    if (!branchDoc.exists) { res.status(400).json({ error: 'Branch not found' }); return; }
    if (!productDoc.exists) { res.status(400).json({ error: 'Product not found' }); return; }

    const branchName = (branchDoc.data() as { name: string }).name;
    const productName = (productDoc.data() as Product).name;
    const now = new Date().toISOString();

    const ref = await adminDb.collection('production_returns').add({
      branchId,
      branchName,
      productId,
      productName,
      qty,
      reason,
      status: 'pending',
      date: businessDateStr(),
      createdBy: req.user!.uid,
      createdByName: req.user!.email,
      createdAt: now,
      reviewedBy: null,
      reviewedByName: null,
      reviewedAt: null,
    });

    await notify({
      type: 'production_return',
      title: 'Product Return Recorded',
      message: `${qty} × ${productName} from ${branchName}`,
      targetRole: 'production_user',
      branchId,
      relatedId: ref.id,
    });

    res.status(201).json({ id: ref.id });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-returns/:id/review — accept (restock) or reject
router.put('/:id/review', validate(ReviewProductionReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status } = req.body as { status: 'accepted' | 'rejected' };
    const id = req.params['id']!;
    const ref = adminDb.collection('production_returns').doc(id);

    const data = await adminDb.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw Object.assign(new Error('Return not found'), { status: 404 });
      const d = doc.data() as { status: string; branchId: string; productId: string; productName: string; qty: number };
      if (d.status !== 'pending') throw Object.assign(new Error('Return already reviewed'), { status: 409 });
      tx.update(ref, {
        status,
        reviewedBy: req.user!.uid,
        reviewedByName: req.user!.email,
        reviewedAt: new Date().toISOString(),
      });
      return d;
    });

    // Accepted returns flow back INTO the production pool and OUT of branch stock.
    if (status === 'accepted') {
      await returnIntoPool(id, { productId: data.productId, productName: data.productName, qty: data.qty });
      await applyStockMovement({
        branchId: data.branchId,
        productId: data.productId,
        productName: data.productName,
        delta: -Math.abs(data.qty),
        type: 'adjustment',
        refId: `return_${id}`,
      });
      await notify({
        type: 'production_return',
        title: 'Return Accepted',
        message: `${data.qty} × ${data.productName} returned to production`,
        targetRole: 'branch_manager',
        branchId: data.branchId,
        relatedId: id,
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
