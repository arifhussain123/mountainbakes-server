import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientBusinessDate } from '../../utils/clientBusinessDate';

// 10:00 Karachi on 27 Oct 2026: business date 2026-10-27. super_admin skips the
// closed-day lookup, so only the window itself is exercised here. A deposit
// passes a wider window when Admin's back-date period reaches past the 7 days.
const NOW = new Date('2026-10-27T05:00:00Z');

test('other writes keep the 7-day window', async () => {
  assert.equal(await resolveClientBusinessDate('2026-10-21', 'super_admin', NOW), '2026-10-21');
  await assert.rejects(resolveClientBusinessDate('2026-10-20', 'super_admin', NOW), /older than the 7-day sync window/);
});

test('a wider window reaches further back', async () => {
  assert.equal(await resolveClientBusinessDate('2026-10-17', 'super_admin', NOW, 10), '2026-10-17');
  await assert.rejects(resolveClientBusinessDate('2026-10-16', 'super_admin', NOW, 10), /older than the 11-day sync window/);
});

test('the future is still refused', async () => {
  await assert.rejects(resolveClientBusinessDate('2026-10-28', 'super_admin', NOW, 10), /dated in the future/);
});
