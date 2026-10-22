import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReturnMonthSummary,
  businessMonthRange,
  currentBusinessMonth,
  filterReturnMonthLines,
  shiftMonth,
  sumReturnMonthLines,
  type ReturnMonthSqlRow,
} from '../../shared';

/**
 * The pure half of Return Summary: the month window and folding Postgres's
 * branch × product × reason-text aggregate into lines, items and totals. The
 * SQL half is return-month-summary.integration.test.ts.
 */

const karachi = (local: string) => new Date(`${local}+05:00`);
const NOW = karachi('2026-10-18T10:00:00');

const row = (over: Partial<ReturnMonthSqlRow>): ReturnMonthSqlRow => ({
  branchId: 'A',
  branchName: 'DHA Branch',
  productId: 'P1',
  productName: 'Chocolate Pastry',
  reason: 'damaged',
  count: 1,
  qty: 1,
  amount: 150,
  unpriced: 0,
  ...over,
});

describe('businessMonthRange', () => {
  test('runs from the 1st to the last day of the month', () => {
    assert.deepEqual(businessMonthRange('2026-10'), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(businessMonthRange('2026-11'), { from: '2026-11-01', to: '2026-11-30' });
    assert.deepEqual(businessMonthRange('2026-12'), { from: '2026-12-01', to: '2026-12-31' });
  });

  test('February has 28 days, 29 in a leap year', () => {
    assert.equal(businessMonthRange('2027-02').to, '2027-02-28');
    assert.equal(businessMonthRange('2028-02').to, '2028-02-29');
    assert.equal(businessMonthRange('2100-02').to, '2100-02-28', 'a century that is not a leap year');
  });

  test('shiftMonth crosses year boundaries both ways', () => {
    assert.equal(shiftMonth('2026-12', 1), '2027-01');
    assert.equal(shiftMonth('2027-01', -1), '2026-12');
    assert.equal(shiftMonth('2026-10', -10), '2025-12');
  });
});

describe('currentBusinessMonth', () => {
  test('is the month today’s business date falls in', () => {
    assert.equal(currentBusinessMonth(NOW), '2026-10');
  });

  test('rolls over at the 02:00 business-day start on the 1st, not at midnight', () => {
    assert.equal(currentBusinessMonth(karachi('2026-11-01T01:59:00')), '2026-10');
    assert.equal(currentBusinessMonth(karachi('2026-11-01T02:00:00')), '2026-11');
    assert.equal(currentBusinessMonth(karachi('2027-01-01T02:00:00')), '2027-01');
  });
});

describe('buildReturnMonthSummary', () => {
  const rows: ReturnMonthSqlRow[] = [
    // DHA chocolate pastry: "damaged" typed two ways is one Damaged line…
    row({ reason: 'damaged', qty: 2, amount: 300, count: 1 }),
    row({ reason: 'damage in transit', qty: 3, amount: 450, count: 2 }),
    // …and an unsold one stays its own line.
    row({ reason: 'unsold', qty: 3, amount: 450, count: 1 }),
    // The same item at another branch is a separate line.
    row({ branchId: 'B', branchName: 'North Nazimabad Branch', reason: 'not sold', qty: 4, amount: 600, count: 1 }),
    // Another item, one with no price on record.
    row({ productId: 'P2', productName: 'Cream Puff', reason: '', qty: 6, amount: 250, count: 2, unpriced: 1 }),
  ];
  const s = buildReturnMonthSummary(rows, '2026-10', NOW);

  test('names the month, its days, and the current month', () => {
    assert.equal(s.month, '2026-10');
    assert.equal(s.from, '2026-10-01');
    assert.equal(s.to, '2026-10-31');
    assert.equal(s.currentMonth, '2026-10');
  });

  test('consolidates branch × item × reason bucket, keeping different reasons and branches apart', () => {
    assert.deepEqual(
      s.lines.map((l) => [l.branchName, l.productName, l.reasonLabel, l.qty, l.amount, l.count]),
      [
        ['DHA Branch', 'Chocolate Pastry', 'Damaged', 5, 750, 3],
        ['DHA Branch', 'Chocolate Pastry', 'Unsold', 3, 450, 1],
        ['DHA Branch', 'Cream Puff', 'Not given', 6, 250, 2],
        ['North Nazimabad Branch', 'Chocolate Pastry', 'Unsold', 4, 600, 1],
      ],
    );
  });

  test('item-wise totals add every branch and reason, each item once', () => {
    assert.deepEqual(
      s.items.map((i) => [i.productName, i.qty, i.amount]),
      [
        ['Chocolate Pastry', 12, 1800],
        ['Cream Puff', 6, 250],
      ],
    );
    const choc = s.items[0]!;
    assert.deepEqual(choc.branches, [
      { branchId: 'A', branchName: 'DHA Branch', qty: 8, amount: 1200 },
      { branchId: 'B', branchName: 'North Nazimabad Branch', qty: 4, amount: 600 },
    ]);
  });

  test('totals agree with both tables and count branches and items once each', () => {
    assert.deepEqual(s.totals, { qty: 18, amount: 2050, count: 7, unpricedCount: 1, branchCount: 2, itemCount: 2 });
    assert.equal(s.items.reduce((t, i) => t + i.qty, 0), s.totals.qty);
    assert.equal(sumReturnMonthLines(s.lines).amount, s.totals.amount);
  });

  test('adds money in paisa, not floats', () => {
    const r = buildReturnMonthSummary([row({ amount: 0.1 }), row({ reason: 'broken', amount: 0.2 })], '2026-10', NOW);
    assert.equal(r.totals.amount, 0.3);
  });

  test('an empty month is all zeros, not an error', () => {
    const r = buildReturnMonthSummary([], '2026-11', karachi('2026-11-01T09:00:00'));
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.items, []);
    assert.deepEqual(r.totals, { qty: 0, amount: 0, count: 0, unpricedCount: 0, branchCount: 0, itemCount: 0 });
  });
});

describe('filterReturnMonthLines', () => {
  const { lines } = buildReturnMonthSummary(
    [
      row({}),
      row({ reason: 'unsold' }),
      row({ branchId: 'B', branchName: 'North Nazimabad Branch' }),
      row({ productId: 'P2', productName: 'Cream Puff' }),
    ],
    '2026-10',
    NOW,
  );

  test('searches the item name, case-insensitively', () => {
    assert.deepEqual(filterReturnMonthLines(lines, { search: '  CREAM ' }).map((l) => l.productName), ['Cream Puff']);
  });

  test('filters by branch and by reason, and combines them', () => {
    assert.equal(filterReturnMonthLines(lines, { branchId: 'B' }).length, 1);
    assert.equal(filterReturnMonthLines(lines, { reason: 'unsold' }).length, 1);
    assert.equal(filterReturnMonthLines(lines, { branchId: 'A', reason: 'damaged' }).length, 2);
    assert.equal(filterReturnMonthLines(lines, {}).length, lines.length);
  });
});
