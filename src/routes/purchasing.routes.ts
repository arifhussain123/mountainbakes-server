import { Router, type NextFunction, type Response } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  BillDecisionSchema,
  BillInputSchema,
  CreditInputSchema,
  DeliveryInputSchema,
  DemandInputSchema,
  DemandUpdateSchema,
  IngredientAdjustSchema,
  MessageReplySchema,
  MessageReviewSchema,
  NoteSchema,
  PURCHASE_BUCKETS,
  PaymentInputSchema,
  PurchaseItemInputSchema,
  QuotationDecisionSchema,
  QuotationInputSchema,
  ReasonSchema,
  ReceiptInputSchema,
  RevisionSchema,
  SupplierInputSchema,
  businessDateStr,
  type PurchaseBucket,
} from '../shared';
import type { Actor } from '../services/purchasing/common';
import * as demands from '../services/purchasing/demands.service';
import * as suppliers from '../services/purchasing/suppliers.service';
import * as conversations from '../services/purchasing/conversations.service';

/**
 * WhatsApp Purchasing — Production's control center.
 *
 * Production users run it; Super Admin may too. Branch and Finance roles get a
 * 403 from the mount: Finance's part (approving supplier payments and credit)
 * is /api/finance/supplier-payments, behind requireFinance.
 *
 * Every state change below is one database function that re-checks the
 * demand's state under its row lock, so a button that a stale screen still
 * shows is refused with a 409 and a sentence, never applied twice.
 */
export const router = Router();

