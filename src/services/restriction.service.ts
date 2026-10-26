import { dbFor } from '../db';
import {
  CASH_DEPOSITS_PER_DAY,
  DEFAULT_RESTRICTION_RULES,
  RESTRICTION_GROUPS,
  SYSTEM_LEDGER_HEAD_CODES,
  backdatedDemandDate,
  businessDateStr,
  closingContext,
  evalBackdatedDemand,
  evalCashBackdate,
  evalCashLimit,
  evalCompanyShare,
  evalHourlySales,
  evalLedgerBackdate,
  evalLowSales,
  evalPendingDemand,
  hhmmToMinutes,
  karachiMinutesOfDay,
  mergeRules,
  pickRestriction,
  restrictionAllows,
  restrictionDmy,
  type CreateRestrictionRequestInput,
  type Restriction,
  type RestrictionCheck,
  type RestrictionCode,
  type RestrictionEvent,
  type RestrictionEventResult,
  type RestrictionGroup,
  type RestrictionMonitorRow,
  type RestrictionRequest,
  type RestrictionRequestType,
  type RestrictionRules,
  type RestrictionRulesState,
} from '../shared';
import { getCached, invalidate, setCached } from '../utils/cache';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';
import { getAppSettings } from './settings.service';
import { computeBranchStockDay } from './stock.service';

const db = dbFor('restriction');
/**
 * Restriction Rules — the I/O half. Loads configuration and the facts each rule
 * needs, hands them to the pure evaluators in shared/utils/restriction.ts, and owns the
 * approval requests and the audit trail.
 *
 * THE SAME EVALUATION SERVES BOTH QUESTIONS. The popup's preflight ("what will
 * the server say?") and the write path ("may this go in?") call the same
 * `check*` function, so what a branch is shown and what is enforced cannot
 * disagree. Only the write path spends an approval or writes an audit row.
 *
 * NOTHING HERE TRUSTS THE CLIENT. Branch, user and business date come from the
 * token and the server clock; an approval is found by a binding the server
 * builds from the transaction itself, never by an id or a flag in the request.
 */

export const RESTRICTION_TIMEZONE = 'Asia/Karachi';

interface Actor {
  uid: string;
  name: string;
}

interface BranchRef {
  id: string;
  name: string | null;
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * What applies while migration 136 has not been pushed: every new rule off, and
 * the cash-deposit limit exactly as it was hard-coded before this feature. The
 * API is deployed before the database on this project, and a missing table must
 * not start refusing sales.
 */
const PRE_MIGRATION_RULES: RestrictionRules = (() => {
  const rules = structuredClone(DEFAULT_RESTRICTION_RULES) as RestrictionRules;
  rules.demand.pendingLimit.enabled = false;
  rules.demand.backdated.enabled = false;
  rules.demand.lowSales.enabled = false;
  rules.sales.hourly.enabled = false;
  rules.ledger.backdate.enabled = false;
  rules.company.shareIncome.enabled = false;
  rules.cash.dailyLimit = { enabled: true, limit: CASH_DEPOSITS_PER_DAY, allowExceptions: false };
  rules.cash.backdate.enabled = false;
  return rules;
})();

/** Postgres "relation does not exist" / PostgREST "not in the schema cache". */
function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205';
}

interface StoredRules {
  rules: RestrictionRules;
  saved: RestrictionRulesState['saved'];
}

async function loadRules(): Promise<StoredRules> {
  const hit = getCached<StoredRules>('restrictionRules');
  if (hit) return hit;

  const saved = Object.fromEntries(
    RESTRICTION_GROUPS.map((g) => [g, { updatedAt: null, updatedByName: null }]),
  ) as RestrictionRulesState['saved'];

  const { data, error } = await db
    .from('restriction_rules')
    .select('group_key, config, updated_at, updated_by_name');
  if (error) {
    if (!isMissingTable(error)) throw new Error(`Failed to load restriction rules: ${error.message}`);
    console.warn('[restrictions] restriction_rules is missing — apply migration 136. New rules are OFF until then.');
    const fallback = { rules: PRE_MIGRATION_RULES, saved };
    setCached('restrictionRules', fallback);
    return fallback;
  }

  const stored: Partial<Record<RestrictionGroup, unknown>> = {};
  for (const row of data ?? []) {
    const group = row.group_key as RestrictionGroup;
    stored[group] = row.config;
    saved[group] = { updatedAt: row.updated_at as string, updatedByName: (row.updated_by_name as string) ?? null };
  }

  const result = { rules: mergeRules(stored), saved };
  setCached('restrictionRules', result);
  return result;
}

