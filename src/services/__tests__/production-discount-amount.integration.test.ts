import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';

/**
 * Production → Discounts → Discount Detail → Edit amount, end to end against the
 * REAL routes and the REAL migration (20261106000003) over stub tables, through
 * `authenticate` with API-signed tokens.
 *
 * PUT /api/production-discounts/:id/amount corrects a pending claim, keeps the
 * branch's own figure in original_amount (from the FIRST change only), clears
 * the record when set back to it, refuses a claim that is no longer pending, and
 * the branch's own revision afterwards takes the claim back as its own.
 */

const read = (dir: string, file: string) => readFileSync(join(__dirname, dir, file), 'utf8');

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table business_day_closures (business_date date primary key, status text not null);
  create table branches (id uuid primary key default gen_random_uuid(), name text);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
  create table notifications (
    id uuid primary key default gen_random_uuid(), type text not null, title text not null, message text not null,
    target_user_id uuid, target_role text, branch_id uuid, related_id uuid,
    is_read boolean not null default false, created_at timestamptz not null default now());
  -- As the baseline creates it.
  create type public.branch_discount_status as enum ('pending', 'approved', 'rejected', 'returned');
  create table public.branch_discounts (
    id uuid default gen_random_uuid() primary key, branch_id uuid not null, branch_name text,
    production_order_id uuid not null, demand_number text, amount numeric(14,2) not null,
    reason text not null, status public.branch_discount_status default 'pending' not null,
    business_date date not null, created_by uuid, created_by_name text,
    created_at timestamptz default now() not null, reviewed_by uuid, reviewed_by_name text,
    reviewed_at timestamptz, review_note text,
    constraint branch_discounts_amount_positive check (amount > 0));
`;

const BRANCH = '00000000-0000-4000-8000-00000000000a';
const ACTORS = {
  production: { id: '10000000-0000-4000-8000-000000000001', email: 'prod@mb.test', role: 'production_user', branchId: null, branchName: null },
  branch: { id: '10000000-0000-4000-8000-000000000002', email: 'a@mb.test', role: 'branch_manager', branchId: BRANCH, branchName: 'DHA Branch' },
} as const;
const TOKENS: Record<string, string> = {};

let db: PGlite;
let server: Server;
let base = '';

async function claim(amount: number, status = 'pending'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into branch_discounts (branch_id, branch_name, production_order_id, demand_number, amount, reason, status, business_date)
     values ($1, 'DHA Branch', gen_random_uuid(), 'DMD-000001', $2, 'Short delivery', $3, '2026-11-05') returning id`,
    [BRANCH, amount, status],
  );
  return rows[0]!.id;
}

