import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildReturnsSummary, monthToDateRange, type ReturnsSummaryRow } from '../../shared';

/**
 * The pure half of the monthly Product Returns summary: the month-to-date
 * window, and folding Postgres's branch × status aggregate into per-branch and
 * overall figures. The SQL half (pricing, branch scope, the window applied to
 * real rows) is returns-summary.integration.test.ts.
 */

/** A Karachi wall-clock instant (+05:00, no DST). */
const karachi = (local: string) => new Date(`${local}+05:00`);

describe('monthToDateRange', () => {
  test('runs from the 1st of the business month to today, inclusive', () => {
    assert.deepEqual(monthToDateRange(karachi('2026-10-18T10:00:00')), { from: '2026-10-01', to: '2026-10-18' });
  });

  test('on the 1st it is a one-day window', () => {
    assert.deepEqual(monthToDateRange(karachi('2026-11-01T09:00:00')), { from: '2026-11-01', to: '2026-11-01' });
  });

  test('the last day of a month still belongs to that month', () => {
    assert.deepEqual(monthToDateRange(karachi('2026-10-31T23:59:00')), { from: '2026-10-01', to: '2026-10-31' });
  });

  test('before the 02:00 rollover on the 1st it is still the previous month', () => {
    assert.deepEqual(monthToDateRange(karachi('2026-11-01T01:30:00')), { from: '2026-10-01', to: '2026-10-31' });
  });

  test('December → January crosses the year at the business-day rollover', () => {
    assert.deepEqual(monthToDateRange(karachi('2027-01-01T01:59:00')), { from: '2026-12-01', to: '2026-12-31' });
    assert.deepEqual(monthToDateRange(karachi('2027-01-01T02:00:00')), { from: '2027-01-01', to: '2027-01-01' });
  });
});

const RANGE = { from: '2026-10-01', to: '2026-10-18' };
const row = (o: Partial<ReturnsSummaryRow>): ReturnsSummaryRow => ({
  branchId: 'a', branchName: 'DHA Branch', status: 'pending',
  productId: 'p1', productName: 'Fudge Pastry', productCode: 'FP-01',
  count: 1, qty: 1, amount: 100, unpriced: 0, ...o,
});

