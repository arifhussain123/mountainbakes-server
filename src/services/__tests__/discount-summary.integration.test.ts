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
import { getMonthlyDiscountSummary } from '../discount-summary.service';

/**
 * The monthly Branch Discount summary's SQL, run for real in pglite over stub
 * tables: the month-to-date window applied to `business_date`, per-status
 * buckets, branch scope — and then the two routes that serve it, so the role
 * and branch rules are the real middleware's, not a mocked handler's.
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

  create type branch_discount_status as enum ('pending', 'approved', 'rejected', 'returned');
  create table branch_discounts (
    id uuid primary key default gen_random_uuid(),
    branch_id uuid not null references branches (id), branch_name text,
    production_order_id uuid not null, demand_number text,
    amount numeric(14,2) not null, reason text not null,
    status branch_discount_status not null default 'pending',
    business_date date not null,
    created_by uuid, created_by_name text, created_at timestamptz not null default now(),
    reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz, review_note text);
`;

const BRANCH_A = '00000000-0000-4000-8000-00000000000a'; // DHA
const BRANCH_B = '00000000-0000-4000-8000-00000000000b'; // Gulshan
const BRANCH_C = '00000000-0000-4000-8000-00000000000c'; // inactive, no claims
const BRANCH_D = '00000000-0000-4000-8000-00000000000d'; // active, no claims this month
const ORDER = '30000000-0000-4000-8000-000000000001';

/** 18 Oct 2026, 10:00 in Karachi — the summary covers 1–18 Oct. */
const NOW = new Date('2026-10-18T10:00:00+05:00');

let db: PGlite;
let server: Server;
let base: string;

interface Actor { id: string; email: string; role: string; branchId: string | null; branchName: string | null }
const ACTORS: Record<string, Actor> = {
  production: { id: '10000000-0000-4000-8000-000000000001', email: 'prod@mb.test', role: 'production_user', branchId: null, branchName: null },
  'branch-a': { id: '10000000-0000-4000-8000-000000000002', email: 'a@mb.test', role: 'branch_manager', branchId: BRANCH_A, branchName: 'DHA Branch' },
  admin: { id: '10000000-0000-4000-8000-000000000003', email: 'admin@mb.test', role: 'super_admin', branchId: null, branchName: null },
};
const TOKENS: Record<string, string> = {};

