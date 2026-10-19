import { Router } from 'express';
import { randomUUID } from 'crypto';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  businessDateStr,
  CreateBranchReturnSchema,
  ReviseBranchReturnSchema,
  businessDaysAgoStr,
  type StockAuditLog,
  type StockFigures,
  BRANCH_ROLES,
  isBranchRole,
  ADMIN_STOCK_FIGURES,
  AdminStockSaveSchema,
  AdminStockDeleteSchema,
  type AdminStockSaveInput,
  type AdminStockDeleteInput,
} from '../shared';
import { notify } from '../services/push.service';
import {
  applyStockCorrection,
  commitBranchReturn,
  computeBranchStockDay,
  computeAllBranchesStockSummary,
  computeBranchStockHistory,
  reconcileBranchStockDay,
  computeStockRows,
  preloadBranchStock,
  purgeBranchStock,
  DayClosedError,
  InsufficientStockError,
  NegativeBalanceError,
  OverdeterminedCorrectionError,
  type StockCorrectionTargets,
} from '../services/stock.service';
import {
  listBranchReturns,
  resolveReturnLinePhotos,
  returnAuditDetails,
  resubmitBranchReturn,
  reviseBranchReturn,
  withdrawBranchReturn,
  ReturnLockedError,
  ReturnNotFoundError,
} from '../services/branch-returns.service';
import { assertStagedAttachments, bindAttachments } from '../services/attachments.service';
import { logAudit } from '../services/audit.service';
import { getMonthlyReturnsSummary } from '../services/returns-summary.service';
import { idempotent, persistIfCommitted } from '../middleware/idempotency';
import { resolveClientBusinessDate } from '../utils/clientBusinessDate';
import { requireInsideGeofence } from '../middleware/requireInsideGeofence';
import { rowToApi } from '../utils/case';

const db = dbFor('stock');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const router = Router();

router.use(authenticate);

