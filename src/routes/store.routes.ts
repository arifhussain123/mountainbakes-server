import { Router, type NextFunction, type Response } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { validate } from '../middleware/validate';
import {
  STORE_DEMAND_STATUSES,
  STORE_QUERY_STATUSES,
  STORE_REPORT_TYPES,
  STORE_VIEW_ROLES,
  StoreAccountFlagsSchema,
  StoreAdjustInputSchema,
  StoreConfirmIssueSchema,
  StoreDecisionSchema,
  StoreDemandInputSchema,
  StoreIssueInputSchema,
  StoreItemInputSchema,
  StoreItemStatusSchema,
  StoreLookupInputSchema,
  StorePriceInputSchema,
  StoreQueryInputSchema,
  StoreQueryMessageSchema,
  StoreReceiptInputSchema,
  StoreSettingsSchema,
  storeCan,
  type StoreAction,
  type StoreDemandStatus,
  type StoreQueryStatus,
  type StoreReportType,
} from '../shared';
import { businessDate, loadActor, type StoreActor } from '../services/store/common';
import * as catalog from '../services/store/catalog.service';
import * as stock from '../services/store/stock.service';
import * as demands from '../services/store/demands.service';
import * as queries from '../services/store/queries.service';
import * as reports from '../services/store/reports.service';

/**
 * Dry Items Store — /api/store.
 *
 * Who may do what is `storeCan()` (shared/types/store.types.ts), checked here
 * per route against the caller's role and, for a Store keeper, the switches
 * Admin set on their account. The client reads the same function only to hide
 * buttons. Every stock-moving write is one database function that locks what
 * it changes; nothing here posts to Finance.
 */
export const router = Router();

interface StoreRequest extends AuthRequest {
  actor?: StoreActor;
}

router.use(authenticate, async (req: StoreRequest, res, next) => {
  try {
    const role = req.user!.role;
    if (!STORE_VIEW_ROLES.includes(role) && role !== 'production_user') {
      res.status(403).json({ error: 'Forbidden: the Dry Items Store is not open to this account' });
      return;
    }
    req.actor = await loadActor(req.user!.uid, req.user!.email, role);
    next();
  } catch (err) {
    next(err);
  }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const int = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);
const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : undefined);

/** Only callers `storeCan` allows; any one of the actions is enough. */
const can = (...actions: StoreAction[]) => (req: StoreRequest, res: Response, next: NextFunction) => {
  const a = req.actor!;
  if (actions.some((x) => storeCan(a.role, x, a.flags))) {
    next();
    return;
  }
  res.status(403).json({ error: 'Forbidden: your account is not allowed to do this in the Store' });
};

