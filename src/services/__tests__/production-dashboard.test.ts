import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketKeys,
  buildBranchSummary,
  buildCurrentStock,
  buildReceivedDemand,
  buildRepairedStock,
  buildReturnStock,
  dashboardWindow,
  mondayOf,
  pctDelta,
  ptsDelta,
  ratePct,
  returnReasonBucket,
  seriesBucket,
  stockState,
} from '../../shared';

/**
 * The Production Dashboard's period arithmetic and the pure half of each
 * section — everything that happens after the SQL has answered. The SQL itself
 * runs for real in production-dashboard.integration.test.ts.
 */

const AT = '2026-10-18T00:00:00.000Z';

describe('dashboardWindow', () => {
  test('today is compared with yesterday', () => {
    assert.deepEqual(dashboardWindow('today', '2026-10-14'), {
      period: 'today', from: '2026-10-14', to: '2026-10-14', prevFrom: '2026-10-13', prevTo: '2026-10-13',
    });
  });

  test('a week runs Monday to today, beside the same weekdays of last week', () => {
    // Wednesday 14 Oct 2026
    assert.deepEqual(dashboardWindow('week', '2026-10-14'), {
      period: 'week', from: '2026-10-12', to: '2026-10-14', prevFrom: '2026-10-05', prevTo: '2026-10-07',
    });
  });

  test('on a Sunday the week is the whole Monday..Sunday, never the next one', () => {
    const w = dashboardWindow('week', '2026-10-18');
    assert.equal(w.from, '2026-10-12');
    assert.equal(w.to, '2026-10-18');
    assert.equal(w.prevFrom, '2026-10-05');
    assert.equal(w.prevTo, '2026-10-11');
  });

  test('on a Monday the week is that one day', () => {
    const w = dashboardWindow('week', '2026-10-12');
    assert.equal(w.from, '2026-10-12');
    assert.equal(w.prevFrom, '2026-10-05');
    assert.equal(w.prevTo, '2026-10-05');
  });

  test('a week that started last month still starts on its Monday', () => {
    assert.equal(dashboardWindow('week', '2026-10-01').from, '2026-09-28'); // Thursday 1 Oct
    assert.equal(mondayOf('2026-01-01'), '2025-12-29');
  });

  test('a month runs from the 1st, beside the same days of last month', () => {
    assert.deepEqual(dashboardWindow('month', '2026-10-14'), {
      period: 'month', from: '2026-10-01', to: '2026-10-14', prevFrom: '2026-09-01', prevTo: '2026-09-14',
    });
  });

  test('the previous month is clamped to its own length', () => {
    const w = dashboardWindow('month', '2026-03-31');
    assert.equal(w.prevFrom, '2026-02-01');
    assert.equal(w.prevTo, '2026-02-28');
    assert.equal(dashboardWindow('month', '2026-01-15').prevFrom, '2025-12-01');
  });

  test('the previous window always ends before the current one starts', () => {
    for (const today of ['2026-10-01', '2026-10-12', '2026-10-18', '2026-03-31', '2026-01-01']) {
      for (const p of ['today', 'week', 'month'] as const) {
        const w = dashboardWindow(p, today);
        assert.ok(w.prevTo < w.from, `${p} on ${today}`);
      }
    }
  });
});

describe('series buckets', () => {
  test('today by the hour, a month of stacked columns by week, otherwise by day', () => {
    assert.equal(seriesBucket('today'), 'hour');
    assert.equal(seriesBucket('week'), 'day');
    assert.equal(seriesBucket('month'), 'day');
    assert.equal(seriesBucket('month', { weeklyForMonth: true }), 'week');
    assert.equal(seriesBucket('week', { weeklyForMonth: true }), 'day');
  });

  test('every day of the window is a key, even with nothing in it', () => {
    assert.deepEqual(bucketKeys({ from: '2026-10-12', to: '2026-10-14' }, 'day'), ['2026-10-12', '2026-10-13', '2026-10-14']);
  });

  test('weeks are keyed by their Monday, the first one before the 1st if need be', () => {
    assert.deepEqual(bucketKeys({ from: '2026-10-01', to: '2026-10-14' }, 'week'), ['2026-09-28', '2026-10-05', '2026-10-12']);
  });

  test('hours fill the gap between the first and the last seen, and nothing else', () => {
    assert.deepEqual(bucketKeys({ from: '2026-10-14', to: '2026-10-14' }, 'hour', ['2026-10-14T11', '2026-10-14T09']), [
      '2026-10-14T09', '2026-10-14T10', '2026-10-14T11',
    ]);
    assert.deepEqual(bucketKeys({ from: '2026-10-14', to: '2026-10-14' }, 'hour'), []);
  });

  test('an hour past midnight still belongs to the business day it was keyed under', () => {
    assert.deepEqual(bucketKeys({ from: '2026-10-14', to: '2026-10-14' }, 'hour', ['2026-10-14T23', '2026-10-15T01']), [
      '2026-10-14T23', '2026-10-15T00', '2026-10-15T01',
    ]);
  });
});

