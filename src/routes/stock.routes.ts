import { Router } from 'express';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { businessDateStr, CreateBranchReturnSchema, type StockAuditLog } from '../shared';
import { notify } from '../services/push.service';
import { returnIntoPool } from '../services/production-stock.service';
import { commitBranchReturn, computeStockRows, InsufficientStockError } from '../services/stock.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate);

// GET /api/stock/audit — blocked-sale attempts (Admin: all; branch manager: own branch)
router.get('/audit', async (req: AuthRequest, res, next) => {
  try {
    // Ordering and the 200-row cap happen in Postgres (stock_audit_log_branch_idx
    // is already (branch_id, created_at desc)); this used to fetch every row and
    // sort/slice in memory.
    let query = supabaseAdmin
      .from('stock_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (req.user!.role === 'branch_manager') {
      if (!req.user!.branchId) { res.status(400).json({ error: 'No branch assigned' }); return; }
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.user!.role !== 'super_admin') {
      res.status(403).json({ error: 'Access denied' });
      return;
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    const logs = rowToApi<StockAuditLog[]>(data ?? []);
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

    const [branchRes, productRes] = await Promise.all([
      supabaseAdmin.from('branches').select('name').eq('id', branchId).maybeSingle(),
      supabaseAdmin.from('products').select('name').eq('id', productId).maybeSingle(),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (productRes.error) throw productRes.error;
    if (!branchRes.data) { res.status(400).json({ error: 'Branch not found' }); return; }
    if (!productRes.data) { res.status(400).json({ error: 'Product not found' }); return; }

    const branchName = branchRes.data.name as string;
    const productName = productRes.data.name as string;

    // Mint the return id up front so it is the shared refId across branch stock,
    // the production pool and the record — that id is the idempotency key on both
    // stock_history and production_stock_history, so all three movements must
    // agree on it. (Minted client-side with randomUUID().)
    const returnId = randomUUID();
    const now = new Date().toISOString();

    // 1) Decrement branch stock (validates qty <= balance atomically).
    try {
      await commitBranchReturn({ branchId, productId, productName, qty, refId: returnId });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        res.status(409).json({ error: 'Return quantity cannot be greater than available stock.', details: err.shortfalls });
        return;
      }
      throw err;
    }

    // 2) Add the units back into the central production pool (feeds "Returned").
    await returnIntoPool(returnId, { productId, productName, qty });

    // 3) Record an accepted return so it surfaces on the Production Returns page.
    //    The id is supplied rather than generated, to match the refId above.
    const { error: insertErr } = await supabaseAdmin.from('production_returns').insert({
      id: returnId,
      branch_id: branchId,
      branch_name: branchName,
      product_id: productId,
      product_name: productName,
      qty,
      reason: reason || '',
      status: 'accepted',
      source: 'branch',
      business_date: businessDateStr(),
      created_by: req.user!.uid,
      created_by_name: req.user!.email,
      reviewed_by: req.user!.uid,
      reviewed_by_name: req.user!.email,
      reviewed_at: now,
    });
    if (insertErr) throw insertErr;

    // 4) Notify Production in real time.
    await notify({
      type: 'production_return',
      title: 'Stock Returned',
      message: `${qty} × ${productName} from ${branchName}`,
      targetRole: 'production_user',
      branchId,
      relatedId: returnId,
    });

    res.status(201).json({ id: returnId });
  } catch (err) {
    next(err);
  }
});
