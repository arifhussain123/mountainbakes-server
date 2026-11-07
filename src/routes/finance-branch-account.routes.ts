import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  BranchAccountStartSchema,
  PostBranchAccountAdjustmentSchema,
  ReverseBranchAccountAdjustmentSchema,
} from '../shared';
import {
  getDemandRecord,
  getDemandRecordDetail,
  getLedgerStart,
  getMonthStatement,
  listAdjustments,
  postAdjustment,
  reverseAdjustment,
  setLedgerStart,
} from '../services/branch-account.service';
import { auditSnapshot, logFinanceAudit } from '../services/finance-audit.service';

/**
 * /api/finance/branch-account — the Demand Record: each branch's running
 * balance with the company, demand by demand. See branch-account.service.ts.
 *
 * Finance roles only, like the rest of /api/finance: viewing needs `view`,
 * Finance's own entries need `approve` (they move what a branch owes with no
 * second step), and the go-live date needs `configure`. Branch and Production
 * users hold no finance permission, so they cannot read any branch's account.
 */

export const router = Router();

router.use(authenticate);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(req: AuthRequest): { uid: string; name: string } {
  return { uid: req.user!.uid, name: req.user!.email };
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function optionalUuid(v: unknown, name: string): string | null {
  if (v === undefined || v === '' || v === 'all') return null;
  if (typeof v !== 'string' || !UUID.test(v)) throw badRequest(`${name} must be a UUID`);
  return v;
}

function optionalDate(v: unknown, name: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !DATE.test(v)) throw badRequest(`${name} must be YYYY-MM-DD`);
  return v;
}

router.get('/settings', requireFinance('view'), async (_req, res, next) => {
  try {
    res.json({ startDate: await getLedgerStart() });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', requireFinance('configure'), validate(BranchAccountStartSchema), async (req: AuthRequest, res, next) => {
  try {
    const result = await setLedgerStart(req.body.startDate);
    await logFinanceAudit(req, {
      entity: 'branch_account',
      action: 'updated',
      entityRef: 'go-live date',
      previousValues: { startDate: result.previous },
      newValues: { startDate: result.start, sharePctFrozenForDemands: result.frozen },
    });
    res.json({ startDate: result.start, frozen: result.frozen });
  } catch (err) {
    next(err);
  }
});

// GET /?branchId=&from=&to=&search=&sortDir=asc|desc&page=&pageSize=
router.get('/', requireFinance('view'), async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json(await getDemandRecord({
      branchId: optionalUuid(q['branchId'], 'branchId'),
      from: optionalDate(q['from'], 'from'),
      to: optionalDate(q['to'], 'to'),
      search: q['search'],
      sortDir: q['sortDir'] === 'asc' ? 'asc' : 'desc',
      page: q['page'] ? Number(q['page']) : undefined,
      pageSize: q['pageSize'] ? Number(q['pageSize']) : undefined,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /statement?month=YYYY-MM&branchId=  (no branchId: every active branch)
router.get('/statement', requireFinance('view'), async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json(await getMonthStatement(q['month'] ?? '', optionalUuid(q['branchId'], 'branchId')));
  } catch (err) {
    next(err);
  }
});

// GET /detail?branchId=&orderId=  (no orderId: the branch's opening row)
router.get('/detail', requireFinance('view'), async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const branchId = optionalUuid(q['branchId'], 'branchId');
    if (!branchId) throw badRequest('branchId is required');
    res.json(await getDemandRecordDetail(branchId, optionalUuid(q['orderId'], 'orderId')));
  } catch (err) {
    next(err);
  }
});

router.get('/adjustments', requireFinance('view'), async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json({ adjustments: await listAdjustments(optionalUuid(q['branchId'], 'branchId')) });
  } catch (err) {
    next(err);
  }
});

router.post('/adjustments', requireFinance('approve'), validate(PostBranchAccountAdjustmentSchema), async (req: AuthRequest, res, next) => {
  try {
    const { entry, replayed } = await postAdjustment(req.body, actorOf(req));
    if (!replayed) {
      await logFinanceAudit(req, {
        entity: 'branch_account',
        entityId: entry.id,
        entityRef: `${entry.branchName} ${entry.kind}`,
        action: 'created',
        newValues: auditSnapshot(entry as unknown as Record<string, unknown>, [
          'branchName', 'kind', 'amount', 'businessDate', 'reason',
        ]),
      });
    }
    res.status(replayed ? 200 : 201).json({ entry, replayed });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/adjustments/:id/reverse',
  requireFinance('approve'),
  validate(ReverseBranchAccountAdjustmentSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = optionalUuid(req.params['id'], 'id');
      if (!id) throw badRequest('id is required');
      const { entry, replayed } = await reverseAdjustment(id, req.body, actorOf(req));
      if (!replayed) {
        await logFinanceAudit(req, {
          entity: 'branch_account',
          entityId: entry.id,
          entityRef: `${entry.branchName} reversal`,
          action: 'reversed',
          previousValues: { reversedEntryId: id },
          newValues: auditSnapshot(entry as unknown as Record<string, unknown>, ['branchName', 'amount', 'reason']),
        });
      }
      res.status(replayed ? 200 : 201).json({ entry, replayed });
    } catch (err) {
      next(err);
    }
  },
);
