import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { PrismaClient } from '../../generated/prisma/client';
import { dailyStatus, dueWindow, getMissingDailyTransfers } from '../cash-transfer-missing.service';

/**
 * Missing daily cash transfers, on the REAL baseline `branches` and
 * `cash_transfers` tables and `app.business_date`.
 *
 * "Now" is 27 Oct 2026 10:00 Karachi unless a test says otherwise, so the
 * business date is the 27th and the last due date the 26th.
 */

const BASELINE = readFileSync(join(__dirname, '../../../prisma/migrations/0_baseline/migration.sql'), 'utf8');
function lift(head: string, tail: string): string {
  const start = BASELINE.indexOf(head);
  assert.ok(start >= 0, `not in the baseline: ${head}`);
  const end = BASELINE.indexOf(tail, start);
  return `${BASELINE.slice(start, end + tail.length)}\n`;
}

const STUBS = `
  create schema app;
  create function app.next_finance_number(p_key text, p_prefix text) returns text language sql as $$ select p_prefix || '-' || substr(md5(random()::text), 1, 6) $$;
`;

const A = '40000000-0000-4000-8000-00000000000a';
const B = '40000000-0000-4000-8000-00000000000b';
const C = '40000000-0000-4000-8000-00000000000c';
const OFF = '40000000-0000-4000-8000-0000000000ff'; // inactive
const NEW = '40000000-0000-4000-8000-0000000000ee'; // opened on the 25th

const NOW = new Date('2026-10-27T10:00:00+05:00');
const WINDOW = { from: '2026-10-24', to: '2026-10-26' };

let db: PGlite;
let prisma: PrismaClient;

