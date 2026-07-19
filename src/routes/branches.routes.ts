import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateBranchSchema, UpdateBranchSchema } from '../shared';
import { slugify } from '../utils/slugify';
import { notify } from '../services/push.service';
import { getCached, setCached, invalidate } from '../utils/cache';

export const router = Router();

// GET /api/branches — all authenticated users can read branches
router.get('/', authenticate, async (_req, res, next) => {
  try {
    const hit = getCached<unknown[]>('branches');
    if (hit) { res.json({ branches: hit }); return; }

    const snapshot = await adminDb.collection('branches').orderBy('name').get();
    const branches = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    setCached('branches', branches);
    res.json({ branches });
  } catch (err) {
    next(err);
  }
});

// GET /api/branches/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const doc = await adminDb.collection('branches').doc(req.params['id']!).get();
    if (!doc.exists) { res.status(404).json({ error: 'Branch not found' }); return; }
    res.json({ branch: { id: doc.id, ...doc.data() } });
  } catch (err) {
    next(err);
  }
});

// POST /api/branches — admin only
router.post('/', authenticate, requireRole('super_admin'), validate(CreateBranchSchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, location, phone, address, city, dailyBudget, weeklyBudget, monthlyBudget } = req.body;
    const now = new Date().toISOString();

    const ref = await adminDb.collection('branches').add({
      name,
      slug: slugify(name),
      location,
      phone,
      address,
      city,
      managerId: null,
      managerName: null,
      isActive: true,
      dailyBudget: dailyBudget ?? 0,
      weeklyBudget: weeklyBudget ?? 0,
      monthlyBudget: monthlyBudget ?? 0,
      createdAt: now,
      updatedAt: now,
    });
    invalidate('branches');

    // Notify admins of new branch (in-app + web push)
    await notify({
      type: 'branch_added',
      title: 'New Branch Added',
      message: `${name} has been added to the system`,
      targetRole: 'super_admin',
      branchId: ref.id,
      relatedId: ref.id,
    });

    res.status(201).json({ id: ref.id, name });
  } catch (err) {
    next(err);
  }
});

// PUT /api/branches/:id — admin only
router.put('/:id', authenticate, requireRole('super_admin'), validate(UpdateBranchSchema), async (req: AuthRequest, res, next) => {
  try {
    const updates = { ...req.body, updatedAt: new Date().toISOString() };
    if (updates.name) updates['slug'] = slugify(updates.name);

    await adminDb.collection('branches').doc(req.params['id']!).update(updates);
    invalidate('branches');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/branches/:id — admin only (soft delete)
router.delete('/:id', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    await adminDb.collection('branches').doc(req.params['id']!).update({
      isActive: false,
      updatedAt: new Date().toISOString(),
    });
    invalidate('branches');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
