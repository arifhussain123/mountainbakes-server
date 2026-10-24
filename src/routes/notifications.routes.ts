import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  MARK_READ_MAX,
  getNotificationFeed,
  markNotificationsRead,
} from '../services/notification-feed.service';

export const router = Router();

router.use(authenticate);

/**
 * The feed is POLLED by every open tab, so it is the one read in the API whose
 * volume is set by a timer rather than by somebody doing something.
 *
 * That is why app.ts leaves it out of the app-wide limiter and it carries this
 * one instead. The app-wide limiter keys on `req.ip`, which without `trust
 * proxy` is the hosting proxy's address, shared by unrelated users — a handful of
 * idle tabs polling would spend the allowance that real work needs. Keyed on
 * the authenticated user, a runaway client can only ever throttle itself.
 *
 * 240 per 15 minutes is one poll every 30 seconds from eight tabs.
 */
const feedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).user?.uid ?? 'unknown',
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many notification requests' },
});

const MarkReadSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MARK_READ_MAX),
});

function reader(req: AuthRequest) {
  const { uid, role, branchId } = req.user!;
  return { uid, role, branchId };
}

// GET /api/notifications — the caller's recent notifications and which of them
// they have read. Personal notifications plus broadcasts to their role/branch.
router.get('/', feedLimiter, async (req: AuthRequest, res, next) => {
  try {
    res.json(await getNotificationFeed(reader(req)));
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read — mark notifications read for the caller only.
router.post('/read', validate(MarkReadSchema), async (req: AuthRequest, res, next) => {
  try {
    const readIds = await markNotificationsRead(reader(req), req.body.ids);
    res.json({ readIds });
  } catch (err) {
    next(err);
  }
});
