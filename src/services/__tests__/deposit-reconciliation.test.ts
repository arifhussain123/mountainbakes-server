import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountsAgree,
  reconcileDeposits,
  summarizeDepositReconciliation,
  type BranchDayDeposit,
  type DailySaleReconciliation,
  type DepositReconRecord,
} from '../../shared';

/**
 * Finding the deposit that paid each branch day's Company Share.
 *
 * A deposit is dated the day it was handed over, which is usually the day after
 * the sales it pays for. So it is found by amount, on the sale day or within two
 * days after it — and each deposit is used once.
 */
const A = 'branch-a';
const B = 'branch-b';

function day(businessDate: string, companyShare: number, over: Partial<DepositReconRecord> = {}): DepositReconRecord {
  return { id: `rec-${businessDate}`, status: 'verified', branchId: A, businessDate, companyShare, ...over };
}

let seq = 0;
function deposit(
  businessDate: string,
  amount: number,
  over: Partial<BranchDayDeposit> = {},
): BranchDayDeposit {
  seq += 1;
  return {
    id: `dep-${seq}`,
    transferNo: `CT-${seq}`,
    voucherNo: `RV-${seq}`,
    status: 'approved',
    branchId: A,
    branchName: 'Gulberg',
    businessDate,
    cashAmount: amount,
    easypaisaAmount: 0,
    bankAmount: 0,
    amount,
    ...over,
  };
}

function reconcile(records: DepositReconRecord[], deposits: BranchDayDeposit[]) {
  const { byDay, unclaimed } = reconcileDeposits(records, deposits);
  const of = (businessDate: string, branchId = A): DailySaleReconciliation =>
    byDay.get(`${branchId}|${businessDate}`)!;
  return { of, unclaimed };
}

describe('amountsAgree', () => {
  test('the same amount to the rupee — a share ending in 50 paisa paid in whole notes', () => {
    assert.equal(amountsAgree(38737.5, 38737), true);
    assert.equal(amountsAgree(29737.5, 29737.5), true);
    assert.equal(amountsAgree(1000, 1000.99), true);
  });

  test('a rupee or more apart is a different amount', () => {
    assert.equal(amountsAgree(1000, 1001), false);
    assert.equal(amountsAgree(1000, 999), false);
    assert.equal(amountsAgree(28575, 23587), false);
  });
});

describe('a deposit of the same amount', () => {
  test('dated the next day → matched', () => {
    const { of, unclaimed } = reconcile([day('2026-10-01', 29737.5)], [deposit('2026-10-02', 29737.5)]);
    const r = of('2026-10-01');
    assert.equal(r.status, 'matched');
    assert.equal(r.match, 'amount');
    assert.equal(r.expected, 29737.5);
    assert.equal(r.received, 29737.5);
    assert.equal(r.difference, 0);
    assert.equal(r.deposits[0]!.businessDate, '2026-10-02');
    assert.deepEqual(unclaimed, []);
  });

  test('dated the same day, or two days later → matched', () => {
    assert.equal(reconcile([day('2026-10-01', 500)], [deposit('2026-10-01', 500)]).of('2026-10-01').status, 'matched');
    assert.equal(reconcile([day('2026-10-01', 500)], [deposit('2026-10-03', 500)]).of('2026-10-01').status, 'matched');
  });

  test('dated three days later, or the day before → not found', () => {
    const late = reconcile([day('2026-10-01', 500)], [deposit('2026-10-04', 500)]);
    assert.equal(late.of('2026-10-01').status, 'not_received');
    assert.equal(late.unclaimed.length, 1);

    const early = reconcile([day('2026-10-02', 500)], [deposit('2026-10-01', 500)]);
    assert.equal(early.of('2026-10-02').status, 'not_received');
  });

  test('to the rupee: 38,737 pays a share of 38,737.50, and the 50 paisa is still shown', () => {
    const r = reconcile([day('2026-10-03', 38737.5)], [deposit('2026-10-04', 38737)]).of('2026-10-03');
    assert.equal(r.status, 'matched');
    assert.equal(r.difference, 0.5);
  });

  test('two deposits handed over on one date that add up to the share → matched', () => {
    const r = reconcile(
      [day('2026-10-01', 1500)],
      [deposit('2026-10-02', 1100), deposit('2026-10-02', 400, { cashAmount: 0, easypaisaAmount: 400 })],
    ).of('2026-10-01');
    assert.equal(r.status, 'matched');
    assert.equal(r.received, 1500);
    assert.equal(r.approvedCount, 2);
  });

  test('another branch\'s deposit is never taken', () => {
    const { of, unclaimed } = reconcile(
      [day('2026-10-01', 500)],
      [deposit('2026-10-02', 500, { branchId: B, branchName: 'Saddar' })],
    );
    assert.equal(of('2026-10-01').status, 'not_received');
    assert.equal(unclaimed.length, 1);
  });
});

