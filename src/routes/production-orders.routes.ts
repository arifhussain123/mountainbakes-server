import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateProductionOrderSchema,
  ReviewProductionOrderSchema,
  AddProductionOrderItemSchema,
  VerifyProductionOrderSchema,
  CancelProductionOrderSchema,
  businessDateStr,
  businessDaysAgoStr,
  karachiTimeStr,
  karachiMinutesOfDay,
  isWithinOrderWindow,
  BRANCH_ROLES,
  isBranchRole,
  type ProductionShortfall,
  enforcesProductionStock,
  evalProductionShortage,
} from '../shared';
import { bindAttachments, listAttachmentsFor } from '../services/attachments.service';
import { notify } from '../services/push.service';
import { applyProductionToStock } from '../services/stock.service';
import { getPreviousOrderBalance } from '../services/previous-balance.service';
import { transferOutOnApproval } from '../services/production-stock.service';
import { getAppSettings, orderWindowMinutes } from '../services/settings.service';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';
import { idempotent } from '../middleware/idempotency';
import { resolveClientBusinessDate } from '../utils/clientBusinessDate';
import { checkDemand, enforceRestrictions, getRestrictionRules, logRestrictionEvent, type RestrictionGuard } from '../services/restriction.service';
import { rowToApi } from '../utils/case';

const db = dbFor('production-orders');

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
    id, product_id, product_name, qty, unit_price, remarks, is_special, added_by_production,
    previous_balance_qty, total_required_qty, approved_qty, remaining_balance_qty, line_no
  ),
  packingItems:production_order_packing_items(
    packing_material_id, material_name, qty, approved_qty, line_no
  )
