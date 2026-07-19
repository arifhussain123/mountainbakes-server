import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/requireRole';
import { CreateCustomerSchema, UpdateCustomerSchema } from '../shared';

export const router = Router();

router.use(authenticate);

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { search } = req.query;
    let query = adminDb.collection('customers') as FirebaseFirestore.Query;

    // Branch managers can only see their own branch customers
    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.where('branchId', '==', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.where('branchId', '==', req.query['branchId']);
    }

    const snapshot = await query.get();
    let customers = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, unknown>[];
    customers.sort((a, b) => String(b['createdAt'] ?? '').localeCompare(String(a['createdAt'] ?? '')));

    if (search) {
      const s = String(search).toLowerCase();
      customers = customers.filter((c: Record<string, unknown>) =>
        String(c['name']).toLowerCase().includes(s) ||
        String(c['phone']).includes(String(search))
      );
    }

    res.json({ customers, total: customers.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const doc = await adminDb.collection('customers').doc(req.params['id']!).get();
    if (!doc.exists) { res.status(404).json({ error: 'Customer not found' }); return; }

    const data = doc.data() as { branchId: string };
    if (req.user!.role === 'branch_manager' && data.branchId !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({ customer: { id: doc.id, ...data } });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('super_admin', 'branch_manager'), validate(CreateCustomerSchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, phone, email, address, branchId } = req.body;

    // Branch managers can only create customers for their own branch
    const effectiveBranchId = req.user!.role === 'branch_manager' ? req.user!.branchId! : branchId;

    const branchDoc = await adminDb.collection('branches').doc(effectiveBranchId).get();
    if (!branchDoc.exists) { res.status(400).json({ error: 'Branch not found' }); return; }
    const branchName = (branchDoc.data() as { name: string }).name;

    const now = new Date().toISOString();
    const ref = await adminDb.collection('customers').add({
      name, phone, email, address,
      branchId: effectiveBranchId,
      branchName,
      totalOrders: 0,
      totalSpent: 0,
      createdAt: now,
      updatedAt: now,
    });

    res.status(201).json({ id: ref.id, name });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireRole('super_admin', 'branch_manager'), validate(UpdateCustomerSchema), async (req: AuthRequest, res, next) => {
  try {
    const doc = await adminDb.collection('customers').doc(req.params['id']!).get();
    if (!doc.exists) { res.status(404).json({ error: 'Customer not found' }); return; }

    const data = doc.data() as { branchId: string };
    if (req.user!.role === 'branch_manager' && data.branchId !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await adminDb.collection('customers').doc(req.params['id']!).update({
      ...req.body,
      updatedAt: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
