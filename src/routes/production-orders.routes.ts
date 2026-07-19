import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateProductionOrderSchema,
  ReviewProductionOrderSchema,
  businessDateStr,
  businessDaysAgoStr,
  karachiTimeStr,
  karachiMinutesOfDay,
  isWithinOrderWindow,
  type Product,
} from '../shared';
import { notify } from '../services/push.service';
import { applyProductionToStock } from '../services/stock.service';
import { transferOutOnApproval } from '../services/production-stock.service';
import { getAppSettings, orderWindowMinutes } from '../services/settings.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';

export const router = Router();

router.use(authenticate);

// POST /api/production-orders — branch submits a daily production request
router.post('/', requireRole('branch_manager'), validate(CreateProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    // Branch production requests are only accepted inside the configured order
    // window (default 8:00 AM–2:00 AM Karachi, which wraps past midnight).
    const settings = await getAppSettings();
    const { openMin, closeMin } = orderWindowMinutes(settings);
    if (!isWithinOrderWindow(karachiMinutesOfDay(), openMin, closeMin)) {
      res.status(403).json({ error: `Ordering time has ended. New production orders will open again at ${settings.orderStartTime}.` });
      return;
    }

    const branchId = req.user!.branchId;
    if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }

    const { items } = req.body as { items: { productId: string; qty: number; remarks: string }[] };

    // Resolve product names (branch users never send prices/names — controlled by Admin)
    const productDocs = await Promise.all(items.map((i) => adminDb.collection('products').doc(i.productId).get()));
    const resolvedItems = items.map((i, idx) => {
      const pDoc = productDocs[idx];
      if (!pDoc || !pDoc.exists) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
      const product = pDoc.data() as Product;
      return { productId: i.productId, productName: product.name, qty: i.qty, remarks: i.remarks || '' };
    });

    const now = new Date();
    await assertBusinessDayOpen(businessDateStr(now), req.user!.role);
    const ref = await adminDb.collection('production_orders').add({
      branchId,
      branchName: req.user!.branchName || '',
      date: businessDateStr(now),
      time: karachiTimeStr(now),
      items: resolvedItems,
      status: 'pending',
      createdBy: req.user!.uid,
      createdByName: req.user!.email,
      submittedAt: now.toISOString(),
      approvedBy: null,
      approvedByName: null,
      approvedAt: null,
    });

    await notify({
      type: 'production_demand',
      title: 'New Production Demand Received',
      message: `${req.user!.branchName || 'A branch'} submitted ${resolvedItems.length} item${resolvedItems.length === 1 ? '' : 's'}`,
      targetRole: 'production_user',
      branchId,
      relatedId: ref.id,
    });

    res.status(201).json({ id: ref.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders — last 7 days, branch-scoped
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    let query = adminDb.collection('production_orders') as FirebaseFirestore.Query;
    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.where('branchId', '==', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.where('branchId', '==', req.query['branchId']);
    }

    const snapshot = await query.get();
    const cutoff = businessDaysAgoStr(6); // inclusive last 7 business days
    const orders = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
      .filter((o) => String(o['date'] ?? '') >= cutoff)
      .sort((a, b) => String(b['submittedAt'] ?? '').localeCompare(String(a['submittedAt'] ?? '')));

    res.json({ orders, total: orders.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders/balances — outstanding pending balances per product.
// Branch managers are scoped to their own branch; others may pass ?branchId=.
// Defined as a literal path (no GET '/:id' route exists) so it never shadows.
router.get('/balances', async (req: AuthRequest, res, next) => {
  try {
    let query = adminDb.collection('production_balances') as FirebaseFirestore.Query;
    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.where('branchId', '==', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.where('branchId', '==', req.query['branchId']);
    }
    const snapshot = await query.get();
    const balances = snapshot.docs
      .map((d) => d.data() as Record<string, unknown>)
      .filter((b) => Number(b['pendingQty'] ?? 0) > 0);
    res.json({ balances });
  } catch (err) {
    next(err);
  }
});

type ReviewedItem = {
  productId: string;
  productName: string;
  qty: number;
  previousBalanceQty: number;
  totalRequiredQty: number;
  approvedQty: number;
  remainingBalanceQty: number;
};

// PUT /api/production-orders/:id/review — production/admin approves or rejects
router.put('/:id/review', requireRole('super_admin', 'production_user'), validate(ReviewProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status, approvedItems, reason } = req.body as {
      status: 'approved' | 'rejected';
      approvedItems?: { productId: string; approvedQty: number }[];
      reason?: string;
    };
    const id = req.params['id']!;
    const ref = adminDb.collection('production_orders').doc(id);

    // Approved qty overrides, keyed by productId (defaults to the total required qty).
    const overrides = new Map((approvedItems ?? []).map((a) => [a.productId, a.approvedQty] as const));

    // Atomic check-and-set (prevents double review). On approval we also read each
    // product's carried-forward pending balance and persist the new remainder in the
    // SAME transaction, so status and balances can never diverge. Firestore requires
    // all reads before any writes — mirrors commitSaleTransaction in stock.service.ts.
    const order = await adminDb.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw Object.assign(new Error('Production order not found'), { status: 404 });
      const data = doc.data() as { status: string; branchId: string; branchName: string; items: { productId: string; productName: string; qty: number }[] };
      if (data.status !== 'pending') throw Object.assign(new Error('Order already reviewed'), { status: 409 });

      const now = new Date().toISOString();
      const base: Record<string, unknown> = {
        status,
        approvedBy: req.user!.uid,
        approvedByName: req.user!.email,
        approvedAt: now,
      };

      if (status !== 'approved') {
        // Rejection: only flip status. Pending balances are intentionally left
        // untouched so any outstanding demand still carries into the next order.
        tx.update(ref, base);
        return data;
      }

      // ── Reads (all before writes): current pending balance per (branch, product) ──
      const balanceRefs = data.items.map((it) =>
        adminDb.collection('production_balances').doc(`${data.branchId}_${it.productId}`));
      const balanceSnaps = await Promise.all(balanceRefs.map((r) => tx.get(r)));

      // Total Required = carried-in balance + New Demand; approve the total by default.
      const items: ReviewedItem[] = data.items.map((it, i) => {
        const previousBalanceQty = balanceSnaps[i]!.exists ? Number(balanceSnaps[i]!.data()!['pendingQty'] ?? 0) : 0;
        const totalRequiredQty = previousBalanceQty + Number(it.qty ?? 0);
        const approvedQty = overrides.has(it.productId) ? overrides.get(it.productId)! : totalRequiredQty;
        const remainingBalanceQty = Math.max(0, totalRequiredQty - approvedQty);
        return { ...it, previousBalanceQty, totalRequiredQty, approvedQty, remainingBalanceQty };
      });

      base['items'] = items;
      base['wasChanged'] = items.some((it) => it.approvedQty !== it.totalRequiredQty);
      base['changeReason'] = reason ?? null;

      // ── Writes: order doc + the new pending balances (SET/overwrite, never increment;
      // totalRequiredQty already folded the prior balance in) ──
      tx.update(ref, base);
      items.forEach((it, i) => {
        tx.set(balanceRefs[i]!, {
          branchId: data.branchId,
          branchName: data.branchName ?? '',
          productId: it.productId,
          productName: it.productName,
          pendingQty: it.remainingBalanceQty,
          updatedAt: now,
        }, { merge: true });
      });

      return { ...data, items };
    });

    // On approval, move approved units OUT of the production pool and INTO branch
    // stock (both idempotent by order id, kept as separate retry-safe units).
    if (status === 'approved') {
      const items = order.items as ReviewedItem[];
      const moves = items.map((it) => ({ productId: it.productId, productName: it.productName, qty: it.approvedQty }));
      await transferOutOnApproval(id, moves);
      await Promise.all(moves.map((m) => applyProductionToStock({
        branchId: order.branchId,
        productId: m.productId,
        productName: m.productName,
        qty: m.qty,
        refId: id,
      })));
    }

    // Notify the branch with a per-product Total Required / Approved / Pending summary.
    const message = status === 'approved'
      ? (order.items as ReviewedItem[])
          .map((it) => `${it.productName}: Required ${it.totalRequiredQty}, Approved ${it.approvedQty}, Pending ${it.remainingBalanceQty}`)
          .join(' · ')
      : 'Your production order was rejected';

    await notify({
      type: 'production_reviewed',
      title: status === 'approved' ? 'Production Order Approved' : 'Production Order Rejected',
      message,
      targetRole: 'branch_manager',
      branchId: order.branchId,
      relatedId: id,
    });

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-orders/:id/printed — mark the slip printed. Idempotent merge-set;
// printing never mutates stock or creates records, so re-printing is a safe no-op.
router.put('/:id/printed', requireRole('super_admin', 'production_user'), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    await adminDb.collection('production_orders').doc(id).set(
      { printed: true, printedAt: new Date().toISOString() },
      { merge: true },
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
