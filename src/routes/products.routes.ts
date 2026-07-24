import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateProductSchema, UpdateProductSchema, CreateCategorySchema, UpdateCategorySchema, ChangePriceSchema } from '../shared';
import { slugify } from '../utils/slugify';
import { notify } from '../services/push.service';
import { getCached, setCached, invalidate } from '../utils/cache';
import { applyPriceChange } from '../services/price.service';
import { resolveAdminName } from '../services/audit.service';
import { rowToApi, apiToRow } from '../utils/case';

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

    // Sorting moves into Postgres; it was an in-memory sort of the whole collection.
    const { data, error } = await supabaseAdmin
      .from('categories')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;

    const categories = rowToApi<Record<string, unknown>[]>(data ?? []);
    setCached('categories', categories);
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

router.post('/categories', authenticate, requireRole('super_admin'), validate(CreateCategorySchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, sortOrder } = req.body;

    // created_at comes from the column default — do not set it here.
    const { data, error } = await supabaseAdmin
      .from('categories')
      .insert({ name, slug: slugify(name), sort_order: sortOrder ?? 0, is_active: true })
      .select('id')
      .single();

    // `slug` is UNIQUE: two categories whose names slugify identically collide.
    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: `A category named "${name}" already exists` });
        return;
      }
      throw error;
    }

    invalidate('categories');
    res.status(201).json({ id: data.id, name });
  } catch (err) {
    next(err);
  }
});

router.put('/categories/:id', authenticate, requireRole('super_admin'), validate(UpdateCategorySchema), async (req, res, next) => {
  try {
    // updated_at is maintained by the categories_touch trigger — do not set it here.
    const updates = apiToRow(req.body);
    if (typeof req.body.name === 'string') updates['slug'] = slugify(req.body.name);

    const { data, error } = await supabaseAdmin
      .from('categories')
      .update(updates)
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: `A category named "${req.body.name}" already exists` });
        return;
      }
      throw error;
    }
    if (!data) { res.status(404).json({ error: 'Category not found' }); return; }

    invalidate('categories');
    // A renamed category invalidates the denormalised products.category_name
    // copies below, so drop the product cache too.
    invalidate('products');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('categories')
      .update({ is_active: false })
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Category not found' }); return; }

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

    let query = supabaseAdmin.from('products').select('*').order('name', { ascending: true });
    if (categoryId) query = query.eq('category_id', categoryId);
    if (isActive !== undefined) query = query.eq('is_active', isActive === 'true');

    // Free-text search moves into Postgres. `or` + ilike matches the previous
    // case-insensitive substring behaviour over name and sku, but without pulling
    // the whole table into memory first. Commas and parens are stripped from the
    // term because they are the syntax separators of PostgREST's `or` filter.
    if (search) {
      const term = String(search).replace(/[(),*]/g, ' ').trim();
      if (term) query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const products = rowToApi<Record<string, unknown>[]>(data ?? []);
    const payload = { products, total: products.length };
    if (cacheKey) setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Product not found' }); return; }

    res.json({ product: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/:id/price — the ONLY way to change a price. Records an
// immutable history row; applies immediately if effective today/past, else
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

    // category_name is a denormalised cache of categories.name, so the category
    // must be read before the insert.
    const { data: category, error: catErr } = await supabaseAdmin
      .from('categories')
      .select('name')
      .eq('id', categoryId)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!category) { res.status(400).json({ error: 'Category not found' }); return; }

    const { data, error } = await supabaseAdmin
      .from('products')
      .insert({
        name,
        category_id: categoryId,
        category_name: category.name,
        sku,
        price,
        cost_price: costPrice,
        description,
        is_active: true,
      })
      .select('id')
      .single();
    if (error) throw error;

    invalidate('products');

    // Notify branch managers a product was added.
    await notify({
      type: 'price_changed',
      title: 'New Product Added',
      message: `${name} has been added at Rs.${price}`,
      targetRole: 'branch_manager',
      relatedId: data.id,
    });

    res.status(201).json({ id: data.id, name, price });
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

    // updated_at is maintained by the products_touch trigger — do not set it here.
    const updates = apiToRow(parsed.data);

    // Price changes must go through POST /:id/price so they always record history +
    // an effective date. Strip any price here so this path can never bypass that.
    delete updates['price'];

    // Keep the denormalised category_name in step when the category changes.
    if (parsed.data.categoryId) {
      const { data: category, error: catErr } = await supabaseAdmin
        .from('categories')
        .select('name')
        .eq('id', parsed.data.categoryId)
        .maybeSingle();
      if (catErr) throw catErr;
      if (category) updates['category_name'] = category.name;
    }

    const { data, error } = await supabaseAdmin
      .from('products')
      .update(updates)
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Product not found' }); return; }

    invalidate('products');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ is_active: false })
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Product not found' }); return; }

    invalidate('products');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
