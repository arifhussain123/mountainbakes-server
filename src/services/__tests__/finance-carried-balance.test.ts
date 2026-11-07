import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DemandRecordRow } from '../../shared';
import { carriedBalances } from '../finance-monthly-dashboard.service';

/**
 * Last Month Balance on the Finance Dashboard: what each branch carried into
 * the month from the Demand Record. The record began on 1 Oct, when every
 * branch started at zero unless Finance entered an opening balance.
 */

const row = (branchId: string, businessDate: string, opts: { opening?: boolean; previous?: number; remaining: number }) =>
  ({
    branchId, branchName: branchId, businessDate,
    orderId: opts.opening ? null : `o-${branchId}-${businessDate}`,
    previousBalance: opts.previous ?? 0, remaining: opts.remaining,
  }) as unknown as DemandRecordRow;

const rows = [
  // Alpha: Finance entered a 1,000 opening; demands from 2 Oct.
  row('alpha', '2026-10-01', { opening: true, remaining: 1000 }),
  row('alpha', '2026-10-02', { previous: 1000, remaining: 1800 }),
  row('alpha', '2026-11-03', { previous: 1800, remaining: 2400 }),
  // Beta: no opening entry; first demand 5 Oct.
  row('beta', '2026-10-05', { previous: 0, remaining: 500 }),
  // Gamma: joins in November.
  row('gamma', '2026-11-10', { previous: 0, remaining: 300 }),
];
const of = (xs: { branchId: string | null; balance: number | null }[]) => Object.fromEntries(xs.map((x) => [x.branchId, x.balance]));

test('October, the first month: the opening balance or 0 — never blank', () => {
  assert.deepEqual(of(carriedBalances(rows, '2026-10-01', '2026-10-31')), { alpha: 1000, beta: 0 });
});

test('November: each branch carries its October closing; a branch new this month carries 0', () => {
  assert.deepEqual(of(carriedBalances(rows, '2026-11-01', '2026-11-30')), { alpha: 1800, beta: 500, gamma: 0 });
});

test('September, before the record began: nothing is carried, so the table says "no records"', () => {
  assert.deepEqual(carriedBalances(rows, '2026-09-01', '2026-09-30'), []);
});