type Handler = (req: StoreRequest, res: Response) => Promise<unknown>;
const h =
  (fn: Handler) =>
  async (req: StoreRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      for (const k of ['id', 'userId', 'lineId']) {
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

/** A date range from the query string, defaulting to the month so far. */
async function range(req: StoreRequest): Promise<{ from: string; to: string }> {
  const today = await businessDate();
  const to = day(req.query['to']) ?? today;
  const from = day(req.query['from']) ?? `${to.slice(0, 8)}01`;
  if (from > to) throw Object.assign(new Error('From must be on or before To'), { status: 400 });
  return { from, to };
}

// ── Who am I ────────────────────────────────────────────────────────────────

router.get('/me', h(async (req) => {
  const a = req.actor!;
  const actions: StoreAction[] = ['view', 'items.edit', 'items.delete', 'prices.edit', 'receive', 'receive.override', 'adjust', 'opening',
    'demand.create', 'demand.review', 'issue', 'issue.confirm', 'queries.raise', 'queries.admin', 'reports', 'accounts'];
  return {
    store: await catalog.getStore(),
    role: a.role,
    flags: a.flags,
    can: Object.fromEntries(actions.map((x) => [x, storeCan(a.role, x, a.flags)])),
    businessDate: await businessDate(),
  };
}));

// ── Settings and accounts (Admin) ───────────────────────────────────────────

router.get('/lookups', can('view', 'demand.create'), h((req) => catalog.listLookups(req.query['all'] === 'true')));
router.post('/lookups', can('accounts'), validate(StoreLookupInputSchema), h(async (req, res) => {
  res.status(201);
  return catalog.addLookup(req.body, req.actor!);
}));
router.patch('/lookups/:id', can('accounts'), validate(StoreItemStatusSchema), h((req) => catalog.setLookupActive(req.params['id']!, req.body.active, req.actor!)));
router.put('/settings', can('accounts'), validate(StoreSettingsSchema), h((req) => catalog.updateSettings(req.body, req.actor!)));

router.get('/accounts', can('accounts'), h(() => catalog.listAccounts()));
router.put('/accounts/:userId', can('accounts'), validate(StoreAccountFlagsSchema), h((req) => catalog.saveAccountFlags(req.params['userId']!, req.body, req.actor!)));
router.get('/audit', can('accounts'), h((req) => catalog.listAudit({ entity: str(req.query['entity']), limit: int(req.query['limit'], 50), offset: int(req.query['offset'], 0) })));

// ── Items ───────────────────────────────────────────────────────────────────

router.get('/items', can('view'), h((req) => catalog.listItems({ includeInactive: req.query['includeInactive'] === 'true' })));
router.post('/items', can('items.edit'), validate(StoreItemInputSchema), h(async (req, res) => {
  res.status(201);
  return catalog.saveItem(null, req.body, req.actor!);
}));
router.put('/items/:id', can('items.edit'), validate(StoreItemInputSchema), h((req) => catalog.saveItem(req.params['id']!, req.body, req.actor!)));
router.patch('/items/:id/status', can('items.edit'), validate(StoreItemStatusSchema), h((req) => catalog.setItemStatus(req.params['id']!, req.body.active, req.actor!)));
router.delete('/items/:id', can('items.delete'), h(async (req) => {
  await catalog.deleteItem(req.params['id']!, req.actor!);
  return { ok: true };
}));
router.get('/items/:id/history', can('view'), h((req) => catalog.itemHistory(req.params['id']!)));
router.get('/items/:id/ledger', can('view'), h(async (req) => {
  const { from, to } = await range(req);
  return { from, to, ...(await stock.itemLedger(req.params['id']!, from, to)) };
}));
router.get('/items/:id/batches', can('view'), h((req) => stock.listBatches(req.params['id']!, req.query['open'] === 'true')));

// ── Price Control ───────────────────────────────────────────────────────────

router.get('/prices', can('view'), h((req) => catalog.listPrices({ itemId: str(req.query['itemId']), history: req.query['history'] === 'true' })));
router.post('/prices', can('prices.edit'), idempotent('store.price_add'), validate(StorePriceInputSchema), h(async (req, res) => {
  res.status(201);
  return catalog.addPrice(req.body, req.actor!);
}));
router.post('/prices/:id/deactivate', can('prices.edit'), h((req) => catalog.deactivatePrice(req.params['id']!, req.actor!)));

// ── Receiving and stock ─────────────────────────────────────────────────────

router.get('/suppliers', can('receive', 'view'), h(() => stock.listSuppliers()));
router.get('/receipts', can('view'), h(async (req) => {
  return stock.listReceipts({ from: day(req.query['from']), to: day(req.query['to']), search: str(req.query['search']), limit: int(req.query['limit'], 50), offset: int(req.query['offset'], 0) });
}));
router.get('/receipts/:id', can('view'), h((req) => stock.getReceipt(req.params['id']!)));
router.post('/receipts', can('receive'), idempotent('store.receive'), validate(StoreReceiptInputSchema), h(async (req, res) => {
  res.status(201);
  return stock.receive(req.body, req.actor!);
}));

router.get('/stock', can('view'), h(async (req) => {
  const { from, to } = await range(req);
  return { from, to, rows: await stock.stockSummary(from, to) };
}));

router.get('/adjustments', can('view'), h((req) => stock.listAdjustments({
  from: day(req.query['from']), to: day(req.query['to']), itemId: str(req.query['itemId']), limit: int(req.query['limit'], 50), offset: int(req.query['offset'], 0),
})));
router.post('/adjustments', can('adjust'), idempotent('store.adjust'), validate(StoreAdjustInputSchema), h(async (req, res) => {
  res.status(201);
  return stock.adjust(req.body, req.actor!);
}));

// ── Production demand ───────────────────────────────────────────────────────

const mineIfProduction = (req: StoreRequest) => (req.actor!.role === 'production_user' ? req.actor!.uid : undefined);
const statuses = (v: unknown): StoreDemandStatus[] | undefined => {
  const list = (str(v) ?? '').split(',').filter((s): s is StoreDemandStatus => (STORE_DEMAND_STATUSES as readonly string[]).includes(s));
  return list.length ? list : undefined;
};

router.get('/demands', can('view', 'demand.create'), h((req) => demands.listDemands({
  status: statuses(req.query['status']), mine: mineIfProduction(req), from: day(req.query['from']), to: day(req.query['to']),
  search: str(req.query['search']), limit: int(req.query['limit'], 50), offset: int(req.query['offset'], 0),
})));
router.get('/demands/counts', can('view', 'demand.create'), h((req) => demands.demandCounts(mineIfProduction(req))));
router.get('/demands/:id', can('view', 'demand.create'), h((req) => demands.getDemand(req.params['id']!, req.actor!)));
router.post('/demands', can('demand.create'), idempotent('store.demand_create'), validate(StoreDemandInputSchema), h(async (req, res) => {
  res.status(201);
  return demands.createDemand(req.body, req.actor!);
}));
router.post('/demands/:id/cancel', can('demand.create'), h((req) => demands.cancelDemand(req.params['id']!, req.actor!)));
router.post('/demands/:id/approve-all', can('demand.review'), h((req) => demands.approveAll(req.params['id']!, req.actor!)));
router.post('/demand-lines/:lineId/decision', can('demand.review'), validate(StoreDecisionSchema), h((req) =>
  demands.decideLine(req.params['lineId']!, req.body, req.actor!)));

// ── Issues ──────────────────────────────────────────────────────────────────

router.get('/issues', can('view', 'issue.confirm'), h((req) => demands.listIssues({
  demandId: str(req.query['demandId']), mine: mineIfProduction(req), status: str(req.query['status']),
  from: day(req.query['from']), to: day(req.query['to']), search: str(req.query['search']),
  limit: int(req.query['limit'], 50), offset: int(req.query['offset'], 0),
})));
router.get('/issues/:id', can('view', 'issue.confirm'), h((req) => demands.getIssue(req.params['id']!, req.actor!)));
router.post('/issues', can('issue'), idempotent('store.issue'), validate(StoreIssueInputSchema), h(async (req, res) => {
  res.status(201);
  return demands.issue(req.body, req.actor!);
}));
router.post('/issues/:id/confirm', can('issue.confirm'), validate(StoreConfirmIssueSchema), h((req) => demands.confirmIssue(req.params['id']!, req.body, req.actor!)));

// ── Queries ─────────────────────────────────────────────────────────────────

router.get('/queries', can('queries.raise', 'queries.admin'), h((req) => {
  const s = str(req.query['status']);
  return queries.listQueries({
    actor: req.actor!,
    status: s && (STORE_QUERY_STATUSES as readonly string[]).includes(s) ? (s as StoreQueryStatus) : undefined,
    search: str(req.query['search']),
    archived: req.query['archived'] === 'true',
    limit: int(req.query['limit'], 50),
    offset: int(req.query['offset'], 0),
  });
}));
router.get('/queries/:id', can('queries.raise', 'queries.admin'), h((req) => queries.getQuery(req.params['id']!, req.actor!)));
router.post('/queries', can('queries.raise'), idempotent('store.query_create'), validate(StoreQueryInputSchema), h(async (req, res) => {
  res.status(201);
  return queries.createQuery(req.body, req.actor!);
}));
router.post('/queries/:id/messages', can('queries.raise', 'queries.admin'), validate(StoreQueryMessageSchema), h((req) =>
  queries.addMessage(req.params['id']!, req.body, req.actor!)));
router.delete('/queries/:id', can('queries.admin'), h(async (req) => {
  await queries.archiveQuery(req.params['id']!, req.actor!);
  return { ok: true };
}));

// ── Dashboard and reports ───────────────────────────────────────────────────

router.get('/dashboard', can('reports'), h(async (req) => {
  const { from, to } = await range(req);
  const p = str(req.query['period']);
  const period = p === 'week' || p === 'month' ? p : 'day';
  return { from, to, period, ...(await reports.dashboard(from, to, period)) };
}));

const reportType = (v: unknown): StoreReportType => {
  if (typeof v === 'string' && (STORE_REPORT_TYPES as readonly string[]).includes(v)) return v as StoreReportType;
  throw Object.assign(new Error('Unknown report'), { status: 400 });
};

router.get('/reports/:type', can('reports'), h(async (req) => {
  const { from, to } = await range(req);
  return reports.report(reportType(req.params['type']), from, to, str(req.query['itemId']));
}));
router.get('/reports/:type/export', can('reports'), h(async (req, res) => {
  const { from, to } = await range(req);
  const rep = await reports.report(reportType(req.params['type']), from, to, str(req.query['itemId']));
  const buf = await reports.reportWorkbook(rep);
  const filename = `store-${rep.type.replace(/_/g, '-')}-${from}-to-${to}`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
  return undefined;
}));
