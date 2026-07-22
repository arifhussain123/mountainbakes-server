import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateBranchSchema, UpdateBranchSchema, type Branch } from '../shared';
import { slugify } from '../utils/slugify';
import { notify } from '../services/push.service';
import { getCached, setCached, invalidate } from '../utils/cache';
import { rowToApi, apiToRow } from '../utils/case';

export const router = Router();

/**
 * GET /api/branches — all authenticated users can read branches.
 *
 * Inactive branches are EXCLUDED by default. DELETE /:id is a soft delete
 * (is_active = false), so without this a "deleted" branch kept appearing in
 * every list and picker forever. Pass ?includeInactive=true to get them back —
 * an admin screen managing closed branches would want that.
 *
 * The cache key varies with the flag; `invalidate('branches')` matches on the
 * `branches:` prefix so it still clears both variants on write.
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const includeInactive = req.query['includeInactive'] === 'true';
    const cacheKey = `branches:${includeInactive ? 'all' : 'active'}`;

    const hit = getCached<Branch[]>(cacheKey);
    if (hit) { res.json({ branches: hit }); return; }

    let query = supabaseAdmin.from('branches').select('*').order('name', { ascending: true });
    if (!includeInactive) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) throw error;

    const branches = rowToApi<Branch[]>(data ?? []);
    setCached(cacheKey, branches);
    res.json({ branches });
  } catch (err) {
    next(err);
  }
});

// GET /api/branches/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    // maybeSingle() returns null instead of erroring when there is no match, so a
    // missing branch stays a clean 404 rather than a 500.
    const { data, error } = await supabaseAdmin
      .from('branches')
      .select('*')
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Branch not found' }); return; }

    res.json({ branch: rowToApi<Branch>(data) });
  } catch (err) {
    next(err);
  }
});

// POST /api/branches — admin only
router.post('/', authenticate, requireRole('super_admin'), validate(CreateBranchSchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, location, phone, address, city, dailyBudget, weeklyBudget, monthlyBudget } = req.body;

    // created_at / updated_at come from column defaults — do not set them here.
    const { data, error } = await supabaseAdmin
      .from('branches')
      .insert({
        name,
        slug: slugify(name),
        location,
        phone,
        address,
        city,
        manager_id: null,
        manager_name: null,
        is_active: true,
        daily_budget: dailyBudget ?? 0,
        weekly_budget: weeklyBudget ?? 0,
        monthly_budget: monthlyBudget ?? 0,
      })
      .select('id')
      .single();

    // `slug` is UNIQUE. Two branches with the same name slugify identically, so
    // surface that as a 409 the UI can show rather than a generic 500.
    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: `A branch named "${name}" already exists` });
        return;
      }
      throw error;
    }

    invalidate('branches');

    // Notify admins of new branch. In-app only for now — web push is not
    // delivered until VAPID is implemented (see push.service.ts).
    // branchId is null: super_admin is a central role with no branch claim, and the
    // notifications RLS filters out a role broadcast whose branch_id doesn't match
    // the recipient's — so a non-null branchId hides this from every admin. The new
    // branch is still linked via relatedId.
    await notify({
      type: 'branch_added',
      title: 'New Branch Added',
      message: `${name} has been added to the system`,
      targetRole: 'super_admin',
      branchId: null,
      relatedId: data.id,
    });

    res.status(201).json({ id: data.id, name });
  } catch (err) {
    next(err);
  }
});

// PUT /api/branches/:id — admin only
router.put('/:id', authenticate, requireRole('super_admin'), validate(UpdateBranchSchema), async (req: AuthRequest, res, next) => {
  try {
    // updated_at is maintained by the branches_touch trigger — do not set it here.
    const updates = apiToRow(req.body);
    if (typeof req.body.name === 'string') updates['slug'] = slugify(req.body.name);

    // A Postgres UPDATE against a missing row just reports 0 rows affected rather
    // than erroring. Select the id back so a bad :id is still a 404.
    const { data, error } = await supabaseAdmin
      .from('branches')
      .update(updates)
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: `A branch named "${req.body.name}" already exists` });
        return;
      }
      throw error;
    }
    if (!data) { res.status(404).json({ error: 'Branch not found' }); return; }

    invalidate('branches');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/branches/:id — admin only (soft delete)
router.delete('/:id', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('branches')
      .update({ is_active: false })
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Branch not found' }); return; }

    invalidate('branches');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
