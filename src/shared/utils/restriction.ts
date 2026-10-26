import { addDaysToDateStr, daysBetweenDateStr } from './hijri';
import { BUSINESS_DAY_START_MINUTES, isWithinOrderWindow } from './timezone';
import {
  DEFAULT_RESTRICTION_RULES,
  RESTRICTION_GROUPS,
  type Restriction,
  type RestrictionCheck,
  type RestrictionCode,
  type RestrictionGroup,
  type RestrictionRequest,
  type RestrictionRules,
  type RestrictionSeverity,
} from '../types/restriction.types';

/**
 * The restriction rules as PURE functions: configuration and already-loaded
 * facts in, a worded restriction (or null) out. No database, no clock.
 *
 * In the shared package, apart from the API's restriction.service.ts, for two
 * reasons: every threshold and boundary (2 warns, 3 blocks, the 4th day back
 * needs approval) can be tested without a database; and the admin "Popup
 * Preview" renders through these same functions, so it cannot drift from what a
 * branch is actually shown. The web app only ever uses them to PREVIEW — the
 * decision is the API's, made from facts the API loaded.
 */

/** The slice of a request the evaluators need. */
export type RequestState = Pick<RestrictionRequest, 'id' | 'requestNo' | 'status' | 'approvalNo' | 'adminReason'>;

const SEVERITY_RANK: Record<RestrictionSeverity, number> = {
  blocking: 4,
  admin_approval_required: 3,
  approved: 2,
  warning: 1,
  info: 0,
};

/** Whether the action may go ahead under this restriction. */
export function restrictionAllows(r: Restriction | null): boolean {
  return !r || (r.severity !== 'blocking' && r.severity !== 'admin_approval_required');
}

/**
 * Reduce every restriction that fired to the one the popup shows: the most
 * severe, first-evaluated winning a tie. `allowed` is decided over ALL of them,
 * so a warning can never hide a block behind it.
 */
export function pickRestriction(list: (Restriction | null)[]): RestrictionCheck {
  const fired = list.filter((r): r is Restriction => r !== null);
  let top: Restriction | null = null;
  for (const r of fired) {
    if (!top || SEVERITY_RANK[r.severity] > SEVERITY_RANK[top.severity]) top = r;
  }
  return { allowed: fired.every(restrictionAllows), restriction: top };
}

/**
 * Stored group configs merged over the defaults, one rule at a time, so a rule
 * or a key added after a group was last saved still has a value.
 */
export function mergeRules(stored: Partial<Record<RestrictionGroup, unknown>>): RestrictionRules {
  const out = structuredClone(DEFAULT_RESTRICTION_RULES) as unknown as Record<string, Record<string, Record<string, unknown>>>;
  for (const group of RESTRICTION_GROUPS) {
    const saved = stored[group];
    if (!saved || typeof saved !== 'object') continue;
    for (const [rule, defaults] of Object.entries(out[group]!)) {
      const savedRule = (saved as Record<string, unknown>)[rule];
      if (!savedRule || typeof savedRule !== 'object') continue;
      for (const key of Object.keys(defaults)) {
        const value = (savedRule as Record<string, unknown>)[key];
        if (value !== undefined && value !== null && typeof value === typeof defaults[key]) defaults[key] = value;
      }
    }
  }
  return out as unknown as RestrictionRules;
}

