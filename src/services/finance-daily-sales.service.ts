import { dbFor, maxRows } from '../db';
import {
  DAILY_SALE_MAX_WINDOW_DAYS,
  DEPOSIT_MATCH_DAYS,
  computeDailySaleSummary,
  reconcileDeposits,
  summarizeDepositReconciliation,
  type DailySaleRecordDetail,
  type FinanceDailySaleList,
  type FinanceDailySaleRow,
} from '../shared';
import { listDepositsForReconciliation } from './cash-transfers.service';
import { composeEmptyDailySaleDays, getDailySaleRecordDetail, listDailySaleRecords } from './daily-sale.service';

const db = dbFor('finance-daily-sales');

/**
 * Finance Daily Closing — each branch's Daily Sale Record, as Finance audits it.
 *
 * ─── There is no second copy of the sales ────────────────────────────────────
 * Every row is composed by `listDailySaleRecords`, the function the branch page
 * calls, with the same arguments a super admin's consolidated view passes. This
 * module adds nothing to a record and stores nothing: it reads the branches' cash
 * deposits and finds, for each day, the one that paid that day's Company Share
 * (shared/utils/deposit-reconciliation.ts). Asking twice returns the same rows,
 * keyed by branch and business date, however often it is asked.
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

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

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
async function assertWindowFits(days: number, lead: number): Promise<void> {
  const { data, error } = await db.from('branches').select('id');
  if (error) throw error;
  const branches = (data ?? []).length;
  if (branches * (days + lead) <= maxRows()) return;

  throw Object.assign(
    new Error(
      `Every branch over ${days} days is more than one request can show. ` +
        `Choose one branch, or a window of ${Math.max(1, Math.floor(maxRows() / branches) - lead)} days or fewer.`,
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

export async function listFinanceDailySales(params: FinanceDailySalesParams): Promise<FinanceDailySaleList> {
  const days = windowDays(params.from, params.to);
  // Not a usable window: the list read refuses it, with the reason.
  if (days === null) {
    await listDailySaleRecords(params);
    throw Object.assign(new Error('from and to must be dates in YYYY-MM-DD form'), { status: 400 });
  }
  const from = String(params.from);
  const to = String(params.to);

  // A deposit pays for a day up to DEPOSIT_MATCH_DAYS before the date on it. So
  // the deposits dated at the start of the window may belong to the days just
  // before it, and the days at the end are paid by deposits dated just after.
  // Both margins are read and reconciled, then cut off again: without the first,
  // the window's opening day would be handed the previous day's deposit.
  const lead = days + DEPOSIT_MATCH_DAYS <= DAILY_SALE_MAX_WINDOW_DAYS ? DEPOSIT_MATCH_DAYS : 0;
  if (!params.branchId) await assertWindowFits(days, lead);

  const list = await listDailySaleRecords({ ...params, from: addDays(from, -lead), to });
  const deposits = await listDepositsForReconciliation({
    from: list.from,
    to: addDays(to, DEPOSIT_MATCH_DAYS),
    branchId: params.branchId,
  });

  // A deposit that paid no day goes on the row of the day it was handed over.
  // A day with no sale and no record has no row, so one is made for it — all
  // zeros, the deposit under Received — and the reconciliation run again. That
  // second run pairs every other deposit exactly as the first did: a day that
  // owes nothing takes no deposit until the leftovers are placed.
  const salesDays = new Set(list.records.map((r) => dayKey(r.branchId, r.businessDate)));
  let dayRows = list.records;
  let { byDay, unclaimed } = reconcileDeposits(dayRows, deposits);
  const rowless = new Map<string, { branchId: string; branchName: string; businessDate: string }>();
  for (const d of unclaimed) {
    if (d.businessDate < list.from || d.businessDate > to) continue;
    rowless.set(dayKey(d.branchId, d.businessDate), { branchId: d.branchId, branchName: d.branchName, businessDate: d.businessDate });
  }
  if (rowless.size > 0) {
    dayRows = [...dayRows, ...(await composeEmptyDailySaleDays([...rowless.values()]))].sort((a, b) =>
      a.businessDate === b.businessDate
        ? a.branchName.localeCompare(b.branchName)
        : b.businessDate.localeCompare(a.businessDate),
    );
    ({ byDay, unclaimed } = reconcileDeposits(dayRows, deposits));
  }

  const records: FinanceDailySaleRow[] = dayRows
    .filter((record) => record.businessDate >= from)
    .map((record) => ({
      ...record,
      reconciliation: byDay.get(dayKey(record.branchId, record.businessDate))!,
    }));

  return {
    from,
    to,
    branchId: list.branchId,
    branchName: list.branchName,
    records,
    // Over the sales rows on show, by the helper the branch list itself uses — a
    // row made only for a deposit has no sales to add or count.
    summary: computeDailySaleSummary(records.filter((r) => salesDays.has(dayKey(r.branchId, r.businessDate)))),
    reconciliation: summarizeDepositReconciliation(records),
    unmatchedDeposits: unclaimed.filter((d) => d.businessDate >= from && d.businessDate <= to),
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
  let record = list.records[0];
  // A day with no sale and no record, but a deposit handed over on it: the zero
  // row the board shows that deposit on.
  if (!record) {
    const handedOver = await listDepositsForReconciliation({ from: businessDate, to: businessDate, branchId: branch.id });
    if (handedOver.length > 0) {
      record = (await composeEmptyDailySaleDays([{ branchId: branch.id, branchName: branch.name, businessDate }]))[0];
    }
  }
  if (!record) throw notFound('Nothing was recorded for that branch on that day');

  if (record.id) return getDailySaleRecordDetail(record.id, branch.id);
  return { record, audits: [], locks: list.locks, branch };
}
