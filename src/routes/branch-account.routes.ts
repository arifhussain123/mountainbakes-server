import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { BRANCH_ROLES } from '../shared';
import { getDemandRecord, getDemandRecordDetail, getLedgerStart, getMonthStatement } from '../services/branch-account.service';

/**
 * /api/branch-account — a branch's OWN Demand Record, read-only. The same rows
 * Finance sees at /api/finance/branch-account (branch-account.service.ts), so
 * the branch and Finance can never disagree on a balance.
 *
 * The branch comes from the token, never the query: a branch account reads its
 * own record and nothing else. A demand of another branch is not in this
 * branch's rows, so its detail answers 404. Opening balances and adjustments
 * stay Finance's to enter (the finance router).
 */

export const router = Router();

router.use(authenticate, requireRole(...BRANCH_ROLES));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function optionalDate(v: unknown, name: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !DATE.test(v)) throw badRequest(`${name} must be YYYY-MM-DD`);
  return v;
}

function ownBranch(req: AuthRequest): string {
  const branchId = req.user!.branchId;
  if (!branchId) throw badRequest('Branch context required');
  return branchId;
}

router.get('/settings', async (_req, res, next) => {
  try {
    res.json({ startDate: await getLedgerStart() });
  } catch (err) {
    next(err);
  }
});

// GET /?from=&to=&search=&sortDir=asc|desc&page=&pageSize=
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json(await getDemandRecord({
      branchId: ownBranch(req),
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

// GET /statement?month=YYYY-MM — the branch's own month-end statement
router.get('/statement', async (req: AuthRequest, res, next) => {
  try {
    const month = typeof req.query['month'] === 'string' ? req.query['month'] : '';
    res.json(await getMonthStatement(month, ownBranch(req)));
  } catch (err) {
    next(err);
  }
});

// GET /detail?orderId=  (no orderId: the branch's opening row)
router.get('/detail', async (req: AuthRequest, res, next) => {
  try {
    const orderId = req.query['orderId'];
    if (orderId !== undefined && orderId !== '' && (typeof orderId !== 'string' || !UUID.test(orderId))) {
      throw badRequest('orderId must be a UUID');
    }
    res.json(await getDemandRecordDetail(ownBranch(req), orderId ? (orderId as string) : null));
  } catch (err) {
    next(err);
  }
});
