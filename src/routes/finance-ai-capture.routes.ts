import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import { AnalyzeReceiptsSchema } from '../shared';
import { analyzeReceipts, copyReceiptPhoto } from '../services/ai-expense-capture.service';

/**
 * AI Expense Capture (services/ai-expense-capture.service.ts). Mounted at
 * /api/finance/ai-capture, ahead of the general /api/finance router.
 *
 * Both routes need Finance `create` — the permission that saves an entry —
 * because their only use is preparing entries. Neither writes one: proposals
 * are saved through POST /api/finance/income/entries like any other entry.
 */
export const router = Router();
router.use(authenticate);

// Each run is a paid call to Gemini with up to ten photos. Far above what
// anyone entering receipts needs; low enough that a stuck retry loop cannot
// run up a bill.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).user?.uid ?? 'anonymous',
  message: { error: 'Too many receipt readings in the last hour. Please wait a little and try again.' },
});

router.post(
  '/analyze',
  requireFinance('create'),
  analyzeLimiter,
  validate(AnalyzeReceiptsSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const result = await analyzeReceipts({
        attachmentIds: req.body.attachmentIds,
        actor: { uid: req.user!.uid, email: req.user!.email },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post('/photos/:id/copy', requireFinance('create'), async (req: AuthRequest, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params['id'] ?? '')) {
      res.status(400).json({ error: 'Invalid photo id' });
      return;
    }
    const attachment = await copyReceiptPhoto({
      id: req.params['id']!,
      actor: { uid: req.user!.uid, email: req.user!.email },
    });
    res.status(201).json({ attachment });
  } catch (err) {
    next(err);
  }
});
