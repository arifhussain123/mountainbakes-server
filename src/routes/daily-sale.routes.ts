import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  AmendDailySaleRecordSchema,
  BRANCH_ROLES,
  FeedDailySaleRecordSchema,
  GenerateDailySaleRecordSchema,
  SetPaymentMethodLockSchema,
  UnlockDailySaleRecordSchema,
  businessDateStr,
  businessDaysAgoStr,
  isBranchRole,
  type DailySaleAudit,
} from '../shared';
import { resolveAdminName } from '../services/audit.service';
import {
  amendDailySaleRecord,
  decideDailySaleRecord,
  feedDailySaleRecord,
  generateDailySaleRecord,
  getDailySaleRecordDetail,
  getPaymentMethodLocks,
  listDailySaleRecords,
  setPaymentMethodLock,
  type DailySaleActor,
} from '../services/daily-sale.service';
import { rowToApi } from '../utils/case';

const db = dbFor('daily-sale');

/**
 * Daily Sale Record — `/api/daily-sale-records`.
 *
 * ─── Who may open it (§1) ────────────────────────────────────────────────────
 * `super_admin` and the branch manager, who physically counts the drawer.
 *
 * `production_user` and every finance role are absent. Production never handles a
 * branch's till, and Finance reads the same records, read-only, through its own
 * router (finance-daily-sales.routes.ts) — kept apart so that nothing a branch may
 * DO here is ever one role-list edit away from a finance account.
 *
 * ─── What each role may DO is decided per endpoint, not here ─────────────────
 *   feed            branch roles + admin   (locks decided per method, in SQL)
 *   verify          nobody — the 12:30 AM job (daily-sale-verify.job.ts)
 *   lock / unlock   admin only
 *   amend           admin only
 *   set a lock      admin only
 *
 * Verification is not an endpoint: every fed record is verified automatically at
 * 12:30 AM. What stays admin-only is everything that CLOSES a record or CHANGES a
 * signed figure.
 *
 * ─── Nothing here computes money ─────────────────────────────────────────────
 * Every figure comes from Postgres (migration 101). This file resolves whose data
 * the caller is asking about — from the JWT, never from the query string — and
 * hands it on. See daily-sale.service.ts.
 */
export const router = Router();

router.use(authenticate, requireRole('super_admin', ...BRANCH_ROLES));

/**
 * Decide whose records the caller is asking about.
 *
 * A branch role is pinned to its own `branchId` and the `branchId` parameter is
 * DISCARDED, not validated and rejected — rejecting it would still be a channel,
 * telling an attacker which branch ids exist by the difference between a 403 and
 * a 200. Only a super_admin's parameter is read at all; omitting it means every
 * branch consolidated.
 *
 * `isBranchRole` is the shared branch-scoping test (BRANCH_ROLES).
 */
async function resolveScope(
  req: AuthRequest,
  raw?: unknown,
): Promise<{ branchId: string | null; branchName: string | null }> {
  if (isBranchRole(req.user!.role)) {
    // Fail closed, exactly as `authenticate` does for a missing role: a branch
    // account with no branch claim sees nothing rather than everything.
    if (!req.user!.branchId) {
      throw Object.assign(new Error('Your account is not assigned to a branch'), { status: 403 });
    }
    return { branchId: req.user!.branchId, branchName: req.user!.branchName };
  }

  const requested = String(raw ?? '').trim();
  if (!requested) return { branchId: null, branchName: null };

  const { data, error } = await db
    .from('branches')
    .select('id, name')
    .eq('id', requested)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Branch not found'), { status: 404 });
  return { branchId: data.id as string, branchName: data.name as string };
}

/**
 * A branch that a write must name.
 *
 * Different from `resolveScope` in one way that matters: a super admin may READ
 * every branch consolidated, but may not WRITE to "all branches" — these figures
 * reconcile against one physical cash drawer, so a write with no branch is
 * refused rather than applied to the first one found. The same argument
 * branch-closing.routes.ts makes about its export.
 */
async function requireWriteBranch(req: AuthRequest, raw?: unknown): Promise<{ branchId: string; branchName: string | null }> {
  const scope = await resolveScope(req, raw);
  if (!scope.branchId) {
    throw Object.assign(new Error('Name the branch this record belongs to'), { status: 400 });
  }
  return { branchId: scope.branchId, branchName: scope.branchName };
}

