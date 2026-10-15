import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../../services/auth/tokens';

/**
 * GET /api/production-orders/:id — the one demand's complete record Finance
 * Income opens from a Demand Amount drill-down (Demand number → full detail).
 *
 * Mirrors the branch-scoping rule `GET /api/orders/:id` already uses: a branch
 * manager may only open their own branch's demand, every other role may open
 * any. Run against the REAL router over a stub schema (pglite), not a mocked
 * handler, so the permission check and the embedded items/packing-items select
 * are exercised exactly as the API serves them.
 */

const MIGRATIONS = join(__dirname, '../../../db/history/migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create type branch_production_order_status as enum
    ('pending', 'awaiting_verification', 'verified', 'approved', 'rejected', 'cancelled');
  create type attachment_entity as enum
    ('production_order_demand', 'production_order_verification', 'production_order_special_item');
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table business_day_closures (business_date date primary key, status text not null);
  create table branches (id uuid primary key default gen_random_uuid(), name text);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
  create table products (id uuid primary key default gen_random_uuid(), name text not null, price numeric not null default 0);
  create table production_orders (
    id uuid primary key default gen_random_uuid(),
    demand_number text not null,
    branch_id uuid not null references branches(id),
    branch_name text,
    business_date date not null default current_date,
    submitted_time text not null default '00:00',
    required_date date,
    status branch_production_order_status not null default 'pending',
    was_changed boolean not null default false,
    change_reason text,
    created_by uuid, created_by_name text,
    submitted_at timestamptz not null default now(),
    approved_by uuid, approved_by_name text, approved_at timestamptz,
    verified_by uuid, verified_by_name text, verified_at timestamptz,
    printed boolean not null default false, printed_at timestamptz,
    cancel_reason text, cancelled_by uuid, cancelled_by_name text, cancelled_at timestamptz);
  create table production_order_items (
    id uuid primary key default gen_random_uuid(),
    production_order_id uuid not null references production_orders(id),
    product_id uuid, product_name text not null, qty numeric not null, unit_price numeric,
    remarks text default '', approved_qty numeric, is_special boolean not null default false,
    added_by_production boolean not null default false,
    previous_balance_qty numeric default 0, total_required_qty numeric default 0, remaining_balance_qty numeric default 0,
    line_no integer not null);
  create table production_order_packing_items (
    id uuid primary key default gen_random_uuid(),
    production_order_id uuid not null references production_orders(id),
    packing_material_id uuid, material_name text not null, qty numeric not null, approved_qty numeric,
    line_no integer not null);
  create table attachments (
    id uuid primary key default gen_random_uuid(), entity attachment_entity not null,
    entity_id uuid, storage_path text not null, mime_type text not null default 'image/webp',
    size_bytes integer not null default 1, width integer, height integer,
    uploaded_by uuid, uploaded_by_name text, bound_at timestamptz,
    created_at timestamptz not null default now());
`;

let db: PGlite;
let server: Server;
let base: string;

const BRANCH_A = '00000000-0000-4000-8000-00000000000a';
const BRANCH_B = '00000000-0000-4000-8000-00000000000b';
interface Actor { id: string; email: string; role: string; branchId: string | null; branchName: string | null }
const ACTORS: Record<string, Actor> = {
  'branch-a': { id: '10000000-0000-4000-8000-000000000001', email: 'a@mb.test', role: 'branch_manager', branchId: BRANCH_A, branchName: 'DHA Branch' },
  'branch-b': { id: '10000000-0000-4000-8000-000000000002', email: 'b@mb.test', role: 'branch_manager', branchId: BRANCH_B, branchName: 'Gulshan Branch' },
  finance: { id: '10000000-0000-4000-8000-000000000003', email: 'fin@mb.test', role: 'finance_manager', branchId: null, branchName: null },
};
const TOKENS: Record<string, string> = {};

async function call(as: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKENS[as]}` } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  process.env['JWT_SECRET'] = 'production-orders-detail-test-secret-that-is-long-enough';

  db = new PGlite();
  await db.exec('create schema app');
  await db.exec(STUBS);
  await db.exec(`begin;${read('20261009000149_custom_auth.sql')}commit;`);

  await db.query(`insert into branches (id, name) values ($1, 'DHA Branch'), ($2, 'Gulshan Branch')`, [BRANCH_A, BRANCH_B]);
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
  const { router } = await import('../production-orders.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/production-orders', router);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('GET /api/production-orders/:id', () => {
  test('returns the complete demand, with its items, for the owning branch', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into production_orders (demand_number, branch_id, branch_name, created_by, created_by_name)
       values ('DMD-000001', $1, 'DHA Branch', $2, 'a@mb.test') returning id`,
      [BRANCH_A, ACTORS['branch-a']!.id],
    );
    const id = rows[0]!.id;
    await db.query(
      `insert into production_order_items (production_order_id, product_id, product_name, qty, approved_qty, line_no)
       values ($1, gen_random_uuid(), 'Chicken Patty', 10, 8, 1)`,
      [id],
    );

    const res = await call('branch-a', `/api/production-orders/${id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.order.demandNumber, 'DMD-000001');
    assert.equal(res.body.order.branchId, BRANCH_A);
    assert.equal(res.body.order.items.length, 1);
    assert.equal(res.body.order.items[0].productName, 'Chicken Patty');
    assert.equal(res.body.order.items[0].approvedQty, 8);
  });

  test('a different branch cannot open another branch’s demand', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into production_orders (demand_number, branch_id) values ('DMD-000002', $1) returning id`,
      [BRANCH_A],
    );
    const res = await call('branch-b', `/api/production-orders/${rows[0]!.id}`);
    assert.equal(res.status, 403);
  });

  test('Finance may open any branch’s demand', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into production_orders (demand_number, branch_id) values ('DMD-000003', $1) returning id`,
      [BRANCH_A],
    );
    const res = await call('finance', `/api/production-orders/${rows[0]!.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.order.demandNumber, 'DMD-000003');
  });

  test('an unknown id is a 404, not a 500', async () => {
    const res = await call('finance', `/api/production-orders/00000000-0000-4000-8000-0000000000ff`);
    assert.equal(res.status, 404);
  });
});
