import { Router, type NextFunction, type Response } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import { CreditDecisionSchema, PaymentApproveSchema, ReasonSchema } from '../shared';
import * as finance from '../services/purchasing/finance.service';
import { supplierBalances } from '../services/purchasing/suppliers.service';

/**
 * Finance → supplier payments and supplier credit raised from WhatsApp
 * Purchasing. Production records; Finance approves here, and only an
 * approval posts to the book (services/purchasing/finance.service.ts).
 *
 * `view` for the lists and balances, `approve` for every decision — the same
 * split every other finance document uses, so an Accountant sees the queue and
 * a Finance Manager clears it.
 */
export const router = Router();

router.use(authenticate);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actor = (req: AuthRequest) => ({ uid: req.user!.uid, name: req.user!.email });
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const h =
  (fn: (req: AuthRequest) => Promise<unknown>) =>
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.params['id'] !== undefined && !UUID.test(req.params['id'])) {
        res.status(400).json({ error: 'id must be a uuid' });
        return;
      }
      res.json(await fn(req));
    } catch (err) {
      next(err);
    }
  };

router.get('/', requireFinance('view'), h((req) =>
  finance.listPayments({
    status: str(req.query['status']),
    supplierId: str(req.query['supplierId']),
    search: str(req.query['search']),
    limit: Number(req.query['limit'] ?? 50),
    offset: Number(req.query['offset'] ?? 0),
  })));

router.get('/credits', requireFinance('view'), h((req) =>
  finance.listCredits({
    status: str(req.query['status']),
    supplierId: str(req.query['supplierId']),
    limit: Number(req.query['limit'] ?? 50),
    offset: Number(req.query['offset'] ?? 0),
  })));

router.get('/balances', requireFinance('view'), h((req) => supplierBalances(str(req.query['supplierId']))));

router.get('/heads', requireFinance('view'), h(() => finance.expenseHeads()));

router.post('/credits/:id/decision', requireFinance('approve'), validate(CreditDecisionSchema), h((req) =>
  finance.decideCredit(req.params['id']!, req.body, actor(req))));

router.post('/:id/approve', requireFinance('approve'), validate(PaymentApproveSchema), h((req) =>
  finance.approvePayment(req.params['id']!, req.body.ledgerHeadId, actor(req))));

router.post('/:id/reject', requireFinance('approve'), validate(ReasonSchema), h((req) =>
  finance.rejectPayment(req.params['id']!, req.body.reason, actor(req))));

router.post('/:id/reverse', requireFinance('approve'), validate(ReasonSchema), h((req) =>
  finance.reversePayment(req.params['id']!, req.body.reason, actor(req))));
