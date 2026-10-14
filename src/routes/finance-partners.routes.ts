import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  ApproveSchema,
  CreatePartnerExpenseSchema,
  PartnerLedgerQuerySchema,
  PartnerLedgerTransactionsQuerySchema,
  RejectSchema,
  UpdateFinancePartnerSchema,
  UpdatePartnerExpenseSchema,
  type FinanceDocStatus,
} from '../shared';
import {
  approvePartnerExpense,
  createPartnerExpense,
  getPartnerExpense,
  getPartnerShareSummary,
  listFinancePartners,
  listPartnerExpenses,
  rejectPartnerExpense,
  submitPartnerExpense,
  updateFinancePartner,
  updatePartnerExpense,
  type PartnerExpenseQuery,
} from '../services/finance-documents.service';
import { auditSnapshot, logFinanceAudit } from '../services/finance-audit.service';
import { getPartnerLedger, getPartnerLedgerTransactions } from '../services/finance-ledgers.service';

/**
 * /api/finance/partner-expenses — money paid out to the partners.
 *
 * Its own prefix rather than a filter over the manual-entry route, because the
 * brief asks for a dedicated section and the fields genuinely differ (a partner
 * name and a requester, no branch). The approval rules are identical, and the
 * shared machinery in finance-documents.service is what guarantees they stay so.
 */

export const router = Router();

router.use(authenticate);

function actorOf(req: AuthRequest): { uid: string; name: string } {
  return { uid: req.user!.uid, name: req.user!.email };
}

// ---------------------------------------------------------------------------
// Partners — the fixed four, and the Partner Share Detail report
// ---------------------------------------------------------------------------

router.get('/partners', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const partners = await listFinancePartners(req.query['includeInactive'] === 'true');
    res.json({ partners, total: partners.length });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/partners/:id',
  requireFinance('configure'),
  validate(UpdateFinancePartnerSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const partner = await updateFinancePartner(id, req.body);
      await logFinanceAudit(req, {
        entity: 'finance_partner',
        entityId: partner.id,
        entityRef: partner.name,
        action: 'updated',
        newValues: auditSnapshot(partner as unknown as Record<string, unknown>, [
          'fatherName', 'dateOfBirth', 'joinedOn', 'partnerType', 'address', 'contactNumber', 'emergencyNumber',
        ]),
      });
      res.json({ partner });
    } catch (err) {
      next(err);
    }
  },
);

router.get('/share-summary', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const summary = await getPartnerShareSummary(q['from'], q['to']);
    res.json({ summary });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Company Transaction Details — the read-only year ledger
//
// GET only, and registered ahead of the `/:id` routes below so that "ledger" is
// never read as a document id. Nothing under /ledger accepts a write: a figure
// changes only when a partner advance or draw is approved or corrected through
// the routes further down.
// ---------------------------------------------------------------------------

/** GET /api/finance/partner-expenses/ledger?year= — partner × month, approved only. */
router.get('/ledger', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json({ ledger: await getPartnerLedger(PartnerLedgerQuerySchema.parse(req.query)) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/finance/partner-expenses/ledger/transactions — the records behind a cell, a partner or a year. */
router.get('/ledger/transactions', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json(await getPartnerLedgerTransactions(PartnerLedgerTransactionsQuerySchema.parse(req.query)));
  } catch (err) {
    next(err);
  }
});

/**
 * Anything else aimed at the ledger — a POST, a PUT, a DELETE — is refused by
 * name rather than left to fall through to whichever route happens to match.
 */
router.all(['/ledger', '/ledger/*'], (_req, res) => {
  res.set('Allow', 'GET').status(405).json({
    error: 'This ledger is read-only. Create and approve records through their own page.',
  });
});

// ---------------------------------------------------------------------------
// Partner advances / draws
// ---------------------------------------------------------------------------

router.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const { expenses, total } = await listPartnerExpenses({
      status: (q['status'] as FinanceDocStatus | 'pending') || undefined,
      partnerId: q['partnerId'],
      partnerName: q['partnerName'],
      txnKind: q['txnKind'] as 'advance' | 'draw' | undefined,
      from: q['from'],
      to: q['to'],
      search: q['search'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
      sortBy: q['sortBy'] as PartnerExpenseQuery['sortBy'],
      sortDir: q['sortDir'] as PartnerExpenseQuery['sortDir'],
    });
    res.json({ expenses, total });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  requireFinance('create'),
  validate(CreatePartnerExpenseSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const expense = await createPartnerExpense(req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'partner_expense',
        entityId: expense.id,
        entityRef: expense.expenseNo,
        action: 'created',
        newValues: auditSnapshot(expense as unknown as Record<string, unknown>, [
          'partnerName', 'txnKind', 'description', 'amount', 'paymentMethod', 'businessDate', 'status',
        ]),
      });
      res.status(201).json({ expense });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/:id',
  requireFinance('create'),
  validate(UpdatePartnerExpenseSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = await getPartnerExpense(id);
      const expense = await updatePartnerExpense(id, req.body);

      await logFinanceAudit(req, {
        entity: 'partner_expense',
        entityId: id,
        entityRef: expense.expenseNo,
        action: 'updated',
        previousValues: before
          ? auditSnapshot(before as unknown as Record<string, unknown>, ['partnerName', 'txnKind', 'amount', 'status'])
          : null,
        newValues: auditSnapshot(expense as unknown as Record<string, unknown>, ['partnerName', 'txnKind', 'amount', 'status']),
      });

      res.json({ expense });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/:id/submit', requireFinance('create'), async (req: AuthRequest, res, next) => {
  try {
    const expense = await submitPartnerExpense(String(req.params['id']));
    await logFinanceAudit(req, {
      entity: 'partner_expense',
      entityId: expense.id,
      entityRef: expense.expenseNo,
      action: 'submitted',
      newValues: { amount: expense.amount, status: expense.status },
    });
    res.json({ expense });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/approve',
  requireFinance('approve'),
  validate(ApproveSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { document, entry } = await approvePartnerExpense(String(req.params['id']), actorOf(req), req.body.notes);
      await logFinanceAudit(req, {
        entity: 'partner_expense',
        entityId: document.id,
        entityRef: document.expenseNo,
        action: 'approved',
        newValues: { partnerName: document.partnerName, amount: document.amount, voucherNo: entry.voucherNo },
      });
      res.json({ expense: document, ledgerEntry: entry });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/reject',
  requireFinance('approve'),
  validate(RejectSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const expense = await rejectPartnerExpense(String(req.params['id']), req.body.reason, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'partner_expense',
        entityId: expense.id,
        entityRef: expense.expenseNo,
        action: 'rejected',
        newValues: { reason: req.body.reason, partnerName: expense.partnerName, amount: expense.amount },
      });
      res.json({ expense });
    } catch (err) {
      next(err);
    }
  },
);
