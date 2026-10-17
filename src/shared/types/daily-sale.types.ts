// Daily Sale Record — one branch, one business day, reconciled.
//
// The record answers three questions in one row: what the sales system says was
// taken (AUTO), what a person physically counted (MANUAL), and the difference.
// It is a REPORTING LAYER over `orders` and `expenses` and modifies neither; a
// wrong auto figure means a wrong sale, corrected by correcting the sale.
//
// See migration 101 for the tables and the six functions every write goes
// through. Nothing here is computed on the client — the differences arrive as
// generated columns, and the helpers below only decide how to LABEL them.

import type { PaymentMethod } from './order.types';

/**
 * Where a record sits in the day's sign-off.
 *
 *   open                 — generated from sales; nothing counted yet
 *   pending_verification — a counted figure has been fed; awaiting sign-off
 *   verified             — signed off; still correctable by an admin
 *   locked               — closed; the branch cannot touch it
 *   amended              — locked, and an admin has since corrected a figure
 *
 * `amended` is a state of its own rather than a flag on `locked`, because "this
 * record changed after it was signed off" is the fact a reader must not have to
 * dig for.
 */
export type DailySaleRecordStatus =
  | 'open'
  | 'pending_verification'
  | 'verified'
  | 'locked'
  | 'amended';

export const DAILY_SALE_RECORD_STATUSES = [
  'open',
  'pending_verification',
  'verified',
  'locked',
  'amended',
] as const satisfies readonly DailySaleRecordStatus[];

export const DAILY_SALE_STATUS_LABELS: Record<DailySaleRecordStatus, string> = {
  open: 'Open',
  pending_verification: 'Pending Verification',
  verified: 'Verified',
  locked: 'Locked',
  amended: 'Amended',
};

/**
 * The two states in which a BRANCH may still write to a record.
 *
 * The client mirror of the rule `feed_daily_sale_record` enforces in SQL — same
 * relationship `isDiscountOpen` has to the status predicate in
 * branch-discounts.routes.ts. Used to decide which buttons render; it is never
 * the thing that stops a write.
 */
export function isDailySaleRecordOpen(status: DailySaleRecordStatus): boolean {
  return status === 'open' || status === 'pending_verification';
}

/**
 * The payment methods a person can be asked to count, and therefore the only ones
 * the Manual Feed form offers.
 *
 * Foodpanda is absent deliberately: the aggregator settles it and there is
 * nothing at the counter to count, so a "physically received" Foodpanda figure
 * would be somebody retyping the system's own number. §7 of the brief says the
 * same.
 *
 * MIRRORED IN SQL as `app.payment_method_default_locked()` (migration 101), which
 * is what decides the lock default for a branch with no stored configuration.
 * Change one, change the other — nothing enforces the match.
 */
export const DAILY_SALE_MANUAL_METHODS = [
  'cash',
  'easypaisa',
  'bank_account',
] as const satisfies readonly PaymentMethod[];

export type DailySaleManualMethod = (typeof DAILY_SALE_MANUAL_METHODS)[number];

/** Every method the reconciliation reports on, in the order the screens show them. */
export const DAILY_SALE_METHODS = [
  'cash',
  'easypaisa',
  'foodpanda',
  'bank_account',
] as const satisfies readonly PaymentMethod[];

export function isManualMethod(method: string): method is DailySaleManualMethod {
  return (DAILY_SALE_MANUAL_METHODS as readonly string[]).includes(method);
}

/**
 * The only columns an amendment may touch.
 *
 * Auto figures are absent and must stay absent: they are derived from `orders`,
 * so overwriting one would leave the books and the reconciliation each claiming
 * to be right about the same day. `amend_daily_sale_record` rejects anything else.
 */
export type DailySaleAmendField = 'manual_cash' | 'manual_easypaisa' | 'manual_bank';

export const DAILY_SALE_AMEND_FIELDS = [
  'manual_cash',
  'manual_easypaisa',
  'manual_bank',
] as const satisfies readonly DailySaleAmendField[];

export const DAILY_SALE_FIELD_LABELS: Record<DailySaleAmendField, string> = {
  manual_cash: 'Counted Cash',
  manual_easypaisa: 'Counted Easypaisa',
  manual_bank: 'Counted Bank',
};

/**
 * How a difference reads (§19).
 *
 * `matched` is reserved for an exact zero. There is no tolerance band and there
 * must not be one: a shop that is out by five rupees every day is out by 1,800 a
 * year, and a band wide enough to hide the noise is wide enough to hide a habit.
 * `uncounted` is the fourth case and the reason this returns a union rather than
 * a sign — nothing has been counted, which is not the same as nothing being wrong.
 */
export type DifferenceStatus = 'uncounted' | 'matched' | 'over' | 'short';

export function differenceStatus(difference: number | null | undefined): DifferenceStatus {
  if (difference === null || difference === undefined) return 'uncounted';
  if (difference === 0) return 'matched';
  return difference > 0 ? 'over' : 'short';
}

export const DIFFERENCE_STATUS_LABELS: Record<DifferenceStatus, string> = {
  uncounted: 'Not counted',
  matched: 'Matched',
  over: 'Over',
  short: 'Short',
};

/**
 * One day's reconciliation.
 *
 * `id` is null for a day that has sales but no stored record yet — the list
 * endpoint merges live figures over the stored ones so a branch sees today
 * before anybody has opened it. Every action on such a row generates the record
 * first; see `useFeedDailySale`.
 */
