/**
 * Restriction Rules (migration 136) — admin-configured limits on what a branch
 * may do, evaluated by the API and shown inside the popup where the branch
 * attempts the action.
 *
 * The API is the authority. Every type here describes something the server
 * computed; nothing a client sends in these shapes is ever trusted back.
 */

export const RESTRICTION_CODES = [
  'DEMAND_PENDING_LIMIT',
  'BACKDATED_DEMAND',
  'LOW_SALES_AFTER_CLOSING',
  'HOURLY_SALES_LIMIT',
  'CASH_DEPOSIT_LIMIT',
  'CASH_DEPOSIT_BACKDATE',
  'LEDGER_BACKDATE',
  'COMPANY_SHARE_INCOME',
  'PRODUCTION_STOCK_SHORTAGE',
] as const;
export type RestrictionCode = (typeof RESTRICTION_CODES)[number];

/**
 * `warning` leaves the action available; `blocking` and
 * `admin_approval_required` do not. `approved` is the state after an admin has
 * said yes to a request and before the branch has used it.
 */
export type RestrictionSeverity = 'info' | 'warning' | 'blocking' | 'admin_approval_required' | 'approved';

export interface RestrictionStat {
  label: string;
  value: string;
}

/** One restriction, already worded for the popup that will show it. */
export interface Restriction {
  code: RestrictionCode;
  severity: RestrictionSeverity;
  title: string;
  /** Paragraphs shown before `list`. */
  messages: string[];
  /** Real identifiers from the database — demand numbers, CT numbers. */
  list?: string[];
  /** Paragraphs shown after `list`. */
  after?: string[];
  stats?: RestrictionStat[];
  /** Production stock short of a demand — one row per product, exact quantities. */
  shortages?: { productName: string; required: number; available: number; short: number }[];
  /** Sold-percentage bar: both values are 0–100. */
  meter?: { value: number; required: number };
  /** The admin's reason on a rejected request. */
  reason?: string;
  threshold?: number;
  currentValue?: number;
  requiresAdminApproval: boolean;
  /** Whether the popup may offer "Request Admin Approval" for this restriction. */
  canRequestApproval?: boolean;
  /** The request this restriction is about, once one exists. */
  requestId?: string;
  requestNo?: string;
  approvalNo?: string;
  requestStatus?: RestrictionRequestStatus;
}

/**
 * The standard answer to "may this branch do this now?". `restriction` is the
 * single most severe one — a popup shows one notice, never a stack.
 */
