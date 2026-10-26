import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientBusinessDate } from '../../utils/clientBusinessDate';
import { CASH_DEPOSIT_BACKDATE_DAYS } from '../cash-transfers.service';

// 10:00 Karachi on 27 Oct 2026: business date 2026-10-27. super_admin skips the
// closed-day lookup, so only the window itself is exercised here.
const NOW = new Date('2026-10-27T05:00:00Z');
const deposit = (date: string | undefined) =>
  resolveClientBusinessDate(date, 'super_admin', NOW, CASH_DEPOSIT_BACKDATE_DAYS);

test('a cash deposit may be dated today or yesterday', async () => {
  assert.equal(await deposit(undefined), '2026-10-27');
  assert.equal(await deposit('2026-10-27'), '2026-10-27');
  assert.equal(await deposit('2026-10-26'), '2026-10-26');
});

test('a cash deposit dated two or more days back is refused', async () => {
  for (const date of ['2026-10-25', '2026-10-21']) {
    await assert.rejects(deposit(date), (e: Error & { status?: number }) => {
      assert.equal(e.status, 400);
      assert.equal(e.message, `This entry is dated ${date}. It can be dated today or yesterday only.`);
      return true;
    });
  }
});

test('the future is still refused', async () => {
  await assert.rejects(deposit('2026-10-28'), /dated in the future/);
});

test('other writes keep the 7-day window', async () => {
  assert.equal(await resolveClientBusinessDate('2026-10-21', 'super_admin', NOW), '2026-10-21');
  await assert.rejects(resolveClientBusinessDate('2026-10-20', 'super_admin', NOW), /older than the 7-day sync window/);
});
