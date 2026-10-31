import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryRangeFromQuery } from '../summaryRange';

/** 18 Oct 2026, 10:00 in Karachi. */
const NOW = new Date('2026-10-18T10:00:00+05:00');

test('no Date filter → this business month to date', () => {
  assert.deepEqual(summaryRangeFromQuery({}, NOW), { ok: true, range: { from: '2026-10-01', to: '2026-10-18' } });
  assert.deepEqual(summaryRangeFromQuery({ from: '', to: '  ' }, NOW), { ok: true, range: { from: '2026-10-01', to: '2026-10-18' } });
});

test('both dates → exactly that range, across months', () => {
  assert.deepEqual(summaryRangeFromQuery({ from: '2026-09-15', to: '2026-10-05' }, NOW), { ok: true, range: { from: '2026-09-15', to: '2026-10-05' } });
});

test('from only → to today; to only → from the 1st of its month', () => {
  assert.deepEqual(summaryRangeFromQuery({ from: '2026-09-20' }, NOW), { ok: true, range: { from: '2026-09-20', to: '2026-10-18' } });
  assert.deepEqual(summaryRangeFromQuery({ to: '2026-09-20' }, NOW), { ok: true, range: { from: '2026-09-01', to: '2026-09-20' } });
});

test('a malformed or impossible date is refused', () => {
  assert.equal(summaryRangeFromQuery({ from: '2026-02-30' }, NOW).ok, false);
  assert.equal(summaryRangeFromQuery({ to: '18/10/2026' }, NOW).ok, false);
  assert.equal(summaryRangeFromQuery({ from: ['2026-10-01'] }, NOW).ok, true); // array → ignored, month to date
});