export async function getRestrictionRules(): Promise<RestrictionRules> {
  return (await loadRules()).rules;
}

export async function getRestrictionRulesState(): Promise<RestrictionRulesState> {
  const [{ rules, saved }, settings] = await Promise.all([loadRules(), getAppSettings()]);
  return {
    rules,
    saved,
    businessDate: businessDateStr(),
    timezone: RESTRICTION_TIMEZONE,
    closingTime: settings.businessClosingTime,
  };
}

/**
 * Replace one group's configuration. `config` has already been through its Zod
 * schema. A rule the body leaves out (an older client that does not know it
 * yet) keeps its current setting rather than falling back to the default.
 */
export async function saveRestrictionGroup(group: RestrictionGroup, config: object, actor: Actor): Promise<void> {
  const current = (await loadRules()).rules[group];
  const { error } = await db.from('restriction_rules').upsert(
    {
      group_key: group,
      config: { ...current, ...config },
      updated_by: actor.uid,
      updated_by_name: actor.name,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'group_key' },
  );
  if (error) throw error;
  invalidate('restrictionRules');

  await logRestrictionEvent({
    ruleCode: 'RULES_CONFIG',
    actor,
    branch: null,
    ref: group,
    action: `Save ${group} rules`,
    result: 'Updated',
  });
}

// ─── Audit ───────────────────────────────────────────────────────────────────

interface EventInput {
  ruleCode: RestrictionCode | 'RULES_CONFIG';
  actor: Actor | null;
  branch: BranchRef | null;
  ref?: string | null;
  currentValue?: string | null;
  threshold?: string | null;
  action: string;
  result: RestrictionEventResult;
  approvalNo?: string | null;
}

/**
 * Append a row to `restriction_events`. Never throws — as with `logAudit`, a
 * failed audit write must not break (or, worse, un-block) the action it records.
 */
export async function logRestrictionEvent(input: EventInput): Promise<void> {
  try {
    const { error } = await db.from('restriction_events').insert({
      rule_code: input.ruleCode,
      branch_id: input.branch?.id ?? null,
      branch_name: input.branch?.name ?? null,
      user_id: input.actor?.uid ?? null,
      user_name: input.actor?.name ?? null,
      ref: input.ref ?? null,
      current_value: input.currentValue ?? null,
      threshold: input.threshold ?? null,
      action: input.action,
      result: input.result,
      approval_no: input.approvalNo ?? null,
    });
    if (error && !isMissingTable(error)) console.error('[restrictions] failed to write event', error);
  } catch (err) {
    console.error('[restrictions] failed to write event', err);
  }
}

/** "3 / 3", "22% / 30%", "7 d / 3 d" — the value and threshold as the audit log shows them. */
function auditFigures(r: Restriction): { currentValue: string | null; threshold: string | null } {
  if (r.code === 'BACKDATED_DEMAND') {
    return { currentValue: r.stats?.[0]?.value ?? null, threshold: r.stats?.[1]?.value ?? null };
  }
  if (r.currentValue === undefined || r.threshold === undefined) return { currentValue: null, threshold: null };
  const unit = r.code === 'LOW_SALES_AFTER_CLOSING' ? '%' : r.code === 'LEDGER_BACKDATE' ? ' d' : '';
  return { currentValue: `${r.currentValue}${unit}`, threshold: `${r.threshold}${unit}` };
}

