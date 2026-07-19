import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateProductSchema, UpdateProductSchema, CreateCategorySchema, UpdateCategorySchema, ChangePriceSchema } from '../shared';
import { slugify } from '../utils/slugify';
import { notify } from '../services/push.service';
import { getCached, setCached, invalidate } from '../utils/cache';
import { applyPriceChange } from '../services/price.service';
import { resolveAdminName } from '../services/audit.service';

/** 'YYYY-MM-DD' → 'DD-MM-YYYY' for human-facing messages. */
function dmy(d: string): string {
  const [y, m, dd] = String(d).split('-');
  return dd && m && y ? `${dd}-${m}-${y}` : String(d);
}

export const router = Router();

// ─── Categories ───────────────────────────────────────────────────────────────

router.get('/categories', authenticate, async (_req, res, next) => {
  try {
    const cachedCategories = getCached<Record<string, unknown>[]>('categories');
    if (cachedCategories) { res.json({ categories: cachedCategories }); return; }

    const snapshot = await adminDb.collection('categories').where('isActive', '==', true).get();
    const categories = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, unknown>[];
    categories.sort((a, b) => Number(a['sortOrder'] ?? 0) - Number(b['sortOrder'] ?? 0));
    setCached('categories', categories);
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

router.post('/categories', authenticate, requireRole('super_admin'), validate(CreateCategorySchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, sortOrder } = req.body;
    const now = new Date().toISOString();
    const ref = await adminDb.collection('categories').add({
      name,
      slug: slugify(name),
      sortOrder: sortOrder ?? 0,
      isActive: true,
      createdAt: now,
    });
    invalidate('categories');
    res.status(201).json({ id: ref.id, name });
  } catch (err) {
    next(err);
  }
});

router.put('/categories/:id', authenticate, requireRole('super_admin'), validate(UpdateCategorySchema), async (req, res, next) => {
  try {
    const updates = req.body;
    if (updates.name) updates['slug'] = slugify(updates.name);
    await adminDb.collection('categories').doc(req.params['id']!).update(updates);
    invalidate('categories');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    await adminDb.collection('categories').doc(req.params['id']!).update({ isActive: false });
    invalidate('categories');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Products ────────────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { search, categoryId, isActive } = req.query;

    // Cache only the unfiltered-by-search list variants (the hot path used across the
    // app); free-text searches are pass-through so results are always fresh.
    const cacheKey = search ? null : `products:${categoryId ?? 'all'}:${isActive ?? 'any'}`;
    if (cacheKey) {
      const hit = getCached<{ products: Record<string, unknown>[]; total: number }>(cacheKey);
      if (hit) { res.json(hit); return; }
    }

    let query = adminDb.collection('products') as FirebaseFirestore.Query;

    if (categoryId) query = query.where('categoryId', '==', categoryId);
    if (isActive !== undefined) query = query.where('isActive', '==', isActive === 'true');

    const snapshot = await query.get();
    let products = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, unknown>[];
    products.sort((a, b) => String(a['name'] ?? '').localeCompare(String(b['name'] ?? '')));

    if (search) {
      const s = String(search).toLowerCase();
      products = products.filter((p: Record<string, unknown>) =>
        String(p['name']).toLowerCase().includes(s) || String(p['sku']).toLowerCase().includes(s)
      );
    }

    const payload = { products, total: products.length };
    if (cacheKey) setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const doc = await adminDb.collection('products').doc(req.params['id']!).get();
    if (!doc.exists) { res.status(404).json({ error: 'Product not found' }); return; }
    res.json({ product: { id: doc.id, ...doc.data() } });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/:id/price — the ONLY way to change a price. Records an
// immutable history/audit row; applies immediately if effective today/past, else
// schedules for activation on the effective date. (2 segments, so it never clashes
// with GET/PUT/DELETE '/:id'.)
router.post('/:id/price', authenticate, requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const parsed = ChangePriceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.errors });
      return;
    }
    const { newPrice, effectiveDate, reason } = parsed.data;
    const changedByName = await resolveAdminName(req.user!.uid, req.user!.email);
    const result = await applyPriceChange({
      productId: req.params['id']!,
      newPrice,
      effectiveDate,
      reason,
      source: 'manual',
      changedBy: req.user!.uid,
      changedByName,
    });

    if (result.status === 'skipped') {
      res.json({ status: 'skipped', reason: result.reason });
      return;
    }

    // Branches are notified only when a price goes live now; a scheduled change is
    // announced when it activates on the effective date.
    if (result.status === 'active') {
      await notify({
        type: 'price_changed',
        title: 'Price Updated',
        message: `${result.productName || 'A product'} price is now Rs.${newPrice}`,
        targetRole: 'branch_manager',
        relatedId: req.params['id'],
      });
    }

    res.json({ status: result.status, versionNumber: result.versionNumber, effectiveDate: dmy(effectiveDate) });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const parsed = CreateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.errors });
      return;
    }

    const { name, categoryId, sku, price, costPrice, description } = parsed.data;

    // Get category name
    const catDoc = await adminDb.collection('categories').doc(categoryId).get();
    if (!catDoc.exists) { res.status(400).json({ error: 'Category not found' }); return; }
    const categoryName = (catDoc.data() as { name: string }).name;

    const now = new Date().toISOString();
    const ref = await adminDb.collection('products').add({
      name,
      categoryId,
      categoryName,
      sku,
      price,
      costPrice,
      description,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    invalidate('products');

    // Notify branch managers a product was added (in-app + web push)
    await notify({
      type: 'price_changed',
      title: 'New Product Added',
      message: `${name} has been added at Rs.${price}`,
      targetRole: 'branch_manager',
      relatedId: ref.id,
    });

    res.status(201).json({ id: ref.id, name, price });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authenticate, requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const parsed = UpdateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.errors });
      return;
    }

    const updates: Record<string, unknown> = { ...parsed.data, updatedAt: new Date().toISOString() };

    // Price changes must go through POST /:id/price so they always record history +
    // an effective date. Strip any price here so this path can never bypass that.
    delete updates['price'];

    if (updates['categoryId']) {
      const catDoc = await adminDb.collection('categories').doc(String(updates['categoryId'])).get();
      if (catDoc.exists) updates['categoryName'] = (catDoc.data() as { name: string }).name;
    }

    await adminDb.collection('products').doc(req.params['id']!).update(updates);
    invalidate('products');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    await adminDb.collection('products').doc(req.params['id']!).update({
      isActive: false,
      updatedAt: new Date().toISOString(),
    });
    invalidate('products');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
