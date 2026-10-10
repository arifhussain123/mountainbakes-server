import { dbFor, maxRows } from '../db';
import {
  computeDepositReconciliation,
  summarizeDepositReconciliation,
  type BranchDayDeposit,
  type DailySaleRecordDetail,
  type FinanceDailySaleList,
  type FinanceDailySaleRow,
  type ReconciliationDeposit,
} from '../shared';
import { listDepositsForReconciliation } from './cash-transfers.service';
import { getDailySaleRecordDetail, listDailySaleRecords } from './daily-sale.service';

const db = dbFor('finance-daily-sales');

/**
 * Finance Daily Closing — each branch's Daily Sale Record, as Finance audits it.
 *
 * ─── There is no second copy of the sales ────────────────────────────────────
 * Every row is composed by `listDailySaleRecords`, the function the branch page
 * calls, with the same arguments a super admin's consolidated view passes. This
 * module adds nothing to a record and stores nothing: it reads the day's cash
 * deposits beside it and sets the two against each other. Asking twice returns
 * the same rows, keyed by branch and business date, however often it is asked.
 *
 * ─── It never writes ─────────────────────────────────────────────────────────
 * Finance does not generate, feed, verify, lock or amend a record from here. The
 * one decision Finance makes about a day's money — whether a deposit arrived — is
 * made on the deposit itself (finance-cash-transfers.routes.ts), and this view
 * follows it. A discrepancy is reported, never corrected into agreement.
 */

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Days in a window, or null when either end is not a date `listDailySaleRecords` will accept. */
function windowDays(from: unknown, to: unknown): number | null {
  const f = String(from ?? '');
  const t = String(to ?? '');
  if (!DATE_RE.test(f) || !DATE_RE.test(t)) return null;
  const days = Math.floor((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000) + 1;
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Refuse an all-branch window too wide to be read whole.
 *
 * One read returns at most `maxRows()` rows, and a window of every branch over
 * many days can hold more branch days than that. The rows past the ceiling would
 * simply be missing, and a missing day on this screen reads as a day with no
 * sales. A refusal that says how to narrow the request is the honest answer.
 */
async function assertWindowFits(from: unknown, to: unknown): Promise<void> {
  const days = windowDays(from, to);
  if (days === null) return; // not a usable window; the list read says why

  const { data, error } = await db.from('branches').select('id');
  if (error) throw error;
  const branches = (data ?? []).length;
  if (branches * days <= maxRows()) return;

  throw Object.assign(
    new Error(
      `Every branch over ${days} days is more than one request can show. ` +
        `Choose one branch, or a window of ${Math.max(1, Math.floor(maxRows() / branches))} days or fewer.`,
    ),
    { status: 400 },
  );
}

export interface FinanceDailySalesParams {
  from: unknown;
  to: unknown;
  /** Null for every branch. A named branch has already been found by the router. */
  branchId: string | null;
  branchName: string | null;
}

const dayKey = (branchId: string, businessDate: string) => `${branchId}|${businessDate}`;

function toLine(d: BranchDayDeposit): ReconciliationDeposit {
  return {
    id: d.id,
    transferNo: d.transferNo,
    voucherNo: d.voucherNo,
    status: d.status,
    cashAmount: d.cashAmount,
    easypaisaAmount: d.easypaisaAmount,
    bankAmount: d.bankAmount,
    amount: d.amount,
  };
}

export async function listFinanceDailySales(params: FinanceDailySalesParams): Promise<FinanceDailySaleList> {
  if (!params.branchId) await assertWindowFits(params.from, params.to);

  const list = await listDailySaleRecords(params);
  const deposits = await listDepositsForReconciliation({
    from: list.from,
    to: list.to,
    branchId: params.branchId,
  });

  const byDay = new Map<string, BranchDayDeposit[]>();
  for (const d of deposits) {
    const key = dayKey(d.branchId, d.businessDate);
    const day = byDay.get(key);
    if (day) day.push(d);
    else byDay.set(key, [d]);
  }

  const matchedDays = new Set<string>();
  const records: FinanceDailySaleRow[] = list.records.map((record) => {
    const key = dayKey(record.branchId, record.businessDate);
    matchedDays.add(key);
    return {
      ...record,
      reconciliation: computeDepositReconciliation(record, (byDay.get(key) ?? []).map(toLine)),
    };
  });

  return {
    from: list.from,
    to: list.to,
    branchId: list.branchId,
    branchName: list.branchName,
    records,
    summary: list.summary,
    reconciliation: summarizeDepositReconciliation(records),
    unmatchedDeposits: deposits.filter((d) => !matchedDays.has(dayKey(d.branchId, d.businessDate))),
  };
}

/** A branch by id, or a 404 — the lookup every named-branch read starts with. */
export async function findBranch(id: string): Promise<DailySaleRecordDetail['branch']> {
  const { data, error } = await db
    .from('branches')
    .select('id, name, address, phone, city')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Branch not found');
  return {
    id: String(data['id']),
    name: String(data['name'] ?? ''),
    address: (data['address'] as string | null) ?? null,
    phone: (data['phone'] as string | null) ?? null,
    city: (data['city'] as string | null) ?? null,
  };
}

/**
 * One branch day in full, for the View popup and the print sheet.
 *
 * Addressed by branch and date rather than by record id, because the day Finance
 * most often opens is today, and today usually has sales but no stored record
 * yet. A branch generates that record when it first acts on the day; Finance must
 * not, so a day without one is shown from its live figures with an empty history.
 */
export async function getFinanceDailySaleDay(
  branch: DailySaleRecordDetail['branch'],
  businessDate: string,
): Promise<DailySaleRecordDetail> {
  const list = await listDailySaleRecords({
    from: businessDate,
    to: businessDate,
    branchId: branch.id,
    branchName: branch.name,
  });
  const record = list.records[0];
  if (!record) throw notFound('Nothing was recorded for that branch on that day');

  if (record.id) return getDailySaleRecordDetail(record.id, branch.id);
  return { record, audits: [], locks: list.locks, branch };
}