describe('deltas', () => {
  test('percent change against the previous period, one decimal', () => {
    assert.deepEqual(pctDelta(150, 120), { value: 25, unit: '%' });
    assert.deepEqual(pctDelta(80, 105), { value: -23.8, unit: '%' });
  });

  test('nothing to compare with when the previous period had nothing', () => {
    assert.equal(pctDelta(10, 0), null);
    assert.equal(pctDelta(0, 0), null);
  });

  test('a rate changes by points, not percent', () => {
    assert.deepEqual(ptsDelta(80, 75.5), { value: 4.5, unit: 'pts' });
    assert.equal(ptsDelta(null, 50), null);
    assert.equal(ptsDelta(50, null), null);
  });

  test('a rate with nothing to divide by is null, not 0 or 100', () => {
    assert.equal(ratePct(5, 0), null);
    assert.equal(ratePct(1, 3), 33.3);
    // Never capped: more delivered than asked for is a real answer.
    assert.equal(ratePct(120, 100), 120);
  });
});

describe('Received Demand', () => {
  const win = dashboardWindow('week', '2026-10-14');

  test('kpis, deltas and stacked series by status', () => {
    const s = buildReceivedDemand(win, 'day', [
      { cur: true, status: 'pending', orders: 1, units: 10 },
      { cur: true, status: 'awaiting_verification', orders: 2, units: 30 },
      { cur: true, status: 'rejected', orders: 1, units: 5 },
      { cur: false, status: 'approved', orders: 2, units: 30 },
      { cur: false, status: 'rejected', orders: 2, units: 4 },
    ], [
      { bucket: '2026-10-12', status: 'pending', orders: 1, units: 10 },
      { bucket: '2026-10-14', status: 'awaiting_verification', orders: 2, units: 30 },
      { bucket: '2026-10-14', status: 'rejected', orders: 1, units: 5 },
    ], [{ productId: 'p1', productName: 'Bun', units: 20 }], AT);

    assert.deepEqual(s.kpis, { units: 45, orders: 4, avgUnits: 11.3, pendingVerification: 2, rejected: 1 });
    assert.deepEqual(s.previous, { units: 34, orders: 4, avgUnits: 8.5, pendingVerification: 0, rejected: 2 });
    assert.deepEqual(s.comparePrevious.units, { value: 32.4, unit: '%' });
    assert.deepEqual(s.comparePrevious.rejected, { value: -50, unit: '%' });
    assert.equal(s.comparePrevious.pendingVerification, null, 'nothing pending last week');
    assert.deepEqual(s.series.map((p) => p.bucket), ['2026-10-12', '2026-10-13', '2026-10-14']);
    assert.equal(s.series[1]!.units, 0, 'an empty day is still there, at zero');
    assert.deepEqual(s.series[2]!.byStatus.awaiting_verification, { units: 30, orders: 2 });
    assert.equal(s.series[2]!.units, 35);
    assert.equal(s.breakdown.topProducts[0]!.productName, 'Bun');
  });

  test('an empty period has zeros, no averages and no deltas', () => {
    const s = buildReceivedDemand(win, 'day', [], [], [], AT);
    assert.deepEqual(s.kpis, { units: 0, orders: 0, avgUnits: null, pendingVerification: 0, rejected: 0 });
    assert.ok(Object.values(s.comparePrevious).every((d) => d === null));
    assert.equal(s.series.length, 3);
    assert.ok(s.series.every((p) => p.units === 0));
  });
});

