import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { runDailyClosing, listClosures, currentBusinessDate } from '../services/daily-closing.service';

export const router = Router();

router.use(authenticate);

// GET /api/business-day — the currently-open business date (any authenticated user).
router.get('/', (_req, res) => {
  res.json({ businessDate: currentBusinessDate() });
});

// GET /api/business-day/closures — closing/audit history (Super Admin).
router.get('/closures', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query['days'] ?? 30)));
    const closures = await listClosures(days);
    res.json({ closures, total: closures.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/business-day/close — manually run the closing (Super Admin). Safety net
// for a missed scheduler tick; optional { businessDate } re-runs a specific day.
router.post('/close', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const businessDate = typeof req.body?.businessDate === 'string' ? req.body.businessDate : undefined;
    const result = await runDailyClosing({ trigger: 'manual', actor: req.user!.email, businessDate });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
