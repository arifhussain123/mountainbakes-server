import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';

export const router = Router();

router.use(authenticate);

// GET /api/search?q=
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const q = String(req.query['q'] || '').toLowerCase().trim();
    if (!q || q.length < 2) { res.json({ results: [] }); return; }

    const isBranchManager = req.user!.role === 'branch_manager';
    const isProductionUser = req.user!.role === 'production_user';
    const branchId = req.user!.branchId;

    // Build orders query: apply branch filter in DB for branch managers (avoids in-memory
    // truncation when total orders exceed the limit), restrict production users to active statuses
    let ordersQuery: FirebaseFirestore.Query = adminDb.collection('orders');
    if (isBranchManager && branchId) {
      ordersQuery = ordersQuery.where('branchId', '==', branchId);
    }
    if (isProductionUser) {
      ordersQuery = ordersQuery.where('status', 'in', ['pending', 'preparing', 'ready']);
    }
    ordersQuery = ordersQuery.orderBy('createdAt', 'desc').limit(200);

    const [ordersSnap, productsSnap, customersSnap] = await Promise.all([
      ordersQuery.get(),
      adminDb.collection('products').where('isActive', '==', true).limit(200).get(),
      // Production users have no access to customer data
      isProductionUser
        ? Promise.resolve(null)
        : isBranchManager && branchId
          ? adminDb.collection('customers').where('branchId', '==', branchId).limit(200).get()
          : adminDb.collection('customers').limit(200).get(),
    ]);

    type OrderDoc = { id: string; branchId: string; orderNumber: string; customerName: string; status: string };
    type ProductDoc = { id: string; name: string; sku: string; price: number };
    type CustomerDoc = { id: string; name: string; phone: string };

    const matchOrders = (ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as unknown as OrderDoc[])
      .filter((o) => o.orderNumber?.toLowerCase().includes(q) || o.customerName?.toLowerCase().includes(q))
      .slice(0, 5)
      .map((o) => ({ id: o.id, label: `${o.orderNumber} — ${o.customerName}`, type: 'order', href: `/orders/${o.id}`, status: o.status }));

    const matchProducts = (productsSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as unknown as ProductDoc[])
      .filter((p) => p.name?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q))
      .slice(0, 5)
      .map((p) => ({ id: p.id, label: `${p.name} (${p.sku}) — Rs.${p.price}`, type: 'product', href: `/products/${p.id}` }));

    const matchCustomers = customersSnap
      ? (customersSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as unknown as CustomerDoc[])
          .filter((c) => c.name?.toLowerCase().includes(q) || c.phone?.includes(q))
          .slice(0, 5)
          .map((c) => ({ id: c.id, label: `${c.name} — ${c.phone}`, type: 'customer', href: `/customers/${c.id}` }))
      : [];

    const results = [
      { type: 'Orders', items: matchOrders },
      { type: 'Products', items: matchProducts },
      { type: 'Customers', items: matchCustomers },
    ].filter((g) => g.items.length > 0);

    res.json({ results });
  } catch (err) {
    next(err);
  }
});
