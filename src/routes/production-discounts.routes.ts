import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { ProductionDiscountAmountSchema, ReviewBranchDiscountSchema, businessDaysAgoStr } from '../shared';
import { notify } from '../services/push.service';
import { getMonthlyDiscountSummary } from '../services/discount-summary.service';
import { getDiscountDayCheck } from '../services/discount-day-check.service';
import { rowToApi } from '../utils/case';

const db = dbFor('production-discounts');

/**
 * Production → Discounts: the queue of money branches are claiming back.
 *
 * The deliberate twin of production-returns.routes.ts. Same four states, same
 * three decisions, same atomic check-and-set on review — so that Production
 * learns one board and reads two.
 *
 * WHAT IS NOT HERE IS THE POINT. A return review has to get stock right: which
 * side has already moved, what acceptance credits, what rejection puts back, and
 * an idempotency key under all of it because the movements commit in a separate
 * transaction from the status. A discount moves nothing. Approving one is a
 * status write and a notification. There is no pool to credit, no branch balance
 * to unwind, and so nothing here that can leave stock and paperwork disagreeing.
 *
 * That is why 'returned' is offered unconditionally, where the returns route has
 * to refuse it on Production-recorded rows: every claim in this table was raised
 * by a branch, so there is always branch paperwork to hand back.
 */
export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

const BRANCH_DISCOUNT_STATUSES = ['pending', 'approved', 'rejected', 'returned'] as const;

/** Allowlist for `?sortBy=` — `date` is this API's own rename of `business_date` (see `toApi`). */
const BRANCH_DISCOUNT_SORTABLE_COLUMNS: Record<string, string> = {
  date: 'business_date',
  createdAt: 'created_at',
  branchName: 'branch_name',
  demandNumber: 'demand_number',
  amount: 'amount',
  reason: 'reason',
  status: 'status',
};

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
  return camel.map(({ businessDate, amount, originalAmount, ...rest }) => ({
    ...rest,
    amount: Number(amount),
    // Same numeric-as-string fix as `amount`; null while the figure is the branch's own.
    originalAmount: originalAmount == null ? null : Number(originalAmount),
    date: businessDate,
  }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/production-discounts/summary?branchId=
// — this business month to date (1st → today), per branch × status, summed in
// Postgres. No branchId = every active branch plus an overall total; a branchId
// narrows both to that branch. The window is the server's own clock, never a
// client-supplied range. See shared/utils/discount-summary.ts.
router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const branchId = (req.query['branchId'] as string | undefined) || null;
    if (branchId && !UUID_RE.test(branchId)) { res.status(400).json({ error: 'branchId must be a uuid' }); return; }
    res.json(await getMonthlyDiscountSummary({ branchId }));
  } catch (err) {
    next(err);
  }
});

// GET /api/production-discounts/day-check?branchId=&date=
// — the branch's till discounts for that business day, per product, against the
// claims it raised for the same day. Behind the "Product breakdown" button.
router.get('/day-check', async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.query['branchId'] as string | undefined;
    const date = req.query['date'] as string | undefined;
    if (!branchId || !UUID_RE.test(branchId)) { res.status(400).json({ error: 'branchId must be a uuid' }); return; }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'date must be YYYY-MM-DD' }); return; }
    res.json(await getDiscountDayCheck({ branchId, date }));
  } catch (err) {
    next(err);
  }
});

