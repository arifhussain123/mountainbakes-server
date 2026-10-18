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
import { businessDateStr } from '../../shared';
import { getMonthlyReturnsSummary } from '../returns-summary.service';

/**
 * The monthly Product Returns summary's SQL, run for real in pglite over stub
 * tables: the month-to-date window applied to `business_date`, the
 * price-on-the-day lookup through `product_price_history`, branch scope — and
 * then the two routes that serve it, so the role and branch rules are the
 * real middleware's, not a mocked handler's.
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

  create type production_return_status as enum ('pending', 'accepted', 'rejected', 'returned');
  create type price_change_status as enum ('scheduled', 'active', 'superseded');
  create table products (id uuid primary key default gen_random_uuid(), name text not null, price numeric(14,2));
  create table product_price_history (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references products (id),
    old_price numeric(14,2), new_price numeric(14,2) not null,
    effective_date date not null, status price_change_status not null, version_number int not null);
  create table production_returns (
    id uuid primary key default gen_random_uuid(),
    branch_id uuid not null references branches (id), branch_name text,
    product_id uuid not null references products (id), product_name text not null,
    qty numeric(14,3) not null check (qty > 0), reason text,
    status production_return_status not null default 'pending',
    source text, business_date date not null,
    created_at timestamptz not null default now());
`;

const BRANCH_A = '00000000-0000-4000-8000-00000000000a'; // DHA
const BRANCH_B = '00000000-0000-4000-8000-00000000000b'; // Gulshan
const BRANCH_C = '00000000-0000-4000-8000-00000000000c'; // inactive, never returns anything
const BRANCH_D = '00000000-0000-4000-8000-00000000000d'; // active, nothing returned this month
const FUDGE = '20000000-0000-4000-8000-000000000001';
const LOTUS = '20000000-0000-4000-8000-000000000002';
const NO_PRICE = '20000000-0000-4000-8000-000000000003';

/** 18 Oct 2026, 10:00 in Karachi — the summary covers 1–18 Oct. */
const NOW = new Date('2026-10-18T10:00:00+05:00');

let db: PGlite;
let server: Server;
let base: string;

interface Actor { id: string; email: string; role: string; branchId: string | null; branchName: string | null }
const ACTORS: Record<string, Actor> = {
  production: { id: '10000000-0000-4000-8000-000000000001', email: 'prod@mb.test', role: 'production_user', branchId: null, branchName: null },
  'branch-a': { id: '10000000-0000-4000-8000-000000000002', email: 'a@mb.test', role: 'branch_manager', branchId: BRANCH_A, branchName: 'DHA Branch' },
};
const TOKENS: Record<string, string> = {};

