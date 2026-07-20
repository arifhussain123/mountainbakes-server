import { Router } from 'express';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { PrepareProductionSchema, businessDateStr } from '../shared';
import { prepareProducts, getProductionStockRows } from '../services/production-stock.service';

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

// GET /api/production-stock?date=YYYY-MM-DD — production pool table (defaults to today)
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const date = typeof req.query['date'] === 'string' && req.query['date'] ? String(req.query['date']) : businessDateStr();
    const rows = await getProductionStockRows(date);
    res.json({ rows, date });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-stock/prepare — record "Today's Prepared Products"
router.post('/prepare', validate(PrepareProductionSchema), async (req: AuthRequest, res, next) => {
  try {
    const { items } = req.body as { items: { productId: string; qty: number }[] };

    // Resolve product names server-side (names/prices are Admin-owned). One query
    // rather than N point reads.
    const productIds = [...new Set(items.map((i) => i.productId))];
    const { data: products, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .in('id', productIds);
    if (prodErr) throw prodErr;

    const nameById = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
    const resolved = items.map((i) => {
      const name = nameById.get(i.productId);
      if (!name) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
      return { productId: i.productId, productName: name, qty: i.qty };
    });

    // A fresh id per submission keeps each prep batch idempotent yet additive
    // (the ref_id half of the production_stock_history idempotency key).
    const refId = randomUUID();
    await prepareProducts(refId, resolved);

    res.status(201).json({ id: refId, count: resolved.length });
  } catch (err) {
    next(err);
  }
});