export async function listRestrictionEvents(q: { ruleCode?: string; limit?: number }): Promise<RestrictionEvent[]> {
  let query = db
    .from('restriction_events')
    .select('id, event_no, rule_code, branch_name, user_name, ref, current_value, threshold, action, result, approval_no, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(q.limit ?? 200, 1), 500));
  if (q.ruleCode) query = query.eq('rule_code', q.ruleCode);
  const { data, error } = await query;
  if (error) throw error;
  return rowToApi<RestrictionEvent[]>(data ?? []);
}

// ─── Requests ────────────────────────────────────────────────────────────────

const REQUEST_COLUMNS =
  'id, request_no, type, binding_key, branch_id, branch_name, requested_date, current_business_date, amount, ' +
  'description, entry_label, reason, requested_by, requested_by_name, requested_at, status, approval_no, ' +
  'decided_by_name, decided_at, admin_reason, consumed_at, consumed_ref';

function toRequest(row: Record<string, unknown>): RestrictionRequest {
  const { bindingKey: _bindingKey, ...api } = rowToApi<RestrictionRequest & { bindingKey: string }>(row);
  // `numeric` arrives from PostgREST as a string.
  return { ...api, amount: api.amount === null || api.amount === undefined ? null : Number(api.amount) };
}

/**
 * What an approval covers. A branch rule is bound to the branch and the date; a
 * finance rule to the user, the head, the date and the amount — change any of
 * them and the approval no longer matches, which is the point.
 */
const bindings = {
  branchDate: (branchId: string, date: string) => `branch:${branchId}|date:${date}`,
  financeEntry: (userId: string, headId: string, date: string, amount: number) =>
    `user:${userId}|head:${headId}|date:${date}|amount:${amount.toFixed(2)}`,
};

/**
 * The latest request for a binding that has not been spent, or null. A spent
 * approval is history: the next attempt starts from "no request".
 */
async function openRequest(type: RestrictionRequestType, bindingKey: string): Promise<RestrictionRequest | null> {
  const { data, error } = await db
    .from('restriction_requests')
    .select(REQUEST_COLUMNS)
    .eq('type', type)
    .eq('binding_key', bindingKey)
    .is('consumed_at', null)
    .order('requested_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data as unknown as Record<string, unknown>[] | null)?.[0];
  return row ? toRequest(row) : null;
}

export async function listRestrictionRequests(q: {
  type?: string;
  status?: string;
  requestedBy?: string;
  branchId?: string;
  limit?: number;
}): Promise<RestrictionRequest[]> {
  let query = db
    .from('restriction_requests')
    .select(REQUEST_COLUMNS)
    .order('requested_at', { ascending: false })
    .limit(Math.min(Math.max(q.limit ?? 200, 1), 500));
  if (q.type) query = query.eq('type', q.type);
  if (q.status) query = query.eq('status', q.status);
  if (q.requestedBy) query = query.eq('requested_by', q.requestedBy);
  if (q.branchId) query = query.eq('branch_id', q.branchId);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toRequest);
}

export async function countPendingRestrictionRequests(): Promise<number> {
  const { count, error } = await db
    .from('restriction_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) throw error;
  return count ?? 0;
}

const clientError = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Raise a request to lift a restriction once.
 *
 * The server re-derives everything that matters: that the rule is on, that it
 * actually applies to this transaction, and what the request is bound to. A
 * request for something that is not restricted is refused rather than filed —
 * an approval nobody needed is an approval waiting to be misused.
 */
export async function createRestrictionRequest(
  input: CreateRestrictionRequestInput,
  user: { uid: string; name: string; branchId: string | null; branchName: string | null },
): Promise<RestrictionRequest> {
  const rules = await getRestrictionRules();
  const today = businessDateStr();
  if (input.date > today) throw clientError(400, 'That date is in the future.');

  let bindingKey: string;
  let branch: BranchRef | null = null;
  let amount: number | null = null;
  let description: string | null = input.description ?? null;
  let entryLabel: string | null = null;

  if (input.type === 'BACKDATED_DEMAND' || input.type === 'CASH_DEPOSIT_LIMIT') {
    if (!user.branchId) throw clientError(400, 'No branch assigned to this account');
    branch = { id: user.branchId, name: user.branchName };
    bindingKey = bindings.branchDate(user.branchId, input.date);

    if (input.type === 'BACKDATED_DEMAND') {
      const cfg = rules.demand.backdated;
      if (!cfg.enabled || !cfg.requireApproval) throw clientError(400, 'Backdated demands cannot be requested for approval.');
      if (input.date >= today) throw clientError(400, 'This demand is not backdated — no approval is needed.');
      entryLabel = 'Demand';
    } else {
      const cfg = rules.cash.dailyLimit;
      if (!cfg.enabled || !cfg.allowExceptions) throw clientError(400, 'Cash-deposit exceptions are not allowed.');
      const live = await liveDepositNumbers(user.branchId, input.date);
      if (live.length < cfg.limit) throw clientError(400, 'The cash-deposit limit has not been reached — no approval is needed.');
      entryLabel = 'Cash Deposit';
      description = description ?? `Deposits already forwarded: ${live.join(', ')}`;
    }
  } else {
    const head = await ledgerHead(input.ledgerHeadId!);
    amount = input.amount!;
    bindingKey = bindings.financeEntry(user.uid, head.id, input.date, amount);
    entryLabel = `${head.type === 'income' ? 'Income' : 'Expense'} · ${head.name}`;
    if (input.branchId) branch = await branchRef(input.branchId);

    if (input.type === 'LEDGER_BACKDATE') {
      const applies = evalLedgerBackdate(rules.ledger.backdate, { entryDate: input.date, today, request: null });
      if (!applies) throw clientError(400, 'This entry is inside the allowed back-entry period — no approval is needed.');
    } else {
      const cfg = rules.company.shareIncome;
      if (!cfg.enabled || !cfg.allowApproval) throw clientError(400, 'Company Share income cannot be requested for approval.');
      if (head.code !== SYSTEM_LEDGER_HEAD_CODES.COMPANY_SHARE) throw clientError(400, 'This entry is not a Company Share income entry.');
    }
  }

  const { data, error } = await db
    .from('restriction_requests')
    .insert({
      type: input.type,
      binding_key: bindingKey,
      branch_id: branch?.id ?? null,
      branch_name: branch?.name ?? null,
      requested_date: input.date,
      current_business_date: today,
      amount,
      description,
      entry_label: entryLabel,
      reason: input.reason,
      requested_by: user.uid,
      requested_by_name: user.name,
    })
    .select(REQUEST_COLUMNS)
    .single();
  if (error) {
    // restriction_requests_open_idx: a request for this exact transaction is
    // already pending, or approved and unused.
    if (error.code === '23505') throw clientError(409, 'A request for this is already with Admin.');
    throw error;
  }

  const request = toRequest(data as unknown as Record<string, unknown>);
  await logRestrictionEvent({
    ruleCode: input.type,
    actor: user,
    branch,
    ref: request.requestNo,
    currentValue: restrictionDmy(input.date),
    threshold: restrictionDmy(today),
    action: 'Request approval',
    result: 'Approval requested',
  });
  return request;
}

/** Approve or reject. Only a pending request can be decided, and only once. */
export async function decideRestrictionRequest(
  id: string,
  decision: 'approved' | 'rejected',
  reason: string | undefined,
  admin: Actor,
): Promise<RestrictionRequest> {
  const { data, error } = await db.rpc('decide_restriction_request', {
    p_id: id,
    p_decision: decision,
    p_reason: reason ?? null,
    p_actor_id: admin.uid,
    p_actor_name: admin.name,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw clientError(409, 'This request has already been decided, or no longer exists.');

  const request = toRequest(row);
  await logRestrictionEvent({
    ruleCode: request.type,
    actor: admin,
    branch: request.branchId ? { id: request.branchId, name: request.branchName } : null,
    ref: request.requestNo,
    action: 'Admin decision',
    result: decision === 'approved' ? 'Approved' : 'Rejected',
    approvalNo: request.approvalNo,
  });
  return request;
}

// ─── Fact loaders ────────────────────────────────────────────────────────────

async function branchRef(branchId: string): Promise<BranchRef> {
  const { data, error } = await db.from('branches').select('id, name').eq('id', branchId).maybeSingle();
  if (error) throw error;
  if (!data) throw clientError(400, 'Branch not found');
  return { id: data.id as string, name: data.name as string };
}

async function ledgerHead(id: string): Promise<{ id: string; name: string; type: string; code: string }> {
  const { data, error } = await db.from('ledger_heads').select('id, name, type, code').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw clientError(404, 'Ledger head not found');
  return data as { id: string; name: string; type: string; code: string };
}

/**
 * The demands that count towards the pending-verification limit, oldest first:
 * status `awaiting_verification` — Production has sent the goods and the branch
 * has not yet confirmed receipt (the "Awaiting Verification" status on screen).
 * The branch clears them itself by verifying what it received. A `pending`
 * demand, still waiting on Production, does not count: the branch cannot act
 * on it.
 */
async function pendingDemands(branchId?: string): Promise<{ branchId: string; demandNumber: string; submittedAt: string }[]> {
  let query = db
    .from('production_orders')
    .select('branch_id, demand_number, submitted_at')
    .eq('status', 'awaiting_verification')
    .order('submitted_at', { ascending: true })
    .limit(1000);
  if (branchId) query = query.eq('branch_id', branchId);
  const { data, error } = await query;
  if (error) throw error;
  return rowToApi(data ?? []);
}

/**
 * CT numbers of a branch's live deposits for a business date, oldest first:
 * pending or approved, not deleted. A rejected or deleted deposit does not
 * count — the branch raises it again. THE definition of "counts towards the
 * daily limit"; cash-transfers.service.ts enforces through here.
 */
export async function liveDepositNumbers(branchId: string, businessDate: string): Promise<string[]> {
  const { data, error } = await withoutDeleted(db.from('cash_transfers').select('transfer_no'))
    .eq('branch_id', branchId)
    .eq('business_date', businessDate)
    .neq('status', 'rejected')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((d) => d.transfer_no as string);
}

/**
 * The current clock hour. Asia/Karachi is a whole-hour offset from UTC, so the
 * Karachi hour and the UTC hour start at the same instant.
 */
function currentHour(now: Date): { fromISO: string; label: string } {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  const hour = Math.floor(karachiMinutesOfDay(now) / 60);
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return { fromISO: start.toISOString(), label: `${hh(hour)}–${hh(hour + 1)}` };
}

// ─── Checks ──────────────────────────────────────────────────────────────────

/** A check, plus what the write path needs to enforce and audit it. */
export interface Evaluation {
  check: RestrictionCheck;
  /** Every restriction that fired, most severe or not. */
  restrictions: Restriction[];
  /** Approved requests this action is relying on; spent when it goes through. */
  approvals: RestrictionRequest[];
}

function evaluation(list: (Restriction | null)[], requests: (RestrictionRequest | null)[]): Evaluation {
  const restrictions = list.filter((r): r is Restriction => r !== null);
  const relied = new Set(restrictions.filter((r) => r.severity === 'approved').map((r) => r.requestId));
  return {
    check: pickRestriction(restrictions),
    restrictions,
    approvals: requests.filter((r): r is RestrictionRequest => r !== null && relied.has(r.id)),
  };
}

export async function checkDemand(input: {
  branchId: string;
  requiredDate?: string;
  claimedBusinessDate?: string;
  now?: Date;
}): Promise<Evaluation> {
  const now = input.now ?? new Date();
  const today = businessDateStr(now);
  const [rules, settings] = await Promise.all([getRestrictionRules(), getAppSettings()]);
  const cfg = rules.demand;

  const pending = cfg.pendingLimit.enabled ? await pendingDemands(input.branchId) : [];

  const backdatedDate = cfg.backdated.enabled
    ? backdatedDemandDate(today, input.requiredDate, input.claimedBusinessDate)
    : null;
  const request =
    backdatedDate && cfg.backdated.requireApproval
      ? await openRequest('BACKDATED_DEMAND', bindings.branchDate(input.branchId, backdatedDate))
      : null;

  // Closing time is the configured Business Hours value, never a literal.
  let lowSales: Restriction | null = null;
  if (cfg.lowSales.enabled) {
    const startMin = hhmmToMinutes(settings.businessStartTime);
    const closeMin = hhmmToMinutes(settings.businessClosingTime);
    if (startMin !== null && closeMin !== null) {
      const ctx = closingContext(karachiMinutesOfDay(now), startMin, closeMin, today);
      if (ctx.afterClosing) {
        const day = await computeBranchStockDay(input.branchId, ctx.tradingDate, today);
        lowSales = evalLowSales(cfg.lowSales, {
          afterClosing: true,
          applicableQty: day.openingQty + day.newQty,
          soldQty: day.soldQty,
        });
      }
    }
  }

  return evaluation(
    [
      evalPendingDemand(cfg.pendingLimit, pending.map((p) => p.demandNumber)),
      evalBackdatedDemand(cfg.backdated, { backdatedDate, today, request }),
      lowSales,
    ],
    [request],
  );
}

export async function checkSale(input: { branchId: string; now?: Date }): Promise<Evaluation> {
  const rules = await getRestrictionRules();
  const cfg = rules.sales.hourly;
  if (!cfg.enabled) return evaluation([], []);

  const hour = currentHour(input.now ?? new Date());
  // created_at, not business_date: the rule is about when entries were keyed,
  // by the server's clock. A device's own idea of the time has no say.
  const { count, error } = await db
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('branch_id', input.branchId)
    // Completed sales only: a counter sale is 'delivered' the moment it is
    // saved. An open or cancelled order is not sales activity.
    .eq('status', 'delivered')
    .gte('created_at', hour.fromISO);
  if (error) throw error;

  return evaluation([evalHourlySales(cfg, { count: count ?? 0, hourLabel: hour.label })], []);
}

export async function checkCashDeposit(input: { branchId: string; businessDate: string }): Promise<Evaluation> {
  const rules = await getRestrictionRules();
  const today = businessDateStr();
  const backdate = evalCashBackdate(rules.cash.backdate, { businessDate: input.businessDate, today });
  const cfg = rules.cash.dailyLimit;
  if (!cfg.enabled) return evaluation([backdate], []);

  const transferNos = await liveDepositNumbers(input.branchId, input.businessDate);
  const request =
    cfg.allowExceptions && transferNos.length >= cfg.limit
      ? await openRequest('CASH_DEPOSIT_LIMIT', bindings.branchDate(input.branchId, input.businessDate))
      : null;

  return evaluation(
    [backdate, evalCashLimit(cfg, { transferNos, businessDate: input.businessDate, today, request })],
    [request],
  );
}

export async function checkFinanceEntry(input: {
  userId: string;
  ledgerHeadId: string;
  businessDate: string;
  amount: number;
}): Promise<Evaluation> {
  const rules = await getRestrictionRules();
  const today = businessDateStr();
  if (!rules.ledger.backdate.enabled && !rules.company.shareIncome.enabled) return evaluation([], []);

  const head = await ledgerHead(input.ledgerHeadId);
  const key = bindings.financeEntry(input.userId, head.id, input.businessDate, input.amount);

  const isCompanyShare = head.code === SYSTEM_LEDGER_HEAD_CODES.COMPANY_SHARE;
  const shareRequest =
    rules.company.shareIncome.enabled && isCompanyShare ? await openRequest('COMPANY_SHARE_INCOME', key) : null;
  const share = evalCompanyShare(rules.company.shareIncome, { isCompanyShare, request: shareRequest });

  const needsBackdate = evalLedgerBackdate(rules.ledger.backdate, { entryDate: input.businessDate, today, request: null });
  const backRequest = needsBackdate ? await openRequest('LEDGER_BACKDATE', key) : null;
  const backdate = needsBackdate
    ? evalLedgerBackdate(rules.ledger.backdate, { entryDate: input.businessDate, today, request: backRequest })
    : null;

  // Company Share first: when both apply it is the one the user must clear
  // first, and pickRestriction keeps the earlier of two equals.
  return evaluation([share, backdate], [shareRequest, backRequest]);
}

// ─── Enforcement ─────────────────────────────────────────────────────────────

/**
 * Thrown when a restriction refuses a write. 409 with the standard
 * `{ allowed, restriction }` payload in `details`, which errorHandler already
 * passes through — the popup reads it and shows the notice in place of a toast.
 * `message` is a plain-text rendering for clients with no notice UI (the mobile
 * app's refusal banner, a curl).
 */
export class RestrictionError extends Error {
  status = 409;
  details: { code: 'restriction' } & RestrictionCheck;

  constructor(check: RestrictionCheck) {
    const r = check.restriction;
    super(r ? [r.title + ':', ...r.messages, ...(r.list ?? []), ...(r.after ?? [])].join(' ') : 'This action is restricted.');
    this.name = 'RestrictionError';
    this.details = { code: 'restriction', ...check };
  }
}

export interface RestrictionGuard {
  check: RestrictionCheck;
  /** The write succeeded: record what it was, and audit warnings and approvals used. */
  commit(ref: string): Promise<void>;
  /** The write failed after the guard passed: give back any approval it spent. */
  release(): Promise<void>;
}

/**
 * Enforce an evaluation on a write path.
 *
 * Refused → audited as Blocked and thrown. Allowed → any approval relied on is
 * SPENT NOW, before the write, with `UPDATE … WHERE consumed_at IS NULL`: two
 * requests racing on one approval cannot both get it, and a replay of an old
 * request finds it gone. If the write then fails, `release()` gives it back.
 */
export async function enforceRestrictions(
  ev: Evaluation,
  ctx: { action: string; actor: Actor; branch: BranchRef | null },
): Promise<RestrictionGuard> {
  if (!ev.check.allowed) {
    const top = ev.check.restriction!;
    await logRestrictionEvent({
      ruleCode: top.code,
      actor: ctx.actor,
      branch: ctx.branch,
      ref: top.requestNo ?? null,
      ...auditFigures(top),
      action: ctx.action,
      result: 'Blocked',
    });
    throw new RestrictionError(ev.check);
  }

  const spent: RestrictionRequest[] = [];
  const release = async () => {
    if (spent.length === 0) return;
    const { error } = await db
      .from('restriction_requests')
      .update({ consumed_at: null, consumed_ref: null })
      .in('id', spent.map((r) => r.id));
    if (error) console.error('[restrictions] failed to release approval', error);
    spent.length = 0;
  };

  for (const approval of ev.approvals) {
    const { data, error } = await db
      .from('restriction_requests')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', approval.id)
      .eq('status', 'approved')
      .is('consumed_at', null)
      .select('id');
    if (error) {
      await release();
      throw error;
    }
    if (!data || data.length === 0) {
      await release();
      throw new RestrictionError({
        allowed: false,
        restriction: {
          code: approval.type,
          severity: 'blocking',
          title: 'Approval Already Used',
          messages: [
            `Approval ${approval.approvalNo ?? approval.requestNo} has already been used.`,
            'An approval covers one transaction. Request a new one to continue.',
          ],
          requiresAdminApproval: true,
          canRequestApproval: true,
        },
      });
    }
    spent.push(approval);
  }

  return {
    check: ev.check,
    release,
    commit: async (ref: string) => {
      if (spent.length > 0) {
        const { error } = await db
          .from('restriction_requests')
          .update({ consumed_ref: ref })
          .in('id', spent.map((r) => r.id));
        if (error) console.error('[restrictions] failed to record approval use', error);
      }
      for (const approval of spent) {
        await logRestrictionEvent({
          ruleCode: approval.type,
          actor: ctx.actor,
          branch: ctx.branch,
          ref,
          action: ctx.action,
          result: 'Allowed',
          approvalNo: approval.approvalNo,
        });
      }
      for (const r of ev.restrictions.filter((x) => x.severity === 'warning')) {
        await logRestrictionEvent({
          ruleCode: r.code,
          actor: ctx.actor,
          branch: ctx.branch,
          ref,
          ...auditFigures(r),
          action: ctx.action,
          result: 'Warned',
        });
      }
    },
  };
}

// ─── Branch monitor ──────────────────────────────────────────────────────────

/** Live restriction state for every active branch, under the current rules. */
export async function getRestrictionMonitor(): Promise<RestrictionMonitorRow[]> {
  const now = new Date();
  const today = businessDateStr(now);
  const hour = currentHour(now);

  const [rules, branchesRes, pending, salesRes, depositsRes] = await Promise.all([
    getRestrictionRules(),
    db.from('branches').select('id, name').eq('is_active', true).order('name'),
    pendingDemands(),
    db.from('orders').select('branch_id').eq('status', 'delivered').gte('created_at', hour.fromISO).limit(5000),
    withoutDeleted(db.from('cash_transfers').select('branch_id'))
      .eq('business_date', today)
      .neq('status', 'rejected')
      .limit(5000),
  ]);
  if (branchesRes.error) throw branchesRes.error;
  if (salesRes.error) throw salesRes.error;
  if (depositsRes.error) throw depositsRes.error;

  const tally = (rows: { branch_id: unknown }[] | null) => {
    const counts = new Map<string, number>();
    for (const r of rows ?? []) counts.set(r.branch_id as string, (counts.get(r.branch_id as string) ?? 0) + 1);
    return counts;
  };
  const sales = tally(salesRes.data);
  const deposits = tally(depositsRes.data);

  return (branchesRes.data ?? []).map((b) => {
    const mine = pending.filter((p) => p.branchId === b.id);
    const verdict = evalPendingDemand(rules.demand.pendingLimit, mine.map((p) => p.demandNumber));
    return {
      branchId: b.id as string,
      branchName: b.name as string,
      pendingCount: mine.length,
      pendingDemandNumbers: mine.map((p) => p.demandNumber),
      oldestPending: mine[0] ? { demandNumber: mine[0].demandNumber, submittedAt: mine[0].submittedAt } : null,
      salesThisHour: sales.get(b.id as string) ?? 0,
      depositsToday: deposits.get(b.id as string) ?? 0,
      demandStatus: !verdict ? 'Normal' : restrictionAllows(verdict) ? 'Warning' : 'Blocked',
    };
  });
}