router.use(authenticate, requireRole('production_user', 'super_admin'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actor = (req: AuthRequest): Actor => ({ uid: req.user!.uid, name: req.user!.email });
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const int = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
/** Wrap a handler: id params checked, errors to the error handler. */
const h =
  (fn: Handler) =>
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      for (const k of ['id', 'qid', 'bid', 'pid', 'mid']) {
        const v = req.params[k];
        if (v !== undefined && !UUID.test(v)) {
          res.status(400).json({ error: `${k} must be a uuid` });
          return;
        }
      }
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };

// ── Overview ────────────────────────────────────────────────────────────────

// GET /api/purchasing/status — the WhatsApp connection panel. Never a secret.
router.get('/status', h(() => conversations.connectionStatus()));

// GET /api/purchasing/summary — tab counts, failed/unmatched messages, credit outstanding.
router.get('/summary', h(() => demands.getSummary()));

// ── Suppliers ───────────────────────────────────────────────────────────────

router.get('/suppliers', h((req) =>
  suppliers.listSuppliers({
    search: str(req.query['search']),
    includeInactive: req.query['includeInactive'] === 'true',
    limit: int(req.query['limit'], 100),
    offset: int(req.query['offset'], 0),
  })));

router.get('/suppliers/balances', h((req) => suppliers.supplierBalances(str(req.query['supplierId']))));

router.get('/suppliers/:id', h(async (req, res) => {
  const s = await suppliers.getSupplier(req.params['id']!);
  if (!s) res.status(404).json({ error: 'Supplier not found' });
  return s;
}));

router.post('/suppliers', validate(SupplierInputSchema), h(async (req, res) => {
  res.status(201);
  return suppliers.createSupplier(req.body, actor(req));
}));

router.put('/suppliers/:id', validate(SupplierInputSchema), h((req) => suppliers.updateSupplier(req.params['id']!, req.body, actor(req))));

router.delete('/suppliers/:id', validate(ReasonSchema), h(async (req) => {
  await suppliers.deleteSupplier(req.params['id']!, req.body.reason, actor(req));
  return { ok: true };
}));

// ── Ingredient catalog and stock ────────────────────────────────────────────

router.get('/items', h((req) => suppliers.listItems({ search: str(req.query['search']), includeInactive: req.query['includeInactive'] === 'true' })));

router.post('/items', validate(PurchaseItemInputSchema), h(async (req, res) => {
  res.status(201);
  return suppliers.createItem(req.body, actor(req));
}));

router.put('/items/:id', validate(PurchaseItemInputSchema), h((req) => suppliers.updateItem(req.params['id']!, req.body)));

router.get('/stock/movements', h((req) =>
  suppliers.listMovements({ itemId: str(req.query['itemId']), limit: int(req.query['limit'], 50), offset: int(req.query['offset'], 0) })));

router.post('/stock/adjust', idempotent('purchasing.stock_adjust'), validate(IngredientAdjustSchema), h(async (req, res) => {
  res.status(201);
  return suppliers.adjustStock(req.body, businessDateStr(), actor(req));
}));

// ── Demands ─────────────────────────────────────────────────────────────────

const SORTS = ['created_at', 'required_date', 'demand_no', 'supplier_name', 'updated_at'] as const;

router.get('/demands', h((req) => {
  const bucket = str(req.query['bucket']);
  const sortBy = str(req.query['sortBy']);
  return demands.listDemands({
    bucket: bucket && (PURCHASE_BUCKETS as readonly string[]).includes(bucket) ? (bucket as PurchaseBucket) : undefined,
    status: str(req.query['status']),
    priority: str(req.query['priority']),
    supplierId: str(req.query['supplierId']),
    from: str(req.query['from']),
    to: str(req.query['to']),
    search: str(req.query['search']),
    sortBy: sortBy && (SORTS as readonly string[]).includes(sortBy) ? (sortBy as (typeof SORTS)[number]) : undefined,
    sortDir: req.query['sortDir'] === 'asc' ? 'asc' : 'desc',
    limit: int(req.query['limit'], 25),
    offset: int(req.query['offset'], 0),
  });
}));

router.get('/demands/:id', h((req) => demands.getDemandDetail(req.params['id']!)));

// POST /api/purchasing/demands — a draft. Retried with the same clientRequestId
// (or Idempotency-Key) it returns the first demand rather than a second.
router.post('/demands', idempotent('purchasing.demand_create'), validate(DemandInputSchema), h(async (req, res) => {
  const d = await demands.createDemand(req.body, actor(req));
  res.status(d.replayed ? 200 : 201);
  return d;
}));

router.put('/demands/:id', validate(DemandUpdateSchema), h((req) => demands.updateDemand(req.params['id']!, req.body, actor(req))));

router.post('/demands/:id/verify', validate(RevisionSchema), h((req) => demands.verifyDemand(req.params['id']!, req.body.revision, actor(req))));

router.post('/demands/:id/send', idempotent('purchasing.demand_send'), validate(RevisionSchema), h((req) =>
  demands.sendDemand(req.params['id']!, req.body.revision, actor(req))));

router.post('/demands/:id/resend-link', idempotent('purchasing.resend_link'), h((req) => demands.resendLink(req.params['id']!, actor(req))));

router.post('/demands/:id/cancel', validate(ReasonSchema), h((req) => demands.cancelDemand(req.params['id']!, req.body.reason, actor(req))));

router.post('/demands/:id/notes', validate(NoteSchema), h(async (req, res) => {
  await demands.addNote(req.params['id']!, req.body.note, actor(req));
  res.status(201);
  return { ok: true };
}));

// ── Quotation ───────────────────────────────────────────────────────────────

// A quotation the supplier sent as a plain WhatsApp message, keyed in by staff.
router.post('/demands/:id/quotations', idempotent('purchasing.quotation_enter'), validate(QuotationInputSchema), h(async (req, res) => {
  res.status(201);
  return demands.enterQuotation(req.params['id']!, req.body, actor(req));
}));

router.post('/demands/:id/quotations/:qid/decision', validate(QuotationDecisionSchema), h((req) =>
  demands.decideQuotation(req.params['id']!, req.params['qid']!, req.body, actor(req))));

// ── Bill ────────────────────────────────────────────────────────────────────

router.post('/demands/:id/bills', idempotent('purchasing.bill_enter'), validate(BillInputSchema), h(async (req, res) => {
  res.status(201);
  return demands.enterBill(req.params['id']!, req.body, actor(req));
}));

router.post('/demands/:id/bills/:bid/decision', validate(BillDecisionSchema), h((req) =>
  demands.decideBill(req.params['id']!, req.params['bid']!, req.body, actor(req))));

// ── Delivery, receipt, payment, credit ──────────────────────────────────────

router.put('/demands/:id/delivery', validate(DeliveryInputSchema), h((req) => demands.saveDelivery(req.params['id']!, req.body, actor(req))));

router.post('/demands/:id/receipts', idempotent('purchasing.receipt'), validate(ReceiptInputSchema), h(async (req, res) => {
  const r = await demands.recordReceipt(req.params['id']!, req.body, actor(req));
  res.status(r.replayed ? 200 : 201);
  return r;
}));

router.post('/demands/:id/payments', idempotent('purchasing.payment'), validate(PaymentInputSchema), h(async (req, res) => {
  const p = await demands.recordPayment(req.params['id']!, req.body, actor(req));
  res.status(p.replayed ? 200 : 201);
  return p;
}));

router.post('/demands/:id/credits', idempotent('purchasing.credit'), validate(CreditInputSchema), h(async (req, res) => {
  res.status(201);
  return demands.requestCredit(req.params['id']!, req.body, actor(req));
}));

// ── Conversations and messages ──────────────────────────────────────────────

router.get('/conversations', h((req) =>
  conversations.listConversations({ search: str(req.query['search']), limit: int(req.query['limit'], 30), offset: int(req.query['offset'], 0) })));

router.post('/conversations/:id/read', h(async (req) => {
  await conversations.markConversationRead(req.params['id']!);
  return { ok: true };
}));

router.post('/conversations/:id/reply', idempotent('purchasing.reply'), validate(MessageReplySchema), h(async (req, res) => {
  res.status(201);
  return conversations.reply(req.params['id']!, req.body, actor(req));
}));

const MESSAGE_FILTERS = ['failed', 'unmatched', 'inbound', 'outbound'] as const;
router.get('/messages', h((req) => {
  const filter = str(req.query['filter']);
  return conversations.listMessages({
    conversationId: str(req.query['conversationId']),
    supplierId: str(req.query['supplierId']),
    demandId: str(req.query['demandId']),
    filter: filter && (MESSAGE_FILTERS as readonly string[]).includes(filter) ? (filter as (typeof MESSAGE_FILTERS)[number]) : undefined,
    limit: int(req.query['limit'], 50),
    offset: int(req.query['offset'], 0),
  });
}));

router.post('/messages/:mid/retry', h((req) => conversations.retryMessage(req.params['mid']!, actor(req))));

router.post('/messages/:mid/review', validate(MessageReviewSchema), h((req) => conversations.reviewMessage(req.params['mid']!, req.body, actor(req))));