describe('Branch-wise', () => {
  const win = dashboardWindow('week', '2026-10-14');
  const row = (branchId: string, branchName: string, demanded: number, delivered: number, returned = 0, prevDemanded = 0, prevDelivered = 0) => ({
    branchId, branchName, lastSubmittedAt: null, demanded, delivered, returned, prevDemanded, prevDelivered,
  });

  test('every active branch is listed, busiest first, idle ones by name', () => {
    const s = buildBranchSummary(win, 'day', [
      row('c', 'Zeta', 0, 0), row('a', 'Alpha', 10, 8, 1, 20, 20), row('b', 'Beta', 40, 30), row('d', 'Delta', 0, 0),
    ], [{ branchId: 'b', bucket: '2026-10-13', units: 40 }], AT);
    assert.deepEqual(s.series.map((b) => b.branchName), ['Beta', 'Alpha', 'Delta', 'Zeta']);
    assert.equal(s.kpis.activeBranches, 4);
    assert.equal(s.kpis.branchesWithDemand, 2);
    assert.equal(s.series.find((b) => b.branchId === 'c')!.fulfilment, null, 'no demand, no rate');
    assert.deepEqual(s.series.find((b) => b.branchId === 'b')!.spark, [0, 40, 0]);
    assert.deepEqual(s.series.find((b) => b.branchId === 'a')!.spark, [0, 0, 0]);
    assert.deepEqual(s.breakdown.sparkKeys, ['2026-10-12', '2026-10-13', '2026-10-14']);
  });

  test('fulfilment is delivered ÷ demanded over the same orders, compared in points', () => {
    const s = buildBranchSummary(win, 'day', [row('a', 'A', 100, 80, 0, 100, 90)], [], AT);
    assert.equal(s.kpis.fulfilment, 80);
    assert.equal(s.previous.fulfilment, 90);
    assert.deepEqual(s.comparePrevious.fulfilment, { value: -10, unit: 'pts' });
    assert.equal(s.comparePrevious.activeBranches, null, 'not a period figure');
  });
});

describe('Repaired Stock', () => {
  test('repair rate is repaired ÷ returned; the top product comes from the ranked list', () => {
    const win = dashboardWindow('week', '2026-10-14');
    const s = buildRepairedStock(win, 'day', [
      { cur: true, returned: 20, repaired: 5, backToStock: 3 },
      { cur: false, returned: 10, repaired: 5, backToStock: 0 },
    ], [{ bucket: '2026-10-13', returned: 20, repaired: 5 }], [{ productId: 'p', productName: 'Rusk', units: 5 }], AT);
    assert.deepEqual(s.kpis, { repaired: 5, repairRate: 25, backToStock: 3 });
    assert.deepEqual(s.comparePrevious.repairRate, { value: -25, unit: 'pts' });
    assert.equal(s.comparePrevious.repaired!.value, 0);
    assert.equal(s.comparePrevious.backToStock, null);
    assert.equal(s.breakdown.topProduct!.productName, 'Rusk');
    assert.deepEqual(s.series.map((p) => [p.bucket, p.repaired, p.returned]), [
      ['2026-10-12', 0, 0], ['2026-10-13', 5, 20], ['2026-10-14', 0, 0],
    ]);
  });

  test('nothing returned: no rate, no top product', () => {
    const s = buildRepairedStock(dashboardWindow('today', '2026-10-14'), 'hour', [], [], [], AT);
    assert.deepEqual(s.kpis, { repaired: 0, repairRate: null, backToStock: 0 });
    assert.equal(s.breakdown.topProduct, null);
    assert.deepEqual(s.series, []);
  });
});

