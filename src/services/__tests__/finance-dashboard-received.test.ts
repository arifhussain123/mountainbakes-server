import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FinanceDashboardDay } from '../../shared';
import { applyCashTransfers } from '../finance-monthly-dashboard.service';

/**
 * Received on the Finance Dashboard is the Cash Transfer Details table's Total
 * Amount — the Company Share money, never Fuel Charges — not the income ledger.
 */

const day = (date: string, branchId: string | null, received: number, receipts: number, orders = 0) =>
  ({
    date, branchId, demand: 0, companyShare: 0, received, returns: 0, discount: 0,
    orders, unpricedLines: 0, receipts, returnCount: 0, discountCount: 0,
  }) as FinanceDashboardDay;

test('Received is replaced by the transfers on that day and branch; the ledger figure (with fuel) is dropped', () => {
  const out = applyCashTransfers(
    [day('2026-10-01', 'a', 1300, 2, 1), day('2026-10-02', 'a', 500, 1, 1), day('2026-10-01', null, 900, 1)],
    [{ date: '2026-10-01', branchId: 'a', amount: 1000, transfers: 1 }],
    '2026-10-01',
    '2026-10-31',
  );
  const pick = (d: string, b: string | null) => out.find((x) => x.date === d && x.branchId === b)!;
  assert.deepEqual([pick('2026-10-01', 'a').received, pick('2026-10-01', 'a').receipts], [1000, 1]);
  // No transfer that day: nothing received, even though the ledger had an entry.
  assert.deepEqual([pick('2026-10-02', 'a').received, pick('2026-10-02', 'a').receipts], [0, 0]);
  // A ledger receipt with no branch is not a cash transfer.
  assert.equal(pick('2026-10-01', null).received, 0);
});

test('a transfer on a day with no other activity is added; one outside the window is not', () => {
  const out = applyCashTransfers(
    [],
    [
      { date: '2026-10-05', branchId: 'b', amount: 2500.5, transfers: 2 },
      { date: '2026-09-30', branchId: 'b', amount: 99, transfers: 1 },
    ],
    '2026-10-01',
    '2026-10-31',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.date, '2026-10-05');
  assert.equal(out[0]!.received, 2500.5);
  assert.equal(out[0]!.receipts, 2);
  assert.equal(out[0]!.orders, 0);
});