async function call(as: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKENS[as]}` } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function addReturn(branchId: string, productId: string, qty: number, status: string, date: string) {
  const branchName = branchId === BRANCH_A ? 'DHA Branch' : 'Gulshan Branch';
  await db.query(
    `insert into production_returns (branch_id, branch_name, product_id, product_name, qty, status, source, business_date)
     values ($1, $2, $3, (select name from products where id = $3), $4, $5, 'branch', $6)`,
    [branchId, branchName, productId, qty, status, date],
  );
}

before(async () => {
  process.env['JWT_SECRET'] = 'returns-summary-test-secret-that-is-long-enough-to-sign';

  db = new PGlite();
  await db.exec('create schema app');
  await db.exec(STUBS);
  await db.exec(`begin;${read('20261009000149_custom_auth.sql')}commit;`);

  await db.query(
    `insert into branches (id, name, is_active) values
       ($1, 'DHA Branch', true), ($2, 'Gulshan Branch', true), ($3, 'Closed Branch', false), ($4, 'Bahria Branch', true)`,
    [BRANCH_A, BRANCH_B, BRANCH_C, BRANCH_D],
  );

  // Fudge Pastry was Rs. 150 until 10 Oct, Rs. 200 from then on.
  // Lotus Pastry has always been Rs. 150: its history holds only a scheduled
  // change that never took effect (superseded) and one not yet due — neither
  // may price anything.
  await db.query(
    `insert into products (id, name, price) values ($1, 'Fudge Pastry', 200), ($2, 'Lotus Pastry', 150), ($3, 'Unpriced Item', null)`,
    [FUDGE, LOTUS, NO_PRICE],
  );
  await db.query(
    `insert into product_price_history (product_id, old_price, new_price, effective_date, status, version_number) values
       ($1, 150, 200, '2026-10-10', 'active', 1),
       ($2, 150, 999, '2026-10-01', 'superseded', 1),
       ($2, 150, 500, '2026-10-25', 'scheduled', 2)`,
    [FUDGE, LOTUS],
  );

  // DHA, inside the window
  await addReturn(BRANCH_A, FUDGE, 2, 'pending', '2026-10-01'); //  first of the month, old price: 2 × 150 = 300
  await addReturn(BRANCH_A, LOTUS, 3, 'accepted', '2026-10-18'); // today:                           3 × 150 = 450
  await addReturn(BRANCH_A, FUDGE, 1, 'rejected', '2026-10-12'); // new price:                       1 × 200 = 200
  // DHA, outside the window
  await addReturn(BRANCH_A, LOTUS, 4, 'accepted', '2026-09-30'); // last day of the previous month
  await addReturn(BRANCH_A, FUDGE, 5, 'pending', '2026-10-19'); //  tomorrow
  // Gulshan
  await addReturn(BRANCH_B, LOTUS, 2, 'returned', '2026-10-05'); //                                  2 × 150 = 300
  await addReturn(BRANCH_B, FUDGE, 1, 'accepted', '2026-10-10'); // the day the new price took effect: 1 × 200 = 200
  await addReturn(BRANCH_B, NO_PRICE, 2, 'pending', '2026-10-07'); // no price anywhere — counted, not valued

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
  const { router: productionReturns } = await import('../../routes/production-returns.routes');
  const { router: stock } = await import('../../routes/stock.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/production-returns', productionReturns);
  app.use('/api/stock', stock);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('getMonthlyReturnsSummary — all branches', () => {
  test('covers 1st of the month through today, and excludes last month and tomorrow', async () => {
    const s = await getMonthlyReturnsSummary({ branchId: null, now: NOW });
    assert.equal(s.from, '2026-10-01');
    assert.equal(s.to, '2026-10-18');
    const dha = s.branches.find((b) => b.branchId === BRANCH_A)!;
    assert.deepEqual(dha.submitted, { qty: 6, amount: 950, count: 3 });
  });

  test('prices each return at the price in force on its own business date', async () => {
    const s = await getMonthlyReturnsSummary({ branchId: null, now: NOW });
    const dha = s.branches.find((b) => b.branchId === BRANCH_A)!;
    assert.deepEqual(dha.pending, { qty: 2, amount: 300, count: 1 }, 'Fudge on 1 Oct at the old Rs. 150');
    assert.deepEqual(dha.rejected, { qty: 1, amount: 200, count: 1 }, 'Fudge on 12 Oct at the new Rs. 200');
    assert.deepEqual(dha.accepted, { qty: 3, amount: 450, count: 1 }, 'Lotus ignores superseded and scheduled changes');
    const gulshan = s.branches.find((b) => b.branchId === BRANCH_B)!;
    assert.deepEqual(gulshan.accepted, { qty: 1, amount: 200, count: 1 }, 'the effective date itself is the new price');
  });

  test('status buckets never overlap and the overall total adds every branch', async () => {
    const s = await getMonthlyReturnsSummary({ branchId: null, now: NOW });
    assert.deepEqual(s.totals.submitted, { qty: 11, amount: 1450, count: 6 });
    assert.deepEqual(s.totals.accepted, { qty: 4, amount: 650, count: 2 });
    assert.deepEqual(s.totals.pending, { qty: 4, amount: 300, count: 2 });
    assert.deepEqual(s.totals.rejected, { qty: 1, amount: 200, count: 1 });
    assert.deepEqual(s.totals.returned, { qty: 2, amount: 300, count: 1 });
    const bucketCounts = s.totals.pending.count + s.totals.accepted.count + s.totals.rejected.count + s.totals.returned.count;
    assert.equal(bucketCounts, s.totals.submitted.count);
  });

  test('a return with no price is counted and flagged, never given an invented amount', async () => {
    const s = await getMonthlyReturnsSummary({ branchId: null, now: NOW });
    const gulshan = s.branches.find((b) => b.branchId === BRANCH_B)!;
    assert.deepEqual(gulshan.submitted, { qty: 5, amount: 500, count: 3 });
    assert.equal(gulshan.unpricedCount, 1);
    assert.equal(s.totals.unpricedCount, 1);
  });

  test('lists every active branch, at zero where nothing came back, and skips inactive ones', async () => {
    const s = await getMonthlyReturnsSummary({ branchId: null, now: NOW });
    assert.deepEqual(s.branches.map((b) => b.branchName), ['Bahria Branch', 'DHA Branch', 'Gulshan Branch']);
    assert.deepEqual(s.branches[0]!.submitted, { qty: 0, amount: 0, count: 0 });
  });
});

describe('getMonthlyReturnsSummary — one branch', () => {
  test('a branch-scoped summary holds that branch alone', async () => {
    const s = await getMonthlyReturnsSummary({ branchId: BRANCH_A, now: NOW });
    assert.deepEqual(s.branches.map((b) => b.branchId), [BRANCH_A]);
    assert.deepEqual(s.totals.submitted, { qty: 6, amount: 950, count: 3 });
  });
});

describe('getMonthlyReturnsSummary — month turnover', () => {
  test('a new month starts empty and last month keeps its own figures', async () => {
    await addReturn(BRANCH_B, LOTUS, 1, 'accepted', '2026-12-31');
    await addReturn(BRANCH_B, LOTUS, 2, 'accepted', '2027-01-01');

    const dec = await getMonthlyReturnsSummary({ branchId: BRANCH_B, now: new Date('2027-01-01T01:30:00+05:00') });
    assert.equal(dec.from, '2026-12-01');
    assert.equal(dec.to, '2026-12-31');
    assert.deepEqual(dec.totals.submitted, { qty: 1, amount: 150, count: 1 });

    const jan = await getMonthlyReturnsSummary({ branchId: BRANCH_B, now: new Date('2027-01-01T09:00:00+05:00') });
    assert.equal(jan.from, '2027-01-01');
    assert.equal(jan.to, '2027-01-01');
    assert.deepEqual(jan.totals.submitted, { qty: 2, amount: 300, count: 1 });
  });

  test('a later price change does not alter returns already made', async () => {
    const before = await getMonthlyReturnsSummary({ branchId: BRANCH_A, now: NOW });
    // Fudge goes to Rs. 300 from 17 Oct — after every DHA Fudge return this month.
    await db.query(`update products set price = 300 where id = $1`, [FUDGE]);
    await db.query(
      `insert into product_price_history (product_id, old_price, new_price, effective_date, status, version_number)
       values ($1, 200, 300, '2026-10-17', 'active', 2)`,
      [FUDGE],
    );
    const afterChange = await getMonthlyReturnsSummary({ branchId: BRANCH_A, now: NOW });
    assert.deepEqual(afterChange.totals, before.totals);
  });
});

describe('summary routes', () => {
  test('Production sees every branch', async () => {
    const res = await call('production', '/api/production-returns/summary');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.to, businessDateStr());
    assert.ok(res.body.branches.length >= 3);
  });

  test('Production can narrow to one branch', async () => {
    const res = await call('production', `/api/production-returns/summary?branchId=${BRANCH_B}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.branches.map((b: { branchId: string }) => b.branchId), [BRANCH_B]);
  });

  test('a malformed branchId is a 400, not a database error', async () => {
    const res = await call('production', '/api/production-returns/summary?branchId=nope');
    assert.equal(res.status, 400);
  });

  test('a branch manager cannot open Production’s all-branch summary', async () => {
    const res = await call('branch-a', '/api/production-returns/summary');
    assert.equal(res.status, 403);
  });

  test('a branch manager gets their own branch only, whatever branchId they send', async () => {
    const res = await call('branch-a', `/api/stock/returns/summary?branchId=${BRANCH_B}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.branches.map((b: { branchId: string }) => b.branchId), [BRANCH_A]);
  });

  test('Production has no branch of its own to read from the branch route', async () => {
    const res = await call('production', '/api/stock/returns/summary');
    assert.equal(res.status, 403);
  });
});
