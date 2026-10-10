import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDepositReconciliation,
  expectedDeposit,
  summarizeDepositReconciliation,
  type DepositReconRecord,
  type ReconciliationDeposit,
} from '../../shared';

/**
 * A branch day's recorded money against the deposits Finance approved for it.
 *
 * The day used throughout: Cash on Table 900 (cash 1,000 less 100 paid out of the
 * drawer), Easypaisa 400, Bank 200 — 1,500 to hand over.
 */
const DAY: DepositReconRecord = {
  id: 'rec-1',
  status: 'verified',
  expectedCashInHand: 900,
  autoEasypaisa: 400,
  autoBank: 200,
};

let seq = 0;
function deposit(
  status: 'pending' | 'approved',
  cashAmount: number,
  easypaisaAmount = 0,
  bankAmount = 0,
): ReconciliationDeposit {
  seq += 1;
  return {
    id: `dep-${seq}`,
    transferNo: `CT-${seq}`,
    voucherNo: status === 'approved' ? `RV-${seq}` : null,
    status,
    cashAmount,
    easypaisaAmount,
    bankAmount,
    amount: cashAmount + easypaisaAmount + bankAmount,
  };
}

describe('expectedDeposit', () => {
  test('is Cash on Table, Easypaisa and Bank — the figures the deposit form offers', () => {
    assert.deepEqual(expectedDeposit(DAY), { cash: 900, easypaisa: 400, bank: 200, total: 1500 });
  });

  test('a drawer the expenses emptied has no cash to hand over', () => {
    assert.deepEqual(expectedDeposit({ ...DAY, expectedCashInHand: -250 }), {
      cash: 0,
      easypaisa: 400,
      bank: 200,
      total: 600,
    });
  });

  test('Foodpanda is not part of it, whatever the day took through it', () => {
    const withFoodpanda = { ...DAY, autoFoodpanda: 5000 } as DepositReconRecord;
    assert.equal(expectedDeposit(withFoodpanda).total, 1500);
  });
});

