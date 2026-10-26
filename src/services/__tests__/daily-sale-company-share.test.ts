import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailySaleCompanyShare, resolveShareSplit } from '../../shared';

/**
 * Company Share on the Daily Sale Record: Total Sale × the Admin company share,
 * and the Branch Share beside it — the rest of the same sale (65a74da), so the
 * two always add up to Total Sale.
 *
 * The percentage is the branch's own where it has one, else the global finance
 * setting (`resolveShareSplit`); a day already imported for income approval keeps
 * the percentage that approval was booked at.
 */

/** What the service passes as "current" for a branch. */
const current = (branchPct: number | null, globalPct: number) =>
  resolveShareSplit(branchPct, globalPct).companySharePct;

describe('daily sale company share', () => {
  test('1. 1,000 at 75% → 750', () => {
    assert.deepEqual(computeDailySaleCompanyShare(1000, null, 75), {
      companySharePct: 75, companyShare: 750, branchSharePct: 25, branchShare: 250,
    });
  });

  test('2. 37,750 at 75% → 28,312.50', () => {
    assert.equal(computeDailySaleCompanyShare(37750, null, 75).companyShare, 28312.5);
  });

  test('3. 50,000 at 50% → 25,000', () => {
    assert.equal(computeDailySaleCompanyShare(50000, null, 50).companyShare, 25000);
  });

  test('4. a day with no sale → 0', () => {
    assert.equal(computeDailySaleCompanyShare(0, null, 75).companyShare, 0);
  });

  test('5. missing or unusable configuration → 0, never NaN', () => {
    for (const pct of [null, undefined, NaN, -5, 140, '' as unknown]) {
      const r = computeDailySaleCompanyShare(1000, null, pct as number);
      // No usable % means no company share: the whole sale stays the branch's.
      assert.deepEqual(r, { companySharePct: 0, companyShare: 0, branchSharePct: 100, branchShare: 1000 });
    }
    assert.equal(computeDailySaleCompanyShare(NaN, null, 75).companyShare, 0);
    // No branch override and no usable global setting resolves to 0 as well.
    assert.equal(current(null, NaN), 0);
  });

  test('6. a day booked at 70% stays at 70% after Admin moves the branch to 75%', () => {
    assert.deepEqual(computeDailySaleCompanyShare(1000, 70, 75), {
      companySharePct: 70, companyShare: 700, branchSharePct: 30, branchShare: 300,
    });
    // A day with no approval yet has nothing to hold it and reads at the current rate.
    assert.equal(computeDailySaleCompanyShare(1000, null, 75).companyShare, 750);
    // A snapshot of 0% is a real percentage, not "missing".
    assert.equal(computeDailySaleCompanyShare(1000, 0, 75).companyShare, 0);
  });

  test('the branch override wins over the global setting; a null branch inherits', () => {
    assert.equal(computeDailySaleCompanyShare(1000, null, current(60, 75)).companyShare, 600);
    assert.equal(computeDailySaleCompanyShare(1000, null, current(null, 75)).companyShare, 750);
  });

  test('no float drift: the amount is exact to two places', () => {
    assert.equal(computeDailySaleCompanyShare(1000, null, 75).companyShare, 750);
    assert.equal(computeDailySaleCompanyShare(33.33, null, 33.33).companyShare, 11.11);
    assert.equal(computeDailySaleCompanyShare(1.005, null, 100).companyShare, 1.01);
  });

  // The table sorts on the same number the API sends (DataTable's own sorter over
  // the column accessor), so ordering the amounts is ordering the column.
  const rows = [
    computeDailySaleCompanyShare(37750, null, 75).companyShare,
    computeDailySaleCompanyShare(1000, 70, 75).companyShare,
    computeDailySaleCompanyShare(50780, null, 75).companyShare,
    computeDailySaleCompanyShare(0, null, 75).companyShare,
  ];

  test('7. sorts ascending', () => {
    assert.deepEqual([...rows].sort((a, b) => a - b), [0, 700, 28312.5, 38085]);
  });

  test('8. sorts descending', () => {
    assert.deepEqual([...rows].sort((a, b) => b - a), [38085, 28312.5, 700, 0]);
  });
});
