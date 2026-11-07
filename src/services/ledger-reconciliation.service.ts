import { getPrisma } from '../db';
import { toPaisa, type LedgerReconciliation, type LedgerReconciliationBranch, type LedgerReconciliationRow } from '../shared';
import { getDemandRecordPeriod } from './branch-account.service';
import { getPreviousOrderBalance } from './previous-balance.service';

/**
 * Collection slip against Demand Record, demand by demand — READ ONLY
 * (docs/centralized-ledger-rules-audit.md §10.3).
 *
 * The two tracks bill the same delivery separately: the slip printed on the
 * branch's next order says what the rider collects for it
 * (previous-balance.service), and the Demand Record books what the branch owes
 * for it (branch-account.service). Neither formula is re-derived here — each
 * figure is the track's own service's output — so this report can only show
 * where they disagree, never introduce a third answer.
 *
 * A demand's slip is the one printed on the branch's NEXT order (any status)
 * after it was submitted, provided that slip bills it; the slip walks back to
 * the latest order Awaiting Verification or Approved, so a demand only
 * Verified at the time is skipped by it ("billed_other"), and a demand with no
 * later order has no slip yet ("not_billed").
 *
 * The difference is split two ways, because they have different causes:
 *   price       slip Delivered − record Delivered: the slip values goods at
 *               today's product price, the record at the price on the order.
 *   collect     slip Amount to Collect − record Company Share: everything,
 *               price included. Before 1 Nov 2026 it also carries the formula
 *               gap (the slip took the % of gross, then the full Return and
 *               Discount off; the record took the % of the net). From 1 Nov
 *               both take the % of Delivered and subtract neither.
 */

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

const MAX_DAYS = 62;
const CONCURRENCY = 6;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export async function getLedgerReconciliation(q: { branchId: string | null; from: string; to: string }): Promise<LedgerReconciliation> {
  if (q.to < q.from) throw httpError(400, 'to is before from');
  if (daysBetween(q.from, q.to) > MAX_DAYS) throw httpError(400, `At most ${MAX_DAYS} days at a time.`);
  const period = await getDemandRecordPeriod({ branchId: q.branchId, from: q.from, to: q.to });
  if (!period) throw httpError(409, 'The Demand Record has not been switched on yet.');

  const demands = period.rows.filter((r) => r.orderId !== null);
  const branchIds = [...new Set(demands.map((d) => d.branchId))];
  // Every order after the earliest demand, per branch, to find each demand's next one.
  const later = branchIds.length === 0 ? [] : await getPrisma().$queryRawUnsafe<{ id: string; branchId: string; demandNumber: string | null; at: string }[]>(
    `select id::text as id, branch_id::text as "branchId", demand_number as "demandNumber", to_json(submitted_at)#>>'{}' as at
       from public.production_orders
      where branch_id = any($1::uuid[]) and submitted_at > $2::timestamptz
      order by submitted_at, id`,
    branchIds, demands.reduce((m, d) => (d.at < m ? d.at : m), demands[0]!.at));

  const nextOf = (d: (typeof demands)[number]) =>
    later.find((o) => o.branchId === d.branchId && o.id !== d.orderId && Date.parse(o.at) > Date.parse(d.at)) ?? null;

  const rows: LedgerReconciliationRow[] = new Array(demands.length);
  let i = 0;
  const worker = async () => {
    while (i < demands.length) {
      const k = i++;
      const d = demands[k]!;
      const record = { delivered: d.delivered, returns: d.returns, discount: d.discount, companyShare: d.companyShare };
      const base = {
        orderId: d.orderId!, demandNumber: d.demandNumber ?? d.orderId!, branchId: d.branchId, branchName: d.branchName,
        date: d.businessDate, shareOnDelivered: d.shareOnDelivered, record,
      };
      const next = nextOf(d);
      if (!next) {
        rows[k] = { ...base, status: 'not_billed', slip: null, priceDifference: 0, collectDifference: 0 };
        continue;
      }
      const bal = await getPreviousOrderBalance(next.id);
      if (!bal?.previous || bal.previous.demandNumber !== d.demandNumber) {
        rows[k] = {
          ...base, status: 'billed_other', priceDifference: 0, collectDifference: 0,
          slip: { billedOn: next.demandNumber ?? next.id, billedDemand: bal?.previous?.demandNumber ?? null, delivered: 0, returns: 0, discount: 0, companyShare: 0, amountToCollect: 0, returnsDeducted: true },
        };
        continue;
      }
      const slip = {
        billedOn: next.demandNumber ?? next.id, billedDemand: bal.previous.demandNumber,
        delivered: toPaisa(bal.deliveredValue), returns: toPaisa(bal.returnsValue), discount: toPaisa(bal.discountsValue),
        companyShare: toPaisa(bal.companyShareValue), amountToCollect: toPaisa(bal.amountToCollect), returnsDeducted: bal.returnsDeducted,
      };
      const priceDifference = toPaisa(slip.delivered - record.delivered);
      const collectDifference = toPaisa(slip.amountToCollect - record.companyShare);
      rows[k] = {
        ...base, slip, priceDifference, collectDifference,
        status: priceDifference === 0 && collectDifference === 0 ? 'match' : 'differs',
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, demands.length) }, worker));

  const byBranch = new Map<string, LedgerReconciliationBranch>();
  for (const r of rows) {
    const b = byBranch.get(r.branchId) ?? {
      branchId: r.branchId, branchName: r.branchName, demands: 0, match: 0, differs: 0, notBilled: 0, billedOther: 0,
      recordShare: 0, slipCollect: 0, priceDifference: 0, collectDifference: 0,
    };
    b.demands += 1;
    if (r.status === 'match') b.match += 1;
    else if (r.status === 'differs') b.differs += 1;
    else if (r.status === 'not_billed') b.notBilled += 1;
    else b.billedOther += 1;
    if (r.slip && (r.status === 'match' || r.status === 'differs')) {
      b.recordShare = toPaisa(b.recordShare + r.record.companyShare);
      b.slipCollect = toPaisa(b.slipCollect + r.slip.amountToCollect);
      b.priceDifference = toPaisa(b.priceDifference + r.priceDifference);
      b.collectDifference = toPaisa(b.collectDifference + r.collectDifference);
    }
    byBranch.set(r.branchId, b);
  }
  rows.sort((a, b) => a.branchName.localeCompare(b.branchName) || a.date.localeCompare(b.date) || a.demandNumber.localeCompare(b.demandNumber));
  return {
    from: period.from,
    to: period.to,
    branches: [...byBranch.values()].sort((a, b) => a.branchName.localeCompare(b.branchName)),
    rows,
  };
}
