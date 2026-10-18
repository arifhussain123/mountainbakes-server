import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';
import { getMonthlyCashTransferSummary } from '../cash-transfer-summary.service';
import { businessDateStr } from '../../shared';

/**
 * The monthly Cash Transfer summary's SQL, run for real in pglite over a stub
 * `cash_transfers`: the Karachi business-month window on `business_date`,
 * channel and status buckets, fuel apart from Total Amount, soft-deleted rows
 * out, one branch only — and then the route that serves it, so the role and
 * branch rules are the real middleware's.
 */

const MIGRATIONS = join(__dirname, '../../../db/history/migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table business_day_closures (business_date date primary key, status text not null);
  create table branches (id uuid primary key default gen_random_uuid(), name text not null, is_active boolean not null default true);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);

  create type cash_transfer_status as enum ('pending', 'approved', 'rejected');
  create table cash_transfers (
    id uuid primary key default gen_random_uuid(),
    branch_id uuid not null references branches (id), branch_name text not null,
    amount numeric(14,2) not null,
    cash_amount numeric(14,2) not null default 0, easypaisa_amount numeric(14,2) not null default 0,
    bank_amount numeric(14,2) not null default 0, fuel_charges numeric(14,2) not null default 0,
    status cash_transfer_status not null default 'pending',
    business_date date not null,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    constraint cash_transfers_total_is_channels check (amount = cash_amount + easypaisa_amount + bank_amount));
`;

const BRANCH_A = '00000000-0000-4000-8000-00000000000a'; // Committee Chowk
const BRANCH_B = '00000000-0000-4000-8000-00000000000b'; // DHA
const BRANCH_C = '00000000-0000-4000-8000-00000000000c'; // nothing this month

/** 18 Oct 2026, 10:00 in Karachi — the summary covers 1–18 Oct. */
const NOW = new Date('2026-10-18T10:00:00+05:00');

let db: PGlite;
let server: Server;
let base: string;

interface Actor { id: string; email: string; role: string; branchId: string | null; branchName: string | null }
const ACTORS: Record<string, Actor> = {
  'branch-a': { id: '10000000-0000-4000-8000-000000000001', email: 'a@mb.test', role: 'branch_manager', branchId: BRANCH_A, branchName: 'Committee Chowk Branch' },
  'branch-c': { id: '10000000-0000-4000-8000-000000000002', email: 'c@mb.test', role: 'branch_manager', branchId: BRANCH_C, branchName: 'Bahria Branch' },
  admin: { id: '10000000-0000-4000-8000-000000000003', email: 'admin@mb.test', role: 'super_admin', branchId: null, branchName: null },
  production: { id: '10000000-0000-4000-8000-000000000004', email: 'prod@mb.test', role: 'production_user', branchId: null, branchName: null },
};
const TOKENS: Record<string, string> = {};

async function call(as: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKENS[as]}` } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function addTransfer(
  branchId: string,
  ch: { cash?: number; easypaisa?: number; bank?: number; fuel?: number },
  status: string,
  businessDate: string,
  opts: { createdAt?: string; deleted?: boolean } = {},
): Promise<string> {
  const cash = ch.cash ?? 0, easypaisa = ch.easypaisa ?? 0, bank = ch.bank ?? 0;
  const { rows } = await db.query<{ id: string }>(
    `insert into cash_transfers (branch_id, branch_name, amount, cash_amount, easypaisa_amount, bank_amount, fuel_charges,
                                 status, business_date, created_at, deleted_at)
     values ($1, 'Branch', $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()), $10) returning id`,
    [branchId, cash + easypaisa + bank, cash, easypaisa, bank, ch.fuel ?? 0, status, businessDate, opts.createdAt ?? null,
      opts.deleted ? new Date().toISOString() : null],
  );
  return rows[0]!.id;
}