// GET /api/production-discounts?from=&to=&branchId=&status=&search=&limit=&offset=
// — 30 days by default, most recent first, filtered and paginated in Postgres.
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query['limit'] ?? 50), 1), 200);
    const offset = Math.max(Number(req.query['offset'] ?? 0), 0);
    const from = (req.query['from'] as string | undefined) ?? businessDaysAgoStr(29);
    const to = req.query['to'] as string | undefined;
    const branchId = req.query['branchId'] as string | undefined;
    const status = req.query['status'] as string | undefined;

    const sortByKey = req.query['sortBy'] as string | undefined;
    const sortCol = (sortByKey && BRANCH_DISCOUNT_SORTABLE_COLUMNS[sortByKey]) || 'created_at';
    const ascending = req.query['sortDir'] === 'asc';

    let query = db
      .from('branch_discounts')
      .select('*', { count: 'exact' })
      .gte('business_date', from)
      .order(sortCol, { ascending })
      .range(offset, offset + limit - 1);

    if (to) query = query.lte('business_date', to);
    if (branchId) query = query.eq('branch_id', branchId);
    if (status && (BRANCH_DISCOUNT_STATUSES as readonly string[]).includes(status)) {
      query = query.eq('status', status);
    }

    // Free-text search over the demand number, branch and reason — same
    // convention as GET /api/products: strip `or` filter syntax, then ilike.
    const search = (req.query['search'] as string | undefined)?.trim();
    if (search) {
      const term = search.replace(/[(),*]/g, ' ').trim();
      if (term) {
        query = query.or(`demand_number.ilike.%${term}%,reason.ilike.%${term}%,branch_name.ilike.%${term}%`);
      }
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const discounts = toApi(data);
    res.json({ discounts, total: count ?? 0 });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-discounts/:id/amount — Production corrects a pending
// claim's amount from its Discount Detail popup (owner's call, 2026-11-06),
// typically to match the till's Product breakdown before approving.
//
// Only while 'pending' — the same gate as review: a decided claim is final, and
// a 'returned' one is the branch's to correct. `original_amount` keeps the
// branch's own figure from the FIRST change; setting the amount back to it
// clears the record. The update is a check-and-set on the status AND the amount
// read, so a branch revision or a second reviewer landing in between is a 409,
// never a silent overwrite.
router.put('/:id/amount', validate(ProductionDiscountAmountSchema), async (req: AuthRequest, res, next) => {
  try {
    const { amount } = req.body as { amount: number };
    const id = req.params['id']!;
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'id must be a uuid' }); return; }

    const { data: current, error: readErr } = await db
      .from('branch_discounts')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) { res.status(404).json({ error: 'Discount not found' }); return; }
    if (current.status !== 'pending') {
      res.status(409).json({ error: 'Only a claim awaiting review can have its amount changed.' });
      return;
    }

    const before = Number(current.amount);
    if (amount === before) { res.json(toApi([current])[0]); return; }

    const branchFigure = current.original_amount == null ? before : Number(current.original_amount);
    const backToBranch = amount === branchFigure;

    const { data: updated, error } = await db
      .from('branch_discounts')
      .update(
        backToBranch
          ? { amount, original_amount: null, amount_changed_by: null, amount_changed_by_name: null, amount_changed_at: null }
          : {
              amount,
              original_amount: branchFigure,
              amount_changed_by: req.user!.uid,
              amount_changed_by_name: req.user!.email,
              amount_changed_at: new Date().toISOString(),
            },
      )
      .eq('id', id)
      .eq('status', 'pending')
      .eq('amount', current.amount)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: 'This claim changed while you were editing it — refresh and try again.' });
      return;
    }

    await notify({
      type: 'branch_discount_reviewed',
      title: 'Discount Amount Changed',
      message: `Production changed ${updated.demand_number} from ${before} to ${amount}`,
      targetRole: 'branch_manager',
      branchId: updated.branch_id,
      relatedId: id,
    });

    res.json(toApi([updated])[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-discounts/:id/review — approve, reject, or send back.
//
// Three outcomes, none of which move anything:
//
//   approved   the claim is allowed. Final.
//   rejected   the claim is refused. Final.
//   returned   handed back for the branch to correct. NOT final — the branch
//              revises it and it comes back here as 'pending'.
//
// The whole decision is the status and the note. Where the money is settled — a
// credit note, the next invoice, the branch's closing — is downstream of this
// record and outside this table; nothing here books a figure anywhere, which is
// exactly what makes the claim safe to review twice if the first attempt races.
router.put('/:id/review', validate(ReviewBranchDiscountSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status, reviewNote } = req.body as {
      status: 'approved' | 'rejected' | 'returned';
      reviewNote?: string;
    };
    const id = req.params['id']!;

    // Atomic check-and-set. The `.eq('status', 'pending')` predicate is the gate
    // on double review, exactly as it is on production_returns: a zero-row result
    // means someone else decided this between the board rendering and the button
    // being pressed. It also excludes 'returned' — a claim already handed back is
    // the branch's to act on, and deciding one out from under them would settle a
    // correction they are in the middle of making.
    //
    // `reviewed_*` is stamped on all three, 'returned' included: a send-back is a
    // review and this is the record of who last looked. The branch's own PUT
    // clears the three again when it corrects the claim.
    const { data: reviewed, error } = await db
      .from('branch_discounts')
      .update({
        status,
        review_note: reviewNote ?? null,
        reviewed_by: req.user!.uid,
        reviewed_by_name: req.user!.email,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (error) throw error;

    if (!reviewed) {
      // Not-found and already-decided are one 409 on purpose. Distinguishing them
      // would need a second read to say "no such claim" about a row the caller
      // just clicked, and the operator's next move — refresh the board — is the
      // same either way.
      res.status(409).json({ error: 'Discount already reviewed' });
      return;
    }

    const amount = Number(reviewed.amount);
    const outcome = {
      approved: {
        title: 'Discount Approved',
        message: `${amount} on ${reviewed.demand_number} was approved`,
      },
      rejected: {
        title: 'Discount Rejected',
        message: `${amount} on ${reviewed.demand_number} was rejected`,
      },
      returned: {
        title: 'Discount Sent Back',
        message: `${amount} on ${reviewed.demand_number} needs correcting before production can approve it`,
      },
    }[status];

    await notify({
      type: 'branch_discount_reviewed',
      title: outcome.title,
      message: outcome.message,
      // The branch, not a role broadcast: this is one shop's claim and the
      // notifications RLS matches on branch_id, so naming it is what gets the row
      // to the manager who raised it.
      targetRole: 'branch_manager',
      branchId: reviewed.branch_id,
      relatedId: id,
    });

    res.json(toApi([reviewed])[0]);
  } catch (err) {
    next(err);
  }
});