`;

const ITEMS_ORDER = { referencedTable: 'production_order_items', ascending: true } as const;

/** Packing lines need their own ordering clause — see the ORDER_SELECT note above. */
const PACKING_ITEMS_ORDER = { referencedTable: 'production_order_packing_items', ascending: true } as const;

/**
 * Hang the demand and verification photos off a page of orders.
 *
 * Two queries and two signing calls for the whole page rather than per order —
 * an order list runs to a week of demands across every branch, and per-row
 * signing would dominate the response time. Photos are NOT part of ORDER_SELECT
 * because `attachments` has no foreign key to `production_orders` (the parent
 * table is chosen by `entity`), so PostgREST cannot embed it.
 */
async function withPhotos(orders: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const ids = orders.map((o) => String(o['id']));

  // A special item's photo hangs off the ITEM row, not the order, so its ids
  // come from the embedded lines. Collected across the whole page and fetched in
  // the same batch as the other two — a week of demands would otherwise be one
  // query per special line.
  const specialItemIds = orders.flatMap((o) =>
    ((o['items'] ?? []) as Record<string, unknown>[])
      .filter((i) => i['is_special'])
      .map((i) => String(i['id'])),
  );

  const [demand, verification, specialPhotos] = await Promise.all([
    listAttachmentsFor('production_order_demand', ids),
    listAttachmentsFor('production_order_verification', ids),
    specialItemIds.length > 0
      ? listAttachmentsFor('production_order_special_item', specialItemIds)
      : Promise.resolve(new Map()),
  ]);

  return orders.map((o) => ({
    ...o,
    items: ((o['items'] ?? []) as Record<string, unknown>[]).map((i) =>
      i['is_special']
        ? {
            ...i,
            // `description` mirrors `remarks` so a screen rendering a special
            // item does not have to know which column it landed in.
            description: i['remarks'] ?? '',
            photos: specialPhotos.get(String(i['id'])) ?? [],
          }
        : i,
    ),
    demandPhotos: demand.get(String(o['id'])) ?? [],
    verificationPhotos: verification.get(String(o['id'])) ?? [],
  }));
}

router.use(authenticate);

// POST /api/production-orders — branch submits a daily production request
router.post('/', requireRole(...BRANCH_ROLES), idempotent('production_order.create'), validate(CreateProductionOrderSchema), async (req: AuthRequest, res, next) => {
  // Held outside the try so the catch can hand back an approval the guard
  // spent if the demand then fails to save.
  let guard: RestrictionGuard | null = null;
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

    const { items, packingItems = [], attachmentIds = [], requiredDate, businessDate: claimedDate } = req.body as {
      items: { productId: string; qty: number; remarks: string }[];
      packingItems?: { packingMaterialId: string; qty: number }[];
      attachmentIds?: string[];
      // Validated as a real 'YYYY-MM-DD' by CreateProductionOrderSchema, so it
      // reaches here already known-good and non-empty.
      requiredDate: string;
      // The day the demand was RAISED, as captured on the device. Distinct from
      // requiredDate, which is the day the branch wants it delivered.
      businessDate?: string;
    };

    // Restriction Rules (migration 136): pending-verification limit, backdated
    // demand, low sales after closing. Evaluated here, before anything is
    // resolved or written, from the token's branch and the server's clock —
    // the popup's preflight is a courtesy, this is the decision. A refusal
    // throws a 409 carrying the notice the popup shows.
    guard = await enforceRestrictions(
      await checkDemand({ branchId, requiredDate, claimedBusinessDate: claimedDate }),
      {
        action: 'Forward demand',
        actor: { uid: req.user!.uid, name: req.user!.email },
        branch: { id: branchId, name: req.user!.branchName },
      },
    );

    // Resolve names AND the RATE server-side — branch users never send either,
    // both are Admin-controlled (§18). One query rather than N point reads.
    //
    // THE RATE IS SNAPSHOTTED, not referenced. `unit_price` is written onto the
    // line here and never touched again, so a price change tomorrow leaves every
    // order raised today worth exactly what it was worth. Reading `products.price`
    // at display time instead would silently rewrite history — the branch would
    // open last week's demand and find a different total than the one it agreed.
    //
    // A client-supplied price is not merely ignored, it is impossible: the schema
    // accepts {productId, qty, remarks} and nothing else, the same rule
    // `OrderItemSchema` follows for POS sales.
    const productIds = [...new Set(items.map((i) => i.productId))];
    const { data: products, error: prodErr } = await db
      .from('products')
      .select('id, name, price')
      .in('id', productIds);
    if (prodErr) throw prodErr;

    const productById = new Map(
      (products ?? []).map((p) => [p.id as string, { name: p.name as string, price: Number(p.price ?? 0) }]),
    );
    const resolvedItems = items.map((i) => {
      const meta = productById.get(i.productId);
      if (!meta) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
      return {
        productId: i.productId,
        productName: meta.name,
        unitPrice: meta.price,
        qty: i.qty,
        remarks: i.remarks || '',
      };
    });

    // Same treatment for packing materials, with one extra condition: the query
    // filters on is_active, so an inactive material fails the name lookup below and
    // is rejected. The client's list can be stale (a material disabled while the
    // form was open), so "only active materials can be selected" has to be decided
    // here, not in the dropdown.
    let resolvedPacking: { packingMaterialId: string; materialName: string; qty: number }[] = [];
    if (packingItems.length > 0) {
      const materialIds = [...new Set(packingItems.map((i) => i.packingMaterialId))];
      const { data: materials, error: matErr } = await db
        .from('packing_materials')
        .select('id, material_name')
        .eq('is_active', true)
        .in('id', materialIds);
      if (matErr) throw matErr;

      const materialNameById = new Map(
        (materials ?? []).map((m) => [m.id as string, m.material_name as string]),
      );
      resolvedPacking = packingItems.map((i) => {
        const name = materialNameById.get(i.packingMaterialId);
        if (!name) {
          throw Object.assign(
            new Error('One of the selected packing materials is no longer available. Please refresh and try again.'),
            { status: 400 },
          );
        }
        return { packingMaterialId: i.packingMaterialId, materialName: name, qty: i.qty };
      });
    }

    const now = new Date();
    const businessDate = await resolveClientBusinessDate(claimedDate, req.user!.role, now);

    // submitted_at / created_at come from column defaults.
    const { data: order, error: orderErr } = await db
      .from('production_orders')
      .insert({
        branch_id: branchId,
        branch_name: req.user!.branchName || '',
        business_date: businessDate,
        // The day the branch asked for, NOT derived from `now` — see the
        // migration for why the two dates are kept apart.
        required_date: requiredDate,
        submitted_time: karachiTimeStr(now),
        status: 'pending',
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('id, demand_number')
      .single();
    if (orderErr) throw orderErr;

    // The demand exists: record its number against any approval it used, and
    // audit the warnings it went through with. Cleared so a later failure in
    // this handler cannot release an approval a saved demand has spent.
    await guard.commit(order.demand_number as string);
    guard = null;

    // Review-only columns stay null until approval.
    //
    // `is_special` is always false here, and migration 143's trigger refuses a
    // true: a Special Order is raised through /api/special-orders and is never a
    // demand line. CreateProductionOrderSchema has already rejected a non-empty
    // `specialItems`, so there is nothing special to write.
    if (resolvedItems.length > 0) {
      const { error: itemsErr } = await db
        .from('production_order_items')
        .insert(
          resolvedItems.map((it, idx) => ({
            production_order_id: order.id,
            product_id: it.productId,
            product_name: it.productName,
            unit_price: it.unitPrice,
            qty: it.qty,
            remarks: it.remarks,
            is_special: false,
            line_no: idx + 1,
          })),
        );
      if (itemsErr) throw itemsErr;
    }

    // Packing lines ride on the same order. approved_qty stays null until review,
    // exactly like the product lines' review-only columns.
    if (resolvedPacking.length > 0) {
      const { error: packErr } = await db.from('production_order_packing_items').insert(
        resolvedPacking.map((it, idx) => ({
          production_order_id: order.id,
          packing_material_id: it.packingMaterialId,
          material_name: it.materialName,
          qty: it.qty,
          line_no: idx + 1,
        })),
      );
      if (packErr) throw packErr;
    }

    // Claim the photos the branch captured while filling the form. Done before
    // the notification so Production is never told about a demand whose photo
    // failed to bind — the whole point of the notification is "come and look at
    // this", and there would be nothing to look at.
    await bindAttachments({
      entity: 'production_order_demand',
      entityId: order.id,
      attachmentIds,
      actor: { uid: req.user!.uid },
    });

    // NOTE: branchId is deliberately null here. Production users are a central
    // role with no branch claim (only branch_manager carries a branchId), and the
    // notifications RLS narrows a role broadcast that carries a branch_id to that
    // branch — so setting branchId to the submitting branch would filter this out
    // for every production user. The branch is already named in the message and
    // linked via relatedId. Keep it null so all production users see the demand.
    await notify({
      type: 'production_demand',
      title: 'New Production Demand Received',
      message:
        `${req.user!.branchName || 'A branch'} submitted ${resolvedItems.length} item${resolvedItems.length === 1 ? '' : 's'}` +
        (resolvedPacking.length > 0
          ? `, ${resolvedPacking.length} packing material${resolvedPacking.length === 1 ? '' : 's'}`
          : ''),
      targetRole: 'production_user',
      branchId: null,
      relatedId: order.id,
    });

    res.status(201).json({ id: order.id });
  } catch (err) {
    if (guard) await guard.release();
    next(err);
  }
});

// GET /api/production-orders — last 7 business days, branch-scoped
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    // The 7-day cutoff is an indexed predicate now; it used to fetch the branch's
    // entire history and filter in memory.
    let query = db
      .from('production_orders')
      .select(ORDER_SELECT)
      .gte('business_date', businessDaysAgoStr(6)) // inclusive last 7 business days
      .order('submitted_at', { ascending: false })
      .order('line_no', ITEMS_ORDER)
      .order('line_no', PACKING_ITEMS_ORDER);

    if (isBranchRole(req.user!.role) && req.user!.branchId) {
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
    const orders = await withPhotos(
      rows.map(({ businessDate, submittedTime, ...rest }) => ({
        ...rest,
        date: businessDate,
        time: submittedTime,
      })),
    );
    res.json({ orders, total: orders.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders/balances — outstanding pending balances per product.
// Branch managers are scoped to their own branch; others may pass ?branchId=.
// Defined as a literal path BEFORE the GET '/:id' route below, so Express
// matches this one first and ':id' never shadows it.
router.get('/balances', async (req: AuthRequest, res, next) => {
  try {
    // pending_qty > 0 is served by production_balances_outstanding_idx.
    let query = db.from('production_balances').select('*').gt('pending_qty', 0);

    if (isBranchRole(req.user!.role) && req.user!.branchId) {
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

// GET /api/production-orders/:id — a single demand's complete record: the
// company's Finance Income drill-down opens a voucher's related demand through
// this (Demand Amount → demand number), and it is the same read Production/the
// branch get from the list above, just for one id instead of the last 7 days.
// Must be registered AFTER the literal '/balances' route above.
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { data, error } = await db
      .from('production_orders')
      .select(ORDER_SELECT)
      .order('line_no', ITEMS_ORDER)
      .order('line_no', PACKING_ITEMS_ORDER)
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: 'Demand not found' });
      return;
    }

    if (isBranchRole(req.user!.role) && req.user!.branchId && (data as { branch_id: string }).branch_id !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { businessDate, submittedTime, ...rest } = rowToApi<Record<string, unknown>>(data);
    const [order] = await withPhotos([{ ...rest, date: businessDate, time: submittedTime }]);
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

// GET /api/production-orders/:id/previous-balance — what the branch owes for its
// PREVIOUS delivery, for the company copy of this order's slip.
//
// The computation, and the reasoning behind its billing window, live in
// services/previous-balance.service.ts — the Collections export bills off the
// same function, so the slip and the spreadsheet cannot disagree.
router.get('/:id/previous-balance', requireRole('super_admin', 'production_user'), async (req, res, next) => {
  try {
    const balance = await getPreviousOrderBalance(req.params['id']!);
    if (!balance) { res.status(404).json({ error: 'Production order not found' }); return; }
    res.json(balance);
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

/**
 * The INSUFFICIENT_STOCK body (§26).
 *
 * A machine-readable `error` code, the per-product arithmetic, and a `message`
 * already phrased for a human. The three are for three different readers — the
 * client switches on the code, the screen renders the rows, and the message is
 * what ends up in a toast — and computing any of them twice is how they start
 * disagreeing about the same shortfall.
 *
 * `productId` / `requested` / `available` / `shortage` are lifted to the top level
 * as well as listed, because the single-product case is overwhelmingly the common
 * one and the spec's example shows it flat.
 */
function insufficientStockBody(shortfalls: ProductionShortfall[]) {
  const first = shortfalls[0];
  const message =
    shortfalls.length === 1 && first
      ? `Insufficient production stock for ${first.productName}. Requested ${first.requested}, available ${first.available}, short ${first.shortage}.`
      : `Insufficient production stock for ${shortfalls.length} products: ` +
        shortfalls.map((s) => `${s.productName} (short ${s.shortage})`).join(', ') + '.';

  return {
    error: 'INSUFFICIENT_STOCK',
    message,
    shortfalls,
    // The same shortage as a Restriction Rules notice (migration 136), in the
    // `details` the web client already reads: the Production demand popup shows
    // every short product with its exact quantities, in place, instead of a
    // toast that says only INSUFFICIENT_STOCK.
    details: { code: 'restriction', allowed: false, restriction: evalProductionShortage(shortfalls) },
    ...(shortfalls.length === 1 && first
      ? {
          productId: first.productId,
          requested: first.requested,
          available: first.available,
          shortage: first.shortage,
        }
      : {}),
  };
}

/** No balance fields: packing materials carry nothing forward (migration 39). */
interface ReviewedPackingItem {
  packingMaterialId: string;
  materialName: string;
  qty: number;
  approvedQty: number;
}

// PUT /api/production-orders/:id/review — production/admin submits for
// verification, or rejects. 'awaiting_verification' still transfers stock to
// the branch immediately (unchanged) — the branch's own /verify step is what
// finally moves the order to 'approved'.
router.put('/:id/review', requireRole('super_admin', 'production_user'), validate(ReviewProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status: rawStatus, approvedItems, approvedPackingItems, reason } = req.body as {
      status: 'awaiting_verification' | 'approved' | 'rejected';
      approvedItems?: { productId: string; approvedQty: number }[];
      approvedPackingItems?: { packingMaterialId: string; approvedQty: number }[];
      reason?: string;
    };
    const id = req.params['id']!;

    // Legacy alias: a still-cached old web bundle sends 'approved' for what is
    // now 'awaiting_verification'. Normalise it so those clients keep working
    // until they reload — see ReviewProductionOrderSchema.
    const status = rawStatus === 'approved' ? 'awaiting_verification' : rawStatus;

    // §8: committing to SEND is checked against available stock first, and the
    // check runs INSIDE the same transaction as the review. `*_checked` wraps the
    // existing review_production_order rather than reimplementing it (migration
    // 90), so the review logic stays in one place and there is no window between
    // validating and writing for a concurrent branch to slip through.
    //
    // `override=1` is the authorised escape hatch of §8, restricted to
    // super_admin: a production user cannot approve past a shortage, but an admin
    // can consciously decide to. It declines the guard, not the audit trail —
    // every movement is still written exactly as it would have been.
    //
    // Both the check and the escape hatch are Restriction Rules (Admin Settings →
    // Restriction Rules → Production): the rule can be switched off, and the
    // admin override can be closed. Read here, from the server's own copy —
    // nothing the client sends decides whether stock is checked.
    const override = req.query['override'] === '1' && req.user!.role === 'super_admin';
    const enforceStock = enforcesProductionStock((await getRestrictionRules()).production.stockShortage, { adminOverride: override });

    const { data, error } = await db.rpc('review_production_order_checked', {
      p_order_id: id,
      p_status: status,
      p_overrides: approvedItems ?? [],
      p_reason: reason ?? null,
      p_reviewed_by: req.user!.uid,
      p_reviewed_by_name: req.user!.email,
      p_packing_overrides: approvedPackingItems ?? [],
      p_enforce_stock: enforceStock,
    });
    if (error) throw error;

    const result = data as
      | {
          status: 'ok';
          branchId: string;
          branchName: string | null;
          items: ReviewedItem[];
          packingItems: ReviewedPackingItem[];
        }
      | { status: 'not_found' }
      | { status: 'already_reviewed' }
      | { status: 'insufficient_stock'; shortfalls: ProductionShortfall[] };

    if (result.status === 'insufficient_stock') {
      await logRestrictionEvent({
        ruleCode: 'PRODUCTION_STOCK_SHORTAGE',
        actor: { uid: req.user!.uid, name: req.user!.email },
        branch: null,
        ref: id,
        currentValue: result.shortfalls.map((s) => `${s.productName} −${s.shortage}`).join(', ').slice(0, 200),
        threshold: `${result.shortfalls.length} short`,
        action: 'Submit for verification',
        result: 'Blocked',
      });
      res.status(409).json(insufficientStockBody(result.shortfalls));
      return;
    }

    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Production order not found' });
      return;
    }
    if (result.status === 'already_reviewed') {
      res.status(409).json({ error: 'Order already reviewed' });
      return;
    }

    // NO stock movement here any more (migration 58). The pool is debited when
    // the branch verifies what physically arrived, for the quantity it actually
    // counted — so this step is paperwork, and there is no window where branch
    // stock claims goods nobody has confirmed receiving.

    // Notify the branch with a per-product Demanded / Approved summary.
    //
    // Pending is gone from this line (migration 74): with the carry-forward
    // removed `remainingBalanceQty` is now always 0, so printing it told the
    // branch nothing and read as though every line had been fully met even when
    // Production had cut it. Demanded vs Approved is the whole story now — the
    // difference between the two IS the shortfall, and it does not carry.
    const productSummary = result.items
      .map((it) => `${it.productName}: Demanded ${it.qty}, Approved ${it.approvedQty}`)
      .join(' · ');
    // Packing lines report the same pair, and always did — they never had a
    // carry-forward to lose.
    const packingSummary = (result.packingItems ?? [])
      .map((it) => `${it.materialName}: Requested ${it.qty}, Approved ${it.approvedQty}`)
      .join(' · ');

    const message =
      status === 'awaiting_verification'
        ? [productSummary, packingSummary && `Packing — ${packingSummary}`, 'Please check items received and verify.']
            .filter(Boolean)
            .join(' | ')
        : 'Your production order was rejected';

    await notify({
      type: 'production_reviewed',
      title: status === 'awaiting_verification' ? 'Production Order Sent — Please Verify' : 'Production Order Rejected',
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

// PUT /api/production-orders/:id/cancel — the branch deletes a demand it has
// just sent, giving a reason. Soft delete (migration 73): the row stays and
// keeps its items, so both the branch history and Production's order list can
// show WHAT was withdrawn and WHY, while it drops out of everything that treats
// a demand as work to do.
//
// Two guards, and both matter:
//
//  - Branch scope. A branch may only withdraw its OWN demand. Checked against
//    the JWT's branchId, never a body field.
//  - Status. Only 'pending' — before Production reviewed it. Enforced as a
//    check-and-set (`.eq('status', 'pending')`) rather than a read-then-write,
//    because Production reviewing at the same moment is a real race: a
//    read-then-write would cancel an order whose goods had already gone out,
//    and past verification stock has moved, leaving branch inventory holding
//    goods against a demand that no longer exists.
router.put('/:id/cancel', requireRole(...BRANCH_ROLES), validate(CancelProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { reason } = req.body as { reason: string };

    // Guarded rather than defaulted: `branch_id` is a uuid column, so passing an
    // empty string for a branchless account is a 22P02 from Postgres — a 500
    // where this is plainly a bad request.
    const branchId = req.user!.branchId;
    if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }

    const { data, error } = await db
      .from('production_orders')
      .update({
        status: 'cancelled',
        cancel_reason: reason,
        cancelled_by: req.user!.uid,
        cancelled_by_name: req.user!.email,
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('branch_id', branchId)
      .eq('status', 'pending')
      .select('id, demand_number')
      .maybeSingle();
    if (error) throw error;

    // Nothing matched — work out which of the three predicates failed, so the
    // branch is told what actually happened rather than a bare 404.
    if (!data) {
      const { data: exists, error: exErr } = await db
        .from('production_orders')
        .select('id, status, branch_id')
        .eq('id', id)
        .maybeSingle();
      if (exErr) throw exErr;
      if (!exists) { res.status(404).json({ error: 'Production order not found' }); return; }
      if (exists.branch_id !== branchId) {
        res.status(403).json({ error: 'This demand belongs to a different branch' });
        return;
      }
      res.status(409).json({
        error:
          exists.status === 'cancelled'
            ? 'This demand has already been deleted'
            : 'Production has already started on this demand — it can no longer be deleted',
      });
      return;
    }

    // branchId stays null for the same reason it does on submission: production
    // users carry no branch claim, and the RLS narrowing would filter a
    // branch-stamped role broadcast out for every one of them.
    await notify({
      type: 'production_demand_cancelled',
      title: 'Production Demand Deleted',
      message: `${req.user!.branchName || 'A branch'} deleted demand ${data.demand_number} — ${reason}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: id,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-orders/:id/printed — mark the slip printed. Idempotent;
