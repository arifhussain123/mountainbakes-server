import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateOrderSchema, CreatePosSaleSchema, UpdateOrderStatusSchema, LOW_STOCK_THRESHOLD, businessDateStr, type Product, type AppSettings } from '../shared';
import { generateOrderNumber } from '../utils/orderNumber';
import { notify } from '../services/push.service';
import { commitSaleTransaction, logBlockedSale, InsufficientStockError, type SaleBalance } from '../services/stock.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';

export const router = Router();

router.use(authenticate);

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { status, from, to } = req.query;
    let query = adminDb.collection('orders') as FirebaseFirestore.Query;

    // Branch managers see only their branch
    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.where('branchId', '==', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.where('branchId', '==', req.query['branchId']);
    }

    // Production users are restricted to active order statuses (Admin SDK bypasses Firestore rules)
    const ACTIVE_STATUSES = ['pending', 'preparing', 'ready'];
    if (req.user!.role === 'production_user') {
      if (status) {
        if (!ACTIVE_STATUSES.includes(String(status))) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
        query = query.where('status', '==', status);
      } else {
        query = query.where('status', 'in', ACTIVE_STATUSES);
      }
    } else if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.get();
    let orders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, unknown>[];
    orders.sort((a, b) => String(b['createdAt'] ?? '').localeCompare(String(a['createdAt'] ?? '')));

    // Date filter in memory (Firestore limitation with inequality + equality)
    if (from) orders = orders.filter((o: Record<string, unknown>) => String(o['createdAt']) >= String(from));
    if (to) orders = orders.filter((o: Record<string, unknown>) => String(o['createdAt']) <= String(to) + 'Z');

    res.json({ orders, total: orders.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const doc = await adminDb.collection('orders').doc(req.params['id']!).get();
    if (!doc.exists) { res.status(404).json({ error: 'Order not found' }); return; }

    const data = doc.data() as { branchId: string };
    if (req.user!.role === 'branch_manager' && data.branchId !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({ order: { id: doc.id, ...data } });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('super_admin', 'branch_manager'), validate(CreateOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, customerId, items, paymentMethod, deliveryCharges, notes } = req.body;

    // Scope check for branch managers
    if (req.user!.role === 'branch_manager' && branchId !== req.user!.branchId) {
      res.status(403).json({ error: 'Cannot create orders for other branches' });
      return;
    }

    await assertBusinessDayOpen(businessDateStr(), req.user!.role);

    // Fetch branch + customer concurrently
    const [branchDoc, customerDoc, settingsDoc] = await Promise.all([
      adminDb.collection('branches').doc(branchId).get(),
      adminDb.collection('customers').doc(customerId).get(),
      adminDb.collection('settings').doc('app').get(),
    ]);

    if (!branchDoc.exists) { res.status(400).json({ error: 'Branch not found' }); return; }
    if (!customerDoc.exists) { res.status(400).json({ error: 'Customer not found' }); return; }

    const branch = branchDoc.data() as { name: string };
    const customer = customerDoc.data() as { name: string; phone: string; address: string };
    const settings = settingsDoc.exists ? (settingsDoc.data() as AppSettings) : null;
    const taxRate = settings?.gstEnabled ? (settings.gstRate / 100) : 0;

    // Resolve products and build order items
    const productDocs = await Promise.all(items.map((item: { productId: string }) =>
      adminDb.collection('products').doc(item.productId).get()
    ));

    const orderItems = items.map((item: { productId: string; qty: number; discount: number }, i: number) => {
      const pDoc = productDocs[i];
      if (!pDoc || !pDoc.exists) throw Object.assign(new Error(`Product ${item.productId} not found`), { status: 400 });
      const product = pDoc.data() as Product;
      const lineTotal = product.price * item.qty - item.discount;
      return {
        productId: item.productId,
        productName: product.name,
        categoryId: product.categoryId,
        categoryName: product.categoryName,
        unitPrice: product.price,
        qty: item.qty,
        discount: item.discount,
        lineTotal,
      };
    });

    const subtotal = orderItems.reduce((sum: number, i: { lineTotal: number }) => sum + i.lineTotal, 0);
    const discountTotal = orderItems.reduce((sum: number, i: { discount: number }) => sum + i.discount, 0);
    const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
    const grandTotal = subtotal + deliveryCharges + taxAmount;

    const orderNumber = await generateOrderNumber();
    const now = new Date().toISOString();

    const ref = await adminDb.collection('orders').add({
      orderNumber,
      branchId,
      branchName: branch.name,
      customerId,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerAddress: customer.address,
      items: orderItems,
      subtotal,
      discountTotal,
      deliveryCharges,
      taxRate,
      taxAmount,
      grandTotal,
      paymentMethod,
      status: 'pending',
      notes: notes || '',
      createdBy: req.user!.uid,
      createdByName: req.user!.email,
      createdAt: now,
      updatedAt: now,
    });

    // Update customer stats atomically to avoid race conditions
    await adminDb.collection('customers').doc(customerId).update({
      totalOrders: FieldValue.increment(1),
      totalSpent: FieldValue.increment(grandTotal),
    });

    // Notify production of the new order (in-app + web push)
    await notify({
      type: 'order_created',
      title: 'New Order',
      message: `Order ${orderNumber} created at ${branch.name}`,
      targetRole: 'production_user',
      branchId,
      relatedId: ref.id,
    });

    res.status(201).json({ id: ref.id, orderNumber, grandTotal });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders/pos — retail POS sale (completed immediately, decrements stock)
router.post('/pos', requireRole('super_admin', 'branch_manager'), validate(CreatePosSaleSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, customerName, customerPhone, items, paymentMethod, receivedCash, notes } = req.body;

    if (req.user!.role === 'branch_manager' && branchId !== req.user!.branchId) {
      res.status(403).json({ error: 'Cannot create sales for other branches' });
      return;
    }

    await assertBusinessDayOpen(businessDateStr(), req.user!.role);

    const [branchDoc, settingsDoc] = await Promise.all([
      adminDb.collection('branches').doc(branchId).get(),
      adminDb.collection('settings').doc('app').get(),
    ]);
    if (!branchDoc.exists) { res.status(400).json({ error: 'Branch not found' }); return; }

    const branch = branchDoc.data() as { name: string };
    const settings = settingsDoc.exists ? (settingsDoc.data() as AppSettings) : null;
    const taxRate = settings?.gstEnabled ? (settings.gstRate / 100) : 0;

    const productDocs = await Promise.all(items.map((item: { productId: string }) =>
      adminDb.collection('products').doc(item.productId).get()
    ));

    const orderItems = items.map((item: { productId: string; qty: number; discount: number }, i: number) => {
      const pDoc = productDocs[i];
      if (!pDoc || !pDoc.exists) throw Object.assign(new Error(`Product ${item.productId} not found`), { status: 400 });
      const product = pDoc.data() as Product;
      const lineTotal = product.price * item.qty - item.discount;
      return {
        productId: item.productId,
        productName: product.name,
        categoryId: product.categoryId,
        categoryName: product.categoryName,
        unitPrice: product.price,
        qty: item.qty,
        discount: item.discount,
        lineTotal,
      };
    });

    const subtotal = orderItems.reduce((sum: number, i: { lineTotal: number }) => sum + i.lineTotal, 0);
    const discountTotal = orderItems.reduce((sum: number, i: { discount: number }) => sum + i.discount, 0);
    const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
    const grandTotal = subtotal + taxAmount;

    // Cash tendered (cash payments only): must cover the grand total; derive the change.
    let cashFields: { receivedCash: number; cashReturned: number } | null = null;
    if (paymentMethod === 'cash' && receivedCash != null) {
      if (receivedCash < grandTotal) {
        res.status(400).json({ error: 'Received cash is less than the Grand Total.' });
        return;
      }
      cashFields = { receivedCash, cashReturned: Math.round((receivedCash - grandTotal) * 100) / 100 };
    }

    const orderNumber = await generateOrderNumber();
    const now = new Date().toISOString();
    const name = (customerName || '').trim() || 'Walking Customer';
    const orderRef = adminDb.collection('orders').doc();

    const orderData = {
      orderNumber,
      branchId,
      branchName: branch.name,
      customerId: '',
      customerName: name,
      customerPhone: (customerPhone || '').trim(),
      customerAddress: '',
      items: orderItems,
      subtotal,
      discountTotal,
      deliveryCharges: 0,
      taxRate,
      taxAmount,
      grandTotal,
      paymentMethod,
      status: 'delivered', // completed at the counter; bypasses the production queue
      ...(cashFields ?? {}),
      notes: notes || '',
      createdBy: req.user!.uid,
      createdByName: req.user!.email,
      createdAt: now,
      updatedAt: now,
    };

    // Validate stock, create the order and decrement balances atomically. If any
    // product is short, nothing is written — we log the blocked attempt and 409.
    let balances: Map<string, SaleBalance>;
    try {
      balances = await commitSaleTransaction({
        orderRef,
        orderData,
        branchId,
        lines: orderItems.map((it: { productId: string; productName: string; qty: number }) => ({
          productId: it.productId,
          productName: it.productName,
          qty: it.qty,
        })),
      });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        // Best-effort audit log; never let it mask the 409 from the caller.
        await logBlockedSale({
          branchId,
          branchName: branch.name,
          userId: req.user!.uid,
          userName: req.user!.email || req.user!.uid,
          shortfalls: err.shortfalls,
        }).catch((e) => console.error('[stock] failed to write audit log', e));

        res.status(409).json({
          error: 'Stock has changed. Please review your order.',
          details: err.shortfalls,
        });
        return;
      }
      throw err;
    }

    // Notify the three dashboards when a product has just crossed below the low-stock
    // threshold (only on the crossing, so we don't re-alert on every subsequent sale).
    const crossed = [...balances.values()].filter((b) => b.before >= LOW_STOCK_THRESHOLD && b.after < LOW_STOCK_THRESHOLD);
    if (crossed.length > 0) {
      const message = crossed.length === 1
        ? `${crossed[0]!.productName} is low on stock (${crossed[0]!.after} left) at ${branch.name}. Please create a Production Order.`
        : `${crossed.length} products are low on stock at ${branch.name}. Please create a Production Order.`;
      await Promise.all(
        (['branch_manager', 'production_user', 'super_admin'] as const).map((role) =>
          notify({ type: 'low_stock', title: 'Low Stock', message, targetRole: role, branchId, relatedId: null }),
        ),
      ).catch((e) => console.error('[stock] failed to send low-stock notifications', e));
    }

    // Return the server's own snapshot, not just the totals. The printed receipt is
    // built from this — if the client rebuilt it from its cached product list, a
    // price change between opening the form and saving would put a unitPrice on the
    // customer's receipt that disagrees with the order actually stored.
    res.status(201).json({
      id: orderRef.id,
      orderNumber,
      grandTotal,
      items: orderItems,
      subtotal,
      discountTotal,
      taxAmount,
      createdAt: now,
      ...(cashFields ?? {}),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/status', validate(UpdateOrderStatusSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status } = req.body;
    const doc = await adminDb.collection('orders').doc(req.params['id']!).get();
    if (!doc.exists) { res.status(404).json({ error: 'Order not found' }); return; }

    const data = doc.data() as { branchId: string; status: string; orderNumber: string };

    // Branch managers can only update their own branch orders
    if (req.user!.role === 'branch_manager' && data.branchId !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Production users can only advance to preparing/ready
    if (req.user!.role === 'production_user' && !['preparing', 'ready'].includes(status)) {
      res.status(403).json({ error: 'Production can only set preparing or ready' });
      return;
    }

    const now = new Date().toISOString();
    await adminDb.collection('orders').doc(req.params['id']!).update({ status, updatedAt: now });

    if (status === 'ready') {
      await notify({
        type: 'order_ready',
        title: 'Order Ready',
        message: `Order ${data.orderNumber} is ready for delivery`,
        targetRole: 'branch_manager',
        branchId: data.branchId,
        relatedId: req.params['id'],
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