describe('each deposit is used once', () => {
  test('consecutive days each find their own next-day deposit', () => {
    const { of, unclaimed } = reconcile(
      [day('2026-09-30', 24262.5), day('2026-10-01', 29737.5), day('2026-10-02', 34560)],
      [deposit('2026-10-01', 24262.5), deposit('2026-10-02', 29737.5), deposit('2026-10-03', 34560)],
    );
    for (const d of ['2026-09-30', '2026-10-01', '2026-10-02']) assert.equal(of(d).status, 'matched', d);
    assert.equal(of('2026-09-30').deposits[0]!.businessDate, '2026-10-01');
    assert.equal(of('2026-10-02').deposits[0]!.businessDate, '2026-10-03');
    assert.deepEqual(unclaimed, []);
  });

  test('two days with the same share and one deposit: the earlier day takes it', () => {
    const { of } = reconcile([day('2026-10-01', 500), day('2026-10-02', 500)], [deposit('2026-10-02', 500)]);
    assert.equal(of('2026-10-01').status, 'matched');
    assert.equal(of('2026-10-02').status, 'not_received');
  });

  test('a deposit that is exactly a later day\'s share is not taken first as an earlier day\'s near miss', () => {
    const { of, unclaimed } = reconcile(
      [day('2026-10-01', 700), day('2026-10-02', 500)],
      [deposit('2026-10-02', 500), deposit('2026-10-03', 650)],
    );
    assert.equal(of('2026-10-02').status, 'matched');
    assert.equal(of('2026-10-02').received, 500);
    assert.equal(of('2026-10-01').status, 'discrepancy');
    assert.equal(of('2026-10-01').received, 650);
    assert.deepEqual(unclaimed, []);
  });
});

describe('no deposit of the same amount', () => {
  test('the nearest approved deposit, under 1,000 away, is shown, flagged, with a positive difference when it is short', () => {
    const r = reconcile([day('2026-10-05', 28575)], [deposit('2026-10-06', 27587)]).of('2026-10-05');
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.match, 'nearest');
    assert.equal(r.received, 27587);
    assert.equal(r.difference, 988);
  });

  test('1,000 or more away is not the nearest: the gap is shown on the deposit\'s own day', () => {
    const { of, unclaimed } = reconcile(
      [day('2026-10-05', 28575), day('2026-10-06', 30000)],
      [deposit('2026-10-06', 23587)],
    );
    assert.equal(of('2026-10-05').status, 'not_received');
    assert.equal(of('2026-10-05').difference, 28575);
    assert.equal(of('2026-10-06').status, 'discrepancy');
    assert.equal(of('2026-10-06').match, 'same_day');
    assert.equal(of('2026-10-06').difference, 6413);
    assert.deepEqual(unclaimed, []);
  });

  test('999 away is still the nearest, 1,000 away is not', () => {
    assert.equal(reconcile([day('2026-10-05', 2000)], [deposit('2026-10-06', 1001)]).of('2026-10-05').match, 'nearest');
    const r = reconcile([day('2026-10-05', 2000)], [deposit('2026-10-06', 1000)]);
    assert.equal(r.of('2026-10-05').status, 'not_received');
    assert.equal(r.unclaimed.length, 1);
  });

  test('a deposit goes to the day it is nearest, not to the earlier day', () => {
    const { of } = reconcile(
      [day('2026-10-05', 1400), day('2026-10-06', 1460)],
      [deposit('2026-10-06', 1450), deposit('2026-10-07', 1100)],
    );
    // 1,450 is 50 from the 5th's share but 10 from the 6th's.
    assert.equal(of('2026-10-06').received, 1450);
    assert.equal(of('2026-10-05').received, 1100);
  });

  test('more received than the share → discrepancy with a negative difference', () => {
    const r = reconcile([day('2026-10-05', 1000)], [deposit('2026-10-06', 1250)]).of('2026-10-05');
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.difference, -250);
  });

  test('nearest means nearest in amount: one deposit, or one date\'s together', () => {
    const alone = reconcile(
      [day('2026-10-05', 1000)],
      [deposit('2026-10-07', 900), deposit('2026-10-06', 300), deposit('2026-10-06', 200)],
    ).of('2026-10-05');
    assert.equal(alone.received, 900);

    const together = reconcile(
      [day('2026-10-05', 1000)],
      [deposit('2026-10-07', 800), deposit('2026-10-06', 600), deposit('2026-10-06', 350)],
    ).of('2026-10-05');
    assert.equal(together.received, 950);
    assert.deepEqual(together.deposits.map((d) => d.businessDate), ['2026-10-06', '2026-10-06']);
  });

  test('nothing in the window → not received, the whole share outstanding', () => {
    const r = reconcile([day('2026-10-05', 1000)], []).of('2026-10-05');
    assert.equal(r.status, 'not_received');
    assert.equal(r.match, 'none');
    assert.equal(r.difference, 1000);
    assert.deepEqual(r.deposits, []);
  });
});

