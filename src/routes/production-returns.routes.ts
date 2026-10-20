import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateProductionReturnSchema,
  ReviewProductionReturnSchema,
  businessDateStr,
  businessDaysAgoStr,
  type ProductionReturnDisposition,
} from '../shared';
import { notify } from '../services/push.service';
import { acceptReturnIntoReturnStock } from '../services/return-stock.service';
import { applyStockMovement } from '../services/stock.service';
import { toReturnsApi } from '../services/branch-returns.service';
import { getMonthlyReturnsSummary } from '../services/returns-summary.service';
import { rowToApi } from '../utils/case';

const db = dbFor('production-returns');

export const router = Router();

router.use(authenticate, requireRole('super_admin', 'production_user'));

const PRODUCTION_RETURN_STATUSES = ['pending', 'accepted', 'rejected', 'returned'] as const;

/** Allowlist for `?sortBy=` — `date` is this API's own rename of `business_date` (see below). */
const PRODUCTION_RETURN_SORTABLE_COLUMNS: Record<string, string> = {
  date: 'business_date',
  createdAt: 'created_at',
  branchName: 'branch_name',
  productName: 'product_name',
  qty: 'qty',
  source: 'source',
  reason: 'reason',
  status: 'status',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/production-returns/summary?branchId=
// — this business month to date (1st → today), per branch × status, summed in
// Postgres. No branchId = every branch plus an overall total; a branchId narrows
// both to that branch, the same filter the list below takes. The window is the
// server's own clock, never a client-supplied range, so every surface states the
// same month. See shared/utils/returns-summary.ts for what each figure means.
router.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const branchId = (req.query['branchId'] as string | undefined) || null;
    if (branchId && !UUID_RE.test(branchId)) { res.status(400).json({ error: 'branchId must be a uuid' }); return; }
    res.json(await getMonthlyReturnsSummary({ branchId }));
  } catch (err) {
    next(err);
  }
});