async function transfer(
  branch: string,
  date: string,
  status: 'pending' | 'approved' | 'rejected',
  amount: number,
  opts: { fuel?: number; deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into cash_transfers (id, branch_id, branch_name, amount, cash_amount, fuel_charges, business_date, status,
                                 ledger_entry_id, approved_at, rejection_reason, deleted_at)
     values ($1, $2, 'x', $3, $3, $4, $5, $6::cash_transfer_status,
             case when $6 = 'approved' then gen_random_uuid() end,
             case when $6 <> 'pending' then now() end,
             case when $6 = 'rejected' then 'wrong slip' end,
             case when $7 then now() end)`,
    [id, branch, amount, opts.fuel ?? 0, date, status, opts.deleted ?? false]);
  return id;
}

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(lift('CREATE TYPE public.cash_transfer_status AS ENUM (', ');'));
  await db.exec(lift('CREATE FUNCTION app.business_date(', '$$;'));
  await db.exec(lift('CREATE TABLE public.branches (', '\n);'));
  await db.exec(lift('CREATE TABLE public.cash_transfers (', '\n);'));
  await db.exec(`
    alter table branches add primary key (id);
    alter table cash_transfers add primary key (id);
    insert into branches (id, name, slug, is_active, created_at) values
      ('${A}', 'Alpha', 'a', true, '2026-09-01T10:00:00+05'),
      ('${B}', 'Beta', 'b', true, '2026-09-01T10:00:00+05'),
      ('${C}', 'Gamma', 'c', true, '2026-09-01T10:00:00+05'),
      ('${OFF}', 'Closed', 'off', false, '2026-09-01T10:00:00+05'),
      -- 01:30 on the 26th is still the 25th's business day.
      ('${NEW}', 'Newcomer', 'new', true, '2026-10-26T01:30:00+05');
  `);
  prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);
});

after(async () => {
  await prisma?.$disconnect();
  await db?.close();
});

const check = (q: { from?: string; to?: string; branchId?: string | null } = WINDOW, now = NOW) =>
  getMissingDailyTransfers(q, now);
const statusOf = async (date: string, branch: string, q = WINDOW) =>
  (await check(q)).rows.find((r) => r.date === date && r.branchId === branch)?.status;

test('the due window: never today, the last seven due dates by default, at most 62 days', () => {
  assert.deepEqual(dueWindow({}, '2026-10-27'), { from: '2026-10-20', to: '2026-10-26' });
  assert.deepEqual(dueWindow({ from: '2026-10-01', to: '2026-10-31' }, '2026-10-27'), { from: '2026-10-01', to: '2026-10-26' });
  assert.deepEqual(dueWindow({ from: '2026-01-01', to: '2026-10-26' }, '2026-10-27').from, '2026-08-26');
  // Only today asked for: nothing is due yet.
  const w = dueWindow({ from: '2026-10-27', to: '2026-10-27' }, '2026-10-27');
  assert.ok(w.from > w.to);
});

test('one obligation per date: the best live transfer decides', () => {
  assert.equal(dailyStatus([]), 'missing');
  assert.equal(dailyStatus([{ status: 'rejected', amount: 100 }, { status: 'pending', amount: 100 }]), 'pending');
  assert.equal(dailyStatus([{ status: 'pending', amount: 100 }, { status: 'approved', amount: 50 }]), 'approved');
  assert.equal(dailyStatus([{ status: 'approved', amount: 0 }]), 'fuel_only');
  assert.equal(dailyStatus([{ status: 'approved', amount: 0 }, { status: 'rejected', amount: 10 }]), 'rejected');
});

test('1. every required branch submitted: nothing missing', async () => {
  for (const d of ['2026-10-24', '2026-10-25', '2026-10-26']) {
    for (const b of [A, B, C]) await transfer(b, d, 'approved', 1000);
  }
  await transfer(NEW, '2026-10-25', 'approved', 500);
  await transfer(NEW, '2026-10-26', 'approved', 500);
  const r = await check();
  assert.equal(r.branches, 4);
  assert.equal(r.dates, 3);
  assert.deepEqual([r.summary.missingBranches, r.summary.affectedDates, r.summary.pendingTransfers], [0, 0, 0]);
  // 3 old branches × 3 dates + the newcomer from the 25th.
  assert.equal(r.rows.length, 11);
  assert.ok(r.rows.every((x) => x.status === 'approved'));
});

test('10. an inactive branch is never expected; a new branch only from the day it opened', async () => {
  const r = await check();
  assert.ok(!r.rows.some((x) => x.branchId === OFF));
  assert.ok(!r.rows.some((x) => x.branchId === NEW && x.date === '2026-10-24'));
  assert.ok(r.rows.some((x) => x.branchId === NEW && x.date === '2026-10-25'));
});

const Q = { from: '2026-10-20', to: '2026-10-22' };

test('2/3. one branch missing, then several on the same date — each branch on its own', async () => {
  await transfer(A, '2026-10-20', 'approved', 900);
  await transfer(B, '2026-10-20', 'approved', 900);
  // Gamma missing on the 20th; on the 21st only Alpha paid.
  await transfer(A, '2026-10-21', 'approved', 900);
  const r = await check(Q);
  const missing = r.rows.filter((x) => x.status === 'missing').map((x) => `${x.date} ${x.branchName}`);
  assert.deepEqual(missing.filter((m) => m.startsWith('2026-10-20')), ['2026-10-20 Gamma']);
  assert.deepEqual(missing.filter((m) => m.startsWith('2026-10-21')), ['2026-10-21 Beta', '2026-10-21 Gamma']);
  // Rows run newest date first, by branch name.
  assert.equal(r.rows[0]!.date, '2026-10-22');
});

test('4/9. today is not checked until it closes at 02:00; a transfer dated today does not pay yesterday', async () => {
  await transfer(C, '2026-10-27', 'approved', 700);
  const before = await check({});
  assert.equal(before.to, '2026-10-26');
  assert.ok(!before.rows.some((x) => x.date === '2026-10-27'));
  // 01:59 on the 28th is still the 27th's business day; 02:00 closes it.
  const late = await check({}, new Date('2026-10-28T01:59:00+05:00'));
  assert.equal(late.to, '2026-10-26');
  const closed = await check({}, new Date('2026-10-28T02:00:00+05:00'));
  assert.equal(closed.to, '2026-10-27');
  assert.equal(closed.rows.find((x) => x.date === '2026-10-27' && x.branchId === C)?.status, 'approved');
  assert.equal(closed.rows.find((x) => x.date === '2026-10-27' && x.branchId === A)?.status, 'missing');
  // Gamma's transfer on the 27th leaves the 20th missing.
  assert.equal(await statusOf('2026-10-20', C, Q), 'missing');
});

test('5. a transfer awaiting approval is Pending, not missing, and counted as awaiting', async () => {
  await transfer(B, '2026-10-22', 'pending', 1500);
  const r = await check(Q);
  const row = r.rows.find((x) => x.date === '2026-10-22' && x.branchId === B)!;
  assert.equal(row.status, 'pending');
  assert.equal(row.submittedAmount, 1500);
  assert.equal(r.summary.pendingTransfers, 1);
});

test('6. a rejected transfer leaves the day unpaid and flagged', async () => {
  await transfer(A, '2026-10-22', 'rejected', 800);
  const r = await check(Q);
  assert.equal(r.rows.find((x) => x.date === '2026-10-22' && x.branchId === A)!.status, 'rejected');
  assert.equal(r.summary.rejected, 1);
});

test('fuel-only and deleted transfers do not pay the day', async () => {
  await transfer(C, '2026-10-22', 'approved', 0, { fuel: 300 });
  await transfer(C, '2026-10-21', 'approved', 900, { deleted: true });
  assert.equal(await statusOf('2026-10-22', C, Q), 'fuel_only');
  assert.equal(await statusOf('2026-10-21', C, Q), 'missing');
});

test('7. a branch that submits after showing as missing leaves the list on the next check', async () => {
  const before = await check(Q);
  const gamma20 = () => before.rows.find((x) => x.date === '2026-10-20' && x.branchId === C)!;
  assert.equal(gamma20().status, 'missing');
  const id = await transfer(C, '2026-10-20', 'pending', 400);
  assert.equal(await statusOf('2026-10-20', C, Q), 'pending');
  await db.query(`update cash_transfers set status = 'approved', approved_at = now(), ledger_entry_id = gen_random_uuid() where id = $1`, [id]);
  assert.equal(await statusOf('2026-10-20', C, Q), 'approved');
});

test('8. several transfers on one date are one obligation, listed together', async () => {
  await transfer(A, '2026-10-20', 'approved', 100);
  await transfer(A, '2026-10-20', 'pending', 50);
  const r = await check(Q);
  const rows = r.rows.filter((x) => x.date === '2026-10-20' && x.branchId === A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'approved');
  assert.equal(rows[0]!.transfers.length, 3);
  // Only the approved ones make the submitted amount: 900 + 100.
  assert.equal(rows[0]!.submittedAmount, 1000);
});

test('12. several branches submitting at once are each counted', async () => {
  const D = { from: '2026-10-19', to: '2026-10-19' };
  assert.equal((await check(D)).summary.missing, 3);
  await Promise.all([A, B, C].map((b) => transfer(b, '2026-10-19', 'pending', 250)));
  const r = await check(D);
  assert.equal(r.summary.missing, 0);
  assert.equal(r.summary.pending, 3);
  assert.equal(r.summary.pendingTransfers, 3);
});

test('a branch filter checks that branch alone; the summary counts branches and dates', async () => {
  const r = await check({ ...Q, branchId: B });
  assert.equal(r.branches, 1);
  assert.ok(r.rows.every((x) => x.branchId === B));
  const all = await check(Q);
  // Unpaid: 20th none (Gamma now approved), 21st Beta + Gamma, 22nd Alpha (rejected) + Gamma (fuel only).
  assert.deepEqual([all.summary.missingBranches, all.summary.affectedDates], [3, 2]);
});
