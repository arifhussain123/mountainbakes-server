import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { PrepareProductionSchema, businessDateStr, type Product } from '../shared';
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

    // Resolve product names server-side (names/prices are Admin-owned).
    const productDocs = await Promise.all(items.map((i) => adminDb.collection('products').doc(i.productId).get()));
    const resolved = items.map((i, idx) => {
      const pDoc = productDocs[idx];
      if (!pDoc || !pDoc.exists) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
      return { productId: i.productId, productName: (pDoc.data() as Product).name, qty: i.qty };
    });

    // A fresh id per submission keeps each prep batch idempotent yet additive.
    const refId = adminDb.collection('production_stock_history').doc().id;
    await prepareProducts(refId, resolved);

    res.status(201).json({ id: refId, count: resolved.length });
  } catch (err) {
    next(err);
  }
});