describe('buildReturnsSummary', () => {
  test('each status lands in its own bucket only, and the buckets sum to submitted', () => {
    const s = buildReturnsSummary(
      [
        row({ status: 'pending', count: 1, qty: 2, amount: 300 }),
        row({ status: 'accepted', count: 2, qty: 3, amount: 450 }),
        row({ status: 'rejected', count: 1, qty: 1, amount: 150 }),
        row({ status: 'returned', count: 1, qty: 4, amount: 600 }),
      ],
      [{ id: 'a', name: 'DHA Branch' }],
      RANGE,
    );
    const a = s.branches[0]!;
    assert.deepEqual(a.pending, { qty: 2, amount: 300, count: 1 });
    assert.deepEqual(a.accepted, { qty: 3, amount: 450, count: 2 });
    assert.deepEqual(a.rejected, { qty: 1, amount: 150, count: 1 });
    assert.deepEqual(a.returned, { qty: 4, amount: 600, count: 1 });
    assert.deepEqual(a.submitted, { qty: 10, amount: 1500, count: 5 });
  });

  test('overall totals add up every branch, and a branch with no returns shows at zero', () => {
    const s = buildReturnsSummary(
      [
        row({ branchId: 'a', status: 'accepted', count: 2, qty: 5, amount: 750 }),
        row({ branchId: 'b', branchName: 'Gulshan Branch', status: 'pending', count: 1, qty: 2, amount: 300, unpriced: 1 }),
      ],
      [{ id: 'a', name: 'DHA Branch' }, { id: 'b', name: 'Gulshan Branch' }, { id: 'c', name: 'Bahria Branch' }],
      RANGE,
    );
    assert.deepEqual(s.branches.map((b) => b.branchName), ['Bahria Branch', 'DHA Branch', 'Gulshan Branch']);
    assert.deepEqual(s.branches[0]!.submitted, { qty: 0, amount: 0, count: 0 });
    assert.deepEqual(s.totals.submitted, { qty: 7, amount: 1050, count: 3 });
    assert.deepEqual(s.totals.accepted, { qty: 5, amount: 750, count: 2 });
    assert.deepEqual(s.totals.pending, { qty: 2, amount: 300, count: 1 });
    assert.equal(s.totals.unpricedCount, 1);
    assert.equal(s.from, RANGE.from);
    assert.equal(s.to, RANGE.to);
  });

  test('a branch outside the listed ones (e.g. deactivated) is kept under its row name', () => {
    const s = buildReturnsSummary([row({ branchId: 'z', branchName: 'Old Branch' })], [], RANGE);
    assert.equal(s.branches.length, 1);
    assert.equal(s.branches[0]!.branchName, 'Old Branch');
    assert.equal(s.totals.submitted.count, 1);
  });

  test('money stays at the paisa — no float drift across many lines', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ status: 'accepted', amount: 0.1, qty: 1, productId: `p${i}` }));
    const s = buildReturnsSummary(rows, [{ id: 'a', name: 'DHA Branch' }], RANGE);
    assert.equal(s.totals.accepted.amount, 1);
    assert.equal(s.totals.submitted.amount, 1);
  });

  test('item-wise lines add the same product across statuses, per branch and overall', () => {
    const s = buildReturnsSummary(
      [
        row({ branchId: 'a', status: 'pending', productId: 'p1', qty: 2, amount: 300, count: 1 }),
        row({ branchId: 'a', status: 'accepted', productId: 'p1', qty: 3, amount: 450, count: 2 }),
        row({ branchId: 'a', status: 'accepted', productId: 'p2', productName: 'Lotus Pastry', productCode: null, qty: 1, amount: 150 }),
        row({ branchId: 'b', branchName: 'Gulshan Branch', status: 'rejected', productId: 'p1', qty: 4, amount: 600 }),
      ],
      [{ id: 'a', name: 'DHA Branch' }, { id: 'b', name: 'Gulshan Branch' }],
      RANGE,
    );
    const dha = s.branches.find((b) => b.branchId === 'a')!;
    assert.deepEqual(dha.products, [
      { productId: 'p1', productName: 'Fudge Pastry', productCode: 'FP-01', qty: 5, amount: 750, count: 3 },
      { productId: 'p2', productName: 'Lotus Pastry', productCode: null, qty: 1, amount: 150, count: 1 },
    ]);
    // Product lines sum back to submitted — nothing counted twice or dropped.
    const lineTotal = dha.products.reduce((t, p) => t + p.amount, 0);
    assert.equal(lineTotal, dha.submitted.amount);
    assert.deepEqual(s.products[0], { productId: 'p1', productName: 'Fudge Pastry', productCode: 'FP-01', qty: 9, amount: 1350, count: 4 });
    assert.equal(s.branchesReporting, 2);
  });

  test('branchesReporting counts only branches with a return this month', () => {
    const s = buildReturnsSummary([row({ branchId: 'a' })], [{ id: 'a', name: 'DHA Branch' }, { id: 'c', name: 'Bahria Branch' }], RANGE);
    assert.equal(s.branches.length, 2);
    assert.equal(s.branchesReporting, 1);
  });

  test('no rows at all is an all-zero summary, not an error', () => {
    const s = buildReturnsSummary([], [], RANGE);
    assert.deepEqual(s.branches, []);
    assert.deepEqual(s.products, []);
    assert.equal(s.branchesReporting, 0);
    assert.deepEqual(s.totals.submitted, { qty: 0, amount: 0, count: 0 });
    assert.equal(s.totals.unpricedCount, 0);
  });
});
