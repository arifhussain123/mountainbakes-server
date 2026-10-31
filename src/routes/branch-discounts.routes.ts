import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  BRANCH_ROLES,
  CreateBranchDiscountSchema,
  ReviseBranchDiscountSchema,
  businessDateStr,
  businessDaysAgoStr,
  isBranchRole,
} from '../shared';
import { notify } from '../services/push.service';
import { getMonthlyDiscountSummary } from '../services/discount-summary.service';
import { summaryRangeFromQuery } from '../utils/summaryRange';
import { rowToApi } from '../utils/case';

const db = dbFor('branch-discounts');

/**
 * Branch → discount claims. The raising half of the feature; Production's review
 * board is production-discounts.routes.ts.
 *
 * THE SPLIT IS THE SAME ONE RETURNS USE, and for the same reason: this router is
 * mounted behind `requireRole(super_admin, ...BRANCH_ROLES)` and Production's
 * behind `requireRole(super_admin, production_user)`, so neither file has to
 * re-check the caller's side of the transaction in every handler. A branch role
 * that asks for /api/production-discounts gets a 403 from the mount, not a
 * filtered list.
 *
 * NOTHING HERE MOVES STOCK. That is what makes this file so much shorter than the
 * returns equivalent — no idempotency keys, no geofence gate, no compensating
 * movement to unwind, no InsufficientStockError. A claim is a row and an amount,
 * and correcting one is an ordinary update rather than a difference to settle.
 * (The geofence is deliberately not applied: `requireInsideGeofence` guards
 * PHYSICAL acts — counting stock, handing goods over — and a branch manager
 * chasing a short delivery from home is not the thing that guard exists to stop.)
 */
export const router = Router();

router.use(authenticate, requireRole('super_admin', ...BRANCH_ROLES));

/**
 * The branch this request acts on.
 *
 * A branch role is pinned to its own branch off the JWT and the `branchId` query
 * parameter is ignored for it — sending one must never widen what it can see.
 * Only an admin, who has no branch claim of their own, may name a branch.
 */
function scopeBranch(req: AuthRequest): string | null {
  return isBranchRole(req.user!.role)
    ? req.user!.branchId
    : ((req.query['branchId'] as string | undefined) ?? null);
}

/**
 * One DB row → the API's BranchDiscount shape.
 *
 * Two fixes, both of which are silent failures if skipped:
 *
 * - `business_date` → `date`. rowToApi only camelCases keys, so without this
 *   remap every row's `date` is undefined and the client renders formatDate's
 *   '—' placeholder on all of them — the same bug GET /api/production-orders and
 *   the returns list each had to fix.
 * - `amount` through Number(). PostgREST can hand a `numeric` column back as a
 *   STRING, and `BranchDiscount.amount` is typed `number`; a string would flow
 *   all the way to formatCurrency, whose toLocaleString options a string
 *   silently ignores, and the branch would read a raw unformatted figure with no
 *   error anywhere.
 */
function toApi(rows: unknown): Record<string, unknown>[] {
  const camel = rowToApi<Record<string, unknown>[]>((rows ?? []) as Record<string, unknown>[]);
  return camel.map(({ businessDate, amount, ...rest }) => ({
    ...rest,
    amount: Number(amount),
    date: businessDate,
  }));
}

const BRANCH_DISCOUNT_STATUSES = ['pending', 'approved', 'rejected', 'returned'] as const;

/** Allowlist for `?sortBy=` — `date` is this API's own rename of `business_date` (see `toApi`). */
const BRANCH_DISCOUNT_SORTABLE_COLUMNS: Record<string, string> = {
  date: 'business_date',
  createdAt: 'created_at',
  reviewedAt: 'reviewed_at',
  demandNumber: 'demand_number',
  amount: 'amount',
  reason: 'reason',
  status: 'status',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/branch-discounts/summary?from=&to= — this branch's claims, this
// business month to date (1st → today) by default, or the page's Date filter
// range when `from`/`to` are sent, by status. Same branch rule as every route here: a
// branch role is pinned to its token's branch (a `branchId` it sends is
// ignored), super_admin names one. Every branch at once is
// GET /api/production-discounts/summary.
router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const branchId = scopeBranch(req);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }
    if (!UUID_RE.test(branchId)) { res.status(400).json({ error: 'branchId must be a uuid' }); return; }
    const window = summaryRangeFromQuery(req.query);
    if (!window.ok) { res.status(400).json({ error: window.error }); return; }
    res.json(await getMonthlyDiscountSummary({ branchId, range: window.range }));
  } catch (err) {
    next(err);
  }
});

