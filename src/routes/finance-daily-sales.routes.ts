import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { businessDateStr } from '../shared';
import {
  findBranch,
  getFinanceDailySaleDay,
  listFinanceDailySales,
} from '../services/finance-daily-sales.service';

/**
 * /api/finance/daily-sales — the branches' Daily Sale Records, for Finance.
 *
 * Mounted BEFORE the general /api/finance router (see routes/index.ts): Express
 * matches mounts in registration order and `/api/finance` would otherwise
 * swallow the path.
 *
 * Read-only, and `view` on both endpoints: every finance role and super_admin
 * may look, and there is nothing here to approve. Branch and production accounts
 * never match `requireFinance`, so a branch manager cannot use this router to
 * read another shop's day — their own router (daily-sale.routes.ts) pins them to
 * the branch in their token.
 */
export const router = Router();

router.use(authenticate, requireFinance('view'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The branch a query names, checked before it reaches a uuid column. */
function branchParam(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (!UUID_RE.test(value)) throw Object.assign(new Error('branchId is not a valid id'), { status: 400 });
  return value;
}

// GET /api/finance/daily-sales?from=&to=&branchId=
//
// With no dates this is today's business day alone — the day Finance is closing.
// One date given stands for both ends, so "?from=2026-10-01" is that single day
// rather than a window running from it to today.
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const today = businessDateStr();
    const from = req.query['from'] ?? req.query['to'] ?? today;
    const to = req.query['to'] ?? req.query['from'] ?? today;

    const branchId = branchParam(req.query['branchId']);
    const branch = branchId ? await findBranch(branchId) : null;

    res.json(
      await listFinanceDailySales({
        from,
        to,
        branchId: branch?.id ?? null,
        branchName: branch?.name ?? null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/finance/daily-sales/day?branchId=&date=
router.get('/day', async (req: AuthRequest, res, next) => {
  try {
    const branchId = branchParam(req.query['branchId']);
    if (!branchId) throw Object.assign(new Error('Name the branch this day belongs to'), { status: 400 });

    // Checked here so the refusal names the parameter the caller sent: the list
    // read behind this would call the same value "from".
    const date = String(req.query['date'] ?? '').trim();
    if (!DATE_RE.test(date)) {
      throw Object.assign(new Error('date must be a date in YYYY-MM-DD form'), { status: 400 });
    }

    res.json(await getFinanceDailySaleDay(await findBranch(branchId), date));
  } catch (err) {
    next(err);
  }
});
