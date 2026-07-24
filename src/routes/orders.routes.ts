import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateOrderSchema, CreatePosSaleSchema, UpdateOrderStatusSchema, LOW_STOCK_THRESHOLD, businessDateStr } from '../shared';
import { generateOrderNumber } from '../utils/orderNumber';
import { notify } from '../services/push.service';
import { commitSaleTransaction, logBlockedSale, InsufficientStockError, type SaleBalance, type SaleItem } from '../services/stock.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';
import { getAppSettings } from '../services/settings.service';
import { rowToApi } from '../utils/case';

export const router = Router();

/**
 * The line items are normalised into their own `order_items` table
 * (migration 03). Every read therefore joins them back on so the API shape the
 * frontend compiles against is unchanged.
 *
 * Callers MUST also order the embedded rows by line_no (see ORDER_ITEMS_ORDER) —
 * PostgREST makes no ordering guarantee for an embedded resource on its own, and
 * a receipt would print its lines shuffled.
 */
const ORDER_SELECT = `
  *,
  items:order_items(
    product_id, product_name, category_id, category_name,
    unit_price, qty, discount, line_total, line_no
  )
`;

/** Ordering for the embedded order_items rows. Applied alongside ORDER_SELECT. */
const ORDER_ITEMS_ORDER = { referencedTable: 'order_items', ascending: true } as const;

const ACTIVE_STATUSES = ['pending', 'preparing', 'ready'];

/** Shared tax resolution: GST is applied only when enabled in settings. */
async function resolveTaxRate(): Promise<number> {
  const settings = await getAppSettings();
  return settings.gstEnabled ? settings.gstRate / 100 : 0;
}

/**
 * Resolve the posted line items against live product rows and compute the money.
 *
 * Prices come from the database, never from the client — the receipt is built
 * from what is stored, so a stale client price must not be able to set it.
 */
async function buildOrderItems(
  items: { productId: string; qty: number; discount: number }[],
): Promise<SaleItem[]> {
  const productIds = [...new Set(items.map((i) => i.productId))];

  // One query for every product on the order, rather than N point reads.
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('id, name, category_id, category_name, price')
    .in('id', productIds);
  if (error) throw error;

  const byId = new Map((data ?? []).map((p) => [p.id as string, p]));

  return items.map((item) => {
    const product = byId.get(item.productId);
    if (!product) throw Object.assign(new Error(`Product ${item.productId} not found`), { status: 400 });
    const unitPrice = Number(product.price ?? 0);
    return {
      productId: item.productId,
      productName: product.name as string,
      categoryId: (product.category_id as string | null) ?? null,
      categoryName: (product.category_name as string | null) ?? null,
      unitPrice,
      qty: item.qty,
      discount: item.discount,
      lineTotal: unitPrice * item.qty - item.discount,
    };
  });
}

