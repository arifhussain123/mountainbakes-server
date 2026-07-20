import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
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
    // truncation when total orders exceed the limit), restrict production users to active statuses.
    let ordersQuery = supabaseAdmin
      .from('orders')
      .select('id, order_number, customer_name, status, branch_id');
    if (isBranchManager && branchId) {
      ordersQuery = ordersQuery.eq('branch_id', branchId);
    }
    if (isProductionUser) {
      ordersQuery = ordersQuery.in('status', ['pending', 'preparing', 'ready']);
    }
    ordersQuery = ordersQuery.order('created_at', { ascending: false }).limit(200);

    const [ordersRes, productsRes, customersRes] = await Promise.all([
      ordersQuery,
      supabaseAdmin.from('products').select('id, name, sku, price').eq('is_active', true).limit(200),
      // Production users have no access to customer data.
      isProductionUser
        ? Promise.resolve(null)
        : isBranchManager && branchId
          ? supabaseAdmin.from('customers').select('id, name, phone').eq('branch_id', branchId).limit(200)
          : supabaseAdmin.from('customers').select('id, name, phone').limit(200),
    ]);

    if (ordersRes.error) throw ordersRes.error;
    if (productsRes.error) throw productsRes.error;
    if (customersRes && customersRes.error) throw customersRes.error;

    type OrderRow = { id: string; order_number: string; customer_name: string | null; status: string };
    type ProductRow = { id: string; name: string; sku: string | null; price: number };
    type CustomerRow = { id: string; name: string; phone: string | null };

    const matchOrders = ((ordersRes.data ?? []) as OrderRow[])
      .filter((o) => o.order_number?.toLowerCase().includes(q) || o.customer_name?.toLowerCase().includes(q))
      .slice(0, 5)
      .map((o) => ({ id: o.id, label: `${o.order_number} — ${o.customer_name ?? ''}`, type: 'order', href: `/orders/${o.id}`, status: o.status }));

    const matchProducts = ((productsRes.data ?? []) as ProductRow[])
      .filter((p) => p.name?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q))
      .slice(0, 5)
      .map((p) => ({ id: p.id, label: `${p.name} (${p.sku ?? ''}) — Rs.${p.price}`, type: 'product', href: `/products/${p.id}` }));

    const matchCustomers = customersRes
      ? ((customersRes.data ?? []) as CustomerRow[])
          .filter((c) => c.name?.toLowerCase().includes(q) || c.phone?.includes(q))
          .slice(0, 5)
          .map((c) => ({ id: c.id, label: `${c.name} — ${c.phone ?? ''}`, type: 'customer', href: `/customers/${c.id}` }))
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
