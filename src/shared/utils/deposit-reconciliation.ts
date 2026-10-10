import { isDailySaleRecordOpen, type DailySaleRecord } from '../types/daily-sale.types';
import type {
  DailySaleReconciliation,
  DepositChannelAmounts,
  DepositReconStatus,
  FinanceDailySaleSummary,
  ReconciliationDeposit,
} from '../types/finance-daily-sale.types';
import { round2 } from './daily-sale';

/** The part of a record the reconciliation reads. */
export type DepositReconRecord = Pick<
  DailySaleRecord,
  'id' | 'status' | 'expectedCashInHand' | 'autoEasypaisa' | 'autoBank'
>;

function channels(cash: number, easypaisa: number, bank: number): DepositChannelAmounts {
  const c = round2(cash);
  const e = round2(easypaisa);
  const b = round2(bank);
  return { cash: c, easypaisa: e, bank: b, total: round2(c + e + b) };
}

function sumDeposits(deposits: ReconciliationDeposit[]): DepositChannelAmounts {
  let cash = 0;
  let easypaisa = 0;
  let bank = 0;
  for (const d of deposits) {
    cash += d.cashAmount;
    easypaisa += d.easypaisaAmount;
    bank += d.bankAmount;
  }
  return channels(cash, easypaisa, bank);
}

/**
 * What a day's record says the branch should hand over.
 *
 * The same three figures the deposit form's Auto-fill offers a branch
 * (CashDepositModal), so "expected" here is what the branch was itself told to
 * deposit: Cash on Table rather than gross cash, because the day's cash expenses
 * have already left the drawer, and never below zero, because a drawer the
 * expenses emptied has nothing to hand over. Foodpanda has no figure — the
 * aggregator settles it and no deposit carries it.
 */
export function expectedDeposit(record: DepositReconRecord): DepositChannelAmounts {
  return channels(Math.max(0, record.expectedCashInHand), record.autoEasypaisa, record.autoBank);
}

/**
 * One branch day's recorded money against its deposits.
 *
 * Only APPROVED deposits count as received. A pending one is reported beside the
 * figure and holds the day at `pending`, whatever has already been approved,
 * because the answer may still change when Finance decides it.
 */
export function computeDepositReconciliation(
  record: DepositReconRecord,
  deposits: ReconciliationDeposit[],
): DailySaleReconciliation {
  const approved = deposits.filter((d) => d.status === 'approved');
  const waiting = deposits.filter((d) => d.status === 'pending');

  const expected = expectedDeposit(record);
  const received = sumDeposits(approved);
  const pending = sumDeposits(waiting);
  const difference = channels(
    expected.cash - received.cash,
    expected.easypaisa - received.easypaisa,
    expected.bank - received.bank,
  );

  const channelsAgree = difference.cash === 0 && difference.easypaisa === 0 && difference.bank === 0;

  let status: DepositReconStatus;
  if (waiting.length > 0) status = 'pending';
  else if (approved.length === 0) status = expected.total === 0 ? 'nothing_due' : 'not_received';
  else status = channelsAgree ? 'matched' : 'discrepancy';

  return {
    expected,
    received,
    pending,
    difference,
    approvedCount: approved.length,
    pendingCount: waiting.length,
    status,
    provisional: record.id === null || isDailySaleRecordOpen(record.status),
    totalMatches: !channelsAgree && difference.total === 0,
    deposits: [...deposits],
  };
}

/** The reconciliation totals over a window of rows. */
export function summarizeDepositReconciliation(
  rows: { reconciliation: DailySaleReconciliation }[],
): FinanceDailySaleSummary {
  const total = (pick: (r: DailySaleReconciliation) => DepositChannelAmounts): DepositChannelAmounts => {
    let cash = 0;
    let easypaisa = 0;
    let bank = 0;
    for (const row of rows) {
      const a = pick(row.reconciliation);
      cash += a.cash;
      easypaisa += a.easypaisa;
      bank += a.bank;
    }
    return channels(cash, easypaisa, bank);
  };

  const counts: Record<DepositReconStatus, number> = {
    nothing_due: 0,
    not_received: 0,
    pending: 0,
    matched: 0,
    discrepancy: 0,
  };
  for (const row of rows) counts[row.reconciliation.status] += 1;

  return {
    expected: total((r) => r.expected),
    received: total((r) => r.received),
    pending: total((r) => r.pending),
    difference: total((r) => r.difference),
    counts,
  };
}
