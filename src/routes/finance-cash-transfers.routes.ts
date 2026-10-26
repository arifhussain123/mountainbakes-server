import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  ApproveCashTransferSchema,
  RejectCashTransferSchema,
  businessDaysAgoStr,
} from '../shared';
import {
  approveCashTransfer,
  getCashTransfer,
  isCashTransferMethod,
  isCashTransferSortKey,
  isCashTransferStatus,
  listCashTransfers,
  rejectCashTransfer,
  summarizeCashTransfers,
  type CashTransferFilters,
} from '../services/cash-transfers.service';
import { logFinanceAudit } from '../services/finance-audit.service';
import { getMissingDailyTransfers } from '../services/cash-transfer-missing.service';

/**
 * /api/finance/cash-transfers — Finance's review board for branch handovers.
 *
 * Mounted BEFORE the general /api/finance router (see routes/index.ts): Express
 * matches mounts in registration order and `/api/finance` would otherwise
 * swallow the path.
 *
 * `requireFinance('approve')` on the two decisions is the same gate every other
 * finance document uses: finance_admin and finance_manager, and super_admin
 * only when the Finance Settings toggle allows it. Viewing is `view`, which
 * every finance role and super_admin hold.
 */
export const router = Router();

router.use(authenticate);

const actorOf = (req: AuthRequest) => ({ uid: req.user!.uid, name: req.user!.email });

/**
 * The board's filters from the query string, read once for the list and its
 * summary so the figures above the table always describe the table's rows.
 */
function filtersFrom(q: Record<string, string | undefined>): CashTransferFilters {
  // A pending queue is asked for whole — Finance must not miss a handover
  // because it was submitted 31 days ago — so the rolling default applies
  // only when no status is chosen. An explicit range always wins.
  const from = q['from'] || (isCashTransferStatus(q['status']) && q['status'] === 'pending' ? undefined : businessDaysAgoStr(29));

  return {
    branchId: q['branchId'] || undefined,
    from,
    to: q['to'] || undefined,
    status: isCashTransferStatus(q['status']) ? q['status'] : undefined,
    paymentMethod: isCashTransferMethod(q['paymentMethod']) ? q['paymentMethod'] : undefined,
    search: q['search']?.trim() || undefined,
  };
}

// GET /api/finance/cash-transfers?from=&to=&branchId=&status=&paymentMethod=&search=&sortBy=&sortDir=&limit=&offset=
router.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q['limit'] ?? 50), 1), 200);
    const offset = Math.max(Number(q['offset'] ?? 0), 0);

    res.json(
      await listCashTransfers({
        ...filtersFrom(q),
        sortBy: isCashTransferSortKey(q['sortBy']) ? q['sortBy'] : undefined,
        sortDir: q['sortDir'] === 'asc' ? 'asc' : 'desc',
        limit,
        offset,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/finance/cash-transfers/summary?from=&to=&branchId=&status=&paymentMethod=&search=
// The list's filters and defaults, summed over every matching row. Registered
// before /:id, which would otherwise take "summary" for an id.
router.get('/summary', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json(await summarizeCashTransfers(filtersFrom(req.query as Record<string, string | undefined>)));
  } catch (err) {
    next(err);
  }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/finance/cash-transfers/missing?from=&to=&branchId=
// Which active branches have not handed over each due business date. The
// window defaults to the last seven due dates and never reaches today (see
// cash-transfer-missing.service.ts). Registered before /:id.
router.get('/missing', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = q['from'] || undefined;
    const to = q['to'] || undefined;
    const branchId = q['branchId'] || null;
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to)) || (from && to && from > to)) {
      res.status(400).json({ error: 'from/to must be dates, from not after to' });
      return;
    }
    if (branchId && !UUID_RE.test(branchId)) {
      res.status(400).json({ error: 'Unknown branch' });
      return;
    }
    res.json(await getMissingDailyTransfers({ from, to, branchId }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const transfer = await getCashTransfer(String(req.params['id']));
    if (!transfer) { res.status(404).json({ error: 'Cash transfer not found' }); return; }
    res.json(transfer);
  } catch (err) {
    next(err);
  }
});

/**
 * The moment a handover enters the book: one RV- receipt under INC-BRANCH-CASH
 * for the Total (migration 123) and, for fuel charges, one under INC-FUEL.
 */
router.put(
  '/:id/approve',
  requireFinance('approve'),
  validate(ApproveCashTransferSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { transfer, ledgerEntry } = await approveCashTransfer(
        String(req.params['id']),
        actorOf(req),
        (req.body as { note?: string }).note,
      );
      await logFinanceAudit(req, {
        entity: 'cash_transfer',
        entityId: transfer.id,
        entityRef: transfer.transferNo,
        action: 'approved',
        previousValues: { status: 'pending' },
        newValues: {
          status: transfer.status,
          amount: transfer.amount,
          cashAmount: transfer.cashAmount,
          easypaisaAmount: transfer.easypaisaAmount,
          bankAmount: transfer.bankAmount,
          fuelCharges: transfer.fuelCharges,
          branchName: transfer.branchName,
          voucherNo: transfer.voucherNo,
          ledgerEntryId: transfer.ledgerEntryId,
          entryDate: ledgerEntry?.entryDate ?? null,
        },
      });
      res.json({ transfer, ledgerEntry });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/:id/reject',
  requireFinance('approve'),
  validate(RejectCashTransferSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const reason = (req.body as { reason: string }).reason;
      const transfer = await rejectCashTransfer(String(req.params['id']), actorOf(req), reason);
      await logFinanceAudit(req, {
        entity: 'cash_transfer',
        entityId: transfer.id,
        entityRef: transfer.transferNo,
        action: 'rejected',
        previousValues: { status: 'pending' },
        newValues: { status: transfer.status, reason, amount: transfer.amount, branchName: transfer.branchName },
      });
      res.json({ transfer });
    } catch (err) {
      next(err);
    }
  },
);
