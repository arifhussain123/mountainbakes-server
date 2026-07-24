import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateProductionOrderSchema,
  ReviewProductionOrderSchema,
  businessDateStr,
  businessDaysAgoStr,
  karachiTimeStr,
  karachiMinutesOfDay,
  isWithinOrderWindow,
} from '../shared';
import { notify } from '../services/push.service';
import { applyProductionToStock } from '../services/stock.service';
import { transferOutOnApproval } from '../services/production-stock.service';
import { getAppSettings, orderWindowMinutes } from '../services/settings.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';
import { rowToApi } from '../utils/case';

export const router = Router();

/**
 * The branch-submitted items live in their own `production_order_items` table
 * (migration 05). The review-only columns are null until approval, which is what
 * `approved_qty IS NULL` means.
 *
 * Callers must also order the embedded rows by line_no — PostgREST gives no
 * ordering guarantee for an embedded resource on its own.
 */
const ORDER_SELECT = `
  *,
  items:production_order_items(
    product_id, product_name, qty, remarks,
    previous_balance_qty, total_required_qty, approved_qty, remaining_balance_qty, line_no
  )
`;

const ITEMS_ORDER = { referencedTable: 'production_order_items', ascending: true } as const;

router.use(authenticate);

// POST /api/production-orders — branch submits a daily production request
router.post('/', requireRole('branch_manager'), validate(CreateProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    // Branch production requests are only accepted inside the configured order
    // window (default 8:00 AM–2:00 AM Karachi, which wraps past midnight).
    const settings = await getAppSettings();
    const { openMin, closeMin } = orderWindowMinutes(settings);
    if (!isWithinOrderWindow(karachiMinutesOfDay(), openMin, closeMin)) {
      res.status(403).json({ error: `Ordering time has ended. New production orders will open again at ${settings.orderStartTime}.` });
      return;
    }

    const branchId = req.user!.branchId;
    if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }

    const { items } = req.body as { items: { productId: string; qty: number; remarks: string }[] };

    // Resolve product names server-side — branch users never send names or
    // prices, those are Admin-controlled. One query rather than N point reads.
    const productIds = [...new Set(items.map((i) => i.productId))];
    const { data: products, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .in('id', productIds);
    if (prodErr) throw prodErr;

    const nameById = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
    const resolvedItems = items.map((i) => {
      const name = nameById.get(i.productId);
      if (!name) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
      return { productId: i.productId, productName: name, qty: i.qty, remarks: i.remarks || '' };
    });

    const now = new Date();
    await assertBusinessDayOpen(businessDateStr(now), req.user!.role);

    // submitted_at / created_at come from column defaults.
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('production_orders')
      .insert({
        branch_id: branchId,
        branch_name: req.user!.branchName || '',
        business_date: businessDateStr(now),
        submitted_time: karachiTimeStr(now),
        status: 'pending',
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('id')
      .single();
    if (orderErr) throw orderErr;

    // Review-only columns stay null until approval.
    const { error: itemsErr } = await supabaseAdmin.from('production_order_items').insert(
      resolvedItems.map((it, idx) => ({
        production_order_id: order.id,
        product_id: it.productId,
        product_name: it.productName,
        qty: it.qty,
        remarks: it.remarks,
        line_no: idx + 1,
      })),
    );
    if (itemsErr) throw itemsErr;

    // NOTE: branchId is deliberately null here. Production users are a central
    // role with no branch claim (only branch_manager carries a branchId), and the
    // notifications RLS narrows a role broadcast that carries a branch_id to that
    // branch — so setting branchId to the submitting branch would filter this out
    // for every production user. The branch is already named in the message and
    // linked via relatedId. Keep it null so all production users see the demand.
    await notify({
      type: 'production_demand',
      title: 'New Production Demand Received',
      message: `${req.user!.branchName || 'A branch'} submitted ${resolvedItems.length} item${resolvedItems.length === 1 ? '' : 's'}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: order.id,
    });

    res.status(201).json({ id: order.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders — last 7 business days, branch-scoped
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    // The 7-day cutoff is an indexed predicate now; it used to fetch the branch's
    // entire history and filter in memory.
    let query = supabaseAdmin
      .from('production_orders')
      .select(ORDER_SELECT)
      .gte('business_date', businessDaysAgoStr(6)) // inclusive last 7 business days
      .order('submitted_at', { ascending: false })
      .order('line_no', ITEMS_ORDER);

    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    // DB columns are business_date / submitted_time; the API contract
    // (BranchProductionOrder) exposes them as date / time. rowToApi only
    // camelCases keys, so remap those two here — otherwise the client's
    // date/time are undefined (blank columns, and slipReference → "PO--").
    const rows = rowToApi<Record<string, unknown>[]>(data ?? []);
    const orders = rows.map(({ businessDate, submittedTime, ...rest }) => ({
      ...rest,
      date: businessDate,
      time: submittedTime,
    }));
    res.json({ orders, total: orders.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders/balances — outstanding pending balances per product.
// Branch managers are scoped to their own branch; others may pass ?branchId=.
// Defined as a literal path (no GET '/:id' route exists) so it never shadows.
router.get('/balances', async (req: AuthRequest, res, next) => {
  try {
    // pending_qty > 0 is served by production_balances_outstanding_idx.
    let query = supabaseAdmin.from('production_balances').select('*').gt('pending_qty', 0);

    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ balances: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

interface ReviewedItem {
  productId: string;
  productName: string;
  qty: number;
  previousBalanceQty: number;
  totalRequiredQty: number;
  approvedQty: number;
  remainingBalanceQty: number;
}

// PUT /api/production-orders/:id/review — production/admin approves or rejects
router.put('/:id/review', requireRole('super_admin', 'production_user'), validate(ReviewProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status, approvedItems, reason } = req.body as {
      status: 'approved' | 'rejected';
      approvedItems?: { productId: string; approvedQty: number }[];
      reason?: string;
    };
    const id = req.params['id']!;

    // Status check-and-set, balance carry-forward and the item rewrite all happen
    // inside review_production_order (migration 16) — they must be one
    // transaction or a double review would apply the balance maths twice.
    const { data, error } = await supabaseAdmin.rpc('review_production_order', {
      p_order_id: id,
      p_status: status,
      p_overrides: approvedItems ?? [],
      p_reason: reason ?? null,
      p_reviewed_by: req.user!.uid,
      p_reviewed_by_name: req.user!.email,
    });
    if (error) throw error;

    const result = data as
      | { status: 'ok'; branchId: string; branchName: string | null; items: ReviewedItem[] }
      | { status: 'not_found' }
      | { status: 'already_reviewed' };

    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Production order not found' });
      return;
    }
    if (result.status === 'already_reviewed') {
      res.status(409).json({ error: 'Order already reviewed' });
      return;
    }

    // On approval, move approved units OUT of the production pool and INTO branch
    // stock (both idempotent by order id, kept as separate retry-safe units).
    if (status === 'approved') {
      const moves = result.items
        .map((it) => ({ productId: it.productId, productName: it.productName, qty: Number(it.approvedQty) }))
        .filter((m) => m.qty > 0);

      await transferOutOnApproval(id, moves);
      await Promise.all(
        moves.map((m) =>
          applyProductionToStock({
            branchId: result.branchId,
            productId: m.productId,
            productName: m.productName,
            qty: m.qty,
            refId: id,
          }),
        ),
      );
    }

    // Notify the branch with a per-product Total Required / Approved / Pending summary.
    const message =
      status === 'approved'
        ? result.items
            .map((it) => `${it.productName}: Required ${it.totalRequiredQty}, Approved ${it.approvedQty}, Pending ${it.remainingBalanceQty}`)
            .join(' · ')
        : 'Your production order was rejected';

    await notify({
      type: 'production_reviewed',
      title: status === 'approved' ? 'Production Order Approved' : 'Production Order Rejected',
      message,
      targetRole: 'branch_manager',
      branchId: result.branchId,
      relatedId: id,
    });

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-orders/:id/printed — mark the slip printed. Idempotent;
// printing never mutates stock or creates records, so re-printing is a safe no-op.
router.put('/:id/printed', requireRole('super_admin', 'production_user'), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { data, error } = await supabaseAdmin
      .from('production_orders')
      .update({ printed: true, printed_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Production order not found' }); return; }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
