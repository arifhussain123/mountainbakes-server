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
 * DELETE /api/support/:id/demand against the REAL route and migration 82's
 * `delete_production_order`, in pglite.
 *
 * The regression: a demand with a branch discount against it is held by
 * `branch_discounts.production_order_id ... on delete restrict` (migration 93).
 * The RPC's foreign-key error reached the error handler with no status and was
 * masked in production as "Internal server error". It must be a 409 that says
 * why, and must leave the demand, its stock and the query untouched.
 */

const MIGRATIONS = join(__dirname, '../../../db/history/migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
  create type branch_production_order_status as enum
    ('pending', 'awaiting_verification', 'verified', 'approved', 'rejected', 'cancelled');
  create type stock_movement_type as enum ('sale', 'production', 'return', 'adjustment');
  create type production_stock_movement_type as enum ('prepare', 'transfer_out', 'return_in', 'sale', 'adjustment');
  create table production_orders (
    id uuid primary key default gen_random_uuid(), demand_number text, branch_id uuid, branch_name text,
    status branch_production_order_status not null default 'pending', business_date date);
  create table production_order_items (
    id uuid primary key default gen_random_uuid(),
    production_order_id uuid not null references production_orders (id) on delete cascade, line_no integer);
  create table production_order_packing_items (
    id uuid primary key default gen_random_uuid(),
    production_order_id uuid not null references production_orders (id) on delete cascade, line_no integer);
  create table stock_history (
    id uuid primary key default gen_random_uuid(), branch_id uuid, product_id uuid, product_name text,
    delta numeric, ref_id text);
  create table production_stock_history (
    id uuid primary key default gen_random_uuid(), product_id uuid, product_name text, delta numeric, ref_id text);
  create function public.apply_stock_movement(
    p_branch uuid, p_product uuid, p_name text, p_delta numeric, p_type stock_movement_type, p_ref text, p_date date)
    returns void language sql as $$ select $$;
  create function public.apply_production_stock_movement(
    p_product uuid, p_name text, p_delta numeric, p_type production_stock_movement_type, p_ref text, p_date date)
    returns void language sql as $$ select $$;
  create table audit_logs (
    id uuid primary key default gen_random_uuid(), action text, admin_id uuid, admin_name text, details jsonb);
  create table branch_discounts (
    id uuid primary key default gen_random_uuid(),
    production_order_id uuid not null references production_orders (id) on delete restrict,
    status text not null default 'pending');
  create table support_tickets (
    id uuid primary key default gen_random_uuid(), reference_type text, reference_id text,
    reference_snapshot jsonb, status text not null default 'open', resolution_note text,
    resolved_by uuid, resolved_by_name text, resolved_at timestamptz, raised_by uuid,
    branch_id uuid, archived_at timestamptz);
  create table notifications (
    id uuid primary key default gen_random_uuid(), type text, title text, message text,
    target_user_id uuid, target_role text, branch_id uuid, related_id uuid);
`;

/** `delete_production_order` exactly as migration 82 defines it. */
function deleteFunctionFromMigration82(): string {
  const sql = read('20260816000082_delete_production_order.sql');
  const start = sql.indexOf('create or replace function public.delete_production_order(');
  const end = sql.indexOf('$$;', start) + 3;
  assert.ok(start > 0 && end > start, 'delete_production_order not found in migration 82');
  return sql.slice(start, end);
}

let db: PGlite;
let server: Server;
let base: string;
let token = '';
const ADMIN = '10000000-0000-4000-8000-000000000004';

async function del(ticketId: string, demandNumber: string) {
  const res = await fetch(`${base}/api/support/${ticketId}/demand`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Raised in error', confirmDemandNumber: demandNumber, note: '' }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

/** A demand plus the support query raised against it. */
async function demandWithQuery(demandNumber: string) {
  const { rows: [order] } = await db.query<{ id: string }>(
    `insert into production_orders (demand_number, status, business_date) values ($1, 'verified', '2026-10-20') returning id`,
    [demandNumber],
  );
  await db.query(`insert into production_order_items (production_order_id, line_no) values ($1, 1)`, [order!.id]);
  const { rows: [ticket] } = await db.query<{ id: string }>(
    `insert into support_tickets (reference_type, reference_id, reference_snapshot)
     values ('demand', $1, $2) returning id`,
    [demandNumber, JSON.stringify({ entityId: order!.id })],
  );
  return { orderId: order!.id, ticketId: ticket!.id };
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string | number }>(sql, params)).rows[0]!.n);

before(async () => {
  process.env['JWT_SECRET'] = 'support-delete-demand-test-secret-long-enough';

  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(deleteFunctionFromMigration82());
  await db.exec(`begin;${read('20261009000149_custom_auth.sql')}commit;`);
  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);

  await db.query(`insert into users (id, email, role) values ($1, 'admin@mb.test', 'super_admin')`, [ADMIN]);
  const session = await prisma.auth_sessions.create({
    data: { user_id: ADMIN, client: 'web', expires_at: new Date(Date.now() + 3_600_000) },
    select: { id: true },
  });
  token = signAccessToken(ADMIN, session.id).token;

  const express = (await import('express')).default;
  const { router } = await import('../../routes/support.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/support', router);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('DELETE /api/support/:id/demand', () => {
  test('a demand with no discount is deleted and the query resolved', async () => {
    const { orderId, ticketId } = await demandWithQuery('DMD-000101');
    const res = await del(ticketId, 'DMD-000101');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deleted, true);
    assert.equal(await count(`select count(*) as n from production_orders where id = $1`, [orderId]), 0);
    assert.equal(res.body.ticket.status, 'resolved');
  });

  test('a demand with an open discount is refused with a 409 that says why, and nothing changes', async () => {
    const { orderId, ticketId } = await demandWithQuery('DMD-000102');
    await db.query(`insert into branch_discounts (production_order_id, status) values ($1, 'pending')`, [orderId]);

    const res = await del(ticketId, 'DMD-000102');
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.notEqual(res.body.error, 'Internal server error');
    assert.match(res.body.error, /DMD-000102 cannot be deleted: it has 1 open discount claim/);
    assert.match(res.body.error, /withdraw the discount first/);

    assert.equal(await count(`select count(*) as n from production_orders where id = $1`, [orderId]), 1);
    assert.equal(await count(`select count(*) as n from audit_logs`), 1, 'only the first test\'s delete is audited');
    assert.equal(await count(`select count(*) as n from support_tickets where id = $1 and status = 'open'`, [ticketId]), 1);
  });

  test('a decided discount keeps its demand on the record', async () => {
    const { orderId, ticketId } = await demandWithQuery('DMD-000103');
    await db.query(`insert into branch_discounts (production_order_id, status) values ($1, 'approved')`, [orderId]);

    const res = await del(ticketId, 'DMD-000103');
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error, /1 approved\/rejected discount claim/);
    assert.match(res.body.error, /A decided discount keeps its demand on the record/);
  });
});
