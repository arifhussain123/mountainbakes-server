import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FinanceDashboardDay } from '../../shared';
import { applyCompanyShareReceipts } from '../finance-monthly-dashboard.service';

/**
 * Received on the Finance Dashboard is the Daily Ledger's Company Share income
 * per branch — never Fuel Charges or any other head. The SQL picks the head;
 * this regroups it onto the dashboard's days.
 */

const day = (date: string, branchId: string | null, received: number, receipts: number, orders = 0) =>
  ({
    date, branchId, demand: 0, companyShare: 0, received, returns: 0, discount: 0,
    orders, unpricedLines: 0, receipts, returnCount: 0, discountCount: 0,
  }) as FinanceDashboardDay;

test('Received is replaced by the Company Share entries on that day and branch; the old figure (with fuel) is dropped', () => {
  const out = applyCompanyShareReceipts(
    [day('2026-10-01', 'a', 1300, 2, 1), day('2026-10-02', 'a', 500, 1, 1), day('2026-10-01', null, 900, 1)],
    [{ date: '2026-10-01', branchId: 'a', amount: 1000, entries: 1 }],
    '2026-10-01',
    '2026-10-31',
  );
  const pick = (d: string, b: string | null) => out.find((x) => x.date === d && x.branchId === b)!;
  assert.deepEqual([pick('2026-10-01', 'a').received, pick('2026-10-01', 'a').receipts], [1000, 1]);
  // No Company Share entry that day: nothing received, even though another head had one.
  assert.deepEqual([pick('2026-10-02', 'a').received, pick('2026-10-02', 'a').receipts], [0, 0]);
  // No Company Share entry without a branch that day either.
  assert.equal(pick('2026-10-01', null).received, 0);
});

test('Company Share on a day with no other activity is added, unassigned too; one outside the window is not', () => {
  const out = applyCompanyShareReceipts(
    [],
    [
      { date: '2026-10-05', branchId: 'b', amount: 2500.5, entries: 2 },
      { date: '2026-09-30', branchId: 'b', amount: 99, entries: 1 },
      { date: '2026-10-06', branchId: null, amount: 300, entries: 1 },
    ],
    '2026-10-01',
    '2026-10-31',
  );
  assert.equal(out.length, 2);
  assert.deepEqual([out[1]!.branchId, out[1]!.received], [null, 300]);
  assert.equal(out[0]!.date, '2026-10-05');
  assert.equal(out[0]!.received, 2500.5);
  assert.equal(out[0]!.receipts, 2);
  assert.equal(out[0]!.orders, 0);
});
