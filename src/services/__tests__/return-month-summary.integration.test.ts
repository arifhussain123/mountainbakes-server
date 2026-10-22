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
import { currentBusinessMonth, shiftMonth } from '../../shared';
import { getReturnMonthSummary } from '../returns-summary.service';

/**
 * Return Summary's SQL, run for real in pglite over the same stub tables as
 * returns-summary.integration.test.ts: the whole-month window on
 * `business_date`, rejected returns left out, the price on each return's own
 * day, reasons bucketed — and then the route, so the role rules are the real
 * middleware's.
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
  create table products (id uuid primary key default gen_random_uuid(), name text not null, sku text, price numeric(14,2));
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
    created_by uuid, created_by_name text,
    reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
    disposition text, disposition_note text, legacy_id text, photo_attachment_id uuid,
    created_at timestamptz not null default now());
  create type attachment_entity as enum ('branch_return');
  create table attachments (
    id uuid primary key default gen_random_uuid(), entity attachment_entity not null,
    entity_id uuid, storage_path text not null, mime_type text not null default 'image/webp',
    size_bytes integer not null default 1, width integer, height integer,
    uploaded_by uuid, uploaded_by_name text, bound_at timestamptz,
    created_at timestamptz not null default now());
`;

const DHA = '00000000-0000-4000-8000-00000000000a';
const NORTH = '00000000-0000-4000-8000-00000000000b';
const CHOC = '20000000-0000-4000-8000-000000000001';
const PUFF = '20000000-0000-4000-8000-000000000002';
const NO_PRICE = '20000000-0000-4000-8000-000000000003';

const NOW = new Date('2026-10-18T10:00:00+05:00');

let db: PGlite;
let server: Server;
let base: string;

interface Actor { id: string; email: string; role: string; branchId: string | null; branchName: string | null }
const ACTORS: Record<string, Actor> = {
  production: { id: '10000000-0000-4000-8000-000000000001', email: 'prod@mb.test', role: 'production_user', branchId: null, branchName: null },
  branch: { id: '10000000-0000-4000-8000-000000000002', email: 'a@mb.test', role: 'branch_manager', branchId: DHA, branchName: 'DHA Branch' },
  admin: { id: '10000000-0000-4000-8000-000000000003', email: 'admin@mb.test', role: 'super_admin', branchId: null, branchName: null },
  finance: { id: '10000000-0000-4000-8000-000000000004', email: 'fin@mb.test', role: 'finance_admin', branchId: null, branchName: null },
};
const TOKENS: Record<string, string> = {};

async function call(as: string | null, path: string) {
  const res = await fetch(`${base}${path}`, { headers: as ? { Authorization: `Bearer ${TOKENS[as]}` } : {} });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function addReturn(branchId: string, productId: string, qty: number, status: string, date: string, reason: string | null) {
  await db.query(
    `insert into production_returns (branch_id, branch_name, product_id, product_name, qty, status, source, business_date, reason)
     values ($1, (select name from branches where id = $1), $2, (select name from products where id = $2), $3, $4, 'branch', $5, $6)`,
    [branchId, productId, qty, status, date, reason],
  );
}

before(async () => {
  process.env['JWT_SECRET'] = 'return-month-summary-test-secret-that-is-long-enough';

  db = new PGlite();
  await db.exec('create schema app');
  await db.exec(STUBS);
  await db.exec(`begin;${read('20261009000149_custom_auth.sql')}commit;`);

  await db.query(`insert into branches (id, name) values ($1, 'DHA Branch'), ($2, 'North Nazimabad Branch')`, [DHA, NORTH]);
  // Chocolate Pastry was Rs. 150 until 10 Oct, Rs. 200 from then on; today's
  // products.price (250) must never price a past return.
  await db.query(
    `insert into products (id, name, sku, price) values ($1, 'Chocolate Pastry', 'CP', 250), ($2, 'Cream Puff', 'PF', 50), ($3, 'Unpriced Item', null, null)`,
    [CHOC, PUFF, NO_PRICE],
  );
  await db.query(
    `insert into product_price_history (product_id, old_price, new_price, effective_date, status, version_number) values
       ($1, 150, 200, '2026-10-10', 'active', 1), ($1, 200, 250, '2026-10-20', 'active', 2)`,
    [CHOC],
  );

  // October, DHA chocolate pastry
  await addReturn(DHA, CHOC, 2, 'accepted', '2026-10-01', 'Damaged');          // first day, 2 × 150 = 300
  await addReturn(DHA, CHOC, 3, 'pending', '2026-10-12', ' damage in box ');  // 3 × 200 = 600 → same Damaged line
  await addReturn(DHA, CHOC, 3, 'returned', '2026-10-31', 'unsold');          // last day, 3 × 250 = 750 → its own line
  await addReturn(DHA, CHOC, 9, 'rejected', '2026-10-15', 'Damaged');         // rejected: never counted
  // October, other rows
  await addReturn(NORTH, CHOC, 4, 'accepted', '2026-10-05', 'Not sold');      // 4 × 150 = 600
  await addReturn(DHA, PUFF, 6, 'accepted', '2026-10-07', null);              // 6 × 50 = 300, no reason
  await addReturn(NORTH, NO_PRICE, 2, 'pending', '2026-10-08', 'exp');        // counted, not valued
  // Outside October
  await addReturn(DHA, CHOC, 7, 'accepted', '2026-09-30', 'Damaged');
  await addReturn(DHA, CHOC, 8, 'accepted', '2026-11-01', 'Damaged');
  // February 2028, a leap year
  await addReturn(NORTH, PUFF, 1, 'accepted', '2028-02-29', 'expired');
  await addReturn(NORTH, PUFF, 1, 'accepted', '2028-03-01', 'expired');

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
  const { router } = await import('../../routes/production-returns.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/production-returns', router);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('getReturnMonthSummary', () => {
  test('consolidates branch × item × reason at each day’s price, rejected left out', async () => {
    const s = await getReturnMonthSummary({ month: '2026-10', now: NOW });
    assert.equal(s.from, '2026-10-01');
    assert.equal(s.to, '2026-10-31');
    assert.deepEqual(
      s.lines.map((l) => [l.branchName, l.productName, l.reasonLabel, l.qty, l.amount, l.count]),
      [
        ['DHA Branch', 'Chocolate Pastry', 'Damaged', 5, 900, 2],
        ['DHA Branch', 'Chocolate Pastry', 'Unsold', 3, 750, 1],
        ['DHA Branch', 'Cream Puff', 'Not given', 6, 300, 1],
        ['North Nazimabad Branch', 'Chocolate Pastry', 'Unsold', 4, 600, 1],
        ['North Nazimabad Branch', 'Unpriced Item', 'Expired', 2, 0, 1],
      ],
    );
  });

  test('the item-wise box adds every branch, each item once', async () => {
    const s = await getReturnMonthSummary({ month: '2026-10', now: NOW });
    assert.deepEqual(
      s.items.map((i) => [i.productName, i.qty, i.amount]),
      [
        ['Chocolate Pastry', 12, 2250],
        ['Cream Puff', 6, 300],
        ['Unpriced Item', 2, 0],
      ],
    );
  });

  test('cards: totals, distinct branches and items, and the unpriced return flagged', async () => {
    const s = await getReturnMonthSummary({ month: '2026-10', now: NOW });
    assert.deepEqual(s.totals, { qty: 20, amount: 2550, count: 6, unpricedCount: 1, branchCount: 2, itemCount: 3 });
  });

  test('the first and last day are in; the days either side are not', async () => {
    const sep = await getReturnMonthSummary({ month: '2026-09', now: NOW });
    assert.deepEqual(sep.totals.qty, 7, 'only 30 Sep');
    const nov = await getReturnMonthSummary({ month: '2026-11', now: new Date('2026-11-05T10:00:00+05:00') });
    assert.deepEqual(nov.totals.qty, 8, 'only 1 Nov');
  });

  test('February in a leap year includes the 29th and not 1 March', async () => {
    const feb = await getReturnMonthSummary({ month: '2028-02', now: new Date('2028-03-05T10:00:00+05:00') });
    assert.equal(feb.to, '2028-02-29');
    assert.equal(feb.totals.qty, 1);
  });

  test('a month with no returns is empty, not an error', async () => {
    const s = await getReturnMonthSummary({ month: '2026-06', now: NOW });
    assert.deepEqual(s.lines, []);
    assert.equal(s.totals.branchCount, 0);
  });
});

describe('GET /api/production-returns/month-summary', () => {
  test('defaults to the current business month', async () => {
    const res = await call('production', '/api/production-returns/month-summary');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.month, currentBusinessMonth());
    assert.equal(res.body.currentMonth, currentBusinessMonth());
  });

  test('Production and Super Admin can open a past month', async () => {
    for (const who of ['production', 'admin']) {
      const res = await call(who, '/api/production-returns/month-summary?month=2026-10');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.totals.qty, 20);
    }
  });

  test('a malformed month and a month not yet started are refused', async () => {
    assert.equal((await call('production', '/api/production-returns/month-summary?month=2026-13')).status, 400);
    assert.equal((await call('production', '/api/production-returns/month-summary?month=oct')).status, 400);
    const next = shiftMonth(currentBusinessMonth(), 1);
    assert.equal((await call('production', `/api/production-returns/month-summary?month=${next}`)).status, 400);
  });

  test('branch and finance users, and no token, get nothing', async () => {
    assert.equal((await call('branch', '/api/production-returns/month-summary')).status, 403);
    assert.equal((await call('finance', '/api/production-returns/month-summary')).status, 403);
    assert.equal((await call(null, '/api/production-returns/month-summary')).status, 401);
  });
});
