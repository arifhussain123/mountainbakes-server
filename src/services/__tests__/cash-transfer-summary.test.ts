import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  businessDateStr,
  buildCashTransferSummary,
  emptyCashTransferTotals,
  monthToDateRange,
  type CashTransferSummaryRow,
} from '../../shared';

/**
 * The Cash Transfer summary's pure half: the Karachi business-month window it
 * reads, and how the per-status aggregate rows become the eight cards.
 */

const BRANCH = '00000000-0000-4000-8000-00000000000a';
const RANGE = { from: '2026-10-01', to: '2026-10-18' };

const row = (status: string, r: Partial<CashTransferSummaryRow>): CashTransferSummaryRow => ({
  status, transfers: 0, amount: 0, amountCount: 0, cash: 0, cashCount: 0, easypaisa: 0, easypaisaCount: 0,
  bank: 0, bankCount: 0, fuel: 0, fuelCount: 0, ...r,
});

describe('monthToDateRange — Karachi business month', () => {
  test('mid-month: the 1st through today', () => {
    assert.deepEqual(monthToDateRange(new Date('2026-10-18T10:00:00+05:00')), { from: '2026-10-01', to: '2026-10-18' });
  });

  test('00:30 on the 1st is still the last business day of the previous month', () => {
    const at = new Date('2026-11-01T00:30:00+05:00');
    assert.equal(businessDateStr(at), '2026-10-31', 'the business day rolls over at 02:00');
    assert.deepEqual(monthToDateRange(at), { from: '2026-10-01', to: '2026-10-31' });
  });

  test('02:00 on the 1st starts the new month', () => {
    assert.deepEqual(monthToDateRange(new Date('2026-11-01T02:00:00+05:00')), { from: '2026-11-01', to: '2026-11-01' });
  });

  test('read in Karachi time, not UTC: 23:30 UTC on 31 Oct is already 1 Nov 04:30 in Karachi', () => {
    assert.deepEqual(monthToDateRange(new Date('2026-10-31T23:30:00Z')), { from: '2026-11-01', to: '2026-11-01' });
  });

  test('December rolls into January of the next year', () => {
    assert.deepEqual(monthToDateRange(new Date('2027-01-01T09:00:00+05:00')), { from: '2027-01-01', to: '2027-01-01' });
  });
});

describe('buildCashTransferSummary', () => {
  test('an empty month is every card at Rs. 0 with 0 transfers', () => {
    const s = buildCashTransferSummary([], RANGE, BRANCH);
    assert.deepEqual(s, { from: '2026-10-01', to: '2026-10-18', branchId: BRANCH, transfers: 0, totals: emptyCashTransferTotals() });
  });

  test('each status maps to its own card, and the three add up to Total Transferred', () => {
    const s = buildCashTransferSummary(
      [
        row('approved', { transfers: 3, amount: 30000, amountCount: 3 }),
        row('pending', { transfers: 2, amount: 4500.5, amountCount: 2 }),
        row('rejected', { transfers: 1, amount: 700, amountCount: 1 }),
      ],
      RANGE,
      BRANCH,
    );
    assert.deepEqual(s.totals.approved, { amount: 30000, count: 3 });
    assert.deepEqual(s.totals.pending, { amount: 4500.5, count: 2 });
    assert.deepEqual(s.totals.rejected, { amount: 700, count: 1 });
    assert.deepEqual(s.totals.transferred, { amount: 35200.5, count: 6 });
    assert.equal(s.transfers, 6);
  });

  test('channels and fuel add across every status', () => {
    const s = buildCashTransferSummary(
      [
        row('approved', { transfers: 2, amount: 10000, amountCount: 2, cash: 8000, cashCount: 2, bank: 2000, bankCount: 1, fuel: 300, fuelCount: 1 }),
        row('pending', { transfers: 1, amount: 1500, amountCount: 1, easypaisa: 1500, easypaisaCount: 1, fuel: 200, fuelCount: 1 }),
      ],
      RANGE,
      BRANCH,
    );
    assert.deepEqual(s.totals.cash, { amount: 8000, count: 2 });
    assert.deepEqual(s.totals.easypaisa, { amount: 1500, count: 1 });
    assert.deepEqual(s.totals.bank, { amount: 2000, count: 1 });
    assert.deepEqual(s.totals.fuel, { amount: 500, count: 2 });
  });

  test('a fuel-only deposit counts under Fuel Charges and in no money card', () => {
    const s = buildCashTransferSummary([row('approved', { transfers: 1, amount: 0, amountCount: 0, fuel: 400, fuelCount: 1 })], RANGE, BRANCH);
    assert.equal(s.transfers, 1);
    assert.deepEqual(s.totals.transferred, { amount: 0, count: 0 });
    assert.deepEqual(s.totals.approved, { amount: 0, count: 0 });
    assert.deepEqual(s.totals.fuel, { amount: 400, count: 1 });
  });

  test('money is added in paisa: 0.1 + 0.2 is 0.3', () => {
    const s = buildCashTransferSummary(
      [row('approved', { amount: 0.1, amountCount: 1 }), row('pending', { amount: 0.2, amountCount: 1 })],
      RANGE,
      BRANCH,
    );
    assert.equal(s.totals.transferred.amount, 0.3);
  });

  test('an unknown status still counts in the totals but in no status card', () => {
    const s = buildCashTransferSummary([row('final', { transfers: 1, amount: 100, amountCount: 1, cash: 100, cashCount: 1 })], RANGE, BRANCH);
    assert.deepEqual(s.totals.transferred, { amount: 100, count: 1 });
    assert.deepEqual(s.totals.approved, { amount: 0, count: 0 });
    assert.deepEqual(s.totals.pending, { amount: 0, count: 0 });
    assert.deepEqual(s.totals.rejected, { amount: 0, count: 0 });
  });
});