// GET /api/branch-discounts?days=N&status=&limit=&offset= — this branch's
// claims, most recent first.
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const branchId = scopeBranch(req);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    // The window (90 days — a branch auditing its own claims over a quarter,
    // longer than Production's 30-day board of today's work) narrows the
    // result set; limit/offset now page what's left instead of relying on the
    // window alone to keep the response finite.
    const requested = Number(req.query['days'] ?? 90);
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(365, Math.floor(requested))) : 90;
    const limit = Math.min(Math.max(Number(req.query['limit'] ?? 50), 1), 200);
    const offset = Math.max(Number(req.query['offset'] ?? 0), 0);
    // An explicit `from`/`to` (a real date-range filter) overrides the rolling
    // `days` window rather than combining with it — the two express the same
    // thing and `days` is only the default when no range was chosen.
    const from = (req.query['from'] as string | undefined) ?? businessDaysAgoStr(days - 1);
    const to = req.query['to'] as string | undefined;

    const sortByKey = req.query['sortBy'] as string | undefined;
    const sortCol = (sortByKey && BRANCH_DISCOUNT_SORTABLE_COLUMNS[sortByKey]) || 'created_at';
    const ascending = req.query['sortDir'] === 'asc';

    let query = db
      .from('branch_discounts')
      .select('*', { count: 'exact' })
      .eq('branch_id', branchId)
      .gte('business_date', from)
      .order(sortCol, { ascending })
      .range(offset, offset + limit - 1);

    if (to) query = query.lte('business_date', to);

    const status = req.query['status'] as string | undefined;
    if (status && (BRANCH_DISCOUNT_STATUSES as readonly string[]).includes(status)) {
      query = query.eq('status', status);
    }

    // Free-text search over the demand number and reason — same convention as
    // GET /api/products: strip `or` filter syntax, then ilike.
    const search = (req.query['search'] as string | undefined)?.trim();
    if (search) {
      const term = search.replace(/[(),*]/g, ' ').trim();
      if (term) query = query.or(`demand_number.ilike.%${term}%,reason.ilike.%${term}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const discounts = toApi(data);
    res.json({ discounts, total: count ?? 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/branch-discounts — raise a claim against one of this branch's demands.
router.post('/', validate(CreateBranchDiscountSchema), async (req: AuthRequest, res, next) => {
  try {
    const branchId = scopeBranch(req);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }
    const { productionOrderId, amount, reason, businessDate } = req.body as {
      productionOrderId: string;
      amount: number;
      reason: string;
      businessDate?: string;
    };

    // The demand must exist AND belong to the caller's branch. The branch filter
    // is the authorisation, not the lookup: without it a branch could quote
    // another shop's demand number and raise a claim against a delivery it never
    // received, which the review board would render as though it were theirs.
    const { data: order, error: ordErr } = await db
      .from('production_orders')
      .select('id, demand_number, branch_id')
      .eq('id', productionOrderId)
      .eq('branch_id', branchId)
      .maybeSingle();
    if (ordErr) throw ordErr;
    if (!order) { res.status(400).json({ error: 'Demand not found for this branch' }); return; }

    const { data: branch, error: brErr } = await db
      .from('branches')
      .select('name')
      .eq('id', branchId)
      .maybeSingle();
    if (brErr) throw brErr;
    if (!branch) { res.status(400).json({ error: 'Branch not found' }); return; }

    const { data: created, error: insErr } = await db
      .from('branch_discounts')
      .insert({
        branch_id: branchId,
        branch_name: branch.name,
        production_order_id: order.id,
        demand_number: order.demand_number,
        amount,
        reason,
        status: 'pending',
        // The device's business date when the mobile app sends one, today's
        // otherwise — the same precedence CreateBranchReturnSchema's optional
        // businessDate establishes for a branch acting near the day boundary.
        business_date: businessDate ?? businessDateStr(),
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('*')
      .single();
    if (insErr) throw insErr;

    // branchId null, as the returns route explains: a production_user holds no
    // branch claim, and the notifications RLS drops a role broadcast whose
    // branch_id does not match the recipient's. The branch is named in the text.
    await notify({
      type: 'branch_discount',
      title: 'Discount Requested',
      message: `${branch.name} is claiming ${amount} on ${order.demand_number}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: created.id,
    });

    res.status(201).json(toApi([created])[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/branch-discounts/:id — correct a claim that is still the branch's.
//
// Valid on 'pending' and 'returned' only, and the `.in('status', …)` predicate on
// the UPDATE is what enforces it rather than the read above — a claim Production
// approves between the two statements is caught there, not here. The 409 says so
// in words the branch can act on, because the usual cause is exactly that race.
router.put('/:id', validate(ReviseBranchDiscountSchema), async (req: AuthRequest, res, next) => {
  try {
    const branchId = scopeBranch(req);
    const { amount, reason } = req.body as { amount: number; reason: string };

    let q = db
      .from('branch_discounts')
      .update({
        amount,
        reason,
        // Back to pending, and the reviewer fields cleared. A corrected claim is
        // waiting on Production again, and a row waiting on Production must not
        // name a reviewer — the same rule `branch-returns.service.ts` applies
        // when a branch resubmits a sent-back return.
        status: 'pending',
        reviewed_by: null,
        reviewed_by_name: null,
        reviewed_at: null,
      })
      .eq('id', req.params['id']!)
      .in('status', ['pending', 'returned']);
    // A branch role may only touch its own; an admin is unscoped.
    if (branchId) q = q.eq('branch_id', branchId);

    const { data: updated, error } = await q.select('*').maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: 'This discount has already been decided and can no longer be changed.' });
      return;
    }

    res.json(toApi([updated])[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/branch-discounts/:id — withdraw a claim the branch no longer wants.
//
// A real delete, not a 'cancelled' status. Nothing was booked when the claim was
// raised and nothing depends on it, so there is no ledger to keep honest and no
// figure that would silently change — which is the whole reason a deleted DEMAND
// had to become a status (migration 73) and this does not. Restricted to the open
// states so a decided claim stays on the record.
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const branchId = scopeBranch(req);

    let q = db
      .from('branch_discounts')
      .delete()
      .eq('id', req.params['id']!)
      .in('status', ['pending', 'returned']);
    if (branchId) q = q.eq('branch_id', branchId);

    const { data: removed, error } = await q.select('id').maybeSingle();
    if (error) throw error;
    if (!removed) {
      res.status(409).json({ error: 'This discount has already been decided and can no longer be withdrawn.' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
