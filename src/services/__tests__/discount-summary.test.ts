import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscountSummary, type DiscountSummaryRow } from '../../shared';

/**
 * The pure half of the monthly Branch Discount summary: folding Postgres's
 * branch × status aggregate into per-branch and overall figures. The window
 * itself is `monthToDateRange`, pinned in returns-summary.test.ts; the SQL half
 * (window, scope, roles) is discount-summary.integration.test.ts.
 */

const RANGE = { from: '2026-10-01', to: '2026-10-18' };
const row = (o: Partial<DiscountSummaryRow>): DiscountSummaryRow => ({
  branchId: 'a', branchName: 'DHA Branch', status: 'pending', count: 1, amount: 100, ...o,
});

describe('buildDiscountSummary', () => {
  test('each status lands in its own bucket only, and the buckets sum to submitted', () => {
    const s = buildDiscountSummary(
      [
        row({ status: 'pending', count: 1, amount: 300 }),
        row({ status: 'approved', count: 2, amount: 1250 }),
        row({ status: 'rejected', count: 1, amount: 150 }),
        row({ status: 'returned', count: 1, amount: 600 }),
      ],
      [{ id: 'a', name: 'DHA Branch' }],
      RANGE,
    );
    const a = s.branches[0]!;
    assert.deepEqual(a.pending, { amount: 300, count: 1 });
    assert.deepEqual(a.approved, { amount: 1250, count: 2 });
    assert.deepEqual(a.rejected, { amount: 150, count: 1 });
    assert.deepEqual(a.returned, { amount: 600, count: 1 });
    assert.deepEqual(a.submitted, { amount: 2300, count: 5 });
  });

  test('every active branch is listed, a branch with no claims at Rs. 0', () => {
    const s = buildDiscountSummary(
      [row({ branchId: 'a', status: 'approved', amount: 500 })],
      [{ id: 'b', name: 'Gulshan Branch' }, { id: 'a', name: 'DHA Branch' }],
      RANGE,
    );
    assert.deepEqual(s.branches.map((b) => b.branchName), ['DHA Branch', 'Gulshan Branch']);
    const gulshan = s.branches.find((b) => b.branchId === 'b')!;
    assert.deepEqual(gulshan.approved, { amount: 0, count: 0 });
    assert.deepEqual(gulshan.submitted, { amount: 0, count: 0 });
  });

  test('the overall total is the branches added together, per status', () => {
    const s = buildDiscountSummary(
      [
        row({ branchId: 'a', status: 'approved', amount: 1000 }),
        row({ branchId: 'b', branchName: 'Gulshan Branch', status: 'approved', amount: 250.5 }),
        row({ branchId: 'b', branchName: 'Gulshan Branch', status: 'pending', amount: 99.5 }),
      ],
      [{ id: 'a', name: 'DHA Branch' }, { id: 'b', name: 'Gulshan Branch' }],
      RANGE,
    );
    assert.deepEqual(s.totals.approved, { amount: 1250.5, count: 2 });
    assert.deepEqual(s.totals.pending, { amount: 99.5, count: 1 });
    assert.deepEqual(s.totals.submitted, { amount: 1350, count: 3 });
  });

  test('money is added in whole paisa, not as floats', () => {
    const s = buildDiscountSummary(
      [row({ status: 'approved', amount: 0.1 }), row({ branchId: 'b', branchName: 'B', status: 'approved', amount: 0.2 })],
      [{ id: 'a', name: 'DHA Branch' }, { id: 'b', name: 'B' }],
      RANGE,
    );
    assert.equal(s.totals.approved.amount, 0.3);
  });

  test('a claim of a branch outside the list (since deactivated) is kept, so no money drops out', () => {
    const s = buildDiscountSummary([row({ branchId: 'x', branchName: 'Closed Branch', status: 'approved', amount: 400 })], [], RANGE);
    assert.equal(s.branches.length, 1);
    assert.equal(s.totals.approved.amount, 400);
  });

  test('numeric strings from the driver are read as numbers', () => {
    const s = buildDiscountSummary(
      [row({ status: 'approved', amount: '725.50' as unknown as number, count: '3' as unknown as number })],
      [{ id: 'a', name: 'DHA Branch' }],
      RANGE,
    );
    assert.deepEqual(s.branches[0]!.approved, { amount: 725.5, count: 3 });
  });

  test('carries the window it was given', () => {
    const s = buildDiscountSummary([], [], RANGE);
    assert.equal(s.from, '2026-10-01');
    assert.equal(s.to, '2026-10-18');
    assert.deepEqual(s.totals.submitted, { amount: 0, count: 0 });
  });
});