describe('deposits awaiting approval', () => {
  test('a pending deposit of the same amount holds the day at pending and is not counted', () => {
    const r = reconcile([day('2026-10-01', 500)], [deposit('2026-10-02', 500, { status: 'pending', voucherNo: null })]).of('2026-10-01');
    assert.equal(r.status, 'pending');
    assert.equal(r.received, 0);
    assert.equal(r.pending, 500);
    assert.equal(r.difference, 500);
    assert.equal(r.pendingCount, 1);
  });

  test('an approved deposit of the same amount wins over a pending one', () => {
    const { of, unclaimed } = reconcile(
      [day('2026-10-01', 500), day('2026-10-02', 0)],
      [deposit('2026-10-01', 500, { status: 'pending' }), deposit('2026-10-02', 500)],
    );
    // 10-01 is paid by the approved one; the pending one, dated 10-01, then
    // sits on its own date's row as an extra — 10-01 again.
    assert.equal(of('2026-10-01').approvedCount, 1);
    assert.equal(of('2026-10-01').received, 500);
    assert.equal(of('2026-10-01').pending, 500);
    assert.equal(of('2026-10-01').extraCount, 1);
    assert.equal(of('2026-10-01').status, 'pending');
    assert.deepEqual(unclaimed, []);
  });

  test('a pending deposit of the same amount is preferred to an approved one of a different amount', () => {
    const r = reconcile(
      [day('2026-10-01', 500)],
      [deposit('2026-10-01', 320), deposit('2026-10-02', 500, { status: 'pending' })],
    ).of('2026-10-01');
    assert.equal(r.status, 'pending');
    assert.equal(r.pending, 500);
  });
});

describe('days that owe nothing', () => {
  test('a day with no Company Share is nothing due, and takes no deposit', () => {
    const { of, unclaimed } = reconcile([day('2026-10-01', 0)], [deposit('2026-10-02', 300)]);
    assert.equal(of('2026-10-01').status, 'nothing_due');
    assert.equal(of('2026-10-01').difference, 0);
    assert.equal(unclaimed.length, 1);
  });
});