// GET /api/stock/audit — blocked-sale attempts (Admin: all; branch manager: own branch)
router.get('/audit', async (req: AuthRequest, res, next) => {
  try {
    // Ordering and the 200-row cap happen in Postgres (stock_audit_log_branch_idx
    // is already (branch_id, created_at desc)); this used to fetch every row and
    // sort/slice in memory.
    let query = db
      .from('stock_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (isBranchRole(req.user!.role)) {
      if (!req.user!.branchId) { res.status(400).json({ error: 'No branch assigned' }); return; }
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.user!.role !== 'super_admin') {
      res.status(403).json({ error: 'Access denied' });
      return;
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    const logs = rowToApi<StockAuditLog[]>(data ?? []);
    res.json({ logs, total: logs.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/stock/history/branches?days=N — Admin → Branch Stock, "All branches":
// one row per branch, totalled over the window, instead of one row per day for a
// single branch.
//
// Super Admin only, and not for want of a branch scope — a branch role has no use
// for it. The whole point of the row set is comparing shops, which is exactly
// what a branch account may not do.
//
// Registered before `/history` for readability only: Express matches these as
// exact paths, so '/history/branches' and '/history' cannot shadow each other
// whichever order they appear in.
router.get('/history/branches', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    // Parsed leniently, exactly as on /history: a junk or missing `days` falls
    // back to a week rather than 400-ing the screen that asked.
    const parsed = Number(req.query['days']);
    const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;

    res.json(await computeAllBranchesStockSummary(days));
  } catch (err) {
    next(err);
  }
});

// GET /api/stock/history?days=N — Branch Stock History: one row per business day
// (Previous / New / Sold / Remaining, in units and money) for the Branch Dashboard.
//
// Mounted BEFORE `GET /` only for readability — Express matches on the exact path,
// so the two cannot shadow each other. Scoped like /audit: a branch role gets its
// own branch and nothing else, Super Admin may name one, everyone else is refused.
// It reads across days, which is precisely what a branch account may not do for a
// branch that is not its own.
router.get('/history', async (req: AuthRequest, res, next) => {
  try {
    let branchId: string | null;
    if (isBranchRole(req.user!.role)) {
      branchId = req.user!.branchId ?? null;
      if (!branchId) { res.status(400).json({ error: 'No branch assigned' }); return; }
    } else if (req.user!.role === 'super_admin') {
      branchId = (req.query['branchId'] as string | undefined) ?? null;
      if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }
    } else {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // `date` asks for ONE business day (Branch Daily Stock); `days` asks for a
    // window ending today (the dashboard card). Not both — a caller that sends
    // each means two different things, and picking one silently would answer a
    // question it did not ask.
    const date = (req.query['date'] as string | undefined)?.trim();
    if (date) {
      // Both calls below independently read the whole `products` table and this
      // branch's `stock` balances — same rows, neither can change mid-request —
      // so it's fetched once here and handed to both instead of 2-3x each.
      const preload = await preloadBranchStock(branchId);
      const row = await computeBranchStockDay(branchId, date, undefined, preload);
      // Shipped with the row, not behind its own endpoint: the statement is the
      // only place the aggregate is stated, so it is the only place that can say
      // whether the Stock page agrees with it — and a check that has to be asked
      // for separately is a check nobody runs.
      const reconciliation = await reconcileBranchStockDay(branchId, date, row.balanceQty, preload);
      res.json({ branchId, date, row, reconciliation });
      return;
    }

    // Clamped in the service too (1..365); parsed leniently here so a missing or
    // junk `days` falls back to a week rather than 400-ing a dashboard card.
    const parsed = Number(req.query['days']);
    const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;

    res.json(await computeBranchStockHistory(branchId, days));
  } catch (err) {
    next(err);
  }
});

// GET /api/stock?date=YYYY-MM-DD&activityOnly=1 — Opening/New/Sold/Balance per product for a branch (today by default)
//
// `activityOnly` drops every row whose Opening, Received, Sold, Returned and
// Balance are all zero. The Branch Closing sheet asks for it, so a large
// catalogue never travels to the client only to be hidden. The Stock page does
// not ask: it applies the same rule in the browser, because its response is a
// cache entry shared with the balance map that validates returns.
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    // A branch role is pinned to the branch on its JWT — a branchId in the query
    // is ignored, never trusted. Only an admin may name one.
    const branchId = isBranchRole(req.user!.role)
      ? req.user!.branchId
      : (req.query['branchId'] as string | undefined) ?? null;

    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    const date = (req.query['date'] as string | undefined) || businessDateStr();
    const activityOnly = ['1', 'true'].includes(String(req.query['activityOnly'] ?? '').toLowerCase());
    const rows = await computeStockRows(branchId, date, { activityOnly });
    res.json({ date, rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/stock/return — branch returns unsold/damaged stock to production.
//
// RAISED FOR REVIEW, NOT AUTO-APPROVED. This route used to do the whole thing:
// insert the record already `accepted`, credit the production pool, and stamp
// itself as its own reviewer. Production had no say — their Returns screen was a
// log of decisions already taken. It now stops half way:
//
//   here      branch balance ↓, record `pending`, Production notified
//   approve   production pool ↑ (see production-returns.routes.ts)
//   reject    branch balance ↑ — the units come back
//
// The branch half still moves NOW, and deliberately: the goods have physically
// left the shop, and leaving them on the balance would let the counter sell
// stock that is already on its way to production. What waits for review is the
// pool credit — the claim that production actually received them.
//
// The gap between the two is what makes Change and Delete meaningful on the
// branch's Return Stock page: while the row is open the branch may still correct
// or withdraw it (`branch-returns.service.ts`), and once Production has decided
// it is final.
//
// Takes MANY products in one submission: a branch closing out an evening hands
// back everything unsold at once, and Production wants one notification for that,
// not one per line.
//
// ATOMICITY, HONESTLY: commit_branch_return is a per-product RPC and PostgREST
// gives each call its own transaction, so a batch is not all-or-nothing. The
// pre-validation pass below closes the realistic failure (asking for more than is
// on hand) BEFORE anything is written. A concurrent sale landing between validate
// and commit can still fail a later row — the RPC refuses rather than driving the
// branch negative, and the 409 names what did commit. Those stay committed:
// they are real stock movements, and silently reversing them would be worse.
// True all-or-nothing needs a commit_branch_return_batch(p_items jsonb) function.
// `persistIfCommitted` rather than the default: this route commits product by
// product and its 409 reports what already moved before a shortfall stopped it.
// Releasing that key would let a retry return those units a second time.
router.post('/return', requireRole('super_admin', ...BRANCH_ROLES), idempotent('stock.return', { persistOn: persistIfCommitted }), validate(CreateBranchReturnSchema), requireInsideGeofence('stock.return'), async (req: AuthRequest, res, next) => {
  try {
    const branchId = isBranchRole(req.user!.role)
      ? req.user!.branchId
      : ((req.body as { branchId?: string }).branchId ?? null);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    const { items: sentItems, reason, businessDate: claimedDate, attachmentIds = [] } = req.body as {
      items: { productId: string; qty: number; attachmentId?: string }[];
      reason: string;
      // The day the return was made, as captured on the device.
      businessDate?: string;
      // LEGACY: one photo for the whole return (see CreateBranchReturnSchema).
      attachmentIds?: string[];
    };
    // A line left at 0 is not part of the return, and needs no photo.
    const items = sentItems.filter((it) => it.qty > 0);

    const businessDate = await resolveClientBusinessDate(claimedDate, req.user!.role);

    // One query per entity rather than a pair per product: the product names come
    // back in a single `in` lookup however many rows the return carries.
    const productIds = items.map((i) => i.productId);
    const [branchRes, productsRes] = await Promise.all([
      db.from('branches').select('name').eq('id', branchId).maybeSingle(),
      db.from('products').select('id, name').in('id', productIds),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (productsRes.error) throw productsRes.error;
    if (!branchRes.data) { res.status(400).json({ error: 'Branch not found' }); return; }

    const branchName = branchRes.data.name as string;
    const nameById = new Map((productsRes.data ?? []).map((p) => [p.id as string, p.name as string]));
    const missing = productIds.filter((id) => !nameById.has(id));
    if (missing.length) { res.status(400).json({ error: 'Product not found', details: missing }); return; }

    // A PHOTO OF EVERY LINE IS REQUIRED. Refused here rather than by the schema
    // so the answer names the product ("Photo missing for Classic Brownie"), and
    // so RETURN_PHOTO_REQUIRED=false can hold the rule off. After the name
    // lookup, before anything is written.
    const photos = resolveReturnLinePhotos({
      lines: items.map((it) => ({ ...it, productName: nameById.get(it.productId)! })),
      legacyAttachmentIds: attachmentIds,
      required: process.env['RETURN_PHOTO_REQUIRED'] !== 'false',
      strict: process.env['RETURN_PHOTO_PER_LINE'] === 'strict',
    });
    if (!photos.ok) {
      res.status(photos.status).json({ error: photos.error, code: photos.code, ...(photos.details ? { details: photos.details } : {}) });
      return;
    }
    const photoByProduct = new Map(photos.lines.map((l) => [l.productId, l.photoId]));

    // PRE-VALIDATE EVERY ROW BEFORE WRITING ANYTHING. One balance read covers the
    // whole return, and every offending line is reported together — previously the
    // branch discovered an over-return one product at a time, after the earlier
    // ones had already moved.
    const stockRows = await computeStockRows(branchId);
    const balanceById = new Map(stockRows.map((r) => [r.productId, r.balance]));
    const shortfalls = items
      .map((it) => ({
        productId: it.productId,
        productName: nameById.get(it.productId)!,
        requested: it.qty,
        available: balanceById.get(it.productId) ?? 0,
      }))
      .filter((s) => s.requested > s.available);
    if (shortfalls.length) {
      res.status(409).json({
        error: 'Return quantity cannot be greater than available stock.',
        details: shortfalls,
      });
      return;
    }

    // EVERY PHOTO IS PROVEN USABLE BEFORE ANY STOCK MOVES. Each is bound last,
    // once the row it belongs to exists — but a photo that turns out to be
    // someone else's, already used, or swept away must stop the return here,
    // while stopping is still free. Discovering it at bind time would leave units
    // off the branch balance for a return the caller was told had failed.
    await assertStagedAttachments({
      entity: 'branch_return',
      attachmentIds: photos.lines.flatMap((l) => (l.photoId ? [l.photoId] : [])),
      actor: { uid: req.user!.uid },
    });

    const committed: { id: string; productId: string; productName: string; qty: number; photoId: string | null }[] = [];

    for (const it of items) {
      const productName = nameById.get(it.productId)!;
      // One id per product, minted up front: it is the shared refId across branch
      // stock, the production pool and the record — and the idempotency key on
      // both stock_history and production_stock_history — so all three movements
      // for a product must agree on it, and two products must never share one.
      // The pool movement is not written here any more but still uses this id
      // when Production approves, which is what keeps that credit idempotent.
      const returnId = randomUUID();

      // 1) Decrement branch stock (validates qty <= balance atomically).
      //    This is the ONLY ledger write on this path now — see the header.
      try {
        await commitBranchReturn({ branchId, productId: it.productId, productName, qty: it.qty, refId: returnId, businessDate });
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          // Lost a race with a sale after the pre-check above. Report precisely
          // what already went through rather than pretending nothing happened.
          res.status(409).json({
            error: `Stock for ${productName} changed while the return was being saved.`,
            details: err.shortfalls,
            committed: committed.map((c) => ({ id: c.id, productName: c.productName, qty: c.qty })),
          });
          return;
        }
        throw err;
      }

      committed.push({ id: returnId, productId: it.productId, productName, qty: it.qty, photoId: photoByProduct.get(it.productId) ?? null });
    }

    // 2) Record the returns as PENDING so they land on Production's queue.
    //    One row per product (the table is product-scoped) but a single insert.
    //    Ids are supplied rather than generated, to match the refIds above.
    //
    //    `reviewed_*` stay null. They used to be stamped with the branch user who
    //    raised the return, which made every row read as "approved by the person
    //    who asked" — the review columns now mean what they say and stay empty
    //    until Production actually decides.
    const { error: insertErr } = await db.from('production_returns').insert(
      committed.map((c) => ({
        id: c.id,
        branch_id: branchId,
        branch_name: branchName,
        product_id: c.productId,
        product_name: c.productName,
        qty: c.qty,
        reason: reason || '',
        status: 'pending',
        source: 'branch',
        business_date: businessDate,
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
        // This product's own photo.
        photo_attachment_id: c.photoId,
      })),
    );
    if (insertErr) throw insertErr;

    // 2b) Bind each photo to its own row, which is what makes it immutable and
    //     takes it out of reach of the staged-photo sweep.
    //
    //     A failure here is logged, not thrown. The stock has moved and the rows
    //     are written — the return HAPPENED — and answering 500 would have a
    //     client retry it or clean up a photo the rows now cite. The pre-check
    //     above leaves only a same-user double submit able to get here.
    for (const c of committed) {
      if (!c.photoId) continue;
      try {
        await bindAttachments({
          entity: 'branch_return',
          entityId: c.id,
          attachmentIds: [c.photoId],
          actor: { uid: req.user!.uid },
        });
      } catch (bindErr) {
        console.error(`[stock.return] return ${c.id} saved but photo ${c.photoId} did not bind:`, bindErr);
      }
    }

    // 2c) The Audit Trail: every line with the photo it was raised on.
    await logAudit({
      action: 'return_created',
      adminId: req.user!.uid,
      adminName: req.user!.email,
      details: returnAuditDetails(branchName, businessDate, committed),
    });

    // 3) Notify Production in real time — ONCE for the whole return. branchId
    // null: production_user has no branch claim, and the notifications RLS filters
    // out a role broadcast whose branch_id doesn't match the recipient's. The
    // branch is named in the message.
    // The title says what Production has to DO with it. "Stock Returned" read as
    // a completed event, which it no longer is — these rows are waiting on them.
    const totalUnits = committed.reduce((s, c) => s + c.qty, 0);
    await notify({
      type: 'production_return',
      title: 'Return Awaiting Review',
      message: committed.length === 1
        ? `${committed[0].qty} × ${committed[0].productName} from ${branchName}`
        : `${committed.length} products (${totalUnits} units) from ${branchName}`,
      targetRole: 'production_user',
      branchId: null,
      relatedId: committed[0].id,
    });

    res.status(201).json({ ids: committed.map((c) => c.id) });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Branch → Return Stock: the branch's own view of what it has sent back.
//
// A SEPARATE endpoint from GET /api/production-returns rather than a widening of
// it. That router is `super_admin` + `production_user` and answers with every
// branch's returns; a branch may not read another branch's, and does not need
// the extra rows even if it could. Here `branchId` comes off the JWT for a branch
// role, exactly as it does for the rest of this router.
// ───────────────────────────────────────────────────────────────────────────────

// GET /api/stock/returns/summary — the branch's own returns, this business month
// to date (1st → today), by status. Same branch rule as the list below: a branch
// role is pinned to the branch on its token (a `branchId` it sends is ignored),
// super_admin names one. Production's all-branch view of the same figures is
// GET /api/production-returns/summary.
router.get('/returns/summary', requireRole('super_admin', ...BRANCH_ROLES), async (req: AuthRequest, res, next) => {
  try {
    const branchId = isBranchRole(req.user!.role)
      ? req.user!.branchId
      : ((req.query['branchId'] as string | undefined) ?? null);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }
    if (!UUID_RE.test(branchId)) { res.status(400).json({ error: 'branchId must be a uuid' }); return; }
    res.json(await getMonthlyReturnsSummary({ branchId }));
  } catch (err) {
    next(err);
  }
});

// GET /api/stock/returns?days=N&from=&to=&productId=&status=&search=&limit=&offset=
// — the branch's returns, most recent first.
router.get('/returns', requireRole('super_admin', ...BRANCH_ROLES), async (req: AuthRequest, res, next) => {
  try {
    const branchId = isBranchRole(req.user!.role)
      ? req.user!.branchId
      : ((req.query['branchId'] as string | undefined) ?? null);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    // The window (90 days by default, a branch auditing its own returns over a
    // quarter rather than a queue of today's work) narrows the result set;
    // limit/offset now page what's left, so a busy branch's 90-day history
    // doesn't have to come down in one response. An explicit `from` (a real
    // date-range filter) overrides the rolling `days` window rather than
    // combining with it — same convention as GET /api/branch-discounts.
    const requested = Number(req.query['days'] ?? 90);
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(365, Math.floor(requested))) : 90;

    const { returns, total } = await listBranchReturns(branchId, {
      from: (req.query['from'] as string | undefined) ?? businessDaysAgoStr(days - 1),
      to: req.query['to'] as string | undefined,
      limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
      offset: req.query['offset'] ? Number(req.query['offset']) : undefined,
      productId: req.query['productId'] as string | undefined,
      status: req.query['status'] as string | undefined,
      search: req.query['search'] as string | undefined,
      sortBy: req.query['sortBy'] as string | undefined,
      sortDir: req.query['sortDir'] === 'asc' ? 'asc' : req.query['sortDir'] === 'desc' ? 'desc' : undefined,
    });
    res.json({ returns, total });
  } catch (err) {
    next(err);
  }
});

// PUT /api/stock/returns/:id — change the quantity (and reason) of a return.
//
// Geofenced like POST /return: it moves the same stock in the same shop, and a
// correction made from outside the branch is the same thing the geofence exists
// to refuse. Idempotent for callers that send the header — the mobile app does;
// the web app does not, and this is not a no-op it can be retried through
// blindly, which is why the client confirms before sending.
router.put(
  '/returns/:id',
  requireRole('super_admin', ...BRANCH_ROLES),
  idempotent('stock.returns.revise'),
  validate(ReviseBranchReturnSchema),
  requireInsideGeofence('stock.return'),
  async (req: AuthRequest, res, next) => {
    try {
      const { qty, reason } = req.body as { qty: number; reason?: string };
      const updated = await reviseBranchReturn({
        id: req.params['id']!,
        // null lets an admin reach any branch's return; a branch role is pinned
        // to its own, and `reviseBranchReturn` treats null as "skip that check".
        branchId: isBranchRole(req.user!.role) ? req.user!.branchId : null,
        qty,
        ...(reason !== undefined ? { reason } : {}),
        actor: { uid: req.user!.uid, email: req.user!.email },
      });
      res.json(updated);
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        res.status(409).json({
          error: 'The branch no longer holds enough stock to increase this return.',
          details: err.shortfalls,
        });
        return;
      }
      if (err instanceof ReturnLockedError || err instanceof ReturnNotFoundError) { next(err); return; }
      next(err);
    }
  },
);

// POST /api/stock/returns/:id/resubmit — send a handed-back return to Production
// again, unchanged.
//
// NOT geofenced, unlike its neighbours, and the difference is real rather than an
// oversight: the geofence exists to stop stock being moved from somewhere other
// than the shop, and this moves none. The units left the branch when the return
// was raised and the pool has never held them — all that changes is whose queue
// the row sits in. Refusing it off-site would only strand a return that has
// already had its stock effect.
router.post(
  '/returns/:id/resubmit',
  requireRole('super_admin', ...BRANCH_ROLES),
  idempotent('stock.returns.resubmit'),
  async (req: AuthRequest, res, next) => {
    try {
      const updated = await resubmitBranchReturn(
        req.params['id']!,
        isBranchRole(req.user!.role) ? req.user!.branchId : null,
      );
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/stock/returns/:id — withdraw a return; the units go back to the branch.
router.delete(
  '/returns/:id',
  requireRole('super_admin', ...BRANCH_ROLES),
  idempotent('stock.returns.withdraw'),
  requireInsideGeofence('stock.return'),
  async (req: AuthRequest, res, next) => {
    try {
      await withdrawBranchReturn(
        req.params['id']!,
        isBranchRole(req.user!.role) ? req.user!.branchId : null,
      );
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// ───────────────────────────────────────────────────────────────────────────────
// Admin → Branch Stock: direct control over any branch's ledger.
//
// The Stock page a branch sees is read-only by design — stock moves by selling,
// by Production approving a demand, or by returning. Admin needed a way to set a
// figure outright, and until now the ONLY way was to have someone raise a Help
// Desk query and correct it from the Support Center. That is the right shape for
// "a branch disputes a number"; it is the wrong shape for "seed the opening
// balances for a new branch" or "the count is wrong and there is no ticket".
//
// These two endpoints are that missing door. They deliberately reuse the Support
// Center's correction engine rather than writing to `stock` directly:
// `apply_stock_correction` takes ABSOLUTE targets, sizes each compensating
// movement against the live figures under a row lock, refuses to drive a balance
// negative, and appends the whole thing to `stock_history` — so an admin edit is
// as auditable as a sale and cannot silently lose a concurrent one. The only
// difference from the ticket path is the ref_id prefix (`admin:<uid>`), which is
// what tells the two apart in the ledger afterwards.
// ───────────────────────────────────────────────────────────────────────────────

/** The figure keys forwarded to the correction RPC, straight off the schema. */
const ADMIN_TARGET_KEYS = ADMIN_STOCK_FIGURES;

/**
 * Tell the branch its stock was changed under it.
 *
 * `support_resolved` rather than a new notification type on purpose: the client's
 * `useStockRealtime` already treats it as stock-moving and invalidates the whole
 * `['stock']` prefix on it, and a new value would mean a Postgres enum migration
 * for a message that means exactly the same thing to the recipient ("an admin
 * changed your figures — here is what and why"). Best-effort: the correction is
 * already committed and a failed notification must not un-commit it.
 *
 * Targeted at `branch_manager` with the branch id.
 */
async function notifyBranchOfStockChange(
  branchId: string,
  branchName: string,
  message: string,
): Promise<void> {
  try {
    await notify({
      type: 'support_resolved',
      title: 'Stock Updated by Admin',
      message,
      targetRole: 'branch_manager',
      branchId,
      relatedId: null,
    });
  } catch (err) {
    console.error('[stock] admin correction notification failed:', err);
  }
}

/** Look up a branch by id, or null. Shared by both admin endpoints. */
async function findBranch(branchId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db
    .from('branches')
    .select('id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; name: string } | null) ?? null;
}

// PATCH /api/stock/admin — save edited figures for one or many products.
//
// PARTIAL SAVES ARE POSSIBLE and the response says so. `apply_stock_correction`
// is per-product and PostgREST gives each call its own transaction, exactly as on
// the branch-return path above; a row that the RPC refuses (it would go negative,
// or an Opening edit lands on a closed day) is reported in `failed` while the
// rows that went through stay committed. They are real stock movements — quietly
// reversing them would be the worse lie.
router.patch('/admin', requireRole('super_admin'), validate(AdminStockSaveSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, rows, date, reason } = req.body as AdminStockSaveInput;
    const businessDate = date || businessDateStr();

    const branch = await findBranch(branchId);
    if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }

    // One lookup for every product in the save, and the names come from `products`
    // rather than the request: stock_history keeps a name snapshot, and it should
    // read as the name at correction time, not whatever the client's cache held.
    const productIds = [...new Set(rows.map((r) => r.productId))];
    const { data: products, error: prodErr } = await db
      .from('products')
      .select('id, name')
      .in('id', productIds);
    if (prodErr) throw prodErr;

    const nameById = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));
    const missing = productIds.filter((id) => !nameById.has(id));
    if (missing.length) { res.status(400).json({ error: 'Product not found', details: missing }); return; }

    const ticketId = `admin:${req.user!.uid}`;
    const saved: { productId: string; productName: string; applied: boolean; before: StockFigures; after: StockFigures }[] = [];
    const failed: { productId: string; productName: string; error: string }[] = [];

    for (const row of rows) {
      const productName = nameById.get(row.productId)!;

      const targets: StockCorrectionTargets = {};
      for (const key of ADMIN_TARGET_KEYS) {
        const value = row[key];
        if (value !== undefined) targets[key] = value;
      }

      try {
        const result = await applyStockCorrection({
          branchId,
          productId: row.productId,
          productName,
          targets,
          ticketId,
          businessDate,
        });
        saved.push({ productId: row.productId, productName, applied: result.applied, before: result.before, after: result.after });
      } catch (err) {
        // The three the RPC reports as a status rather than throwing SQL. Each is
        // an admin-fixable mistake about ONE row, so it is collected and the rest
        // of the save continues instead of aborting on the first bad number.
        if (err instanceof OverdeterminedCorrectionError || err instanceof DayClosedError || err instanceof NegativeBalanceError) {
          failed.push({ productId: row.productId, productName, error: err.message });
          continue;
        }
        throw err;
      }
    }

    // Nothing at all went through: that is a failed request, not a partial one.
    if (saved.length === 0 && failed.length > 0) {
      res.status(409).json({ error: failed[0]!.error, saved, failed });
      return;
    }

    const changed = saved.filter((s) => s.applied);
    if (changed.length > 0) {
      const detail = changed.length === 1
        ? `${changed[0]!.productName}: balance ${changed[0]!.before.balance} → ${changed[0]!.after.balance}`
        : `${changed.length} products`;
      await notifyBranchOfStockChange(
        branchId,
        branch.name,
        [`${businessDate} — ${detail}`, reason].filter(Boolean).join(' · '),
      );
    }

    res.json({
      branchId,
      date: businessDate,
      // `applied: false` means the figures already matched — a no-op, not a failure.
      saved,
      failed,
      changedCount: changed.length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/stock/admin/delete — remove a product's stock from a branch.
//
// A POST rather than a DELETE because it carries a body (mode, date, reason) and
// bodies on DELETE are inconsistently handled end to end. `mode` decides what
// "remove" means, and the default is the safe one — see AdminStockDeleteSchema.
router.post('/admin/delete', requireRole('super_admin'), validate(AdminStockDeleteSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, productId, mode, date, reason } = req.body as AdminStockDeleteInput;
    const businessDate = date || businessDateStr();

    const branch = await findBranch(branchId);
    if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }

    const { data: product, error: prodErr } = await db
      .from('products')
      .select('name')
      .eq('id', productId)
      .maybeSingle();
    if (prodErr) throw prodErr;
    if (!product) { res.status(404).json({ error: 'Product not found' }); return; }
    const productName = product.name as string;

    if (mode === 'purge') {
      const result = await purgeBranchStock(branchId, productId);
      await notifyBranchOfStockChange(
        branchId,
        branch.name,
        [`${productName} was removed from this branch's stock`, reason].filter(Boolean).join(' · '),
      );
      res.json({ mode, productId, productName, ...result });
      return;
    }

    // mode === 'zero' — an ordinary correction to a balance of 0, so the ledger
    // keeps the movement that took it there and the row can be typed back up.
    try {
      const result = await applyStockCorrection({
        branchId,
        productId,
        productName,
        targets: { balance: 0 },
        ticketId: `admin:${req.user!.uid}`,
        businessDate,
      });
      if (result.applied) {
        await notifyBranchOfStockChange(
          branchId,
          branch.name,
          [`${productName}: balance ${result.before.balance} → 0`, reason].filter(Boolean).join(' · '),
        );
      }
      res.json({ mode, productId, productName, applied: result.applied, before: result.before, after: result.after });
    } catch (err) {
      if (err instanceof NegativeBalanceError || err instanceof DayClosedError || err instanceof OverdeterminedCorrectionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});