export interface RestrictionCheck {
  allowed: boolean;
  restriction: Restriction | null;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export const RESTRICTION_GROUPS = ['demand', 'sales', 'production', 'cash', 'ledger', 'company'] as const;
export type RestrictionGroup = (typeof RESTRICTION_GROUPS)[number];

export interface RestrictionRules {
  demand: {
    /** Counts demands in `awaiting_verification` — sent by Production, not yet verified by the branch. */
    pendingLimit: { enabled: boolean; warnAt: number; blockAt: number };
    backdated: { enabled: boolean; requireApproval: boolean };
    lowSales: { enabled: boolean; minSoldPercent: number };
  };
  sales: {
    /**
     * Minimum sales activity: a branch that has recorded fewer than `threshold`
     * completed sales in the current hour is shown a warning. Never blocks — a
     * till must not be stopped for selling too little.
     */
    hourly: { enabled: boolean; threshold: number };
  };
  production: {
    /**
     * Submit for Verification is refused while any product on the demand asks
     * for more than the available production stock. `allowAdminOverride` is
     * whether a Super Admin may still send a short demand through; a production
     * user never can.
     */
    stockShortage: { enabled: boolean; allowAdminOverride: boolean };
  };
  cash: {
    dailyLimit: { enabled: boolean; limit: number; allowExceptions: boolean };
    /**
     * How far back a deposit may be dated, in business days before today
     * (0 = today only). Off → the 7-day sync window every write has.
     */
    backdate: { enabled: boolean; allowedDays: number };
  };
  ledger: {
    backdate: { enabled: boolean; allowedDays: number };
  };
  company: {
    shareIncome: { enabled: boolean; allowApproval: boolean };
  };
}

export const DEFAULT_RESTRICTION_RULES: RestrictionRules = {
  demand: {
    pendingLimit: { enabled: true, warnAt: 2, blockAt: 3 },
    backdated: { enabled: true, requireApproval: true },
    lowSales: { enabled: true, minSoldPercent: 30 },
  },
  sales: {
    hourly: { enabled: true, threshold: 2 },
  },
  production: { stockShortage: { enabled: true, allowAdminOverride: true } },
  cash: {
    dailyLimit: { enabled: true, limit: 3, allowExceptions: true },
    backdate: { enabled: true, allowedDays: 1 },
  },
  ledger: { backdate: { enabled: true, allowedDays: 3 } },
  company: { shareIncome: { enabled: true, allowApproval: true } },
};

/** What the admin screen loads: the rules plus when each group was last saved. */
export interface RestrictionRulesState {
  rules: RestrictionRules;
  saved: Record<RestrictionGroup, { updatedAt: string | null; updatedByName: string | null }>;
  businessDate: string;
  timezone: string;
  /** 'HH:mm' — the configured business closing time (Business Hours). */
  closingTime: string;
}

// ─── Approval requests ───────────────────────────────────────────────────────

/** The most a deposit's back-date period can be raised to, in days. */
export const CASH_DEPOSIT_MAX_BACKDATE_DAYS = 30;

/** The rules an admin can approve a one-time exception to. */
export const RESTRICTION_REQUEST_TYPES = [
  'BACKDATED_DEMAND',
  'LEDGER_BACKDATE',
  'COMPANY_SHARE_INCOME',
  'CASH_DEPOSIT_LIMIT',
] as const;
export type RestrictionRequestType = (typeof RESTRICTION_REQUEST_TYPES)[number];

export type RestrictionRequestStatus = 'pending' | 'approved' | 'rejected';

export const RESTRICTION_REQUEST_TYPE_LABELS: Record<RestrictionRequestType, string> = {
  BACKDATED_DEMAND: 'Backdated Demand',
  LEDGER_BACKDATE: 'Ledger Back-entry',
  COMPANY_SHARE_INCOME: 'Company Share Income',
  CASH_DEPOSIT_LIMIT: 'Cash Deposit Exception',
};

export const RESTRICTION_REQUEST_STATUS_LABELS: Record<RestrictionRequestStatus, string> = {
  pending: 'Pending Admin Approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export interface RestrictionRequest {
  id: string;
  requestNo: string;
  type: RestrictionRequestType;
  branchId: string | null;
  branchName: string | null;
  /** The date the held transaction is for ('YYYY-MM-DD'). */
  requestedDate: string;
  currentBusinessDate: string;
  amount: number | null;
  description: string | null;
  /** What kind of entry — "Expense · Utilities", "Company Share", … */
  entryLabel: string | null;
  reason: string;
  requestedBy: string | null;
  requestedByName: string;
  requestedAt: string;
  status: RestrictionRequestStatus;
  approvalNo: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  adminReason: string | null;
  /** Set once the approval has been used; it cannot be used again. */
  consumedAt: string | null;
  /** The transaction the approval was spent on — a demand number, voucher, CT number. */
  consumedRef: string | null;
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export type RestrictionEventResult =
  | 'Blocked'
  | 'Warned'
  | 'Approval requested'
  | 'Approved'
  | 'Rejected'
  | 'Allowed'
  | 'Updated';

export interface RestrictionEvent {
  id: string;
  eventNo: string;
  ruleCode: RestrictionCode | 'RULES_CONFIG';
  branchName: string | null;
  userName: string | null;
  /** Transaction or request the event is about. */
  ref: string | null;
  currentValue: string | null;
  threshold: string | null;
  action: string;
  result: RestrictionEventResult;
  approvalNo: string | null;
  createdAt: string;
}

// ─── Branch monitor ──────────────────────────────────────────────────────────

export interface RestrictionMonitorRow {
  branchId: string;
  branchName: string;
  pendingCount: number;
  pendingDemandNumbers: string[];
  oldestPending: { demandNumber: string; submittedAt: string } | null;
  salesThisHour: number;
  depositsToday: number;
  demandStatus: 'Normal' | 'Warning' | 'Blocked';
}