describe('computeDepositReconciliation', () => {
  test('nothing deposited against money that is due → not received', () => {
    const r = computeDepositReconciliation(DAY, []);
    assert.equal(r.status, 'not_received');
    assert.deepEqual(r.received, { cash: 0, easypaisa: 0, bank: 0, total: 0 });
    assert.deepEqual(r.difference, { cash: 900, easypaisa: 400, bank: 200, total: 1500 });
  });

  test('nothing due and nothing deposited → nothing due', () => {
    const r = computeDepositReconciliation(
      { ...DAY, expectedCashInHand: -40, autoEasypaisa: 0, autoBank: 0 },
      [],
    );
    assert.equal(r.status, 'nothing_due');
    assert.equal(r.difference.total, 0);
  });

  test('approved deposits equal to every channel → matched', () => {
    const r = computeDepositReconciliation(DAY, [deposit('approved', 900, 400, 200)]);
    assert.equal(r.status, 'matched');
    assert.deepEqual(r.difference, { cash: 0, easypaisa: 0, bank: 0, total: 0 });
    assert.equal(r.approvedCount, 1);
    assert.equal(r.totalMatches, false);
  });

  test('several approved deposits are added together', () => {
    const r = computeDepositReconciliation(DAY, [
      deposit('approved', 500),
      deposit('approved', 400, 400),
      deposit('approved', 0, 0, 200),
    ]);
    assert.equal(r.status, 'matched');
    assert.equal(r.received.total, 1500);
    assert.equal(r.approvedCount, 3);
  });

  test('less received than recorded → discrepancy, and the difference is positive', () => {
    const r = computeDepositReconciliation(DAY, [deposit('approved', 800, 400, 200)]);
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.difference.cash, 100);
    assert.equal(r.difference.total, 100);
  });

  test('more received than recorded → discrepancy, and the difference is negative', () => {
    const r = computeDepositReconciliation(DAY, [deposit('approved', 900, 450, 200)]);
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.difference.easypaisa, -50);
    assert.equal(r.difference.total, -50);
  });

  test('no tolerance: one paisa out is a discrepancy', () => {
    const r = computeDepositReconciliation(DAY, [deposit('approved', 899.99, 400, 200)]);
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.difference.cash, 0.01);
  });

  test('the right total through the wrong channel is still a discrepancy, and says so', () => {
    const r = computeDepositReconciliation(DAY, [deposit('approved', 1300, 0, 200)]);
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.difference.total, 0);
    assert.equal(r.totalMatches, true);
    assert.equal(r.difference.cash, -400);
    assert.equal(r.difference.easypaisa, 400);
  });

  test('a pending deposit is never counted as received', () => {
    const r = computeDepositReconciliation(DAY, [deposit('pending', 900, 400, 200)]);
    assert.equal(r.status, 'pending');
    assert.equal(r.received.total, 0);
    assert.equal(r.pending.total, 1500);
    assert.equal(r.difference.total, 1500);
    assert.equal(r.pendingCount, 1);
  });

  test('a pending deposit holds the day at pending even when the approved ones already match', () => {
    const r = computeDepositReconciliation(DAY, [
      deposit('approved', 900, 400, 200),
      deposit('pending', 50),
    ]);
    assert.equal(r.status, 'pending');
    assert.equal(r.difference.total, 0);
  });

  test('a deposit against a day with nothing due is a discrepancy, not a match', () => {
    const r = computeDepositReconciliation(
      { ...DAY, expectedCashInHand: 0, autoEasypaisa: 0, autoBank: 0 },
      [deposit('approved', 300)],
    );
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.difference.cash, -300);
  });

  test('an open record, or a day with no record yet, is provisional', () => {
    assert.equal(computeDepositReconciliation(DAY, []).provisional, false);
    assert.equal(computeDepositReconciliation({ ...DAY, status: 'locked' }, []).provisional, false);
    assert.equal(computeDepositReconciliation({ ...DAY, status: 'open' }, []).provisional, true);
    assert.equal(
      computeDepositReconciliation({ ...DAY, status: 'pending_verification' }, []).provisional,
      true,
    );
    assert.equal(computeDepositReconciliation({ ...DAY, id: null, status: 'open' }, []).provisional, true);
  });

  test('float drift does not invent a discrepancy', () => {
    const r = computeDepositReconciliation({ ...DAY, expectedCashInHand: 0.3, autoEasypaisa: 0, autoBank: 0 }, [
      deposit('approved', 0.1),
      deposit('approved', 0.2),
    ]);
    assert.equal(r.status, 'matched');
    assert.equal(r.difference.cash, 0);
  });

  test('neither the record nor the deposits are changed', () => {
    const record = { ...DAY };
    const deposits = [deposit('approved', 800, 400, 200), deposit('pending', 100)];
    const before = JSON.stringify({ record, deposits });
    const r = computeDepositReconciliation(record, deposits);
    assert.equal(JSON.stringify({ record, deposits }), before);
    assert.notEqual(r.deposits, deposits);
    assert.deepEqual(r.deposits, deposits);
  });
});

describe('summarizeDepositReconciliation', () => {
  test('adds the rows up per channel and counts each state', () => {
    const rows = [
      { reconciliation: computeDepositReconciliation(DAY, [deposit('approved', 900, 400, 200)]) },
      { reconciliation: computeDepositReconciliation(DAY, [deposit('approved', 800, 400, 200)]) },
      { reconciliation: computeDepositReconciliation(DAY, [deposit('pending', 900)]) },
      { reconciliation: computeDepositReconciliation(DAY, []) },
    ];
    const s = summarizeDepositReconciliation(rows);
    assert.equal(s.expected.total, 6000);
    assert.equal(s.received.total, 2900);
    assert.equal(s.pending.cash, 900);
    assert.equal(s.difference.total, 3100);
    assert.deepEqual(s.counts, { nothing_due: 0, not_received: 1, pending: 1, matched: 1, discrepancy: 1 });
  });

  test('an empty window is all zeros', () => {
    const s = summarizeDepositReconciliation([]);
    assert.deepEqual(s.difference, { cash: 0, easypaisa: 0, bank: 0, total: 0 });
    assert.deepEqual(s.counts, { nothing_due: 0, not_received: 0, pending: 0, matched: 0, discrepancy: 0 });
  });
});