router.use(authenticate);

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { status, from, to } = req.query;

    let query = supabaseAdmin
      .from('orders')
      .select(ORDER_SELECT)
      .order('created_at', { ascending: false })
      .order('line_no', ORDER_ITEMS_ORDER);

    // Branch managers see only their branch.
    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    // Production users are restricted to active order statuses (the service key
    // bypasses RLS, so this must be enforced here).
    if (req.user!.role === 'production_user') {
      if (status) {
        if (!ACTIVE_STATUSES.includes(String(status))) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
        query = query.eq('status', status);
      } else {
        query = query.in('status', ACTIVE_STATUSES);
      }
    } else if (status) {
      query = query.eq('status', status);
    }

    // Date filtering is a real indexed predicate: an inequality can be combined
    // with the equality filters above directly in the query, rather than being
    // done in memory over the whole result set.
    if (from) query = query.gte('created_at', String(from));
    if (to) query = query.lte('created_at', `${String(to)}Z`);

    const { data, error } = await query;
    if (error) throw error;

    const orders = rowToApi<Record<string, unknown>[]>(data ?? []);
    res.json({ orders, total: orders.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select(ORDER_SELECT)
      .order('line_no', ORDER_ITEMS_ORDER)
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Order not found' }); return; }

    if (req.user!.role === 'branch_manager' && (data as { branch_id: string }).branch_id !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({ order: rowToApi(data) });
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

    const [branchRes, customerRes, taxRate] = await Promise.all([
      supabaseAdmin.from('branches').select('name').eq('id', branchId).maybeSingle(),
      supabaseAdmin.from('customers').select('name, phone, address').eq('id', customerId).maybeSingle(),
      resolveTaxRate(),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (customerRes.error) throw customerRes.error;
    if (!branchRes.data) { res.status(400).json({ error: 'Branch not found' }); return; }
    if (!customerRes.data) { res.status(400).json({ error: 'Customer not found' }); return; }

    const branch = branchRes.data as { name: string };
    const customer = customerRes.data as { name: string; phone: string; address: string };

    const orderItems = await buildOrderItems(items);
    const subtotal = orderItems.reduce((sum, i) => sum + i.lineTotal, 0);
    const discountTotal = orderItems.reduce((sum, i) => sum + (i.discount ?? 0), 0);
    const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
    const grandTotal = subtotal + deliveryCharges + taxAmount;

    const orderNumber = await generateOrderNumber();

    // created_at / updated_at come from column defaults and the orders_touch
    // trigger — do not set them here.
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .insert({
        order_number: orderNumber,
        branch_id: branchId,
        branch_name: branch.name,
        customer_id: customerId,
        customer_name: customer.name,
        customer_phone: customer.phone,
        customer_address: customer.address,
        subtotal,
        discount_total: discountTotal,
        delivery_charges: deliveryCharges,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        grand_total: grandTotal,
        payment_method: paymentMethod,
        status: 'pending',
        notes: notes || '',
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
        business_date: businessDateStr(),
      })
      .select('id')
      .single();
    if (orderErr) throw orderErr;

    // Line items are a separate table now. This is NOT in the same transaction as
    // the order insert — unlike the POS path, which goes through commit_sale.
    // A failure here would leave an order with no lines; acceptable for the
    // non-stock path, but see the note on POST /pos below.
    const { error: itemsErr } = await supabaseAdmin.from('order_items').insert(
      orderItems.map((it, idx) => ({
        order_id: order.id,
        product_id: it.productId,
        product_name: it.productName,
        category_id: it.categoryId,
        category_name: it.categoryName,
        unit_price: it.unitPrice,
        qty: it.qty,
        discount: it.discount ?? 0,
        line_total: it.lineTotal,
        line_no: idx + 1,
      })),
    );
    if (itemsErr) throw itemsErr;

    // Atomic — a plain read-then-write would lose one of two concurrent orders
    // for the same customer (migration 13).
    const { error: statsErr } = await supabaseAdmin.rpc('increment_customer_stats', {
      p_customer_id: customerId,
      p_amount: grandTotal,
    });
    if (statsErr) throw statsErr;

    // branchId is null: production_user is a central role with no branch claim, and
    // the notifications RLS filters out a role broadcast whose branch_id doesn't
    // match the recipient's — so any non-null branchId hides this from every
    // production user. The branch is already named in the message.
    await notify({
      type: 'order_created',
      title: 'New Order',
      message: `Order ${orderNumber} created at ${branch.name}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: order.id,
    });

    res.status(201).json({ id: order.id, orderNumber, grandTotal });
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

    const [branchRes, taxRate] = await Promise.all([
      supabaseAdmin.from('branches').select('name').eq('id', branchId).maybeSingle(),
      resolveTaxRate(),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (!branchRes.data) { res.status(400).json({ error: 'Branch not found' }); return; }
    const branch = branchRes.data as { name: string };

    const orderItems = await buildOrderItems(items);
    const subtotal = orderItems.reduce((sum, i) => sum + i.lineTotal, 0);
    const discountTotal = orderItems.reduce((sum, i) => sum + (i.discount ?? 0), 0);
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
    const name = (customerName || '').trim() || 'Walking Customer';

    // Validate stock, create the order + its line items and decrement balances —
    // all inside commit_sale's single transaction (migration 12). If any product
    // is short, nothing is written; we log the blocked attempt and 409.
    let orderId: string;
    let balances: Map<string, SaleBalance>;
    try {
      ({ orderId, balances } = await commitSaleTransaction({
        branchId,
        items: orderItems,
        order: {
          orderNumber,
          branchName: branch.name,
          // No customer record for a walk-in; the name/phone are captured on the
          // order itself. customerId stays null rather than '' — it is a uuid FK.
          customerId: null,
          customerName: name,
          customerPhone: (customerPhone || '').trim(),
          customerAddress: '',
          subtotal,
          discountTotal,
          deliveryCharges: 0,
          taxRate,
          taxAmount,
          grandTotal,
          paymentMethod,
          status: 'delivered', // completed at the counter; bypasses the production queue
          notes: notes || '',
          createdBy: req.user!.uid,
          createdByName: req.user!.email,
          ...(cashFields ?? {}),
        },
      }));
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
        // Only branch_manager is branch-scoped, so only it keeps branchId (which
        // limits the alert to that branch's manager). production_user/super_admin
        // are central and carry no branch claim — a non-null branchId there would
        // be filtered out by the notifications RLS, so they get null.
        (['branch_manager', 'production_user', 'super_admin'] as const).map((role) =>
          notify({
            type: 'low_stock',
            title: 'Low Stock',
            message,
            targetRole: role,
            branchId: role === 'branch_manager' ? branchId : null,
            relatedId: null,
          }),
        ),
      ).catch((e) => console.error('[stock] failed to send low-stock notifications', e));
    }

    // Return the server's own snapshot, not just the totals. The printed receipt is
    // built from this — if the client rebuilt it from its cached product list, a
    // price change between opening the form and saving would put a unitPrice on the
    // customer's receipt that disagrees with the order actually stored.
    res.status(201).json({
      id: orderId,
      orderNumber,
      grandTotal,
      items: orderItems,
      subtotal,
      discountTotal,
      taxAmount,
      createdAt: new Date().toISOString(),
      ...(cashFields ?? {}),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/status', validate(UpdateOrderStatusSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status } = req.body;

    const { data: order, error: readErr } = await supabaseAdmin
      .from('orders')
      .select('branch_id, status, order_number')
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

    // Branch managers can only update their own branch orders
    if (req.user!.role === 'branch_manager' && order.branch_id !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Production users can only advance to preparing/ready
    if (req.user!.role === 'production_user' && !['preparing', 'ready'].includes(status)) {
      res.status(403).json({ error: 'Production can only set preparing or ready' });
      return;
    }

    // updated_at is maintained by the orders_touch trigger — do not set it here.
    const { error: updErr } = await supabaseAdmin
      .from('orders')
      .update({ status })
      .eq('id', req.params['id']!);
    if (updErr) throw updErr;

    if (status === 'ready') {
      await notify({
        type: 'order_ready',
        title: 'Order Ready',
        message: `Order ${order.order_number} is ready for delivery`,
        targetRole: 'branch_manager',
        branchId: order.branch_id,
        relatedId: req.params['id'],
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