/**
 * Who is acting, for the audit trail and for the override decision.
 *
 * `isAdmin` is derived from the verified JWT role, never from the request body —
 * it is the flag the SQL functions use to decide whether a locked payment method
 * may be written to, so a caller that could set it could unlock itself.
 *
 * The display name is resolved rather than the email used, because the history is
 * read by people: "Asif Khan entered Rs. 44,500" is an audit trail and
 * "a1b2@example.com entered Rs. 44,500" is a log line.
 */
async function resolveActor(req: AuthRequest): Promise<DailySaleActor> {
  const user = req.user!;
  return {
    uid: user.uid,
    name: await resolveAdminName(user.uid, user.email),
    role: user.role,
    isAdmin: user.role === 'super_admin',
  };
}

/** The branch a READ of one record is allowed to touch. Null = unscoped (admin). */
function readScope(req: AuthRequest): string | null {
  return isBranchRole(req.user!.role) ? (req.user!.branchId ?? null) : null;
}

// ───────────────────────────────────────────────────────────────────────────
// PREFIX ORDER MATTERS in this file, exactly as it does in routes/index.ts.
// Express matches in registration order, so every LITERAL path is registered
// before the `/:id` family below — otherwise `GET /locks` would be served by
// `GET /:id` as a lookup for a record whose id is the word "locks", and the
// symptom would be a 404 rather than an obvious routing error.
// ───────────────────────────────────────────────────────────────────────────

/**
 * GET /api/daily-sale-records/locks?branchId=
 *
 * Which payment methods this branch may key by hand. Readable by the branch as
 * well as by an admin: the Manual Feed form has to know which inputs to offer,
 * and a form that offered all three and failed on submit would be worse than one
 * that says up front what is locked.
 */