describe('a deposit no day claimed is shown on its own date', () => {
  test('a second deposit on a day already paid is added to that day, not dropped', () => {
    // 10-03's share is paid exactly by the 10-03 deposit; Alabad hands over a
    // second one the same day that matches nothing.
    const { of, unclaimed } = reconcile(
      [day('2026-10-02', 0), day('2026-10-03', 18000)],
      [deposit('2026-10-03', 18000), deposit('2026-10-03', 18030)],
    );
    const r = of('2026-10-03');
    assert.equal(r.received, 36030);
    assert.equal(r.difference, -18030);
    assert.equal(r.approvedCount, 2);
    assert.equal(r.extraCount, 1);
    assert.equal(r.match, 'amount');
    assert.equal(r.status, 'discrepancy');
    assert.deepEqual(unclaimed, []);
  });

  test('a deposit whose amount paid no day goes on the day it was handed over', () => {
    // 10-12 is paid by its next-day deposit; 20,990 on 10-13 is far from 10-13's share.
    const { of, unclaimed } = reconcile(
      [day('2026-10-12', 15000), day('2026-10-13', 0)],
      [deposit('2026-10-13', 15000), deposit('2026-10-13', 20990)],
    );
    assert.equal(of('2026-10-12').status, 'matched');
    assert.equal(of('2026-10-12').extraCount, 0);
    const r = of('2026-10-13');
    assert.equal(r.received, 20990);
    assert.equal(r.difference, -20990);
    assert.equal(r.match, 'same_day');
    assert.equal(r.extraCount, 1);
    assert.equal(r.status, 'discrepancy');
    assert.deepEqual(unclaimed, []);
  });

  test('a deposit with no row on its date stays unclaimed', () => {
    const { unclaimed } = reconcile([day('2026-10-01', 500)], [deposit('2026-10-01', 500), deposit('2026-10-05', 900)]);
    assert.equal(unclaimed.length, 1);
    assert.equal(unclaimed[0]!.businessDate, '2026-10-05');
  });

  test('another branch\'s row is never used', () => {
    const { of, unclaimed } = reconcile(
      [day('2026-10-01', 0, { branchId: B })],
      [deposit('2026-10-01', 700)],
    );
    assert.equal(of('2026-10-01', B).extraCount, 0);
    assert.equal(unclaimed.length, 1);
  });
});

describe('what is reported alongside', () => {
  test('an open record, or a day with no record yet, is provisional', () => {
    const { of } = reconcile(
      [
        day('2026-10-01', 100),
        day('2026-10-02', 100, { status: 'locked' }),
        day('2026-10-03', 100, { status: 'open' }),
        day('2026-10-04', 100, { status: 'pending_verification' }),
        day('2026-10-05', 100, { id: null, status: 'open' }),
      ],
      [],
    );
    assert.equal(of('2026-10-01').provisional, false);
    assert.equal(of('2026-10-02').provisional, false);
    assert.equal(of('2026-10-03').provisional, true);
    assert.equal(of('2026-10-04').provisional, true);
    assert.equal(of('2026-10-05').provisional, true);
  });

  test('neither the records nor the deposits are changed, or reordered', () => {
    const records = [day('2026-10-02', 500), day('2026-10-01', 700)];
    const deposits = [deposit('2026-10-03', 500), deposit('2026-10-02', 650)];
    const before = JSON.stringify({ records, deposits });
    reconcileDeposits(records, deposits);
    assert.equal(JSON.stringify({ records, deposits }), before);
  });

  test('the same inputs give the same answer every time', () => {
    const records = [day('2026-10-01', 700), day('2026-10-02', 500)];
    const deposits = [deposit('2026-10-02', 500), deposit('2026-10-03', 650)];
    const once = JSON.stringify([...reconcileDeposits(records, deposits).byDay]);
    assert.equal(JSON.stringify([...reconcileDeposits(records, deposits).byDay]), once);
  });
});

describe('summarizeDepositReconciliation', () => {
  test('adds the rows up and counts each state', () => {
    const { of } = reconcile(
      [day('2026-10-01', 1000), day('2026-10-02', 2000), day('2026-10-03', 3000), day('2026-10-06', 4000)],
      [
        deposit('2026-10-02', 1000),
        deposit('2026-10-03', 1500),
        deposit('2026-10-04', 3000, { status: 'pending' }),
      ],
    );
    const rows = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06'].map((d) => ({ reconciliation: of(d) }));
    const s = summarizeDepositReconciliation(rows);
    assert.equal(s.expected, 10000);
    assert.equal(s.received, 2500);
    assert.equal(s.pending, 3000);
    assert.equal(s.difference, 7500);
    assert.deepEqual(s.counts, { nothing_due: 0, not_received: 1, pending: 1, matched: 1, discrepancy: 1 });
  });

  test('an empty window is all zeros', () => {
    const s = summarizeDepositReconciliation([]);
    assert.equal(s.difference, 0);
    assert.deepEqual(s.counts, { nothing_due: 0, not_received: 0, pending: 0, matched: 0, discrepancy: 0 });
  });
});