before(async () => {
  process.env['JWT_SECRET'] = 'cash-transfer-summary-test-secret-long-enough-to-sign';
  db = new PGlite();
  await db.exec('create schema app');
  await db.exec(STUBS);
  await db.exec(`begin;${read('20261009000149_custom_auth.sql')}commit;`);

  await db.query(
    `insert into branches (id, name) values ($1, 'Committee Chowk Branch'), ($2, 'DHA Branch'), ($3, 'Bahria Branch')`,
    [BRANCH_A, BRANCH_B, BRANCH_C],
  );

  // Committee Chowk, inside the window
  await addTransfer(BRANCH_A, { cash: 10000, bank: 5000, fuel: 300 }, 'approved', '2026-10-01'); // first of the month
  await addTransfer(BRANCH_A, { cash: 2000 }, 'approved', '2026-10-18'); // today
  await addTransfer(BRANCH_A, { easypaisa: 1500.5, fuel: 200 }, 'pending', '2026-10-12');
  await addTransfer(BRANCH_A, { cash: 700 }, 'rejected', '2026-10-09');
  await addTransfer(BRANCH_A, { fuel: 400 }, 'approved', '2026-10-10'); // fuel only
  // Committee Chowk, out of every figure
  await addTransfer(BRANCH_A, { cash: 9000 }, 'approved', '2026-09-30'); // last day of last month
  await addTransfer(BRANCH_A, { cash: 8000 }, 'approved', '2026-10-19'); // tomorrow
  await addTransfer(BRANCH_A, { cash: 6000 }, 'pending', '2026-10-11', { deleted: true }); // soft-deleted
  // Saved at 00:30 on 1 Nov: the business day is still 31 Oct.
  await addTransfer(BRANCH_A, { cash: 450 }, 'pending', businessDateStr(new Date('2026-11-01T00:30:00+05:00')), {
    createdAt: '2026-11-01T00:30:00+05:00',
  });
  // Another branch
  await addTransfer(BRANCH_B, { cash: 50000 }, 'approved', '2026-10-05');

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);

  for (const [name, a] of Object.entries(ACTORS)) {
    await db.query(
      `insert into users (id, email, role, branch_id, branch_name) values ($1, $2, $3, $4, $5)`,
      [a.id, a.email, a.role, a.branchId, a.branchName],
    );
    const session = await prisma.auth_sessions.create({
      data: { user_id: a.id, client: 'web', expires_at: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    TOKENS[name] = signAccessToken(a.id, session.id).token;
  }

  const express = (await import('express')).default;
  const { router: cashTransfers } = await import('../../routes/cash-transfers.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/cash-transfers', cashTransfers);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('getMonthlyCashTransferSummary', () => {
  test('covers the 1st through today; last month, tomorrow and deleted rows are out', async () => {
    const s = await getMonthlyCashTransferSummary({ branchId: BRANCH_A, now: NOW });
    assert.equal(s.from, '2026-10-01');
    assert.equal(s.to, '2026-10-18');
    assert.deepEqual(s.totals.transferred, { amount: 19200.5, count: 4 });
    assert.equal(s.transfers, 5, 'four money transfers and one fuel-only');
  });

  test('channels: each counts only transfers with money in it', async () => {
    const { totals } = await getMonthlyCashTransferSummary({ branchId: BRANCH_A, now: NOW });
    assert.deepEqual(totals.cash, { amount: 12700, count: 3 });
    assert.deepEqual(totals.easypaisa, { amount: 1500.5, count: 1 });
    assert.deepEqual(totals.bank, { amount: 5000, count: 1 });
  });

  test('statuses: approved, pending and rejected each on their own card, adding up to the total', async () => {
    const { totals } = await getMonthlyCashTransferSummary({ branchId: BRANCH_A, now: NOW });
    assert.deepEqual(totals.approved, { amount: 17000, count: 2 }, 'the fuel-only approval adds no Total Amount');
    assert.deepEqual(totals.pending, { amount: 1500.5, count: 1 });
    assert.deepEqual(totals.rejected, { amount: 700, count: 1 });
    assert.equal(totals.approved.amount + totals.pending.amount + totals.rejected.amount, totals.transferred.amount);
  });

  test('fuel charges are their own sum, never inside Total Amount', async () => {
    const { totals } = await getMonthlyCashTransferSummary({ branchId: BRANCH_A, now: NOW });
    assert.deepEqual(totals.fuel, { amount: 900, count: 3 });
  });

  test('a transfer saved at 00:30 on the 1st stays in the month it was traded in', async () => {
    const lateOct = await getMonthlyCashTransferSummary({ branchId: BRANCH_A, now: new Date('2026-11-01T01:00:00+05:00') });
    assert.equal(lateOct.from, '2026-10-01');
    assert.equal(lateOct.to, '2026-10-31');
    assert.deepEqual(lateOct.totals.pending, { amount: 1950.5, count: 2 }, '12 Oct and the 00:30 one');
    const nov = await getMonthlyCashTransferSummary({ branchId: BRANCH_A, now: new Date('2026-11-01T09:00:00+05:00') });
    assert.equal(nov.from, '2026-11-01');
    assert.deepEqual(nov.totals.transferred, { amount: 0, count: 0 }, 'November starts empty');
  });

  test('one branch only: another branch\'s money never reaches it', async () => {
    const dha = await getMonthlyCashTransferSummary({ branchId: BRANCH_B, now: NOW });
    assert.deepEqual(dha.totals.transferred, { amount: 50000, count: 1 });
    assert.equal(dha.branchId, BRANCH_B);
  });

  test('an empty month is a summary at Rs. 0, not an error', async () => {
    const s = await getMonthlyCashTransferSummary({ branchId: BRANCH_C, now: NOW });
    assert.equal(s.transfers, 0);
    for (const b of Object.values(s.totals)) assert.deepEqual(b, { amount: 0, count: 0 });
  });

  test('approving a pending transfer moves it, once, from Awaiting to Approved', async () => {
    const id = await addTransfer(BRANCH_C, { cash: 1000 }, 'pending', '2026-10-15');
    let s = await getMonthlyCashTransferSummary({ branchId: BRANCH_C, now: NOW });
    assert.deepEqual(s.totals.pending, { amount: 1000, count: 1 });
    await db.query(`update cash_transfers set status = 'approved' where id = $1`, [id]);
    s = await getMonthlyCashTransferSummary({ branchId: BRANCH_C, now: NOW });
    assert.deepEqual(s.totals.pending, { amount: 0, count: 0 });
    assert.deepEqual(s.totals.approved, { amount: 1000, count: 1 });
    assert.deepEqual(s.totals.transferred, { amount: 1000, count: 1 });
    await db.query(`delete from cash_transfers where id = $1`, [id]);
  });
});

describe('GET /api/cash-transfers/monthly-summary', () => {
  test('a branch manager gets their own branch, whatever branchId they send', async () => {
    const res = await call('branch-a', `/api/cash-transfers/monthly-summary?branchId=${BRANCH_B}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.branchId, BRANCH_A);
    assert.equal(typeof res.body.totals.transferred.amount, 'number');
    assert.match(res.body.from, /^\d{4}-\d{2}-01$/);
  });

  test('is not taken by the /:id route', async () => {
    const res = await call('branch-c', '/api/cash-transfers/monthly-summary');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.branchId, BRANCH_C);
  });

  test('super_admin names a branch and gets that branch', async () => {
    const res = await call('admin', `/api/cash-transfers/monthly-summary?branchId=${BRANCH_B}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.branchId, BRANCH_B);
  });

  test('super_admin without a branch, or with a malformed one, is a 400', async () => {
    assert.equal((await call('admin', '/api/cash-transfers/monthly-summary')).status, 400);
    assert.equal((await call('admin', '/api/cash-transfers/monthly-summary?branchId=nope')).status, 400);
  });

  test('Production cannot read a branch\'s transfers', async () => {
    assert.equal((await call('production', '/api/cash-transfers/monthly-summary')).status, 403);
  });
});