export interface DailySaleRecord {
  /** Null until the record exists in the database. */
  id: string | null;
  branchId: string;
  branchName: string;
  /** 'YYYY-MM-DD' (Karachi, 02:00 rollover). */
  businessDate: string;

  // ── AUTO — from the sales system. Never editable. ──
  /** Money taken, after discount, excluding cancelled and staff sales. */
  autoTotalSale: number;
  /**
   * The company's percentage of this branch's takings for this day, 0–100.
   *
   * The Admin configuration: the branch's own `companySharePct` where it has
   * one, else the global finance setting (`resolveShareSplit`). Where the day has
   * already been imported for income approval, the percentage snapshotted on that
   * approval is used instead, so a later change in Admin does not re-price a day
   * that was booked at the old rate.
   */
  companySharePct: number;
  /** `autoTotalSale × companySharePct`, to two places. Server-computed. */
  companyShare: number;
  /** `100 − companySharePct`. Derived, never stored independently. */
  branchSharePct: number;
  /** `autoTotalSale − companyShare`, to two places. Server-computed. */
  branchShare: number;
  autoCash: number;
  autoEasypaisa: number;
  autoFoodpanda: number;
  autoBank: number;
  /** Any payment method not among the four named ones. Normally 0. */
  autoOther: number;
  /** Staff consumption — goods out, no money in. Excluded from every total above. */
  autoStaff: number;
  /** Already deducted from `autoTotalSale`. Reported, never subtracted twice. */
  discount: number;
  /** Shop expenses paid from the till. Cash only. */
  cashExpense: number;
  /** Every shop expense for the day, whatever it was paid with. */
  expenseTotal: number;
  orderCount: number;
  /** When the auto figures were last read off the sales system. ISO UTC. */
  generatedAt: string;

  // ── MANUAL — what was counted. Null means not counted. ──
  manualCash: number | null;
  manualEasypaisa: number | null;
  manualBank: number | null;
  fedBy: string | null;
  fedByName: string | null;
  fedAt: string | null;

  // ── DIFFERENCE — derived in the database, never sent by a client. ──
  /** Counted cash minus `expectedCashInHand` (Cash on Table), not minus `autoCash`. */
  cashDifference: number | null;
  easypaisaDifference: number | null;
  bankDifference: number | null;
  /** The three above summed, an uncounted method counting as 0. */
  overallDifference: number;
  /** The payment breakdown re-added. Should equal `autoTotalSale`. */
  paymentTotal: number;
  /**
   * Cash on Table — what the drawer should hold: `autoCash − cashExpense`.
   * The counted cash is reconciled against THIS, not against `autoCash`.
   */
  expectedCashInHand: number;

  status: DailySaleRecordStatus;
  createdBy: string | null;
  createdByName: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  lockedBy: string | null;
  lockedByName: string | null;
  lockedAt: string | null;
  amendedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** One entry in a record's history (§17). Append-only. */
export interface DailySaleAudit {
  id: string;
  recordId: string | null;
  branchId: string;
  businessDate: string;
  action: DailySaleAuditAction;
  /** Which figure moved, or 'status'. Null for whole-record actions. */
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  createdAt: string;
}

export type DailySaleAuditAction =
  | 'generated'
  | 'refreshed'
  | 'manual_feed'
  /** An admin wrote into a method this branch has locked. Never routine. */
  | 'manual_feed_override'
  | 'verified'
  | 'locked'
  | 'unlocked'
  | 'amended'
  | 'method_locked'
  | 'method_unlocked';

export const DAILY_SALE_AUDIT_LABELS: Record<DailySaleAuditAction, string> = {
  generated: 'Record generated',
  refreshed: 'Sales figures refreshed',
  manual_feed: 'Manual figure entered',
  manual_feed_override: 'Admin override — locked method',
  verified: 'Verified',
  locked: 'Locked',
  unlocked: 'Unlocked',
  amended: 'Amended',
  method_locked: 'Payment method locked',
  method_unlocked: 'Payment method unlocked',
};

/**
 * Whether a branch may key a figure for one payment method.
 *
 * `source` is what makes the panel honest: 'default' means nobody has configured
 * this branch and the shared rule is being applied, which is a different fact
 * from an admin having deliberately set it — and the difference matters the first
 * time somebody asks why cash is open.
 */
export interface PaymentMethodLock {
  paymentMethod: PaymentMethod;
  isLocked: boolean;
  source: 'default' | 'configured';
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  reason: string | null;
}

/** A record plus everything the View popup and the print sheet need (§21, §22). */
export interface DailySaleRecordDetail {
  record: DailySaleRecord;
  audits: DailySaleAudit[];
  locks: PaymentMethodLock[];
  branch: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    city: string | null;
  };
}

/** The summary cards above the table (§18). Server-computed over the window on show. */
export interface DailySaleSummary {
  totalSale: number;
  cash: number;
  easypaisa: number;
  foodpanda: number;
  bank: number;
  cashExpense: number;
  discount: number;
  /** Sum of every row's `overallDifference`. */
  difference: number;
  /** How many rows have nothing counted yet — the difference above is blind to them. */
  uncounted: number;
}

export interface DailySaleRecordList {
  from: string;
  to: string;
  branchId: string | null;
  branchName: string | null;
  records: DailySaleRecord[];
  summary: DailySaleSummary;
  /** The caller's lock configuration, so the table can hide what it cannot offer. */
  locks: PaymentMethodLock[];
}

/** Widest window one list request will build, in days. Matches the branch closing export. */
export const DAILY_SALE_MAX_WINDOW_DAYS = 180;
