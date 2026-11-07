import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBranchAccount, type BranchAccountFacts, type DemandRecordRow, type FinanceDashboardDay } from '../../shared';
import { applyDemandRecord } from '../finance-monthly-dashboard.service';
import { chainOrder } from '../branch-account.service';

/**
 * Finance dates a demand by its REQUIRED date, not the business date it was
 * submitted on (owner's rule, 2026-11-07). The Demand Record's rows carry that
 * date, the balance chains in that order, and the dashboard's Demand, Company
 * Share and order count follow it. Submitted 31 Oct for 1 Nov is November's.
 */

const row = (orderId: string | null, businessDate: string, demand: number, share: number) =>
  ({ branchId: 'alpha', branchName: 'Alpha', orderId, businessDate, demand, companyShare: share }) as unknown as DemandRecordRow;

const day = (date: string, over: Partial<FinanceDashboardDay> = {}): FinanceDashboardDay => ({
  date, branchId: 'alpha', demand: 0, companyShare: 0, received: 0, returns: 0, discount: 0,
  orders: 0, unpricedLines: 0, receipts: 0, returnCount: 0, discountCount: 0, ...over,
});

// Dated as the Demand Record dates them: o2 was submitted on 31 Oct for 1 Nov.
const rows = [
  row(null, '2026-10-01', 0, 0),
  row('o1', '2026-10-30', 1000, 300),
  row('o2', '2026-11-01', 2000, 600),
  row('o3', '2026-11-02', 500, 150),
];

test('October counts only what was required in October', () => {
  // The SQL (business dates) put o2 on 31 Oct; the record's required date wins.
  const sqlDays = [day('2026-10-30', { demand: 1000, orders: 1 }), day('2026-10-31', { demand: 2000, orders: 1, received: 50 })];
  const out = applyDemandRecord(sqlDays, rows, '2026-10-01', '2026-10-01', '2026-10-31');
  const oct31 = out.find((d) => d.date === '2026-10-31')!;
  assert.deepEqual([oct31.demand, oct31.companyShare, oct31.orders, oct31.received], [0, 0, 0, 50]);
  assert.equal(out.reduce((s, d) => s + d.demand, 0), 1000);
  assert.equal(out.reduce((s, d) => s + d.orders, 0), 1);
});

test('November gains the demand submitted on 31 Oct for 1 Nov', () => {
  const out = applyDemandRecord([], rows, '2026-10-01', '2026-11-01', '2026-11-30');
  assert.deepEqual(out.map((d) => [d.date, d.demand, d.companyShare, d.orders]), [
    ['2026-11-01', 2000, 600, 1],
    ['2026-11-02', 500, 150, 1],
  ]);
});

const facts = (orderId: string | null, businessDate: string, at: string, delivered: number): BranchAccountFacts =>
  ({
    branchId: 'alpha', branchName: 'Alpha', orderId, demandNumber: orderId, businessDate, at, status: 'approved',
    frozenPct: 50, livePct: 50, delivered, returns: 0, returnsQty: 0, discount: 0, received: 0, sales: 0,
    adjustments: 0, unpricedLines: 0,
  }) as BranchAccountFacts;

test('the balance chains in required-date order, opening row first', () => {
  // B was submitted first but is required later than A.
  const list = [
    facts('B', '2026-11-03', '2026-11-01T09:00:00Z', 1000),
    facts(null, '2026-10-01', '2026-10-01T00:00:00Z', 0),
    facts('A', '2026-11-02', '2026-11-01T10:00:00Z', 400),
  ];
  list.sort(chainOrder);
  assert.deepEqual(list.map((f) => f.orderId), [null, 'A', 'B']);
  const chained = computeBranchAccount(list);
  assert.deepEqual(chained.map((r) => [r.orderId, r.previousBalance, r.remaining]), [[null, 0, 0], ['A', 0, 200], ['B', 200, 700]]);
});

test('same required date: submission order', () => {
  const list = [facts('late', '2026-11-02', '2026-11-01T12:00:00Z', 1), facts('early', '2026-11-02', '2026-11-01T08:00:00Z', 1)];
  assert.deepEqual(list.sort(chainOrder).map((f) => f.orderId), ['early', 'late']);
});
