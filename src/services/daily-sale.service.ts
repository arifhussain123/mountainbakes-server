import { dbFor } from '../db';
import {
  computeDailySaleCompanyShare,
  computeDailySaleDifferences,
  computeDailySaleSummary,
  DAILY_SALE_MANUAL_METHODS,
  DAILY_SALE_MAX_WINDOW_DAYS,
  DAILY_SALE_METHODS,
  businessDateStr,
  isDailySaleRecordOpen,
  round2,
  type DailySaleAudit,
  type DailySaleRecord,
  type DailySaleRecordDetail,
  type DailySaleRecordList,
  type DailySaleRecordStatus,
  type PaymentMethod,
  type PaymentMethodLock,
} from '../shared';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';
import { getBranchShareSplits, getFinanceSettings } from './finance-settings.service';

const db = dbFor('daily-sale');

/**
 * Daily Sale Record — the branch's daily reconciliation of system sales against
 * physically counted receipts.
 *
 * ─── Everything that computes money is in Postgres ───────────────────────────
 * `public.daily_sale_figures` (migration 101) does the aggregation, and the five
 * write functions beside it own every rule that has to hold across more than one
 * statement: the one-record-per-branch-per-day constraint, the payment-method
 * lock, the status machine, and the audit row that goes with each change. This
 * module validates the window, decides WHOSE data the caller is asking about, and
 * names the fields. It never adds up a sale.
 *
 * That split is not stylistic. Every `db` call is its own transaction, so
 * "check the lock, then write the figure" cannot be made atomic from here — see
 * the repo CLAUDE.md. It is also what makes §24 true rather than aspirational:
 * there is no shape in which a client can send a total.
 *
 * ─── This service depends on migration 101 being applied ─────────────────────
 * Same contract migration 100 has with sales-analytics.service.ts: the migration
 * is applied before the deploy. `asClientError` turns the specific "function does
 * not exist" failure into a sentence that says so, rather than a masked 500 that
 * reads like the API is down.
 */

