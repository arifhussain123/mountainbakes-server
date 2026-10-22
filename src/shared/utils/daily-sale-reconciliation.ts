import type { DailySaleRecord } from '../types/daily-sale.types';

/**
 * A Daily Sale Record's counted money set against its table, method by method,
 * and whether the day is VERIFIED.
 *
 *   Cash difference      = counted cash − Cash on Table
 *   Easypaisa difference = received Easypaisa − Easypaisa on table
 *   Bank difference      = received bank − bank on table
 *
 * Cash on Table is `expectedCashInHand` — the till's cash takings less the cash
 * expenses already paid out of the drawer — the same basis as the
 * `cash_difference` column (migration 102).
 *
 * WHERE THE NUMBERS COME FROM. A saved record's differences are the database's
 * own generated columns (`cash_difference`, `easypaisa_difference`,
 * `bank_difference`, numeric(14,2)) — the backend is the source of truth and
 * nothing here re-derives them. `reconcileMethod` works one out only for a
 * figure still being typed, in whole paisa so a float can neither hide a
 * difference nor invent one.
 *
 * VERIFIED needs every required method counted and equal to the paisa. Cash and
 * Easypaisa are always required. Bank is part of the same count: required when
 * the day took bank payments or when someone entered a bank figure; a day with
 * no bank takings and nothing entered has nothing to verify there. A missing or
 * invalid figure is never read as 0, so it can only ever make a day NOT
 * VERIFIED. There is no tolerance band (see `differenceStatus`).
 *
 * This reads the record; it never changes a sale, a count or a record.
 */

export type ReconMethodKey = 'cash' | 'easypaisa' | 'bank';
export type ReconMethodStatus = 'missing' | 'match' | 'short' | 'over';

export const RECON_METHOD_LABELS: Record<ReconMethodKey, string> = {
  cash: 'Cash',
  easypaisa: 'Easypaisa',
  bank: 'Bank',
};

export interface MethodReconciliation {
  method: ReconMethodKey;
  /** What the table says this method should come to; null when it is not a usable number. */
  tableAmount: number | null;
  /** What was counted / received; null while nothing (or nothing valid) is entered. */
  counted: number | null;
  /** counted − tableAmount, to the paisa; null while either side is missing. */
  difference: number | null;
  status: ReconMethodStatus;
}

export interface DailySaleVerification {
  cash: MethodReconciliation;
  easypaisa: MethodReconciliation;
  /** Null when the day had no bank takings and nothing was entered — nothing to verify. */
  bank: MethodReconciliation | null;
  verified: boolean;
  /** What stops VERIFIED, in words: "Cash − Rs. 500", "Easypaisa not entered". Empty when verified. */
  problems: string[];
}

const toPaisa = (n: number) => Math.round(n * 100);

function usable(n: number | string | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  if (typeof n === 'string' && n.trim() === '') return null;
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : null;
}

function statusOf(difference: number | null): ReconMethodStatus {
  if (difference === null) return 'missing';
  const p = toPaisa(difference);
  return p === 0 ? 'match' : p < 0 ? 'short' : 'over';
}

/** One method from its two figures — for a count still being typed, so a string is accepted. */
export function reconcileMethod(
  method: ReconMethodKey,
  tableAmount: number | string | null | undefined,
  counted: number | string | null | undefined,
): MethodReconciliation {
  const table = usable(tableAmount);
  const count = usable(counted);
  const difference = table === null || count === null ? null : (toPaisa(count) - toPaisa(table)) / 100;
  return { method, tableAmount: table, counted: count, difference, status: statusOf(difference) };
}

/** One method of a saved record: the database's difference, never re-derived. */
function savedMethod(
  method: ReconMethodKey,
  tableAmount: number | null | undefined,
  counted: number | null | undefined,
  savedDifference: number | null | undefined,
): MethodReconciliation {
  const table = usable(tableAmount);
  const count = usable(counted);
  const difference = table === null || count === null ? null : usable(savedDifference);
  return { method, tableAmount: table, counted: count, difference, status: statusOf(difference) };
}

/** "− Rs. 500", "+ Rs. 200", "Rs. 0" — a real minus sign, and the sign before the symbol. */
export function formatSignedRupees(difference: number, symbol = 'Rs.'): string {
  const abs = Math.abs(difference).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  if (toPaisa(difference) === 0) return `${symbol} 0`;
  return `${difference < 0 ? '−' : '+'} ${symbol} ${abs}`;
}

/** VERIFIED and what stands in its way, from any set of methods (live or saved). */
export function verifyMethods(
  cash: MethodReconciliation,
  easypaisa: MethodReconciliation,
  bank: MethodReconciliation | null,
  symbol = 'Rs.',
): DailySaleVerification {
  const problems = [cash, easypaisa, ...(bank ? [bank] : [])]
    .filter((m) => m.status !== 'match')
    .map((m) =>
      m.status === 'missing'
        ? `${RECON_METHOD_LABELS[m.method]} not entered`
        : `${RECON_METHOD_LABELS[m.method]} ${formatSignedRupees(m.difference!, symbol)}`,
    );
  return { cash, easypaisa, bank, verified: problems.length === 0, problems };
}

/** Whether bank has anything to verify: takings on the table, or a figure entered. */
export function bankRequired(autoBank: number | null | undefined, manualBank: number | string | null | undefined): boolean {
  return (usable(autoBank) ?? 0) !== 0 || usable(manualBank) !== null;
}

export type VerifyRecordFields = Pick<
  DailySaleRecord,
  | 'expectedCashInHand'
  | 'autoEasypaisa'
  | 'autoBank'
  | 'manualCash'
  | 'manualEasypaisa'
  | 'manualBank'
  | 'cashDifference'
  | 'easypaisaDifference'
  | 'bankDifference'
>;

/** A saved record's verification, from its own figures and the database's differences. */
export function verifyDailySale(record: VerifyRecordFields, symbol = 'Rs.'): DailySaleVerification {
  return verifyMethods(
    savedMethod('cash', record.expectedCashInHand, record.manualCash, record.cashDifference),
    savedMethod('easypaisa', record.autoEasypaisa, record.manualEasypaisa, record.easypaisaDifference),
    bankRequired(record.autoBank, record.manualBank)
      ? savedMethod('bank', record.autoBank, record.manualBank, record.bankDifference)
      : null,
    symbol,
  );
}
