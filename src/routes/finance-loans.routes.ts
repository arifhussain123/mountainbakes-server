import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  CancelLoanEntrySchema,
  CreateLoanClientSchema,
  CreateLoanEntrySchema,
  LoanLedgerQuerySchema,
  SetLoanClientStatusSchema,
  UpdateLoanClientSchema,
} from '../shared';
import { logFinanceAudit } from '../services/finance-audit.service';
import {
  cancelLoanEntry,
  createLoanClient,
  getLoanClientDetail,
  getLoanEntry,
  getLoanLedger,
  listLoanClients,
  postLoanEntry,
  setLoanClientActive,
  updateLoanClient,
} from '../services/finance-loans.service';

/**
 * /api/finance/loans — Refundable & Receivable Loans. See finance-loans.service.ts.
 *
 * Finance roles only, like the rest of /api/finance:
 *   read anything                  view
 *   add / edit a client            create
 *   post an entry                  create   (posts at once — no approval step)
 *   (de)activate a client          adjust
 *   cancel a posted entry          adjust   (with a reason; the row is kept)
 */

export const router = Router();

router.use(authenticate);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(req: AuthRequest): { uid: string; name: string } {
  return { uid: req.user!.uid, name: req.user!.email };
}

function idParam(req: AuthRequest): string {
  const id = req.params['id'] ?? '';
  if (!UUID.test(id)) throw Object.assign(new Error('id must be a UUID'), { status: 400 });
  return id;
}

// ── Clients ─────────────────────────────────────────────────────────────────

router.get('/clients', requireFinance('view'), async (_req, res, next) => {
  try {
    res.json({ clients: await listLoanClients() });
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json(await getLoanClientDetail(idParam(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/clients', requireFinance('create'), validate(CreateLoanClientSchema), async (req: AuthRequest, res, next) => {
  try {
    const client = await createLoanClient(req.body, actorOf(req));
    await logFinanceAudit(req, {
      entity: 'loan_client',
      entityId: client.id,
      entityRef: client.clientCode,
      action: 'created',
      newValues: { ...client },
    });
    res.status(201).json({ client });
  } catch (err) {
    next(err);
  }
});

router.put('/clients/:id', requireFinance('create'), validate(UpdateLoanClientSchema), async (req: AuthRequest, res, next) => {
  try {
    const { before, after } = await updateLoanClient(idParam(req), req.body, actorOf(req));
    await logFinanceAudit(req, {
      entity: 'loan_client',
      entityId: after.id,
      entityRef: after.clientCode,
      action: 'updated',
      previousValues: { ...before },
      newValues: { ...after },
    });
    res.json({ client: after });
  } catch (err) {
    next(err);
  }
});

router.put('/clients/:id/status', requireFinance('adjust'), validate(SetLoanClientStatusSchema), async (req: AuthRequest, res, next) => {
  try {
    const client = await setLoanClientActive(idParam(req), req.body.isActive, actorOf(req));
    await logFinanceAudit(req, {
      entity: 'loan_client',
      entityId: client.id,
      entityRef: client.clientCode,
      action: 'updated',
      previousValues: { isActive: !client.isActive },
      newValues: { isActive: client.isActive },
    });
    res.json({ client });
  } catch (err) {
    next(err);
  }
});

// ── Ledger ──────────────────────────────────────────────────────────────────

router.get('/ledger', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = LoanLedgerQuerySchema.parse(req.query);
    res.json(await getLoanLedger(q));
  } catch (err) {
    next(err);
  }
});

router.get('/entries/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json({ entry: await getLoanEntry(idParam(req)) });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/entries',
  requireFinance('create'),
  idempotent('finance_loan.create'),
  validate(CreateLoanEntrySchema),
  async (req: AuthRequest, res, next) => {
    try {
      const entry = await postLoanEntry(req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'loan_entry',
        entityId: entry.id,
        entityRef: entry.voucherNo,
        action: 'posted',
        newValues: {
          entryType: entry.entryType,
          clientCode: entry.clientCode,
          clientName: entry.clientName,
          ledgerHeadName: entry.ledgerHeadName,
          businessDate: entry.businessDate,
          debit: entry.debit,
          credit: entry.credit,
          paymentMethod: entry.paymentMethod,
          branchName: entry.branchName,
          description: entry.description,
        },
      });
      res.status(201).json({ entry });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/entries/:id/cancel', requireFinance('adjust'), validate(CancelLoanEntrySchema), async (req: AuthRequest, res, next) => {
  try {
    const entry = await cancelLoanEntry(idParam(req), req.body.reason, actorOf(req));
    await logFinanceAudit(req, {
      entity: 'loan_entry',
      entityId: entry.id,
      entityRef: entry.voucherNo,
      action: 'reversed',
      previousValues: { status: 'posted', debit: entry.debit, credit: entry.credit },
      newValues: { status: entry.status, reason: entry.cancelReason },
    });
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});
