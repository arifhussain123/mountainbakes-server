import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate';
import { BillInputSchema, QuotationInputSchema } from '../shared';
import { PortalError, resolveToken, submitBill, submitQuotation, view } from '../services/purchasing/portal.service';

/**
 * The supplier portal API — the one part of WhatsApp Purchasing with no
 * Mountain Bakes session. The supplier link's token is sent in the
 * `X-Supplier-Token` header (the web page reads it from the URL fragment, so
 * it never appears in a request line or a server log) and authorizes one
 * demand, read and write, while that demand is in a state that allows it.
 *
 * Rate limited per LINK on top of the app-wide limiter: a token is 256
 * random bits, so guessing is hopeless, but a broken client hammering the
 * endpoint should not be able to load the database either. Not per address:
 * the app does not set `trust proxy`, so behind the host's router every
 * supplier shares one req.ip, and one busy supplier would lock out the rest.
 */
export const router = Router();

router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    // The hash, so the limiter's store never holds a usable token.
    keyGenerator: (req) => {
      const token = req.get('x-supplier-token');
      return token ? `link:${createHash('sha256').update(token).digest('hex')}` : `ip:${req.ip ?? ''}`;
    },
    message: { error: 'Too many requests. Wait a few minutes and try again.' },
  }),
);

// Supplier pages must not be cached anywhere between the API and the phone.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

type Handler = (scope: { demandId: string; expiresAt: string }, req: Request, res: Response) => Promise<unknown>;
const withToken =
  (fn: Handler) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const scope = await resolveToken(req.get('x-supplier-token') ?? undefined);
      res.json(await fn(scope, req, res));
    } catch (err) {
      if (err instanceof PortalError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  };

// GET /api/supplier-portal/demand — the demand this link is for.
router.get('/demand', withToken((s) => view(s.demandId, s.expiresAt)));

// POST /api/supplier-portal/quotation — a new quotation version.
router.post('/quotation', validate(QuotationInputSchema), withToken(async (s, req) => {
  const result = await submitQuotation(s.demandId, req.body);
  return { ...result, demand: await view(s.demandId, s.expiresAt) };
}));

// POST /api/supplier-portal/bill — the final bill against the approved quotation.
router.post('/bill', validate(BillInputSchema), withToken(async (s, req) => {
  const result = await submitBill(s.demandId, req.body);
  return { ...result, demand: await view(s.demandId, s.expiresAt) };
}));