router.get('/locks', async (req: AuthRequest, res, next) => {
  try {
    const { branchId } = await requireWriteBranch(req, req.query['branchId']);
    res.json({ locks: await getPaymentMethodLocks(branchId) });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/daily-sale-records/locks — admin sets one method's lock (§11, §12).
 *
 * Admin-only, and `requireRole` here is the second of two gates: the SQL function
 * does not itself check the role for this one, so this line is the boundary. It is
 * also why `branchId` is required in the schema — an admin has no branch of their
 * own, and a lock applied to "whichever branch" is not a configuration.
 */
router.put('/locks', requireRole('super_admin'), validate(SetPaymentMethodLockSchema), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as { branchId: string; paymentMethod: 'cash' | 'easypaisa' | 'foodpanda' | 'bank_account'; isLocked: boolean; reason?: string };
    const locks = await setPaymentMethodLock({
      branchId: body.branchId,
      paymentMethod: body.paymentMethod,
      isLocked: body.isLocked,
      ...(body.reason ? { reason: body.reason } : {}),
      actor: await resolveActor(req),
    });
    res.json({ locks });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/daily-sale-records/audit?branchId=&days=N
 *
 * A branch's whole history, including the lock changes that belong to no single
 * record. `GET /:id` carries a record's own entries; this is the other half —
 * without it, "Admin unlocked Cash" would be written to the audit table and
 * visible nowhere, because a `method_locked` row has no `record_id` to hang off.
 */
router.get('/audit', async (req: AuthRequest, res, next) => {
  try {
    const { branchId } = await requireWriteBranch(req, req.query['branchId']);

    // Bounded exactly as GET /api/branch-discounts is: the client table is
    // unpaginated, so the window is the only thing keeping it finite.
    const requested = Number(req.query['days'] ?? 30);
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(365, Math.floor(requested))) : 30;

    const { data, error } = await db
      .from('daily_sale_record_audits')
      .select('*')
      .eq('branch_id', branchId)
      .gte('business_date', businessDaysAgoStr(days - 1))
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    const audits = ((data ?? []) as Record<string, unknown>[]).map((a) => rowToApi<DailySaleAudit>(a));
    res.json({ audits, total: audits.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/daily-sale-records/generate — create or refresh one day (§13, §14).
 *
 * Idempotent. The unique key on (branch_id, business_date) plus ON CONFLICT in
 * `ensure_daily_sale_record` is what makes a page refresh, a second tab, a
 * double-clicked button and a retried request all converge on one record instead
 * of racing to insert a second one — which is why this needs no idempotency key
 * and no client-side guard.
 */
router.post('/generate', validate(GenerateDailySaleRecordSchema), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as { businessDate: string; branchId?: string };
    const { branchId } = await requireWriteBranch(req, body.branchId);
    res.json(
      await generateDailySaleRecord({
        branchId,
        businessDate: body.businessDate,
        actor: await resolveActor(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/daily-sale-records/manual-feed — record what was counted (§7, §8).
 *
 * Addressed by branch + business date rather than by record id, on purpose: the
 * record may not exist yet (nobody has opened the day), and making the client
 * generate one first would put a two-call sequence with no transaction around it
 * on the busiest path this feature has. `feed_daily_sale_record` ensures the
 * record, refreshes the auto figures, checks the lock and writes the count — one
 * call, one transaction.
 *
 * The AUTO figures are deliberately not accepted here in any form. A counted
 * figure is the only thing this endpoint takes.
 */
router.put('/manual-feed', validate(FeedDailySaleRecordSchema), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as {
      businessDate: string;
      branchId?: string;
      cash?: number;
      easypaisa?: number;
      bank?: number;
    };
    const { branchId } = await requireWriteBranch(req, body.branchId);
    res.json(
      await feedDailySaleRecord({
        branchId,
        businessDate: body.businessDate,
        ...(body.cash !== undefined ? { cash: body.cash } : {}),
        ...(body.easypaisa !== undefined ? { easypaisa: body.easypaisa } : {}),
        ...(body.bank !== undefined ? { bank: body.bank } : {}),
        actor: await resolveActor(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/daily-sale-records?from=&to=&branchId=
 *
 * Defaults to the last 30 business days ending today. `branchId` is read only for
 * a super_admin; omitting it consolidates every branch, one row per branch per
 * day (never summed across shops — see listDailySaleRecords).
 */
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const today = businessDateStr();
    const scope = await resolveScope(req, req.query['branchId']);
    res.json(
      await listDailySaleRecords({
        from: req.query['from'] ?? businessDaysAgoStr(29),
        to: req.query['to'] ?? today,
        branchId: scope.branchId,
        branchName: scope.branchName,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** GET /api/daily-sale-records/:id — one record, its history, its locks, its branch (§21). */
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    res.json(await getDailySaleRecordDetail(req.params['id']!, readScope(req)));
  } catch (err) {
    next(err);
  }
});

/** PUT /api/daily-sale-records/:id/lock — close the record to the branch. Admin only. */
router.put('/:id/lock', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    res.json(
      await decideDailySaleRecord({
        id: req.params['id']!,
        action: 'lock',
        branchScope: null,
        actor: await resolveActor(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/daily-sale-records/:id/unlock — put a closed record back in play.
 *
 * Admin only, and the reason is mandatory in both places it can be checked: the
 * schema here so the message can name the field, and `decide_daily_sale_record`
 * so no future caller can skip it. §11 requires every unlock to be recorded with
 * its reason, and the reason is the entire audit value of an unlock.
 */
router.put('/:id/unlock', requireRole('super_admin'), validate(UnlockDailySaleRecordSchema), async (req: AuthRequest, res, next) => {
  try {
    res.json(
      await decideDailySaleRecord({
        id: req.params['id']!,
        action: 'unlock',
        reason: (req.body as { reason: string }).reason,
        branchScope: null,
        actor: await resolveActor(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/daily-sale-records/:id/amend — admin corrects a signed-off figure (§16).
 *
 * Only a COUNTED figure can be amended; the schema's enum is what says so and
 * `amend_daily_sale_record` refuses anything else. An auto figure is derived from
 * `orders`, so a wrong one is a wrong sale — corrected by correcting the sale,
 * never by overwriting the reconciliation. §28, as a constraint.
 */
router.put('/:id/amend', requireRole('super_admin'), validate(AmendDailySaleRecordSchema), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as { field: 'manual_cash' | 'manual_easypaisa' | 'manual_bank'; amount: number; reason: string };
    res.json(
      await amendDailySaleRecord({
        id: req.params['id']!,
        field: body.field,
        amount: body.amount,
        reason: body.reason,
        actor: await resolveActor(req),
      }),
    );
  } catch (err) {
    next(err);
  }
});