describe('Return Stock', () => {
  const win = dashboardWindow('week', '2026-10-14');

  test('top branch, top product, heat grid and reasons', () => {
    const s = buildReturnStock(win, 'day', [
      { cur: true, returned: 12, delivered: 200 },
      { cur: false, returned: 6, delivered: 300 },
    ], [{ bucket: '2026-10-14', returned: 12 }], [
      { branchId: 'a', branchName: 'Alpha', productId: 'p1', productName: 'Bun', units: 7 },
      { branchId: 'a', branchName: 'Alpha', productId: 'p2', productName: 'Rusk', units: 1 },
      { branchId: 'b', branchName: 'Beta', productId: 'p2', productName: 'Rusk', units: 4 },
      { branchId: 'c', branchName: 'Gamma', productId: null, productName: null, units: 0 },
    ], [
      { reason: 'expired', units: 5 }, { reason: 'exp', units: 2 }, { reason: 'damage/expired', units: 1 },
      { reason: 'broken box', units: 3 }, { reason: null, units: 1 },
    ], 42, AT);

    assert.deepEqual(s.kpis, { returned: 12, returnRate: 6, onHand: 42 });
    assert.deepEqual(s.comparePrevious.returnRate, { value: 4, unit: 'pts' });
    assert.equal(s.comparePrevious.onHand, null);
    assert.equal(s.breakdown.topBranch!.branchName, 'Alpha');
    assert.equal(s.breakdown.topProduct!.productName, 'Bun');
    assert.deepEqual(s.breakdown.heat.products.map((p) => p.productName), ['Bun', 'Rusk']);
    assert.deepEqual(s.breakdown.heat.rows.map((r) => [r.branchName, r.values]), [
      ['Alpha', [7, 1]], ['Beta', [0, 4]], ['Gamma', [0, 0]],
    ]);
    assert.deepEqual(s.breakdown.byReason.map((r) => [r.reason, r.units]), [
      ['expired', 8], ['damaged', 3], ['unsold', 0], ['other', 0], ['none', 1],
    ]);
  });

  test('a period with no returns has no top branch and an empty grid', () => {
    const s = buildReturnStock(win, 'day', [], [], [
      { branchId: 'a', branchName: 'Alpha', productId: null, productName: null, units: 0 },
    ], [], 0, AT);
    assert.equal(s.kpis.returned, 0);
    assert.equal(s.kpis.returnRate, null);
    assert.equal(s.breakdown.topBranch, null);
    assert.equal(s.breakdown.topProduct, null);
    assert.deepEqual(s.breakdown.heat.products, []);
    assert.ok(s.breakdown.byReason.every((r) => r.units === 0));
  });
});

describe('returnReasonBucket', () => {
  const cases: [string | null, string][] = [
    ['Expired', 'expired'], ['Exp', 'expired'], ['Expeir', 'expired'], ['  EXPIRY DATE ', 'expired'],
    ['damage/expired', 'expired'], ['Damaged', 'damaged'], ['box broken', 'damaged'], ['crushed', 'damaged'],
    ['unsold', 'unsold'], ['Not sold', 'unsold'], ['left over', 'unsold'], ['extra stock', 'unsold'],
    ['wrong item sent', 'other'], [null, 'none'], ['', 'none'], ['  ', 'none'], ['-', 'none'],
  ];
  for (const [reason, bucket] of cases) {
    test(`${JSON.stringify(reason)} → ${bucket}`, () => assert.equal(returnReasonBucket(reason), bucket));
  }
});

describe('Current Stock', () => {
  test('low below the threshold, out at nothing; a pool shortfall is not stock', () => {
    assert.equal(stockState(0, 5), 'out');
    assert.equal(stockState(-3, 5), 'out');
    assert.equal(stockState(4, 5), 'low');
    assert.equal(stockState(5, 5), 'ok');

    const s = buildCurrentStock([
      { productId: 'a', productName: 'Bun', production: 10, branch: 6 },
      { productId: 'b', productName: 'Rusk', production: -4, branch: 3 },
      { productId: 'c', productName: 'Cake', production: 0, branch: 0 },
    ], 5, null, AT);
    assert.deepEqual(s.series.map((r) => [r.productName, r.total, r.state]), [['Bun', 16, 'ok'], ['Rusk', 3, 'low'], ['Cake', 0, 'out']]);
    // Summed as the Production Stock page sums it, shortfall included.
    assert.deepEqual(s.kpis, { production: 6, branch: 9, inStock: 2, low: 1, out: 1 });
    assert.deepEqual(s.breakdown, { threshold: 5, products: 3 });
  });
});