async function call(as: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKENS[as]}` } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function addClaim(branchId: string, amount: number, status: string, date: string): Promise<string> {
  const branchName = branchId === BRANCH_A ? 'DHA Branch' : 'Gulshan Branch';
  const { rows } = await db.query<{ id: string }>(
    `insert into branch_discounts (branch_id, branch_name, production_order_id, demand_number, amount, reason, status, business_date)
     values ($1, $2, $3, 'DMD-000001', $4, 'short delivery', $5, $6) returning id`,
    [branchId, branchName, ORDER, amount, status, date],
  );
  return rows[0]!.id;
}

before(async () => {
  process.env['JWT_SECRET'] = 'discount-summary-test-secret-that-is-long-enough-to-sign';

  db = new PGlite();
  await db.exec('create schema app');
  await db.exec(STUBS);
  await db.exec(`begin;${read('20261009000149_custom_auth.sql')}commit;`);

  await db.query(
    `insert into branches (id, name, is_active) values
       ($1, 'DHA Branch', true), ($2, 'Gulshan Branch', true), ($3, 'Closed Branch', false), ($4, 'Bahria Branch', true)`,
    [BRANCH_A, BRANCH_B, BRANCH_C, BRANCH_D],
  );

  // DHA, inside the window
  await addClaim(BRANCH_A, 500, 'approved', '2026-10-01'); // first of the month
  await addClaim(BRANCH_A, 250.5, 'approved', '2026-10-18'); // today
  await addClaim(BRANCH_A, 300, 'pending', '2026-10-12');
  await addClaim(BRANCH_A, 120, 'rejected', '2026-10-09');
  // DHA, outside the window
  await addClaim(BRANCH_A, 9000, 'approved', '2026-09-30'); // last day of the previous month
  await addClaim(BRANCH_A, 7000, 'approved', '2026-10-19'); // tomorrow
  // Gulshan
  await addClaim(BRANCH_B, 1000, 'approved', '2026-10-05');
  await addClaim(BRANCH_B, 80, 'returned', '2026-10-07');
  // Bahria: only last month
  await addClaim(BRANCH_D, 450, 'approved', '2026-09-15');

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
  const { router: productionDiscounts } = await import('../../routes/production-discounts.routes');
  const { router: branchDiscounts } = await import('../../routes/branch-discounts.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/production-discounts', productionDiscounts);
  app.use('/api/branch-discounts', branchDiscounts);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('getMonthlyDiscountSummary — all branches', () => {
  test('covers the 1st through today, and excludes last month and tomorrow', async () => {
    const s = await getMonthlyDiscountSummary({ branchId: null, now: NOW });
    assert.equal(s.from, '2026-10-01');
    assert.equal(s.to, '2026-10-18');
    const dha = s.branches.find((b) => b.branchId === BRANCH_A)!;
    assert.deepEqual(dha.approved, { amount: 750.5, count: 2 }, '1 Oct and 18 Oct in; 30 Sep and 19 Oct out');
  });

  test('each status in its own bucket, and the buckets sum to submitted', async () => {
    const s = await getMonthlyDiscountSummary({ branchId: null, now: NOW });
    const dha = s.branches.find((b) => b.branchId === BRANCH_A)!;
    assert.deepEqual(dha.pending, { amount: 300, count: 1 });
    assert.deepEqual(dha.rejected, { amount: 120, count: 1 });
    assert.deepEqual(dha.returned, { amount: 0, count: 0 });
    assert.deepEqual(dha.submitted, { amount: 1170.5, count: 4 });
  });

  test('every active branch is listed, at Rs. 0 where nothing was claimed; inactive ones are not', async () => {
    const s = await getMonthlyDiscountSummary({ branchId: null, now: NOW });
    assert.deepEqual(s.branches.map((b) => b.branchName), ['Bahria Branch', 'DHA Branch', 'Gulshan Branch']);
    const bahria = s.branches.find((b) => b.branchId === BRANCH_D)!;
    assert.deepEqual(bahria.approved, { amount: 0, count: 0 }, 'September claims never reach October');
  });

  test('the overall total adds every branch', async () => {
    const s = await getMonthlyDiscountSummary({ branchId: null, now: NOW });
    assert.deepEqual(s.totals.approved, { amount: 1750.5, count: 3 });
    assert.deepEqual(s.totals.pending, { amount: 300, count: 1 });
    assert.deepEqual(s.totals.returned, { amount: 80, count: 1 });
    assert.deepEqual(s.totals.submitted, { amount: 2250.5, count: 6 });
  });
});

describe('getMonthlyDiscountSummary — month turnover', () => {
  test('on 1 Nov the window is November alone and October keeps its figures', async () => {
    const nov = await getMonthlyDiscountSummary({ branchId: null, now: new Date('2026-11-01T09:00:00+05:00') });
    assert.equal(nov.from, '2026-11-01');
    assert.deepEqual(nov.totals.submitted, { amount: 0, count: 0 });
    const oct = await getMonthlyDiscountSummary({ branchId: null, now: new Date('2026-10-31T23:00:00+05:00') });
    assert.equal(oct.from, '2026-10-01');
    // 31 Oct now also takes in the claim dated 19 Oct.
    assert.deepEqual(oct.totals.approved, { amount: 8750.5, count: 4 });
  });

  test('December → January starts a new year\'s month', async () => {
    const jan = await getMonthlyDiscountSummary({ branchId: null, now: new Date('2027-01-01T10:00:00+05:00') });
    assert.equal(jan.from, '2027-01-01');
    assert.equal(jan.to, '2027-01-01');
  });
});

describe('getMonthlyDiscountSummary — changes', () => {
  test('approving, correcting and withdrawing a claim each move the totals once', async () => {
    const id = await addClaim(BRANCH_B, 200, 'pending', '2026-10-15');
    const gulshan = async () => (await getMonthlyDiscountSummary({ branchId: BRANCH_B, now: NOW })).branches[0]!;
    assert.deepEqual((await gulshan()).pending, { amount: 200, count: 1 });

    await db.query(`update branch_discounts set status = 'approved' where id = $1`, [id]);
    let g = await gulshan();
    assert.deepEqual(g.pending, { amount: 0, count: 0 });
    assert.deepEqual(g.approved, { amount: 1200, count: 2 }, 'moved, not copied, into Approved');

    await db.query(`update branch_discounts set amount = 150 where id = $1`, [id]);
    assert.deepEqual((await gulshan()).approved, { amount: 1150, count: 2 });

    await db.query(`delete from branch_discounts where id = $1`, [id]);
    g = await gulshan();
    assert.deepEqual(g.approved, { amount: 1000, count: 1 });
    assert.deepEqual(g.submitted, { amount: 1080, count: 2 });
  });
});

describe('summary routes', () => {
  test('Production sees every active branch and the overall total', async () => {
    const res = await call('production', '/api/production-discounts/summary');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.branches.length, 3);
    assert.equal(typeof res.body.totals.approved.amount, 'number');
  });

  test('Production can narrow to one branch', async () => {
    const res = await call('production', `/api/production-discounts/summary?branchId=${BRANCH_B}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.branches.map((b: { branchId: string }) => b.branchId), [BRANCH_B]);
  });

  test('super_admin sees the all-branch summary', async () => {
    const res = await call('admin', '/api/production-discounts/summary');
    assert.equal(res.status, 200);
    assert.equal(res.body.branches.length, 3);
  });

  test('a malformed branchId is a 400, not a database error', async () => {
    assert.equal((await call('production', '/api/production-discounts/summary?branchId=nope')).status, 400);
    assert.equal((await call('admin', '/api/branch-discounts/summary?branchId=nope')).status, 400);
  });

  test('a branch manager cannot open the all-branch summary', async () => {
    const res = await call('branch-a', '/api/production-discounts/summary');
    assert.equal(res.status, 403);
  });

  test('a branch manager gets their own branch only, whatever branchId they send', async () => {
    const res = await call('branch-a', `/api/branch-discounts/summary?branchId=${BRANCH_B}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.branches.map((b: { branchId: string }) => b.branchId), [BRANCH_A]);
    assert.equal(res.body.totals.submitted.count, res.body.branches[0].submitted.count);
  });

  test('super_admin names a branch on the branch route and gets that branch only', async () => {
    const res = await call('admin', `/api/branch-discounts/summary?branchId=${BRANCH_B}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.branches.map((b: { branchId: string }) => b.branchId), [BRANCH_B]);
  });

  test('Production has no branch of its own to read from the branch route', async () => {
    const res = await call('production', '/api/branch-discounts/summary');
    assert.equal(res.status, 403);
  });
});