const num = (v: unknown): number => {
  // A `numeric` column must not get through as a STRING. Every figure below is
  // typed `number` on the API contract, and a string would flow all the way to
  // formatCurrency — whose toLocaleString options a string silently ignores — so
  // the branch would read a raw unformatted figure with no error anywhere.
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Same coercion, but preserving the null that means "not counted". */
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function parseDate(value: unknown, field: string): string {
  const s = String(value ?? '').trim();
  if (!DATE_RE.test(s)) throw badRequest(`${field} must be a date in YYYY-MM-DD form`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw badRequest(`${field} is not a real date`);
  }
  return s;
}

/**
 * Turn a raised Postgres exception into something the caller can act on.
 *
 * The functions in migration 101 raise with two deliberately different SQLSTATEs,
 * because the two failures have two different fixes and the branch must not be
 * told to retry the first one:
 *
 *   42501 → 403. "This method is locked / only an admin can do that."
 *   P0001 → 409. "The record is in the wrong state for this."
 *
 * PGRST202 / 42883 mean the migration has not been applied — the same case
 * sales-analytics.service.ts spells out, and worth the same plain sentence.
 */
function asClientError(error: { code?: string; message: string }): Error & { status?: number } {
  if (error.code === 'PGRST202' || error.code === '42883') {
    return Object.assign(
      new Error(
        'Daily Sale Records are unavailable: database migration 101 ' +
          '(daily_sale_records) has not been applied. Apply the pending database migrations.',
      ),
      { status: 503 },
    );
  }
  if (error.code === '42501') return Object.assign(new Error(error.message), { status: 403 });
  if (error.code === 'P0001') return Object.assign(new Error(error.message), { status: 409 });
  return Object.assign(new Error(error.message), error.code ? { code: error.code } : {});
}

/** The actor every write function is told about. Resolved from the JWT by the router. */
export interface DailySaleActor {
  uid: string;
  name: string;
  role: string;
  /** Whether this caller may override a lock, amend, lock and unlock. */
  isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/**
 * The four methods' lock state for one branch, stored rows filled in with the
 * shared default.
 *
 * The default rule lives in `DAILY_SALE_MANUAL_METHODS` (@mb/shared) and is
 * mirrored in SQL as `app.payment_method_default_locked` — which is the copy that
 * actually enforces it. This one decides what the panel renders, and reports
 * `source` so "nobody has configured this branch" stays distinguishable from "an
 * admin unlocked it".
 */
export async function getPaymentMethodLocks(branchId: string): Promise<PaymentMethodLock[]> {
  const { data, error } = await db
    .from('payment_method_settings')
    .select('*')
    .eq('branch_id', branchId);
  if (error) throw asClientError(error);

  const stored = new Map(
    ((data ?? []) as Record<string, unknown>[]).map((r) => [String(r['payment_method']), r]),
  );

  return DAILY_SALE_METHODS.map((method) => {
    const row = stored.get(method);
    if (!row) {
      return {
        paymentMethod: method as PaymentMethod,
        isLocked: !(DAILY_SALE_MANUAL_METHODS as readonly string[]).includes(method),
        source: 'default' as const,
        updatedBy: null,
        updatedByName: null,
        updatedAt: null,
        reason: null,
      };
    }
    return {
      paymentMethod: method as PaymentMethod,
      isLocked: Boolean(row['is_locked']),
      source: 'configured' as const,
      updatedBy: (row['updated_by'] as string | null) ?? null,
      updatedByName: (row['updated_by_name'] as string | null) ?? null,
      updatedAt: (row['updated_at'] as string | null) ?? null,
      reason: (row['reason'] as string | null) ?? null,
    };
  });
}

export async function setPaymentMethodLock(input: {
  branchId: string;
  paymentMethod: PaymentMethod;
  isLocked: boolean;
  reason?: string;
  actor: DailySaleActor;
}): Promise<PaymentMethodLock[]> {
  const { error } = await db.rpc('set_payment_method_lock', {
    p_branch_id: input.branchId,
    p_payment_method: input.paymentMethod,
    p_is_locked: input.isLocked,
    p_reason: input.reason ?? null,
    p_actor_id: input.actor.uid,
    p_actor_name: input.actor.name,
    p_actor_role: input.actor.role,
  });
  if (error) throw asClientError(error);

  return getPaymentMethodLocks(input.branchId);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Raw `daily_sale_figures` row, before coercion. */
interface FiguresRow {
  branchId: string;
  businessDate: string;
  totalSale: unknown;
  cash: unknown;
  easypaisa: unknown;
  foodpanda: unknown;
  bank: unknown;
  other: unknown;
  staffTotal: unknown;
  discount: unknown;
  orderCount: unknown;
  cashExpense: unknown;
  expenseTotal: unknown;
}

interface AutoFigures {
  autoTotalSale: number;
  autoCash: number;
  autoEasypaisa: number;
  autoFoodpanda: number;
  autoBank: number;
  autoOther: number;
  autoStaff: number;
  discount: number;
  cashExpense: number;
  expenseTotal: number;
  orderCount: number;
}

const ZERO_FIGURES: AutoFigures = {
  autoTotalSale: 0, autoCash: 0, autoEasypaisa: 0, autoFoodpanda: 0, autoBank: 0,
  autoOther: 0, autoStaff: 0, discount: 0, cashExpense: 0, expenseTotal: 0, orderCount: 0,
};

function figuresFromRow(row: FiguresRow): AutoFigures {
  return {
    autoTotalSale: num(row.totalSale),
    autoCash: num(row.cash),
    autoEasypaisa: num(row.easypaisa),
    autoFoodpanda: num(row.foodpanda),
    autoBank: num(row.bank),
    autoOther: num(row.other),
    autoStaff: num(row.staffTotal),
    discount: num(row.discount),
    cashExpense: num(row.cashExpense),
    expenseTotal: num(row.expenseTotal),
    orderCount: num(row.orderCount),
  };
}

function figuresFromRecord(row: Record<string, unknown>): AutoFigures {
  return {
    autoTotalSale: num(row['auto_total_sale']),
    autoCash: num(row['auto_cash']),
    autoEasypaisa: num(row['auto_easypaisa']),
    autoFoodpanda: num(row['auto_foodpanda']),
    autoBank: num(row['auto_bank']),
    autoOther: num(row['auto_other']),
    autoStaff: num(row['auto_staff']),
    discount: num(row['discount']),
    cashExpense: num(row['cash_expense']),
    expenseTotal: num(row['expense_total']),
    orderCount: num(row['order_count']),
  };
}

/**
 * One presentable record, from a stored row and/or live figures.
 *
 * ─── Which auto figures win, and why ─────────────────────────────────────────
 * While a record is OPEN or PENDING_VERIFICATION the LIVE figures are shown: the
 * branch is counting against what the till says now, and a snapshot taken at
 * breakfast is the wrong thing to reconcile an evening drawer against. Once the
 * record is verified, locked or amended the STORED snapshot wins, because those
 * are the figures somebody signed their name against and they must not move
 * underneath the signature.
 *
 * The differences are then computed from whichever pair was chosen, by the one
 * shared helper. For a frozen record that yields exactly what the generated
 * columns already hold — the two agree by construction, which is what makes a
 * single formula safe here (see computeDailySaleDifferences).
 */
function composeRecord(args: {
  branchId: string;
  branchName: string;
  businessDate: string;
  stored: Record<string, unknown> | undefined;
  live: AutoFigures | undefined;
  /** The branch's company share as Admin has it now. */
  currentSharePct: number;
  /** The percentage on the day's income approval, when it has one. */
  snapshotSharePct: number | null;
}): DailySaleRecord {
  const { stored, live } = args;
  const status = (stored ? String(stored['status']) : 'open') as DailySaleRecordStatus;
  const frozen = stored ? !isDailySaleRecordOpen(status) : false;

  // `live ?? ZERO_FIGURES` and NOT a fallback to the stored snapshot. A
  // non-frozen record with no live row means the day now has no sale and no
  // expense at all — every order cancelled, most likely — and the honest auto
  // figure is zero. Falling back to the snapshot there would keep showing
  // yesterday's takings for a day that no longer has any, and the difference
  // column would be computed against a total that no longer exists.
  const auto = frozen && stored ? figuresFromRecord(stored) : (live ?? ZERO_FIGURES);

  const manual = {
    manualCash: stored ? numOrNull(stored['manual_cash']) : null,
    manualEasypaisa: stored ? numOrNull(stored['manual_easypaisa']) : null,
    manualBank: stored ? numOrNull(stored['manual_bank']) : null,
  };

  const diffs = computeDailySaleDifferences({ ...auto }, manual);
  const share = computeDailySaleCompanyShare(auto.autoTotalSale, args.snapshotSharePct, args.currentSharePct);

  return {
    id: stored ? String(stored['id']) : null,
    branchId: args.branchId,
    // The stored name is a point-in-time snapshot for a signed record; a live row
    // has none yet, so the caller's resolved name fills in.
    branchName: (stored?.['branch_name'] as string | null) || args.branchName,
    businessDate: args.businessDate,
    ...auto,
    ...share,
    ...manual,
    fedBy: (stored?.['fed_by'] as string | null) ?? null,
    fedByName: (stored?.['fed_by_name'] as string | null) ?? null,
    fedAt: (stored?.['fed_at'] as string | null) ?? null,
    ...diffs,
    status,
    createdBy: (stored?.['created_by'] as string | null) ?? null,
    createdByName: (stored?.['created_by_name'] as string | null) ?? null,
    verifiedBy: (stored?.['verified_by'] as string | null) ?? null,
    verifiedByName: (stored?.['verified_by_name'] as string | null) ?? null,
    verifiedAt: (stored?.['verified_at'] as string | null) ?? null,
    lockedBy: (stored?.['locked_by'] as string | null) ?? null,
    lockedByName: (stored?.['locked_by_name'] as string | null) ?? null,
    lockedAt: (stored?.['locked_at'] as string | null) ?? null,
    amendedAt: (stored?.['amended_at'] as string | null) ?? null,
    // Falls back to the auto snapshot time so a live row still has a "Time"
    // column to show — §2 asks for one, and a dash there reads as missing data
    // rather than as "this record has not been opened".
    generatedAt: (stored?.['generated_at'] as string | null) ?? new Date().toISOString(),
    createdAt: (stored?.['created_at'] as string | null) ?? null,
    updatedAt: (stored?.['updated_at'] as string | null) ?? null,
  };
}

/**
 * The company-share percentages a window of records needs.
 *
 * `current` is what Admin has configured per branch right now — the branch's own
 * percentage, else the global finance setting (`getBranchShareSplits`). The
 * setting has no effective-dated history, so on its own it would re-price every
 * past day whenever it changed. `snapshot` is what stops that for the days that
 * matter: an income approval stores the percentage it was imported at, keyed
 * `branchId|businessDate`, and that figure wins for its day.
 *
 * A day with no approval yet has no snapshot and reads at the current rate.
 */
async function loadCompanyShares(
  branchIds: string[],
  from: string,
  to: string,
): Promise<{ current: Map<string, number>; snapshot: Map<string, number>; fallback: number }> {
  const snapshot = new Map<string, number>();
  if (branchIds.length === 0) return { current: new Map(), snapshot, fallback: 0 };

  const [splits, settings, approvals] = await Promise.all([
    getBranchShareSplits(branchIds),
    getFinanceSettings(),
    withoutDeleted(
      db
        .from('finance_income_approvals')
        .select('branch_id, business_date, company_share_pct')
        .in('branch_id', branchIds)
        .gte('business_date', from)
        .lte('business_date', to),
    ),
  ]);
  if (approvals.error) throw asClientError(approvals.error);

  for (const a of (approvals.data ?? []) as Record<string, unknown>[]) {
    const pct = numOrNull(a['company_share_pct']);
    if (pct !== null) snapshot.set(`${a['branch_id']}|${a['business_date']}`, pct);
  }
  return {
    current: new Map([...splits].map(([id, s]) => [id, s.companySharePct])),
    snapshot,
    fallback: Number(settings.companySharePct ?? 0),
  };
}

export interface ListParams {
  from: unknown;
  to: unknown;
  /** ALREADY RESOLVED against the JWT by the router — never a raw query param. */
  branchId: string | null;
  branchName: string | null;
}

/**
 * The reconciliation board for a window.
 *
 * A row appears for every (branch, business date) that has a stored record OR any
 * sale or expense. Days with none of those are ABSENT rather than zero — unlike a
 * sales graph, which fills its series so a closed Sunday is not drawn as a trend,
 * a list of days to sign off must not invite anybody to sign off a day the shop
 * never opened.
 *
 * `branchId` null (super admin, no branch chosen) consolidates across every
 * branch, one row per branch per day. It is deliberately NOT summed into a single
 * row per day: these figures reconcile against one physical cash drawer, and a
 * total spanning four shops reconciles with nothing — the same argument
 * branch-closing.routes.ts makes when it refuses to default its export to "all
 * branches".
 */
export async function listDailySaleRecords(params: ListParams): Promise<DailySaleRecordList> {
  const from = parseDate(params.from, 'from');
  const to = parseDate(params.to, 'to');
  if (from > to) throw badRequest('from must not be after to');
  if (daysBetween(from, to) > DAILY_SALE_MAX_WINDOW_DAYS) {
    throw badRequest(`That range is longer than ${DAILY_SALE_MAX_WINDOW_DAYS} days. Ask for a smaller window.`);
  }

  const [figuresRes, storedRes] = await Promise.all([
    db.rpc('daily_sale_figures', {
      p_from: from,
      p_to: to,
      p_branch_id: params.branchId,
    }),
    (() => {
      let q = db
        .from('daily_sale_records')
        .select('*')
        .gte('business_date', from)
        .lte('business_date', to);
      if (params.branchId) q = q.eq('branch_id', params.branchId);
      return q;
    })(),
  ]);
  if (figuresRes.error) throw asClientError(figuresRes.error);
  if (storedRes.error) throw asClientError(storedRes.error);

  const live = new Map<string, AutoFigures>();
  const liveBranches = new Set<string>();
  for (const raw of (figuresRes.data ?? []) as Record<string, unknown>[]) {
    const row = rowToApi<FiguresRow>(raw);
    live.set(`${row.branchId}|${row.businessDate}`, figuresFromRow(row));
    liveBranches.add(row.branchId);
  }

  const stored = new Map<string, Record<string, unknown>>();
  const storedBranches = new Set<string>();
  for (const row of (storedRes.data ?? []) as Record<string, unknown>[]) {
    stored.set(`${row['branch_id']}|${row['business_date']}`, row);
    storedBranches.add(String(row['branch_id']));
  }

  // Branch names for the consolidated view. Resolved in one query rather than one
  // per row; a branch with no rows in the window is never asked about.
  const names = new Map<string, string>();
  if (params.branchId && params.branchName) {
    names.set(params.branchId, params.branchName);
  } else {
    const ids = [...new Set([...liveBranches, ...storedBranches])];
    if (ids.length > 0) {
      const { data, error } = await db.from('branches').select('id, name').in('id', ids);
      if (error) throw asClientError(error);
      for (const b of (data ?? []) as { id: string; name: string }[]) names.set(b.id, b.name);
    }
  }

  // Company share: two reads for the whole window, never one per row.
  const shares = await loadCompanyShares([...new Set([...liveBranches, ...storedBranches])], from, to);

  const records: DailySaleRecord[] = [...new Set([...live.keys(), ...stored.keys()])]
    .map((key) => {
      const [branchId, businessDate] = key.split('|') as [string, string];
      return composeRecord({
        branchId,
        branchName: names.get(branchId) ?? '',
        businessDate,
        stored: stored.get(key),
        live: live.get(key),
        currentSharePct: shares.current.get(branchId) ?? shares.fallback,
        snapshotSharePct: shares.snapshot.get(key) ?? null,
      });
    })
    // Newest first, then by branch — the order the board reads in, and stable
    // across refetches so a row does not move while somebody is aiming at it.
    .sort((a, b) =>
      a.businessDate === b.businessDate
        ? a.branchName.localeCompare(b.branchName)
        : b.businessDate.localeCompare(a.businessDate),
    );

  return {
    from,
    to,
    branchId: params.branchId,
    branchName: params.branchName,
    records,
    summary: computeDailySaleSummary(records),
    // A consolidated view has no single lock configuration to report; the admin
    // panel asks per branch. An empty array says "not applicable" rather than
    // inventing one branch's settings as though they governed all of them.
    locks: params.branchId ? await getPaymentMethodLocks(params.branchId) : [],
  };
}

/**
 * Rows for days with no record and no sale — every figure zero, open, no id.
 *
 * The board leaves such days out (see `listDailySaleRecords`). Finance's Daily
 * Closing asks for one only where a branch handed over a deposit that day that
 * paid no other day, so the cash has a row to be shown on as received.
 */
export async function composeEmptyDailySaleDays(
  days: { branchId: string; branchName: string; businessDate: string }[],
): Promise<DailySaleRecord[]> {
  if (days.length === 0) return [];
  const dates = days.map((d) => d.businessDate).sort();
  const shares = await loadCompanyShares([...new Set(days.map((d) => d.branchId))], dates[0]!, dates[dates.length - 1]!);
  return days.map((d) =>
    composeRecord({
      ...d,
      stored: undefined,
      live: undefined,
      currentSharePct: shares.current.get(d.branchId) ?? shares.fallback,
      snapshotSharePct: shares.snapshot.get(`${d.branchId}|${d.businessDate}`) ?? null,
    }),
  );
}

/** A record in full, with its history, its branch's locks and the print header (§21, §22). */
export async function getDailySaleRecordDetail(
  id: string,
  branchScope: string | null,
): Promise<DailySaleRecordDetail> {
  let q = db.from('daily_sale_records').select('*').eq('id', id);
  // The branch filter IS the authorisation, not the lookup: without it a branch
  // could read another shop's signed reconciliation by quoting its id.
  if (branchScope) q = q.eq('branch_id', branchScope);
  const { data: row, error } = await q.maybeSingle();
  if (error) throw asClientError(error);
  if (!row) throw Object.assign(new Error('Daily Sale Record not found'), { status: 404 });

  const branchId = String(row['branch_id']);
  const businessDate = String(row['business_date']);
  const status = String(row['status']) as DailySaleRecordStatus;

  const [auditsRes, branchRes, locks, figuresRes] = await Promise.all([
    db
      .from('daily_sale_record_audits')
      .select('*')
      .eq('record_id', id)
      .order('created_at', { ascending: false }),
    db.from('branches').select('id, name, address, phone, city').eq('id', branchId).maybeSingle(),
    getPaymentMethodLocks(branchId),
    // Only worth the round trip while the record is still open — a frozen record
    // shows its snapshot and the live figures would not be used.
    isDailySaleRecordOpen(status)
      ? db.rpc('daily_sale_figures', { p_from: businessDate, p_to: businessDate, p_branch_id: branchId })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (auditsRes.error) throw asClientError(auditsRes.error);
  if (branchRes.error) throw asClientError(branchRes.error);
  if (figuresRes.error) throw asClientError(figuresRes.error);

  const liveRow = ((figuresRes.data ?? []) as Record<string, unknown>[])[0];
  const shares = await loadCompanyShares([branchId], businessDate, businessDate);
  const record = composeRecord({
    branchId,
    branchName: (branchRes.data?.name as string | undefined) ?? '',
    businessDate,
    stored: row,
    live: liveRow ? figuresFromRow(rowToApi<FiguresRow>(liveRow)) : undefined,
    currentSharePct: shares.current.get(branchId) ?? shares.fallback,
    snapshotSharePct: shares.snapshot.get(`${branchId}|${businessDate}`) ?? null,
  });

  const audits = ((auditsRes.data ?? []) as Record<string, unknown>[]).map(
    (a) => rowToApi<DailySaleAudit>(a),
  );

  return {
    record,
    audits,
    locks,
    branch: {
      id: branchId,
      name: (branchRes.data?.name as string | undefined) ?? record.branchName,
      address: (branchRes.data?.address as string | null | undefined) ?? null,
      phone: (branchRes.data?.phone as string | null | undefined) ?? null,
      city: (branchRes.data?.city as string | null | undefined) ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Writing — every one of these is a single RPC, and the RPC owns the rules
// ---------------------------------------------------------------------------

/**
 * Refuse a business date that has not happened yet.
 *
 * There is nothing to reconcile about tomorrow, and generating a record for it
 * would put an empty day on the board for somebody to sign off — the one thing
 * the "absent, not zero" rule in `listDailySaleRecords` exists to prevent.
 */
function assertNotFuture(businessDate: string): void {
  if (businessDate > businessDateStr()) {
    throw badRequest('That business date has not happened yet');
  }
}

export async function generateDailySaleRecord(input: {
  branchId: string;
  businessDate: string;
  actor: DailySaleActor;
}): Promise<DailySaleRecordDetail> {
  assertNotFuture(input.businessDate);

  const { data, error } = await db.rpc('ensure_daily_sale_record', {
    p_branch_id: input.branchId,
    p_business_date: input.businessDate,
    p_actor_id: input.actor.uid,
    p_actor_name: input.actor.name,
    p_actor_role: input.actor.role,
  });
  if (error) throw asClientError(error);

  return getDailySaleRecordDetail(String(data), null);
}

export async function feedDailySaleRecord(input: {
  branchId: string;
  businessDate: string;
  cash?: number;
  easypaisa?: number;
  bank?: number;
  actor: DailySaleActor;
}): Promise<DailySaleRecordDetail> {
  assertNotFuture(input.businessDate);

  // `undefined` → null, which the function reads as "leave this method alone".
  // Sending 0 for an omitted field would record an empty drawer nobody counted.
  const { data, error } = await db.rpc('feed_daily_sale_record', {
    p_branch_id: input.branchId,
    p_business_date: input.businessDate,
    p_cash: input.cash ?? null,
    p_easypaisa: input.easypaisa ?? null,
    p_bank: input.bank ?? null,
    p_actor_id: input.actor.uid,
    p_actor_name: input.actor.name,
    p_actor_role: input.actor.role,
    p_is_admin: input.actor.isAdmin,
  });
  if (error) throw asClientError(error);

  return getDailySaleRecordDetail(String(data), null);
}

export async function decideDailySaleRecord(input: {
  id: string;
  action: 'lock' | 'unlock';
  reason?: string;
  branchScope: string | null;
  actor: DailySaleActor;
}): Promise<DailySaleRecordDetail> {
  // The scope check happens BEFORE the RPC, and it is the reason it is here at
  // all: the function takes a record id and would happily act on any branch's
  // record. This read is what pins a branch role to its own.
  await getDailySaleRecordDetail(input.id, input.branchScope);

  const { error } = await db.rpc('decide_daily_sale_record', {
    p_id: input.id,
    p_action: input.action,
    p_reason: input.reason ?? null,
    p_actor_id: input.actor.uid,
    p_actor_name: input.actor.name,
    p_actor_role: input.actor.role,
    p_is_admin: input.actor.isAdmin,
  });
  if (error) throw asClientError(error);

  return getDailySaleRecordDetail(input.id, input.branchScope);
}

/** Who the audit trail names for a record the 12:30 AM job verified. */
const AUTO_VERIFY_ACTOR = { uid: null, name: 'System (auto-verify)', role: 'system' } as const;

export interface AutoVerifyResult {
  businessDate: string;
  verified: number;
  failed: number;
}

/**
 * Verify every fed record up to and including the business day now ending.
 *
 * Verification is no longer a button: the 12:30 AM job (daily-sale-verify.job.ts)
 * is the only caller. "Fed" means a manual count exists (`fed_at`); a day nobody
 * counted stays open, because a sign-off with nothing counted signs off nothing.
 *
 * Earlier days are swept too, not just today: a run missed during a restart, or a
 * record an admin unlocked (which puts it back to pending_verification), would
 * otherwise have no way to become verified again.
 *
 * Each record's auto figures are refreshed first (`ensure_daily_sale_record`) so
 * the frozen snapshot is the till as of 12:30, not as of the last feed. Sales
 * between 12:30 and the 2:00 AM rollover land after the snapshot — the trade-off
 * of verifying the day before it formally ends.
 *
 * One record failing never stops the rest; each is its own transaction anyway.
 */
export async function autoVerifyDailySaleRecords(): Promise<AutoVerifyResult> {
  const businessDate = businessDateStr();
  const { data, error } = await db
    .from('daily_sale_records')
    .select('id, branch_id, business_date')
    .lte('business_date', businessDate)
    .in('status', ['open', 'pending_verification'])
    .not('fed_at', 'is', null);
  if (error) throw asClientError(error);

  let verified = 0;
  let failed = 0;
  for (const row of (data ?? []) as { id: string; branch_id: string; business_date: string }[]) {
    try {
      const refreshed = await db.rpc('ensure_daily_sale_record', {
        p_branch_id: row.branch_id,
        p_business_date: row.business_date,
        p_actor_id: AUTO_VERIFY_ACTOR.uid,
        p_actor_name: AUTO_VERIFY_ACTOR.name,
        p_actor_role: AUTO_VERIFY_ACTOR.role,
      });
      if (refreshed.error) throw asClientError(refreshed.error);

      const { error: verifyError } = await db.rpc('decide_daily_sale_record', {
        p_id: row.id,
        p_action: 'verify',
        p_reason: null,
        p_actor_id: AUTO_VERIFY_ACTOR.uid,
        p_actor_name: AUTO_VERIFY_ACTOR.name,
        p_actor_role: AUTO_VERIFY_ACTOR.role,
        p_is_admin: false,
      });
      if (verifyError) throw asClientError(verifyError);
      verified += 1;
    } catch (err) {
      failed += 1;
      console.error(`[daily-sale-verify] ${row.business_date} branch ${row.branch_id}:`, err);
    }
  }

  return { businessDate, verified, failed };
}

export async function amendDailySaleRecord(input: {
  id: string;
  field: 'manual_cash' | 'manual_easypaisa' | 'manual_bank';
  amount: number;
  reason: string;
  actor: DailySaleActor;
}): Promise<DailySaleRecordDetail> {
  const { error } = await db.rpc('amend_daily_sale_record', {
    p_id: input.id,
    p_field: input.field,
    p_amount: round2(input.amount),
    p_reason: input.reason,
    p_actor_id: input.actor.uid,
    p_actor_name: input.actor.name,
    p_actor_role: input.actor.role,
  });
  if (error) throw asClientError(error);

  // Admin-only, so no branch scope to apply — the router's requireRole is what
  // guarantees that, and passing a scope here would be misleading.
  return getDailySaleRecordDetail(input.id, null);
}
