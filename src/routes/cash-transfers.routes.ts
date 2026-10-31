import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  BRANCH_ROLES,
  CreateCashTransferSchema,
  ResubmitCashTransferSchema,
  businessDaysAgoStr,
  isBranchRole,
  type CreateCashTransferInput,
  type ResubmitCashTransferInput,
} from '../shared';
import { getDocumentHistory } from '../services/finance-documents.service';
import {
  createCashTransfer,
  getCashTransfer,
  resubmitCashTransfer,
  isCashTransferMethod,
  isCashTransferSortKey,
  isCashTransferStatus,
  listCashTransfers,
} from '../services/cash-transfers.service';
import { getMonthlyCashTransferSummary } from '../services/cash-transfer-summary.service';
import { summaryRangeFromQuery } from '../utils/summaryRange';

/**
 * Branch → cash transfers. The raising half of the feature; Finance's review
 * board is finance-cash-transfers.routes.ts.
 *
 * THE SPLIT IS THE ONE DISCOUNTS USE, for the same reason: this router is
 * mounted behind `requireRole(super_admin, ...BRANCH_ROLES)` and Finance's
 * behind `requireFinance(...)`, so neither file re-checks the caller's side of
 * the transaction in every handler. A branch role asking for
 * /api/finance/cash-transfers gets a 403 from the mount, not a filtered list.
 *
 * NO EDIT, NO WITHDRAW. A transfer is a claim that money moved, evidenced by
 * one photo of one handover; an amount changed under the same photo is not
 * evidence of anything. A wrong submission is rejected by Finance (with a
 * reason the branch sees) and raised again. That is what keeps this file to
 * three routes.
 */
export const router = Router();

router.use(authenticate, requireRole('super_admin', ...BRANCH_ROLES));

/**
 * The branch this request acts on — pinned to the JWT for a branch role, the
 * `branchId` query parameter for an admin. Verbatim from branch-discounts.
 */
function scopeBranch(req: AuthRequest): string | null {
  return isBranchRole(req.user!.role)
    ? req.user!.branchId
    : ((req.query['branchId'] as string | undefined) ?? null);
}

// GET /api/cash-transfers?days=N&from=&to=&status=&paymentMethod=&search=&sortBy=&sortDir=&limit=&offset=
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const branchId = scopeBranch(req);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

    const requested = Number(req.query['days'] ?? 90);
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(365, Math.floor(requested))) : 90;
    const limit = Math.min(Math.max(Number(req.query['limit'] ?? 50), 1), 200);
    const offset = Math.max(Number(req.query['offset'] ?? 0), 0);
    const from = (req.query['from'] as string | undefined) || businessDaysAgoStr(days - 1);
    const to = (req.query['to'] as string | undefined) || undefined;
    const status = req.query['status'];
    const paymentMethod = req.query['paymentMethod'];
    const sortBy = req.query['sortBy'];

    const result = await listCashTransfers({
      branchId,
      from,
      to,
      status: isCashTransferStatus(status) ? status : undefined,
      paymentMethod: isCashTransferMethod(paymentMethod) ? paymentMethod : undefined,
      search: (req.query['search'] as string | undefined)?.trim() || undefined,
      sortBy: isCashTransferSortKey(sortBy) ? sortBy : undefined,
      sortDir: req.query['sortDir'] === 'asc' ? 'asc' : 'desc',
      limit,
      offset,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/cash-transfers/monthly-summary?from=&to= — this branch's transfers,
// this business month to date (1st → today) by default, or the page's Date
// filter range when `from`/`to` are sent, per channel, status and fuel. Same
// branch rule as the list: a branch role is pinned to its token's branch (a
// `branchId` it sends is ignored), super_admin names one. Every other list
// filter (status, channel, search) is ignored by design. Registered before `/:id`, which would otherwise take it.
router.get('/monthly-summary', async (req: AuthRequest, res, next) => {
  try {
    const branchId = scopeBranch(req);
    if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }
    if (!UUID_RE.test(branchId)) { res.status(400).json({ error: 'branchId must be a uuid' }); return; }
    const window = summaryRangeFromQuery(req.query);
    if (!window.ok) { res.status(400).json({ error: window.error }); return; }
    res.json(await getMonthlyCashTransferSummary({ branchId, range: window.range }));
  } catch (err) {
    next(err);
  }
});

// GET /api/cash-transfers/:id — one of this branch's transfers, with its photo.
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const branchId = scopeBranch(req);
    const transfer = await getCashTransfer(String(req.params['id']), branchId);
    if (!transfer) { res.status(404).json({ error: 'Cash transfer not found' }); return; }
    res.json(transfer);
  } catch (err) {
    next(err);
  }
});

// POST /api/cash-transfers — record a handover. Idempotent under the client's
// `Idempotency-Key` (the mobile app's client_operation_id), so a retry after a
// dropped connection replays the first response rather than booking twice.
router.post(
  '/',
  idempotent('cash_transfer.create'),
  validate(CreateCashTransferSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const branchId = scopeBranch(req);
      if (!branchId) { res.status(400).json({ error: 'Branch context required' }); return; }

      const transfer = await createCashTransfer({
        branchId,
        role: req.user!.role,
        actor: { uid: req.user!.uid, email: req.user!.email },
        body: req.body as CreateCashTransferInput,
      });
      res.status(201).json(transfer);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/cash-transfers/:id/history — the deposit's submissions, rejections
// and approval, oldest first. Scoped like the read: a branch sees its own only.
router.get('/:id/history', async (req: AuthRequest, res, next) => {
  try {
    const id = String(req.params['id']);
    if (!(await getCashTransfer(id, scopeBranch(req)))) { res.status(404).json({ error: 'Cash transfer not found' }); return; }
    res.json({ events: await getDocumentHistory('cash_transfer', id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/cash-transfers/:id/resubmit — correct a REJECTED deposit and send
// the same CT- back to Finance. The branch and the date stay as they were.
router.post(
  '/:id/resubmit',
  idempotent('cash_transfer.resubmit'),
  validate(ResubmitCashTransferSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const transfer = await resubmitCashTransfer({
        id: String(req.params['id']),
        // A branch manager can only reach its own branch's deposit; the SQL
        // refuses another branch's id as not found.
        branchId: isBranchRole(req.user!.role) ? req.user!.branchId : null,
        actor: { uid: req.user!.uid, email: req.user!.email },
        body: req.body as ResubmitCashTransferInput,
      });
      res.json(transfer);
    } catch (err) {
      next(err);
    }
  },
);