/** 'YYYY-MM-DD' → 'DD-MM-YYYY', the way dates are written on every screen. */
export function restrictionDmy(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ─── Approval-gated rules share one shape ────────────────────────────────────

interface ApprovalCopy {
  code: RestrictionCode;
  required: { title: string; messages: string[] };
  rejected: { title: string; messages: string[] };
  approved: { messages: string[] };
  /** Shown when the admin has switched approvals off for this rule. */
  closed: { title: string; messages: string[] };
  stats?: Restriction['stats'];
  threshold?: number;
  currentValue?: number;
}

/**
 * The four states of a rule that Admin can lift once: nothing asked yet,
 * waiting, refused (with the admin's reason), and approved.
 *
 * `request` is the latest request for this exact transaction that has not been
 * spent — looked up by the server from its own binding, never taken from the
 * client. A rejection can be asked again; a pending one cannot be duplicated.
 */
function approvalGated(copy: ApprovalCopy, approvalsOpen: boolean, request: RequestState | null): Restriction {
  const base = { code: copy.code, stats: copy.stats, threshold: copy.threshold, currentValue: copy.currentValue };

  if (!approvalsOpen) {
    return { ...base, severity: 'blocking', title: copy.closed.title, messages: copy.closed.messages, requiresAdminApproval: false };
  }

  if (request?.status === 'approved') {
    return {
      ...base,
      severity: 'approved',
      title: 'Admin Approved ✓',
      messages: copy.approved.messages,
      stats: [
        { label: 'Approval', value: request.approvalNo ?? '—' },
        { label: 'Request', value: request.requestNo },
      ],
      requiresAdminApproval: false,
      requestId: request.id,
      requestNo: request.requestNo,
      approvalNo: request.approvalNo ?? undefined,
      requestStatus: 'approved',
    };
  }

  if (request?.status === 'rejected') {
    return {
      ...base,
      severity: 'blocking',
      title: copy.rejected.title,
      messages: copy.rejected.messages,
      reason: request.adminReason ?? undefined,
      requiresAdminApproval: true,
      canRequestApproval: true,
      requestId: request.id,
      requestNo: request.requestNo,
      approvalNo: request.approvalNo ?? undefined,
      requestStatus: 'rejected',
    };
  }

  if (request?.status === 'pending') {
    return {
      ...base,
      severity: 'admin_approval_required',
      title: 'Waiting for Admin Approval',
      messages: [`Request ${request.requestNo} has been sent to Admin.`, 'This cannot continue until Admin approves it.'],
      requiresAdminApproval: true,
      canRequestApproval: false,
      requestId: request.id,
      requestNo: request.requestNo,
      requestStatus: 'pending',
    };
  }

  return {
    ...base,
    severity: 'admin_approval_required',
    title: copy.required.title,
    messages: copy.required.messages,
    requiresAdminApproval: true,
    canRequestApproval: true,
  };
}

// ─── Demand ──────────────────────────────────────────────────────────────────

/**
 * Pending-verification limit. `pendingNumbers` are the branch's real demand
 * numbers in the Awaiting Verification status, oldest first.
 */
export function evalPendingDemand(
  cfg: RestrictionRules['demand']['pendingLimit'],
  pendingNumbers: string[],
): Restriction | null {
  if (!cfg.enabled) return null;
  const count = pendingNumbers.length;
  const list = pendingNumbers.map((n) => `#${n}`);

  if (count >= cfg.blockAt) {
    return {
      code: 'DEMAND_PENDING_LIMIT',
      severity: 'blocking',
      title: 'New Demand Not Authorized',
      messages: [plural(count, 'Your demand number:', 'Your demand numbers:')],
      list,
      after: [
        plural(count, 'is still awaiting verification.', 'are still awaiting verification.'),
        'You cannot forward a new demand until the pending demands are verified.',
        'Please contact the Admin to resolve this issue.',
      ],
      threshold: cfg.blockAt,
      currentValue: count,
      requiresAdminApproval: false,
    };
  }

  if (count >= cfg.warnAt && count > 0) {
    return {
      code: 'DEMAND_PENDING_LIMIT',
      severity: 'warning',
      title: 'Warning',
      messages: [
        `You currently have ${count} ${plural(count, 'demand', 'demands')} awaiting verification.`,
        'Please wait for verification before submitting additional demands.',
        'Pending Demand Numbers:',
      ],
      list,
      threshold: cfg.blockAt,
      currentValue: count,
      requiresAdminApproval: false,
    };
  }

  return null;
}

/**
 * The date that makes a demand backdated, or null when it is not.
 *
 * Either date counts: the Required Date the branch picked, or the business date
 * a device claims the demand was raised on. The earlier of the two is what the
 * approval is bound to.
 */
export function backdatedDemandDate(
  today: string,
  requiredDate: string | undefined,
  claimedBusinessDate: string | undefined,
): string | null {
  const past = [requiredDate, claimedBusinessDate].filter((d): d is string => !!d && d < today).sort();
  return past[0] ?? null;
}

export function evalBackdatedDemand(
  cfg: RestrictionRules['demand']['backdated'],
  input: { backdatedDate: string | null; today: string; request: RequestState | null },
): Restriction | null {
  if (!cfg.enabled || !input.backdatedDate) return null;
  return approvalGated(
    {
      code: 'BACKDATED_DEMAND',
      required: {
        title: 'Backdated Demand',
        messages: [
          'This demand uses a previous business date.',
          'Admin approval is required before this demand can be forwarded.',
        ],
      },
      rejected: { title: 'Backdated Demand Rejected', messages: ['This demand was not approved by Admin.'] },
      approved: { messages: ['Backdated demand is authorized.'] },
      closed: {
        title: 'Backdated Demand',
        messages: ['This demand uses a previous business date.', 'Backdated demands are not allowed. Please contact Admin.'],
      },
      stats: [
        { label: 'Requested', value: restrictionDmy(input.backdatedDate) },
        { label: 'Current', value: restrictionDmy(input.today) },
      ],
    },
    cfg.requireApproval,
    input.request,
  );
}

/**
 * Where "now" sits relative to the configured business hours.
 *
 * `afterClosing` is true in the gap between the closing time and the next
 * opening time. `tradingDate` is the business date of the trading day that just
 * closed — which is YESTERDAY's business date once the 02:00 rollover has
 * passed, because the new business date has not opened for trade yet and has
 * sold nothing by definition.
 */
export function closingContext(
  minutesOfDay: number,
  startMin: number,
  closeMin: number,
  today: string,
): { afterClosing: boolean; tradingDate: string } {
  const afterClosing = !isWithinOrderWindow(minutesOfDay, startMin, closeMin);
  const sinceRollover = (m: number) => (m - BUSINESS_DAY_START_MINUTES + 1440) % 1440;
  const beforeTodaysOpening = sinceRollover(minutesOfDay) < sinceRollover(startMin);
  return { afterClosing, tradingDate: afterClosing && beforeTodaysOpening ? addDaysToDateStr(today, -1) : today };
}

/**
 * After closing, a new demand is refused while less than the minimum share of
 * the day's applicable stock (opening + received) has been sold. A branch that
 * held no stock that day has nothing to be measured against and is not blocked.
 */
export function evalLowSales(
  cfg: RestrictionRules['demand']['lowSales'],
  input: { afterClosing: boolean; applicableQty: number; soldQty: number },
): Restriction | null {
  if (!cfg.enabled || !input.afterClosing || input.applicableQty <= 0) return null;
  // One decimal, rounded DOWN: 29.96% must not display as 30.0% and still block.
  const pct = Math.floor((input.soldQty / input.applicableQty) * 1000) / 10;
  if (pct >= cfg.minSoldPercent) return null;

  const remaining = Math.max(input.applicableQty - input.soldQty, 0);
  return {
    code: 'LOW_SALES_AFTER_CLOSING',
    severity: 'blocking',
    title: 'Demand Forwarding Restricted',
    messages: [
      'Your current stock is still standing.',
      `Only ${pct}% of the applicable stock has been sold.`,
      `Minimum required sold percentage: ${cfg.minSoldPercent}%`,
      'Please sell the available stock before forwarding a new demand.',
    ],
    meter: { value: Math.min(pct, 100), required: cfg.minSoldPercent },
    stats: [
      { label: 'Applicable Stock', value: String(input.applicableQty) },
      { label: 'Sold', value: String(input.soldQty) },
      { label: 'Remaining', value: String(remaining) },
      { label: 'Sold Percentage', value: `${pct}%` },
      { label: 'Required', value: `${cfg.minSoldPercent}%` },
    ],
    threshold: cfg.minSoldPercent,
    currentValue: pct,
    requiresAdminApproval: false,
  };
}

// ─── Sales ───────────────────────────────────────────────────────────────────

/**
 * Hourly sales activity — a MINIMUM, not a cap. `count` is the number of
 * completed sales the branch has recorded in the current clock hour; while it
 * is below the required number the New Sale popup carries a warning. It never
 * blocks: refusing a sale because too few were made would only make it worse.
 */
export function evalHourlySales(
  cfg: RestrictionRules['sales']['hourly'],
  input: { count: number; hourLabel: string },
): Restriction | null {
  if (!cfg.enabled || input.count >= cfg.threshold) return null;
  return {
    code: 'HOURLY_SALES_LIMIT',
    severity: 'warning',
    title: 'Sales Activity Warning',
    messages: [
      input.count === 0
        ? 'Your branch has not recorded any sale during the current hourly period.'
        : `Your branch has recorded only ${input.count} ${plural(input.count, 'sale', 'sales')} during the current hourly period.`,
      'Please continue normal sales activity.',
    ],
    stats: [
      { label: 'Business hour', value: input.hourLabel },
      { label: 'Sales this hour', value: `${input.count} / ${cfg.threshold}` },
    ],
    threshold: cfg.threshold,
    currentValue: input.count,
    requiresAdminApproval: false,
  };
}

// ─── Production ──────────────────────────────────────────────────────────────

/**
 * Whether Submit for Verification must be checked against production stock.
 *
 * `adminOverride` is a Super Admin consciously sending a short demand through
 * (`?override=1`); the route has already established the role. It is honoured
 * only while the rule allows it, and it is the ONLY way past the check — adding
 * stock makes the check pass, it never approves anything by itself.
 */
export function enforcesProductionStock(
  cfg: RestrictionRules['production']['stockShortage'],
  input: { adminOverride: boolean },
): boolean {
  if (!cfg.enabled) return false;
  return !(input.adminOverride && cfg.allowAdminOverride);
}

/**
 * Production stock short of a demand at "Submit for Verification". Names every
 * short product with its exact quantities — never a bare "stock is
 * insufficient". The arithmetic is the database's (review_production_order_checked);
 * this only words it.
 */
export function evalProductionShortage(
  shortfalls: { productName: string; requested: number; available: number; shortage: number }[],
): Restriction | null {
  if (shortfalls.length === 0) return null;
  return {
    code: 'PRODUCTION_STOCK_SHORTAGE',
    severity: 'blocking',
    title: 'Production Stock Shortage',
    messages: ['Production stock is less than demand stock.'],
    shortages: shortfalls.map((s) => ({
      productName: s.productName,
      required: s.requested,
      available: s.available,
      short: s.shortage,
    })),
    after: [
      'Please add new stock for the required products.',
      'After adding the new stock, contact the Admin for approval of this demand.',
    ],
    requiresAdminApproval: false,
  };
}

// ─── Cash deposit ────────────────────────────────────────────────────────────

/**
 * Daily cash-deposit limit. `transferNos` are the CT numbers of the branch's
 * live deposits for the business date (pending or approved; rejected and deleted
 * ones do not count), oldest first.
 */
export function evalCashLimit(
  cfg: RestrictionRules['cash']['dailyLimit'],
  input: { transferNos: string[]; businessDate: string; today: string; request: RequestState | null },
): Restriction | null {
  const count = input.transferNos.length;
  if (!cfg.enabled || count < cfg.limit) return null;

  const day = input.businessDate === input.today ? 'today' : restrictionDmy(input.businessDate);
  const forwarded = {
    messages: [
      `Your ${cfg.limit} allowed cash-deposit ${plural(cfg.limit, 'transaction', 'transactions')} for ${day} ${plural(cfg.limit, 'has', 'have')} already been forwarded.`,
      plural(count, 'Your CT-Number:', 'Your CT-Numbers:'),
    ],
    list: input.transferNos,
  };
  const base = { code: 'CASH_DEPOSIT_LIMIT' as const, threshold: cfg.limit, currentValue: count };

  if (cfg.allowExceptions && input.request?.status === 'approved') {
    return {
      ...base,
      severity: 'approved',
      title: 'Admin Approved ✓',
      messages: ['One additional cash deposit is authorized.'],
      stats: [
        { label: 'Approval', value: input.request.approvalNo ?? '—' },
        { label: 'Request', value: input.request.requestNo },
      ],
      requiresAdminApproval: false,
      requestId: input.request.id,
      requestNo: input.request.requestNo,
      approvalNo: input.request.approvalNo ?? undefined,
      requestStatus: 'approved',
    };
  }

  const pending = cfg.allowExceptions && input.request?.status === 'pending';
  const rejected = cfg.allowExceptions && input.request?.status === 'rejected';
  return {
    ...base,
    ...forwarded,
    severity: 'blocking',
    title: 'Cash Deposit Limit Reached',
    after: [
      plural(count, 'has been forwarded.', 'have been forwarded.'),
      pending
        ? `Request ${input.request!.requestNo} for one more deposit is waiting for Admin.`
        : rejected
          ? 'Admin did not approve an additional deposit.'
          : 'For additional cash-deposit transactions, please contact Admin.',
    ],
    reason: rejected ? (input.request!.adminReason ?? undefined) : undefined,
    requiresAdminApproval: cfg.allowExceptions,
    canRequestApproval: cfg.allowExceptions && !pending,
    requestId: input.request?.id,
    requestNo: input.request?.requestNo,
    requestStatus: cfg.allowExceptions ? input.request?.status : undefined,
  };
}

/**
 * Back-dated deposit. A deposit dated up to `allowedDays` before the business
 * date goes in; anything older is refused. A future date is not this rule's
 * concern (the API refuses it before any rule runs).
 */
export function evalCashBackdate(
  cfg: RestrictionRules['cash']['backdate'],
  input: { businessDate: string; today: string },
): Restriction | null {
  if (!cfg.enabled) return null;
  const daysBack = daysBetweenDateStr(input.businessDate, input.today);
  if (daysBack <= cfg.allowedDays) return null;

  const period =
    cfg.allowedDays === 0 ? 'today only' : cfg.allowedDays === 1 ? 'today or yesterday only' : `up to ${cfg.allowedDays} days back only`;
  return {
    code: 'CASH_DEPOSIT_BACKDATE',
    severity: 'blocking',
    title: 'Back-dated Cash Deposit',
    messages: [
      `This deposit is dated ${restrictionDmy(input.businessDate)}.`,
      `A cash deposit can be dated ${period}.`,
      'For an older deposit, please contact Admin.',
    ],
    stats: [
      { label: 'Deposit date', value: restrictionDmy(input.businessDate) },
      { label: 'Business date', value: restrictionDmy(input.today) },
      { label: 'Allowed from', value: restrictionDmy(addDaysToDateStr(input.today, -cfg.allowedDays)) },
      { label: 'Days back', value: String(daysBack) },
    ],
    threshold: cfg.allowedDays,
    currentValue: daysBack,
    requiresAdminApproval: false,
  };
}

// ─── Finance entry ───────────────────────────────────────────────────────────

/**
 * Ledger back-entry. An entry dated up to `allowedDays` before the business
 * date is saved directly; anything older is held for Admin. A future date is
 * not this rule's concern.
 */
export function evalLedgerBackdate(
  cfg: RestrictionRules['ledger']['backdate'],
  input: { entryDate: string; today: string; request: RequestState | null },
): Restriction | null {
  if (!cfg.enabled) return null;
  const daysBack = daysBetweenDateStr(input.entryDate, input.today);
  if (daysBack <= cfg.allowedDays) return null;

  return approvalGated(
    {
      code: 'LEDGER_BACKDATE',
      required: {
        title: 'Backdated Ledger Entry',
        messages: [
          `This entry is older than the allowed ${cfg.allowedDays}-day back-entry period.`,
          'Admin approval is required.',
        ],
      },
      rejected: { title: 'Ledger Entry Rejected', messages: ['Admin did not approve this backdated entry.'] },
      approved: { messages: ['Backdated ledger entry is authorized.'] },
      // The ledger rule has no "approvals off" switch; kept for the shared shape.
      closed: { title: 'Backdated Ledger Entry', messages: ['This entry is older than the allowed back-entry period.'] },
      stats: [
        { label: 'Entry date', value: restrictionDmy(input.entryDate) },
        { label: 'Business date', value: restrictionDmy(input.today) },
        { label: 'Allowed from', value: restrictionDmy(addDaysToDateStr(input.today, -cfg.allowedDays)) },
        { label: 'Days back', value: String(daysBack) },
      ],
      threshold: cfg.allowedDays,
      currentValue: daysBack,
    },
    true,
    input.request,
  );
}

/** Company Share keyed as an ordinary income entry. */
export function evalCompanyShare(
  cfg: RestrictionRules['company']['shareIncome'],
  input: { isCompanyShare: boolean; request: RequestState | null },
): Restriction | null {
  if (!cfg.enabled || !input.isCompanyShare) return null;
  const why = [
    'Company Share cannot be entered directly as normal income.',
    'Company Share is received through Branch Cash Deposit.',
  ];
  return approvalGated(
    {
      code: 'COMPANY_SHARE_INCOME',
      required: {
        title: 'Company Share Requires Admin Approval',
        messages: [...why, 'Admin approval is required for this Income entry.'],
      },
      rejected: {
        title: 'Company Share Income Rejected',
        messages: ['Admin did not authorize this company-share income entry.'],
      },
      approved: { messages: ['Company Share income entry is authorized.'] },
      closed: { title: 'Company Share Cannot Be Entered as Income', messages: why },
    },
    cfg.allowApproval,
    input.request,
  );
}
