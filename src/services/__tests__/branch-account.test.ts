import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceStanding,
  companyShareOf,
  computeBranchAccount,
  totalBranchAccount,
  type BranchAccountFacts,
} from '../../shared';

/**
 * The Demand Record's money rules (shared/utils/branch-account.ts), on the
 * spec's own worked examples — "Test 1" to "Test 5" of the Demand Record
 * prompt. The database side is branch-account.integration.test.ts.
 */

const facts = (over: Partial<BranchAccountFacts>): BranchAccountFacts => ({
  branchId: 'b1', branchName: 'Branch', orderId: 'o', demandNumber: 'DMD-000001',
  businessDate: '2026-10-01', at: '2026-10-01T05:00:00Z', status: 'approved',
  frozenPct: 80, livePct: 75,
  delivered: 0, returns: 0, returnsQty: 0, discount: 0, received: 0, sales: 0, adjustments: 0, unpricedLines: 0,
  ...over,
});

test('Test 1 — first demand: G. Total 42,800, share 34,240, closing 6,240', () => {
  const [r] = computeBranchAccount([facts({ delivered: 45_000, returns: 1_200, discount: 1_000, received: 28_000 })]);
  assert.equal(r!.gTotal, 42_800);
  assert.equal(r!.companyShare, 34_240);
  assert.equal(r!.previousBalance, 0);
  assert.equal(r!.closingBalance, 6_240);
});

test('Test 2 — second demand carries the first one\'s closing: 2,440', () => {
  const rows = computeBranchAccount([
    facts({ orderId: 'o1', delivered: 45_000, returns: 1_200, discount: 1_000, received: 28_000 }),
    facts({ orderId: 'o2', businessDate: '2026-10-02', delivered: 50_000, discount: 2_000, received: 42_200 }),
  ]);
  assert.equal(rows[1]!.gTotal, 48_000);
  assert.equal(rows[1]!.companyShare, 38_400);
  assert.equal(rows[1]!.previousBalance, 6_240);
  assert.equal(rows[1]!.closingBalance, 2_440);
});

test('Day 3 of the spec\'s running balance: 2,440 + 30,000 − 20,000 = 12,440', () => {
  const rows = computeBranchAccount([
    facts({ orderId: 'o1', delivered: 45_000, returns: 1_200, discount: 1_000, received: 28_000 }),
    facts({ orderId: 'o2', delivered: 50_000, discount: 2_000, received: 42_200 }),
    facts({ orderId: 'o3', delivered: 37_500, received: 20_000 }),
  ]);
  assert.equal(rows[2]!.companyShare, 30_000);
  assert.equal(rows[2]!.closingBalance, 12_440);
});

test('Test 3 — share on sales is its own figure and never replaces what was received', () => {
  assert.equal(companyShareOf(42_300, 80), 33_840);
  const [r] = computeBranchAccount([facts({ delivered: 50_000, discount: 2_000, sales: 42_300, received: 42_200 })]);
  assert.equal(r!.shareOnSales, 33_840);
  assert.equal(r!.received, 42_200);
  assert.equal(r!.closingBalance, 38_400 - 42_200);
});

test('Test 4 — full settlement closes at exactly 0', () => {
  // Previous 6,240 + share 34,240 − received 40,480.
  const [r] = computeBranchAccount([facts({ delivered: 42_800, received: 40_480 })], 6_240);
  assert.equal(r!.companyShare, 34_240);
  assert.equal(r!.closingBalance, 0);
  assert.equal(balanceStanding(r!.closingBalance), 'settled');
});

test('Test 5 — overpayment stays negative, as a credit, never floored at zero', () => {
  const [r] = computeBranchAccount([facts({ delivered: 12_500, received: 12_000 })]);
  assert.equal(r!.companyShare, 10_000);
  assert.equal(r!.closingBalance, -2_000);
  assert.equal(balanceStanding(r!.closingBalance), 'credit');
});

test('the frozen % wins over today\'s; a row nothing froze says so', () => {
  const [frozen, live] = computeBranchAccount([
    facts({ orderId: 'a', delivered: 10_000, frozenPct: 80, livePct: 70 }),
    facts({ orderId: 'b', delivered: 10_000, frozenPct: null, livePct: 70 }),
  ]);
  assert.equal(frozen!.companyShare, 8_000);
  assert.equal(frozen!.pctFrozen, true);
  assert.equal(live!.companyShare, 7_000);
  assert.equal(live!.pctFrozen, false);
});

test('Finance adjustments move the balance like share does; paisa do not drift', () => {
  const rows = computeBranchAccount([
    facts({ orderId: null, demandNumber: null, frozenPct: null, adjustments: 5_000.1 }),
    facts({ orderId: 'a', delivered: 0.3, frozenPct: 100, received: 0.1 }),
  ]);
  assert.equal(rows[0]!.closingBalance, 5_000.1);
  assert.equal(rows[1]!.closingBalance, 5_000.3);
});

test('period totals take balances once per branch, never summed down the rows', () => {
  const rows = computeBranchAccount([
    facts({ orderId: 'o1', delivered: 45_000, returns: 1_200, discount: 1_000, received: 28_000 }),
    facts({ orderId: 'o2', delivered: 50_000, discount: 2_000, received: 42_200 }),
  ]);
  const t = totalBranchAccount(rows, [{ openingBalance: 0, closingBalance: rows[1]!.closingBalance }]);
  assert.equal(t.companyShare, 72_640);
  assert.equal(t.received, 70_200);
  assert.equal(t.openingBalance, 0);
  assert.equal(t.closingBalance, 2_440);
  // Opening + period share + adjustments − received = closing.
  assert.equal(t.openingBalance + t.companyShare + t.adjustments - t.received, t.closingBalance);
});