// GET /api/production-returns?from=&to=&branchId=&productId=&status=&search=&limit=&offset=
// — 30 days by default, most recent first, filtered and paginated in Postgres.
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query['limit'] ?? 50), 1), 200);
    const offset = Math.max(Number(req.query['offset'] ?? 0), 0);
    const from = (req.query['from'] as string | undefined) ?? businessDaysAgoStr(29);
    const to = req.query['to'] as string | undefined;
    const branchId = req.query['branchId'] as string | undefined;
    const productId = req.query['productId'] as string | undefined;
    const status = req.query['status'] as string | undefined;

    const sortByKey = req.query['sortBy'] as string | undefined;
    const sortCol = (sortByKey && PRODUCTION_RETURN_SORTABLE_COLUMNS[sortByKey]) || 'created_at';
    const ascending = req.query['sortDir'] === 'asc';

    let query = db
      .from('production_returns')
      .select('*', { count: 'exact' })
      .gte('business_date', from)
      .order(sortCol, { ascending })
      .range(offset, offset + limit - 1);

    if (to) query = query.lte('business_date', to);
    if (branchId) query = query.eq('branch_id', branchId);
    if (productId) query = query.eq('product_id', productId);
    if (status && PRODUCTION_RETURN_STATUSES.includes(status as (typeof PRODUCTION_RETURN_STATUSES)[number])) {
      query = query.eq('status', status);
    }

    // Free-text search over id/reason/product/branch, in Postgres rather than
    // over the whole downloaded set — same convention as GET /api/products.
    // Commas and parens are stripped because they are PostgREST `or` syntax.
    const search = (req.query['search'] as string | undefined)?.trim();
    if (search) {
      const term = search.replace(/[(),*]/g, ' ').trim();
      if (term) {
        query = query.or(
          `reason.ilike.%${term}%,product_name.ilike.%${term}%,branch_name.ilike.%${term}%,legacy_id.ilike.%${term}%`,
        );
      }
    }

    const { data, error, count } = await query;
    if (error) throw error;

    // The DB column is business_date; the API contract (ProductionReturn) exposes
    // it as date. rowToApi only camelCases keys, so remap it here — same fix as
    // GET /api/production-orders. Without it every row's date is undefined and
    // the Return Date column renders formatDate's "—" placeholder on all of them.
    // `toReturnsApi` also turns each row's photo into a signed URL, so the
    // queue shows what the branch photographed alongside what it claimed.
    res.json({ returns: await toReturnsApi(data ?? []), total: count ?? 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/production-returns — Production records a branch return (pending review)
router.post('/', validate(CreateProductionReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, productId, qty, reason } = req.body as { branchId: string; productId: string; qty: number; reason: string };

    const [branchRes, productRes] = await Promise.all([
      db.from('branches').select('name').eq('id', branchId).maybeSingle(),
      db.from('products').select('name').eq('id', productId).maybeSingle(),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (productRes.error) throw productRes.error;
    if (!branchRes.data) { res.status(400).json({ error: 'Branch not found' }); return; }
    if (!productRes.data) { res.status(400).json({ error: 'Product not found' }); return; }

    // created_at comes from the column default; reviewed_* stay null until review.
    const { data: created, error: insErr } = await db
      .from('production_returns')
      .insert({
        branch_id: branchId,
        branch_name: branchRes.data.name,
        product_id: productId,
        product_name: productRes.data.name,
        qty,
        reason,
        status: 'pending',
        business_date: businessDateStr(),
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    // branchId null: production_user has no branch claim, and the notifications RLS
    // filters out a role broadcast whose branch_id doesn't match the recipient's.
    // The source branch is already named in the message.
    await notify({
      type: 'production_return',
      title: 'Product Return Recorded',
      message: `${qty} × ${productRes.data.name} from ${branchRes.data.name}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: created.id,
    });

    res.status(201).json({ id: created.id });
  } catch (err) {
    next(err);
  }
});

// PUT /api/production-returns/:id/review — approve, reject, or send back.
//
// "return stock" below is Branch Return Stock, a separate inventory from the
// production pool. NO outcome here moves production stock (migration 139).
//
// THREE OUTCOMES, and which stock moves depends on `source` — on how much of the
// return has already happened by the time Production sees it:
//
//                   source 'branch'                   source null (recorded here)
//                   branch already debited at raise    nothing moved yet
//   accepted        return stock ↑                     return stock ↑ AND branch ↓
//   rejected        branch ↑ — units go back           nothing to undo
//   returned        nothing; back to the branch        refused (see below)
//
// The `source = 'branch'` column is what makes the split necessary rather than
// cosmetic. Since auto-approval was dropped, `POST /api/stock/return` takes the
// units off the branch as the return is raised and stops there; doing it again
// on acceptance would debit the shop twice for one return. A Production-recorded
// return has moved nothing at all, so acceptance still owes both movements —
// that is the original behaviour, unchanged.
//
// 'returned' is refused on a Production-recorded row. It means "your paperwork
// is wrong, fix it and send it again", and there is no branch paperwork to hand
// back — Production would be sending their own record to a branch that has no
// screen to correct it on and no way to return it.
router.put('/:id/review', validate(ReviewProductionReturnSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status } = req.body as { status: 'accepted' | 'rejected' | 'returned' };
    const id = req.params['id']!;
    const { disposition = 'saleable', dispositionNote } = req.body as {
      disposition?: ProductionReturnDisposition;
      dispositionNote?: string;
    };

    // Read before write, only to answer "may this row take this decision" — the
    // update below is still the atomic gate on double review, so a row that slips
    // from pending between these two statements is caught there, not here.
    const { data: existing, error: exErr } = await db
      .from('production_returns')
      .select('id, source, status')
      .eq('id', id)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) { res.status(404).json({ error: 'Return not found' }); return; }

    const fromBranch = (existing as { source: string | null }).source === 'branch';
    if (status === 'returned' && !fromBranch) {
      res.status(400).json({ error: 'This return was recorded here, so there is no branch record to send back. Accept or reject it.' });
      return;
    }

    // Atomic check-and-set: the `status = 'pending'` predicate is what makes a
    // double review a no-op (migration 05). A null result means the return was
    // reviewed by someone else in between — the not-found case was already ruled
    // out above.
    //
    // An ACCEPT goes through `accept_production_return` (migration 139), which
    // does that check-and-set AND credits Branch Return Stock in one transaction.
    // It credits Return Stock only. Production stock is not touched by a return,
    // whatever the disposition: the single path from one inventory to the other
    // is the explicit transfer on /api/return-stock/transfer.
    //
    // `reviewed_*` is stamped on all three, 'returned' included: it is the record
    // of who last looked at the row, and a send-back is a review. It is cleared
    // again when the branch resubmits (`branch-returns.service.ts`), because a
    // row waiting on Production must not name a reviewer.
    let reviewed: { branch_id: string; product_id: string; product_name: string; qty: number | string; reason: string | null } | null;
    if (status === 'accepted') {
      const accepted = await acceptReturnIntoReturnStock({
        returnId: id,
        disposition,
        dispositionNote: dispositionNote ?? null,
        actorId: req.user!.uid,
        actorName: req.user!.email,
      });
      reviewed = accepted && {
        branch_id: accepted.branchId,
        product_id: accepted.productId,
        product_name: accepted.productName,
        qty: accepted.qty,
        reason: accepted.reason,
      };
    } else {
      const { data, error: updErr } = await db
        .from('production_returns')
        .update({
          status,
          reviewed_by: req.user!.uid,
          reviewed_by_name: req.user!.email,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'pending')
        .select('branch_id, product_id, product_name, qty, reason')
        .maybeSingle();
      if (updErr) throw updErr;
      reviewed = data;
    }

    if (!reviewed) {
      res.status(409).json({ error: 'Return already reviewed' });
      return;
    }

    const qty = Number(reviewed.qty);

    if (status === 'accepted') {
      // Branch side ONLY for a return Production recorded itself. See the table
      // above: a branch-raised return debited the shop when it was raised.
      if (!fromBranch) {
        await applyStockMovement({
          branchId: reviewed.branch_id,
          productId: reviewed.product_id,
          productName: reviewed.product_name,
          delta: -Math.abs(qty),
          // 'return', not 'adjustment'. This is the same business event as a
          // branch-initiated return (`POST /api/stock/return` -> commitBranchReturn,
          // which has always written 'return'); only the party who recorded it
          // differs. Typing it 'adjustment' put the units in the Stock page's
          // Adjustment column instead of Returned, so a branch that returned stock
          // saw Returned stay 0 and read that as "my return was never taken off".
          //
          // It also broke the Support Center: apply_stock_correction (migration 33)
          // takes an ABSOLUTE target for `returned` and sizes its compensating
          // movement against the live figure. With these units filed as
          // 'adjustment', getProductStockFigures reported returned=0, so an admin
          // correcting Returned to the true figure appended a SECOND 'return'
          // movement and took the stock off twice.
          type: 'return',
          refId: `return_${id}`,
        });
      }
    }

    // A rejected branch return puts the units back on the shop's balance — they
    // were taken off when it was raised and Production is refusing them, so the
    // stock is the branch's again. `+delta` on type 'return' nets them back out
    // of the Returned column rather than appearing as stock from nowhere; the
    // reasoning is spelled out in branch-returns.service.ts's header.
    //
    // A distinct refId prefix from the acceptance path above, because the two are
    // different movements on the same return id and share the ('return', product)
    // half of the idempotency key — reuse would make whichever ran second a
    // silent no-op.
    if (status === 'rejected' && fromBranch) {
      await applyStockMovement({
        branchId: reviewed.branch_id,
        productId: reviewed.product_id,
        productName: reviewed.product_name,
        delta: Math.abs(qty),
        type: 'return',
        refId: `return_rejected_${id}`,
      });
    }

    // Every outcome is now news the branch has to act on, not just acceptance —
    // a rejected return has changed their balance back and a sent-back one is
    // waiting on them to correct it.
    const outcome = {
      accepted: { title: 'Return Accepted', message: `${qty} × ${reviewed.product_name} received into return stock` },
      rejected: { title: 'Return Rejected', message: `${qty} × ${reviewed.product_name} is back in your branch stock` },
      returned: { title: 'Return Sent Back', message: `${qty} × ${reviewed.product_name} needs correcting before production can accept it` },
    }[status];

    await notify({
      type: 'production_return',
      title: outcome.title,
      message: outcome.message,
      targetRole: 'branch_manager',
      branchId: reviewed.branch_id,
      relatedId: id,
    });

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});