// printing never mutates stock or creates records, so re-printing is a safe no-op.
router.put('/:id/printed', requireRole('super_admin', 'production_user'), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { data, error } = await db
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

// POST /api/production-orders/:id/items — Production adds an extra line to a
// still-'pending' order before submitting it for verification. Once submitted
// the order's items are frozen by review_production_order; this only inserts,
// it never touches stock (that happens for every item, old and new, in the
// same /review transfer once the order is submitted).
router.post('/:id/items', requireRole('super_admin', 'production_user'), validate(AddProductionOrderItemSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { productId, qty, remarks } = req.body as { productId: string; qty: number; remarks: string };

    const { data: order, error: orderErr } = await db
      .from('production_orders')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!order) { res.status(404).json({ error: 'Production order not found' }); return; }
    if (order.status !== 'pending') {
      res.status(409).json({ error: 'This order has already been submitted — items can no longer be added' });
      return;
    }

    const { data: product, error: prodErr } = await db
      .from('products')
      .select('name, price')
      .eq('id', productId)
      .maybeSingle();
    if (prodErr) throw prodErr;
    if (!product) { res.status(400).json({ error: 'Product not found' }); return; }

    const { data: maxRow, error: maxErr } = await db
      .from('production_order_items')
      .select('line_no')
      .eq('production_order_id', id)
      .order('line_no', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) throw maxErr;
    const nextLineNo = (maxRow?.line_no ?? 0) + 1;

    const { error: insErr } = await db.from('production_order_items').insert({
      production_order_id: id,
      product_id: productId,
      product_name: product.name,
      // `qty` is the branch's demand everywhere else, and this line is not one:
      // Production is adding it. It still carries the intended quantity — that
      // is what review defaults the approval to, and changing it would alter
      // what ships — but `added_by_production` tells the screens not to report
      // this figure as something the branch asked for (migration 83).
      qty,
      // Snapshotted here for the same reason as on submission (§18): the rate is
      // fixed at the moment the line joins the order and never re-read. Without
      // it a Production-added line is the one row on a demand that can never be
      // priced from its own record, so it would be billed at whatever the
      // catalogue happened to say on the day someone opened the order.
      unit_price: Number(product.price ?? 0),
      added_by_production: true,
      remarks: remarks || '',
      line_no: nextLineNo,
    });
    if (insErr) throw insErr;

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-orders/:id/verify — the branch confirms what it
// physically received against an 'awaiting_verification' demand, correcting
// any shortage/overage and/or adding lines that arrived unrequested. Moves the
// order to 'approved'. Scoped to the branch that owns the order — a branch
// manager can only verify their own branch's demands.
router.put('/:id/verify', requireRole(...BRANCH_ROLES), validate(VerifyProductionOrderSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { verifiedItems, newItems, attachmentIds } = req.body as {
      verifiedItems: { productId: string; verifiedQty: number }[];
      newItems: { productId: string; qty: number }[];
      attachmentIds: string[];
    };

    const { data: order, error: orderErr } = await db
      .from('production_orders')
      .select('id, branch_id, status')
      .eq('id', id)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!order) { res.status(404).json({ error: 'Production order not found' }); return; }
    if (order.branch_id !== req.user!.branchId) {
      res.status(403).json({ error: 'This demand belongs to a different branch' });
      return;
    }

    // newItems only carry a productId from the client — resolve names the same
    // way order creation and /items do, so a stale/tampered name can never land.
    let resolvedNewItems: { productId: string; productName: string; qty: number }[] = [];
    if (newItems.length > 0) {
      const productIds = [...new Set(newItems.map((i) => i.productId))];
      const { data: products, error: prodErr } = await db
        .from('products')
        .select('id, name')
        .in('id', productIds);
      if (prodErr) throw prodErr;
      const nameById = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
      resolvedNewItems = newItems.map((i) => {
        const name = nameById.get(i.productId);
        if (!name) throw Object.assign(new Error(`Product ${i.productId} not found`), { status: 400 });
        return { productId: i.productId, productName: name, qty: i.qty };
      });
    }

    // Bound BEFORE the RPC, unlike the demand photos on create.
    //
    // Verification is the step that moves stock. If binding ran after it and
    // failed, the goods would already be in branch inventory with no photo of
    // what arrived — the exact gap this feature exists to close, and
    // unrecoverable because the order is no longer 'awaiting_verification'.
    // Running it first means a binding failure aborts with nothing done.
    //
    // The cost is that a caller who loses the race — the RPC then answers
    // 'already_reviewed' — leaves its photos attached to an order someone else
    // verified. They are photos of the same delivery, so they belong there
    // anyway; the alternative is the failure mode above.
    await bindAttachments({
      entity: 'production_order_verification',
      entityId: id,
      attachmentIds,
      actor: { uid: req.user!.uid },
    });

    // §8 again, at the moment stock actually LEAVES the pool. Same wrapper
    // pattern, same reason: the check and the write are one transaction.
    const verifyOverride = req.query['override'] === '1' && req.user!.role === 'super_admin';

    const { data, error } = await db.rpc('verify_production_order_checked', {
      p_enforce_stock: !verifyOverride,
      p_order_id: id,
      p_verified_items: verifiedItems.map((v) => ({ productId: v.productId, verifiedQty: v.verifiedQty })),
      p_new_items: resolvedNewItems,
      p_verified_by: req.user!.uid,
      p_verified_by_name: req.user!.email,
    });
    if (error) throw error;

    const result = data as
      | { status: 'ok'; branchId: string; branchName: string | null; items: { productId: string; productName: string; qty: number }[] }
      | { status: 'not_found' }
      | { status: 'already_reviewed' }
      | { status: 'insufficient_stock'; shortfalls: ProductionShortfall[] };

    if (result.status === 'insufficient_stock') {
      res.status(409).json(insufficientStockBody(result.shortfalls));
      return;
    }
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Production order not found' });
      return;
    }
    if (result.status === 'already_reviewed') {
      res.status(409).json({ error: 'This order is not awaiting verification (already verified, or not yet submitted)' });
      return;
    }

    // THE stock movement for this order — not a correction on top of an earlier
    // one. /review no longer moves anything, so the pool is debited once here,
    // for the quantity the branch actually counted.
    //
    // Both helpers are idempotent on (refId, productId, type). That also makes
    // this safe for any order left mid-flight by the previous behaviour: those
    // already carry a transfer_out under this same order id, so re-running is a
    // no-op rather than a second debit.
    //
    // Packing materials stay absent: not stock-tracked yet (migration 38).
    const moves = result.items
      .map((it) => ({ productId: it.productId, productName: it.productName, qty: Number(it.qty) }))
      .filter((m) => m.qty > 0);

    await transferOutOnApproval(id, moves);
    await Promise.all(
      moves.map((m) =>
        applyProductionToStock({
          branchId: order.branch_id,
          productId: m.productId,
          productName: m.productName,
          qty: m.qty,
          refId: id,
        }),
      ),
    );

    const correctionSummary = moves.map((m) => `${m.productName}: ${m.qty}`).join(' · ');

    await notify({
      type: 'production_order_verified',
      title: 'Production Order Verified — Awaiting Final Approval',
      message: `${req.user!.branchName || 'A branch'} verified receipt${correctionSummary ? ` — ${correctionSummary}` : ''}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: id,
    });

    res.json({ success: true, items: moves });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-orders/:id/final-approve — Production's closing sign-off
// on a demand the branch has verified. Status only: stock already moved at
// verification, which is also why there is no reject counterpart here — undoing
// it would mean clawing goods back out of branch inventory.
//
// The `.eq('status', 'verified')` predicate is the check-and-set: a second call
// matches no row and 409s rather than re-stamping the approval.
router.put('/:id/final-approve', requireRole('super_admin', 'production_user'), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;

    const { data, error } = await db
      .from('production_orders')
      .update({
        status: 'approved',
        approved_by: req.user!.uid,
        approved_by_name: req.user!.email,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'verified')
      .select('id, branch_id')
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      const { data: exists, error: exErr } = await db
        .from('production_orders')
        .select('id, status')
        .eq('id', id)
        .maybeSingle();
      if (exErr) throw exErr;
      if (!exists) { res.status(404).json({ error: 'Production order not found' }); return; }
      res.status(409).json({ error: `Cannot approve an order that is ${exists.status} — it must be verified by the branch first` });
      return;
    }

    await notify({
      type: 'production_reviewed',
      title: 'Production Order Approved',
      message: 'Your verified demand has been approved by Production.',
      targetRole: 'branch_manager',
      branchId: data.branch_id,
      relatedId: id,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
