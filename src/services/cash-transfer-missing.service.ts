import { getPrisma } from '../db';
import {
  UNPAID_DAILY_TRANSFER_STATUSES,
  addDaysToDateStr,
  businessDateStr,
  daysBetweenDateStr,
  type DailyTransferCheck,
  type DailyTransferCheckRow,
  type DailyTransferRef,
  type DailyTransferStatus,
} from '../shared';

/**
 * Missing daily cash transfers — which active branches have not handed over a
 * day's money, for Finance → Cash Transfer Details.
 *
 * WHAT IS EXPECTED. Every ACTIVE branch (`branches.is_active`, the list the
 * daily-closing job and Branch Share use) owes one transfer per business date,
 * from the business date it was created on. Nothing in the system marks a
 * branch exempt from depositing or defines holidays or branch closures, so
 * none are applied.
 *
 * WHICH DATES ARE DUE. A business date is due once it has closed: the business
 * day rolls over at 02:00 Karachi (`businessDateStr`), so today is never
 * checked and yesterday is the latest due date. There is no other deposit
 * deadline in the system.
 *
 * WHAT COUNTS. A transfer belongs to the branch and BUSINESS DATE it was
 * recorded on (`cash_transfers.business_date`), never its submission instant.
 * Soft-deleted transfers count for nothing. Several transfers on one date are
 * one obligation; the best of them decides (see DAILY_TRANSFER_STATUSES): an
 * approved transfer with a Total Amount above 0 fulfils the day — the same rule
 * the Demand Record and the dashboard's Received use — a pending one is
 * submitted, not missing. A fuel-only deposit (Total 0) pays no company money,
 * so on its own it leaves the day unpaid.
 *
 * One query covers the whole window: dates × branches, left-joined to the
 * window's transfers through the existing (branch_id, business_date) index.
 */

/** The default window: the last seven due business dates. */
export const DEFAULT_DAYS = 7;
/** The longest window one request may check. */
export const MAX_DAYS = 62;

/** The due window for a requested range: never today or later, at most MAX_DAYS long. */
export function dueWindow(q: { from?: string; to?: string }, today: string): { from: string; to: string } {
  const lastDue = addDaysToDateStr(today, -1);
  const to = q.to && q.to < lastDue ? q.to : lastDue;
  let from = q.from ?? addDaysToDateStr(to, -(DEFAULT_DAYS - 1));
  if (daysBetweenDateStr(from, to) >= MAX_DAYS) from = addDaysToDateStr(to, -(MAX_DAYS - 1));
  return { from, to };
}

/** The best status among one (date, branch)'s live transfers. */
export function dailyStatus(transfers: Pick<DailyTransferRef, 'status' | 'amount'>[]): DailyTransferStatus {
  if (transfers.some((t) => t.status === 'approved' && t.amount > 0)) return 'approved';
  if (transfers.some((t) => t.status === 'pending' && t.amount > 0)) return 'pending';
  if (transfers.some((t) => t.status === 'rejected')) return 'rejected';
  if (transfers.length > 0) return 'fuel_only';
  return 'missing';
}

interface RawRow {
  date: string;
  branchId: string;
  branchName: string;
  transfers: DailyTransferRef[] | null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function buildDailyTransferCheck(
  raw: RawRow[],
  window: { from: string; to: string },
  today: string,
  branchId: string | null,
  branches: number,
): DailyTransferCheck {
  const rows: DailyTransferCheckRow[] = raw.map((r) => {
    const transfers = (r.transfers ?? []).map((t) => ({ ...t, amount: Number(t.amount), fuelCharges: Number(t.fuelCharges) }));
    const status = dailyStatus(transfers);
    const counted = status === 'approved' || status === 'pending' ? transfers.filter((t) => t.status === status && t.amount > 0) : [];
    return {
      date: r.date,
      branchId: r.branchId,
      branchName: r.branchName,
      status,
      transfers,
      submittedAmount: round2(counted.reduce((s, t) => s + t.amount, 0)),
    };
  });
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.branchName.localeCompare(b.branchName));

  const unpaid = rows.filter((r) => UNPAID_DAILY_TRANSFER_STATUSES.includes(r.status));
  const count = (s: DailyTransferStatus) => rows.filter((r) => r.status === s).length;
  return {
    today,
    from: window.from,
    to: window.to,
    branchId,
    branches,
    dates: window.from > window.to ? 0 : daysBetweenDateStr(window.from, window.to) + 1,
    summary: {
      missingBranches: new Set(unpaid.map((r) => r.branchId)).size,
      affectedDates: new Set(unpaid.map((r) => r.date)).size,
      pendingTransfers: rows.reduce((s, r) => s + r.transfers.filter((t) => t.status === 'pending' && t.amount > 0).length, 0),
      missing: count('missing'),
      fuelOnly: count('fuel_only'),
      rejected: count('rejected'),
      pending: count('pending'),
      approved: count('approved'),
    },
    rows,
  };
}

export async function getMissingDailyTransfers(
  q: { from?: string; to?: string; branchId?: string | null },
  now: Date = new Date(),
): Promise<DailyTransferCheck> {
  const today = businessDateStr(now);
  const window = dueWindow(q, today);
  const branchId = q.branchId ?? null;
  const prisma = getPrisma();

  // $1 from, $2 to, $3 branch (null: every active branch).
  const [raw, active] = await Promise.all([
    window.from > window.to
      ? Promise.resolve([] as RawRow[])
      : prisma.$queryRawUnsafe<RawRow[]>(`
          with days as (
            select d::date as d from generate_series($1::date, $2::date, interval '1 day') d
          ),
          br as (
            select b.id, b.name, app.business_date(b.created_at) as since
              from public.branches b
             where b.is_active and ($3::uuid is null or b.id = $3::uuid)
          ),
          t as (
            select t.branch_id, t.business_date,
                   json_agg(json_build_object(
                     'id', t.id::text, 'transferNo', t.transfer_no, 'status', t.status::text,
                     'amount', t.amount::float8, 'fuelCharges', t.fuel_charges::float8,
                     'createdAt', to_json(t.created_at)#>>'{}'
                   ) order by t.created_at) as transfers
              from public.cash_transfers t
             where t.deleted_at is null
               and t.business_date between $1::date and $2::date
               and ($3::uuid is null or t.branch_id = $3::uuid)
             group by t.branch_id, t.business_date
          )
          select to_char(days.d, 'YYYY-MM-DD') as "date", br.id::text as "branchId", br.name as "branchName",
                 t.transfers as "transfers"
            from days
            join br on days.d >= br.since
            left join t on t.branch_id = br.id and t.business_date = days.d`,
          window.from, window.to, branchId),
    prisma.$queryRawUnsafe<{ n: number }[]>(
      `select count(*)::int as n from public.branches where is_active and ($1::uuid is null or id = $1::uuid)`,
      branchId,
    ),
  ]);
  return buildDailyTransferCheck(raw, window, today, branchId, active[0]?.n ?? 0);
}
