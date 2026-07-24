import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateProductionReturnSchema,
  ReviewProductionReturnSchema,
  businessDateStr,
  businessDaysAgoStr,
} from '../shared';
import { notify } from '../services/push.service';
import { returnIntoPool } from '../services/production-stock.service';
import { applyStockMovement } from '../services/stock.service';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

// GET /api/production-returns — last 30 days, most recent first
router.get('/', async (_req, res, next) => {
  try {
    const cutoff = businessDaysAgoStr(29);
    const { data, error } = await supabaseAdmin
      .from('production_returns')
      .select('*')
      .gte('business_date', cutoff)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const returns = rowToApi<Record<string, unknown>[]>(data ?? []);
    res.json({ returns, total: returns.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-returns — Production records a branch return (pending review)
router.post('/', validate(CreateProductionReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, productId, qty, reason } = req.body as { branchId: string; productId: string; qty: number; reason: string };

    const [branchRes, productRes] = await Promise.all([
      supabaseAdmin.from('branches').select('name').eq('id', branchId).maybeSingle(),
      supabaseAdmin.from('products').select('name').eq('id', productId).maybeSingle(),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (productRes.error) throw productRes.error;
    if (!branchRes.data) { res.status(400).json({ error: 'Branch not found' }); return; }
    if (!productRes.data) { res.status(400).json({ error: 'Product not found' }); return; }

    // created_at comes from the column default; reviewed_* stay null until review.
    const { data: created, error: insErr } = await supabaseAdmin
      .from('production_returns')
      .insert({
        branch_id: branchId,
        branch_name: branchRes.data.name,
        product_id: productId,
        product_name: productRes.data.name,
        qty,
        reason,
        status: 'pending',
        business_date: businessDateStr(),
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    // branchId null: production_user has no branch claim, and the notifications RLS
    // filters out a role broadcast whose branch_id doesn't match the recipient's.
    // The source branch is already named in the message.
    await notify({
      type: 'production_return',
      title: 'Product Return Recorded',
      message: `${qty} × ${productRes.data.name} from ${branchRes.data.name}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: created.id,
    });

    res.status(201).json({ id: created.id });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-returns/:id/review — accept (restock) or reject
router.put('/:id/review', validate(ReviewProductionReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status } = req.body as { status: 'accepted' | 'rejected' };
    const id = req.params['id']!;

    // Atomic check-and-set: the `.eq('status', 'pending')` predicate is what makes
    // a double review a no-op (migration 05). A zero-row result means the return
    // was either not found or already reviewed — distinguished below.
    const { data: reviewed, error: updErr } = await supabaseAdmin
      .from('production_returns')
      .update({
        status,
        reviewed_by: req.user!.uid,
        reviewed_by_name: req.user!.email,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('branch_id, product_id, product_name, qty')
      .maybeSingle();
    if (updErr) throw updErr;

    if (!reviewed) {
      const { data: exists, error: exErr } = await supabaseAdmin
        .from('production_returns')
        .select('id')
        .eq('id', id)
        .maybeSingle();
      if (exErr) throw exErr;
      if (!exists) { res.status(404).json({ error: 'Return not found' }); return; }
      res.status(409).json({ error: 'Return already reviewed' });
      return;
    }

    // Accepted returns flow back INTO the production pool and OUT of branch stock.
    // Both movements are idempotent by ref_id, so the separate-transaction gap
    // carried over from the original is retry-safe.
    if (status === 'accepted') {
      await returnIntoPool(id, { productId: reviewed.product_id, productName: reviewed.product_name, qty: Number(reviewed.qty) });
      await applyStockMovement({
        branchId: reviewed.branch_id,
        productId: reviewed.product_id,
        productName: reviewed.product_name,
        delta: -Math.abs(Number(reviewed.qty)),
        type: 'adjustment',
        refId: `return_${id}`,
      });
      await notify({
        type: 'production_return',
        title: 'Return Accepted',
        message: `${Number(reviewed.qty)} × ${reviewed.product_name} returned to production`,
        targetRole: 'branch_manager',
        branchId: reviewed.branch_id,
        relatedId: id,
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