async function call(actor: keyof typeof ACTORS, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKENS[actor]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const setAmount = (id: string, amount: number) => call('production', 'PUT', `/api/production-discounts/${id}/amount`, { amount });

before(async () => {
  process.env['JWT_SECRET'] = 'production-discount-amount-test-secret-long-enough';

  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(`begin;${read('../../../db/history/migrations', '20261009000149_custom_auth.sql')}commit;`);
  await db.exec(read('../../../prisma/migrations/20261106000003_branch_discount_production_amount', 'migration.sql'));
  await db.query(`insert into branches (id, name) values ($1, 'DHA Branch')`, [BRANCH]);
  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);

  for (const [name, a] of Object.entries(ACTORS)) {
    await db.query(`insert into users (id, email, role, branch_id, branch_name) values ($1, $2, $3, $4, $5)`, [a.id, a.email, a.role, a.branchId, a.branchName]);
    const session = await prisma.auth_sessions.create({
      data: { user_id: a.id, client: 'web', expires_at: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    TOKENS[name] = signAccessToken(a.id, session.id).token;
  }

  const express = (await import('express')).default;
  const { router: productionRouter } = await import('../../routes/production-discounts.routes');
  const { router: branchRouter } = await import('../../routes/branch-discounts.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/production-discounts', productionRouter);
  app.use('/api/branch-discounts', branchRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('Production edits a pending claim’s amount', () => {
  test('changes it, keeps the branch’s figure and who changed it, and tells the branch', async () => {
    const id = await claim(700);
    const r = await setAmount(id, 500);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['amount'], 500);
    assert.equal(r.body['originalAmount'], 700);
    assert.equal(r.body['amountChangedByName'], 'prod@mb.test');
    assert.ok(r.body['amountChangedAt']);
    assert.equal(r.body['status'], 'pending');

    const { rows } = await db.query<{ title: string; message: string; target_role: string; branch_id: string }>(
      `select title, message, target_role, branch_id from notifications where related_id = $1`, [id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.title, 'Discount Amount Changed');
    assert.equal(rows[0]!.message, 'Production changed DMD-000001 from 700 to 500');
    assert.equal(rows[0]!.target_role, 'branch_manager');
    assert.equal(rows[0]!.branch_id, BRANCH);
  });

  test('a second change keeps the branch’s FIRST figure; setting it back clears the record', async () => {
    const id = await claim(700);
    await setAmount(id, 500);
    const second = await setAmount(id, 450.5);
    assert.equal(second.body['amount'], 450.5);
    assert.equal(second.body['originalAmount'], 700);

    const back = await setAmount(id, 700);
    assert.equal(back.status, 200);
    assert.equal(back.body['amount'], 700);
    assert.equal(back.body['originalAmount'], null);
    assert.equal(back.body['amountChangedByName'], null);
  });

  test('the same amount changes nothing and sends no notification', async () => {
    const id = await claim(300);
    const r = await setAmount(id, 300);
    assert.equal(r.status, 200);
    assert.equal(r.body['originalAmount'], null);
    const { rows } = await db.query(`select 1 from notifications where related_id = $1`, [id]);
    assert.equal(rows.length, 0);
  });

  test('only a pending claim: approved, rejected and sent-back ones are refused', async () => {
    for (const status of ['approved', 'rejected', 'returned']) {
      const id = await claim(400, status);
      const r = await setAmount(id, 350);
      assert.equal(r.status, 409, status);
      const { rows } = await db.query<{ amount: string }>(`select amount from branch_discounts where id = $1`, [id]);
      assert.equal(Number(rows[0]!.amount), 400, status);
    }
  });

  test('bad amounts are a 400; an unknown claim is a 404', async () => {
    const id = await claim(400);
    assert.equal((await setAmount(id, 0)).status, 400);
    assert.equal((await setAmount(id, -5)).status, 400);
    assert.equal((await setAmount(id, 10.123)).status, 400);
    assert.equal((await setAmount('00000000-0000-4000-8000-0000000000ff', 10)).status, 404);
  });

  test('a branch role cannot use the Production route', async () => {
    const id = await claim(400);
    const r = await call('branch', 'PUT', `/api/production-discounts/${id}/amount`, { amount: 1 });
    assert.equal(r.status, 403);
  });

  test('the branch revising the claim afterwards makes the figure its own again', async () => {
    const id = await claim(700);
    await setAmount(id, 500);
    const r = await call('branch', 'PUT', `/api/branch-discounts/${id}`, { amount: 650, reason: 'Short delivery, recounted' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['amount'], 650);
    assert.equal(r.body['originalAmount'], null);
    assert.equal(r.body['amountChangedByName'], null);
    assert.equal(r.body['amountChangedAt'], null);
  });

  test('src/db/catalog.generated.json describes branch_discounts as the migration leaves it', async () => {
    const { CATALOG_QUERY, shapeCatalog } = await import('../../db/catalog-query');
    const committed = JSON.parse(readFileSync(join(__dirname, '../../db/catalog.generated.json'), 'utf8'));
    await db.exec(`set search_path = ''`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const live = shapeCatalog((await db.query<any>(CATALOG_QUERY)).rows[0].json_build_object) as any;
    await db.exec('reset search_path');
    assert.deepEqual(committed.tables['branch_discounts'], live.tables['branch_discounts']);
  });
});
