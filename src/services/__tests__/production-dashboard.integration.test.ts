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
import {
  getBranchSummary,
  getCurrentStock,
  getPreparedTotals,
  getReceivedDemand,
  getRepairedStock,
  getReturnStock,
} from '../production-dashboard.service';

/**
 * The Production Dashboard sections' SQL, run for real in pglite over stub
 * tables: each period's window and the one before it, branch scope, idle
 * branches, empty periods — then the routes, so validation and roles are the
 * real middleware's.
 *
 * Every figure asserted below is worked out by hand from the rows seeded in
 * `before`. "Today" is Wednesday 14 Oct 2026, so:
 *   today   14 Oct            beside 13 Oct
 *   week    12..14 Oct (Mon)  beside 5..7 Oct
 *   month   1..14 Oct         beside 1..14 Sep
 */

const HISTORY = join(__dirname, '../../../db/history/migrations');
const PRISMA_MIGRATIONS = join(__dirname, '../../../prisma/migrations');
const read = (file: string) => readFileSync(file, 'utf8');

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

  create table products (
    id uuid primary key default gen_random_uuid(), name text not null,
    is_active boolean not null default true, is_special boolean not null default false);

  create type branch_production_order_status as enum ('pending', 'approved', 'rejected', 'awaiting_verification', 'verified', 'cancelled');
  create table production_orders (
    id uuid primary key default gen_random_uuid(),
    branch_id uuid not null references branches (id), branch_name text,
    business_date date not null,
    status branch_production_order_status not null default 'pending',
    submitted_at timestamptz not null default now());
  create table production_order_items (
    id uuid primary key default gen_random_uuid(),
    production_order_id uuid not null references production_orders (id),
    product_id uuid, product_name text not null,
    qty numeric(14,3) not null, approved_qty numeric(14,3));

  create type production_return_status as enum ('pending', 'accepted', 'rejected', 'returned');
  -- As the database has it before this change; the migration under test adds 'repaired'.
  create type production_return_disposition as enum ('saleable', 'damaged', 'expired');
  create table production_returns (
    id uuid primary key default gen_random_uuid(),
    branch_id uuid not null references branches (id), branch_name text,
    product_id uuid references products (id), product_name text not null,
    qty numeric(14,3) not null check (qty > 0), reason text,
    status production_return_status not null default 'pending',
    disposition production_return_disposition not null default 'saleable',
    business_date date not null,
    created_at timestamptz not null default now());

  create type return_stock_movement_type as enum ('return_in', 'transfer_out');
  create table return_stock (product_id uuid primary key, product_name text, balance numeric(14,3) not null default 0);
  create table return_stock_history (
    id uuid primary key default gen_random_uuid(), product_id uuid not null, product_name text not null,
    type return_stock_movement_type not null, delta numeric(14,3) not null,
    business_date date not null, branch_id uuid);

  create table stock (
    id uuid primary key default gen_random_uuid(), branch_id uuid not null, product_id uuid not null, balance numeric(14,3) not null default 0);
  create table production_stock (product_id uuid primary key, balance numeric(14,3) not null default 0);
  create table production_stock_history (
    id uuid primary key default gen_random_uuid(), product_id uuid, type text not null,
    delta numeric(14,3) not null, business_date date not null);

  -- Migration 90, verbatim from the baseline.
  create function public.production_stock_availability()
  returns table(product_id uuid, balance numeric, reserved numeric, available numeric)
  language sql stable as $$
    with reserved as (
      select i.product_id,
             sum(case when o.status = 'pending' then i.qty else coalesce(i.approved_qty, i.qty) end) as qty
        from public.production_order_items i
        join public.production_orders o on o.id = i.production_order_id
       where o.status in ('pending', 'awaiting_verification')
         and i.product_id is not null
       group by i.product_id
    )
    select p.id, coalesce(s.balance, 0), coalesce(r.qty, 0), coalesce(s.balance, 0) - coalesce(r.qty, 0)
      from public.products p
      left join public.production_stock s on s.product_id = p.id
      left join reserved r on r.product_id = p.id;
  $$;
`;

const DHA = '00000000-0000-4000-8000-00000000000a';
const GULSHAN = '00000000-0000-4000-8000-00000000000b';
const BAHRIA = '00000000-0000-4000-8000-00000000000c'; // active, never orders anything
const CLOSED = '00000000-0000-4000-8000-00000000000d'; // inactive
const BUN = '20000000-0000-4000-8000-000000000001';
const RUSK = '20000000-0000-4000-8000-000000000002';
const CAKE = '20000000-0000-4000-8000-000000000003';
const DONUT = '20000000-0000-4000-8000-000000000004';
const SPECIAL = '20000000-0000-4000-8000-000000000005';

const TODAY = '2026-10-14';

let db: PGlite;
let server: Server;
let base: string;

const ACTORS = {
  production: { id: '10000000-0000-4000-8000-000000000001', email: 'prod@mb.test', role: 'production_user', branchId: null },
  branch: { id: '10000000-0000-4000-8000-000000000002', email: 'a@mb.test', role: 'branch_manager', branchId: DHA },
} as const;
const TOKENS: Record<string, string> = {};

async function call(as: keyof typeof ACTORS, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKENS[as]}` } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

/** One order, its lines given as [product, qty, approvedQty]. */
async function order(branchId: string, date: string, status: string, submittedAt: string, lines: [string, number, number | null][]) {
  const { rows } = await db.query<{ id: string }>(
    `insert into production_orders (branch_id, business_date, status, submitted_at) values ($1, $2, $3, $4) returning id`,
    [branchId, date, status, submittedAt],
  );
  for (const [productId, qty, approved] of lines) {
    await db.query(
      `insert into production_order_items (production_order_id, product_id, product_name, qty, approved_qty)
       values ($1, $2, (select name from products where id = $2), $3, $4)`,
      [rows[0]!.id, productId, qty, approved],
    );
  }
}

async function returned(branchId: string, productId: string, qty: number, status: string, disposition: string, reason: string | null, date: string) {
  await db.query(
    `insert into production_returns (branch_id, product_id, product_name, qty, status, disposition, reason, business_date, created_at)
     values ($1, $2, (select name from products where id = $2), $3, $4, $5::production_return_disposition, $6, $7, ($7::date + time '11:00') at time zone 'Asia/Karachi')`,
    [branchId, productId, qty, status, disposition, reason, date],
  );
}

before(async () => {
  process.env['JWT_SECRET'] = 'production-dashboard-test-secret-that-is-long-enough';

  db = new PGlite();
  await db.exec('create schema app');
  await db.exec(STUBS);
  await db.exec(`begin;${read(join(HISTORY, '20261009000149_custom_auth.sql'))}commit;`);
  // The migration under test, applied the way `prisma migrate deploy` applies it.
  await db.exec(`begin;${read(join(PRISMA_MIGRATIONS, '20261018000001_return_disposition_repaired/migration.sql'))}commit;`);

  await db.query(
    `insert into branches (id, name, is_active) values ($1, 'DHA', true), ($2, 'Gulshan', true), ($3, 'Bahria', true), ($4, 'Closed', false)`,
    [DHA, GULSHAN, BAHRIA, CLOSED],
  );
  await db.query(
    `insert into products (id, name, is_special) values ($1, 'Bun', false), ($2, 'Rusk', false), ($3, 'Cake', false), ($4, 'Donut', false), ($5, 'Special Cake', true)`,
    [BUN, RUSK, CAKE, DONUT, SPECIAL],
  );

  // ── Orders ──
  // This week (Mon 12 .. Wed 14)
  await order(DHA, '2026-10-12', 'approved', '2026-10-12T09:15:00+05:00', [[BUN, 10, 8], [RUSK, 5, 5]]);
  await order(DHA, TODAY, 'awaiting_verification', '2026-10-14T10:30:00+05:00', [[BUN, 6, 6]]);
  await order(GULSHAN, '2026-10-13', 'rejected', '2026-10-13T08:00:00+05:00', [[RUSK, 4, null]]);
  // Submitted at 01:20 on the 15th, before the 02:00 rollover: still the 14th's business.
  await order(GULSHAN, TODAY, 'pending', '2026-10-15T01:20:00+05:00', [[BUN, 3, null]]);
  await order(GULSHAN, TODAY, 'cancelled', '2026-10-14T12:00:00+05:00', [[BUN, 100, null]]); // never counted
  // Outside the week
  await order(DHA, '2026-10-11', 'approved', '2026-10-11T09:00:00+05:00', [[BUN, 50, 50]]); //   last Sunday: month only
  await order(DHA, '2026-10-06', 'approved', '2026-10-06T09:00:00+05:00', [[BUN, 20, 20]]); //   last Tuesday: the previous week
  await order(GULSHAN, '2026-10-15', 'pending', '2026-10-15T09:00:00+05:00', [[BUN, 7, null]]); // tomorrow
  await order(GULSHAN, '2026-09-10', 'verified', '2026-09-10T09:00:00+05:00', [[RUSK, 9, 9]]); // the previous month

  // ── Returns ──
  await returned(DHA, BUN, 2, 'accepted', 'saleable', 'Expired', '2026-10-13');
  await returned(DHA, RUSK, 3, 'accepted', 'repaired', 'damaged box', TODAY);
  await returned(GULSHAN, BUN, 1, 'accepted', 'damaged', 'broken', TODAY);
  await returned(GULSHAN, BUN, 4, 'pending', 'saleable', 'Exp', TODAY); //   not accepted: never counted
  await returned(DHA, BUN, 5, 'accepted', 'saleable', null, '2026-10-06'); // the previous week

  await db.query(`insert into return_stock (product_id, product_name, balance) values ($1, 'Bun', 7), ($2, 'Rusk', 3)`, [BUN, RUSK]);
  await db.query(
    `insert into return_stock_history (product_id, product_name, type, delta, business_date, branch_id) values
       ($1, 'Rusk', 'transfer_out', -2, $2, null),
       ($1, 'Rusk', 'return_in', 3, $2, $3)`,
    [RUSK, TODAY, DHA],
  );

  // ── Stock ──
  await db.query(
    `insert into stock (branch_id, product_id, balance) values ($1, $3, 4), ($1, $4, 10), ($2, $3, 1)`,
    [DHA, GULSHAN, BUN, RUSK],
  );
  await db.query(`insert into production_stock (product_id, balance) values ($1, 20), ($2, 0), ($3, 2)`, [BUN, RUSK, CAKE]);
  await db.query(
    `insert into production_stock_history (product_id, type, delta, business_date) values
       ($1, 'prepare', 30, $2), ($1, 'prepare', 50, '2026-10-12'), ($1, 'prepare', 100, '2026-10-02'),
       ($1, 'prepare', 999, '2026-09-30'), ($1, 'adjust', 7, $2), ($1, 'dispatch', -12, $2)`,
    [BUN, TODAY],
  );

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);

  for (const [name, a] of Object.entries(ACTORS)) {
    await db.query(`insert into users (id, email, role, branch_id) values ($1, $2, $3, $4)`, [a.id, a.email, a.role, a.branchId]);
    const session = await prisma.auth_sessions.create({
      data: { user_id: a.id, client: 'web', expires_at: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    TOKENS[name] = signAccessToken(a.id, session.id).token;
  }

  const express = (await import('express')).default;
  const { router: production } = await import('../../routes/production.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/production', production);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('Received Demand', () => {
  test('this week: Monday to today, against the same days of last week', async () => {
    const s = await getReceivedDemand({ period: 'week', today: TODAY, branchId: null });
    assert.deepEqual(s.kpis, { units: 28, orders: 4, avgUnits: 7, pendingVerification: 1, rejected: 1 });
    assert.deepEqual(s.previous, { units: 20, orders: 1, avgUnits: 20, pendingVerification: 0, rejected: 0 });
    assert.deepEqual(s.comparePrevious.units, { value: 40, unit: '%' });
    assert.deepEqual(s.series.map((p) => [p.bucket, p.units]), [['2026-10-12', 15], ['2026-10-13', 4], [TODAY, 9]]);
    assert.deepEqual(s.series[2]!.byStatus.awaiting_verification, { units: 6, orders: 1 });
    assert.deepEqual(s.series[2]!.byStatus.pending, { units: 3, orders: 1 });
    assert.deepEqual(s.breakdown.topProducts.map((p) => [p.productName, p.units]), [['Bun', 19], ['Rusk', 9]]);
  });

  test('this month by week; last Sunday counts, tomorrow and cancelled orders never do', async () => {
    const s = await getReceivedDemand({ period: 'month', today: TODAY, branchId: null });
    assert.equal(s.bucket, 'week');
    assert.equal(s.kpis.units, 98);
    assert.equal(s.kpis.orders, 6);
    assert.equal(s.previous.units, 9);
    assert.deepEqual(s.series.map((p) => [p.bucket, p.units]), [['2026-09-28', 0], ['2026-10-05', 70], ['2026-10-12', 28]]);
  });

  test('today by Karachi hour; an order after midnight stays on its business day', async () => {
    const s = await getReceivedDemand({ period: 'today', today: TODAY, branchId: null });
    assert.equal(s.kpis.units, 9);
    assert.equal(s.previous.units, 4);
    assert.equal(s.series[0]!.bucket, '2026-10-14T10');
    assert.equal(s.series.at(-1)!.bucket, '2026-10-15T01');
    assert.equal(s.series.length, 16);
  });

  test('one branch sees only its own orders', async () => {
    const s = await getReceivedDemand({ period: 'week', today: TODAY, branchId: DHA });
    assert.equal(s.kpis.units, 21);
    assert.equal(s.kpis.orders, 2);
    assert.equal(s.kpis.rejected, 0);
    assert.equal(s.previous.units, 20);
  });

  test('a period with nothing in it', async () => {
    const s = await getReceivedDemand({ period: 'week', today: '2026-06-03', branchId: null });
    assert.deepEqual(s.kpis, { units: 0, orders: 0, avgUnits: null, pendingVerification: 0, rejected: 0 });
    assert.equal(s.comparePrevious.units, null);
    assert.equal(s.series.length, 3);
    assert.deepEqual(s.breakdown.topProducts, []);
  });
});

describe('Branch-wise', () => {
  test('every active branch, idle ones included, inactive ones not', async () => {
    const s = await getBranchSummary({ period: 'week', today: TODAY });
    assert.deepEqual(s.series.map((b) => b.branchName), ['DHA', 'Gulshan', 'Bahria']);
    const dha = s.series[0]!;
    // Delivered is approved_qty on verified/approved orders only: the order still
    // awaiting verification has not reached the branch yet.
    assert.deepEqual([dha.demanded, dha.delivered, dha.returned, dha.fulfilment], [21, 13, 5, 61.9]);
    assert.deepEqual(dha.spark, [15, 0, 6]);
    assert.equal(dha.lastSubmittedAt, new Date('2026-10-14T10:30:00+05:00').toISOString());
    const bahria = s.series[2]!;
    assert.deepEqual([bahria.demanded, bahria.fulfilment, bahria.lastSubmittedAt], [0, null, null]);
    assert.deepEqual(s.kpis, { activeBranches: 3, branchesWithDemand: 2, demanded: 28, delivered: 13, fulfilment: 46.4 });
    assert.deepEqual(s.comparePrevious.fulfilment, { value: -53.6, unit: 'pts' }); // last week 20 of 20
  });

  test('Gulshan\'s latest submission is the pending one, not the cancelled one', async () => {
    const s = await getBranchSummary({ period: 'today', today: TODAY });
    const g = s.series.find((b) => b.branchId === GULSHAN)!;
    assert.equal(g.lastSubmittedAt, new Date('2026-10-15T09:00:00+05:00').toISOString(), 'tomorrow\'s order is still its latest');
    assert.equal(g.demanded, 3);
  });
});

describe('Repaired Stock', () => {
  test('repaired ÷ returned; back to stock is every transfer out of Return Stock', async () => {
    const s = await getRepairedStock({ period: 'week', today: TODAY, branchId: null });
    assert.deepEqual(s.kpis, { repaired: 3, repairRate: 50, backToStock: 2 });
    assert.deepEqual(s.previous, { repaired: 0, repairRate: 0, backToStock: 0 });
    assert.deepEqual(s.breakdown.topProducts, [{ productId: RUSK, productName: 'Rusk', units: 3 }]);
    assert.deepEqual(s.series.map((p) => [p.bucket, p.repaired, p.returned]), [['2026-10-12', 0, 0], ['2026-10-13', 0, 2], [TODAY, 3, 4]]);
  });

  test('a branch filter scopes the returns; transfers stay company-wide', async () => {
    const s = await getRepairedStock({ period: 'week', today: TODAY, branchId: GULSHAN });
    assert.deepEqual(s.kpis, { repaired: 0, repairRate: 0, backToStock: 2 });
    assert.equal(s.breakdown.topProduct, null);
  });
});

describe('Return Stock', () => {
  test('returned, rate against delivered, reasons, branch × product', async () => {
    const s = await getReturnStock({ period: 'week', today: TODAY, branchId: null });
    assert.deepEqual(s.kpis, { returned: 6, returnRate: 46.2, onHand: 10 });
    assert.deepEqual(s.previous, { returned: 5, returnRate: 25, onHand: 10 });
    assert.deepEqual(s.comparePrevious.returned, { value: 20, unit: '%' });
    assert.deepEqual(s.comparePrevious.returnRate, { value: 21.2, unit: 'pts' });
    assert.deepEqual(s.breakdown.topBranch, { branchId: DHA, branchName: 'DHA', units: 5 });
    // Bun and Rusk tie on 3; the name breaks it, so the answer does not flicker.
    assert.deepEqual(s.breakdown.topProduct, { productId: BUN, productName: 'Bun', units: 3 });
    assert.deepEqual(s.breakdown.byReason.map((r) => [r.reason, r.units]), [
      ['expired', 2], ['damaged', 4], ['unsold', 0], ['other', 0], ['none', 0],
    ]);
    assert.deepEqual(s.breakdown.heat.products.map((p) => p.productName), ['Bun', 'Rusk']);
    assert.deepEqual(s.breakdown.heat.rows.map((r) => [r.branchName, r.values]), [['DHA', [2, 3]], ['Gulshan', [1, 0]], ['Bahria', [0, 0]]]);
    assert.deepEqual(s.series.map((p) => p.returned), [0, 2, 4]);
  });

  test('one branch', async () => {
    const s = await getReturnStock({ period: 'week', today: TODAY, branchId: GULSHAN });
    assert.equal(s.kpis.returned, 1);
    assert.equal(s.kpis.returnRate, null, 'nothing delivered to Gulshan this week');
    assert.deepEqual(s.breakdown.heat.rows.map((r) => r.branchName), ['Gulshan']);
  });

  test('a week with no returns', async () => {
    const s = await getReturnStock({ period: 'week', today: '2026-06-03', branchId: null });
    assert.equal(s.kpis.returned, 0);
    assert.equal(s.breakdown.topBranch, null);
    assert.equal(s.breakdown.heat.rows.length, 3);
    assert.deepEqual(s.breakdown.heat.products, []);
  });
});

describe('Current Stock', () => {
  test('available pool stock plus branch shelves, per product; specials left out', async () => {
    const s = await getCurrentStock({ branchId: null });
    // Bun: pool 20 less 16 promised (6 awaiting verification, 3 + 7 pending) = 4.
    assert.deepEqual(s.series.map((r) => [r.productName, r.production, r.branch, r.state]), [
      ['Rusk', 0, 10, 'ok'], ['Bun', 4, 5, 'ok'], ['Cake', 2, 0, 'low'], ['Donut', 0, 0, 'out'],
    ]);
    assert.deepEqual(s.kpis, { production: 6, branch: 15, inStock: 3, low: 1, out: 1 });
  });

  test('one branch\'s shelf beside the central pool', async () => {
    const s = await getCurrentStock({ branchId: GULSHAN });
    assert.deepEqual(s.series.map((r) => [r.productName, r.branch]), [['Bun', 1], ['Cake', 0], ['Donut', 0], ['Rusk', 0]]);
    assert.equal(s.kpis.branch, 1);
  });
});

describe('Prepared totals (the strip under the KPI cards)', () => {
  test('today, Monday..today and the 1st..today, from prepare movements only', async () => {
    assert.deepEqual(await getPreparedTotals({ today: TODAY, weekStart: '2026-10-12', monthStart: '2026-10-01' }), { today: 30, week: 80, month: 180 });
  });

  test('a week that began last month still counts from its Monday', async () => {
    assert.deepEqual(await getPreparedTotals({ today: '2026-10-02', weekStart: '2026-09-28', monthStart: '2026-10-01' }), { today: 100, week: 1099, month: 100 });
  });
});

describe('routes', () => {
  test('each section answers Production with the one shape', async () => {
    for (const path of ['received-demand', 'branch-summary', 'repaired-stock', 'return-stock']) {
      const r = await call('production', `/api/production/dashboard/${path}?period=month`);
      assert.equal(r.status, 200, path);
      for (const k of ['kpis', 'previous', 'comparePrevious', 'series', 'breakdown', 'window']) assert.ok(k in r.body, `${path}.${k}`);
      assert.equal(r.body.window.period, 'month');
    }
    const cs = await call('production', `/api/production/dashboard/current-stock?branchId=${DHA}`);
    assert.equal(cs.status, 200);
    assert.equal(cs.body.branchId, DHA);
  });

  test('the period defaults to this week', async () => {
    const r = await call('production', '/api/production/dashboard/received-demand');
    assert.equal(r.body.window.period, 'week');
  });

  test('a bad period or branch id is a 400, not a silent fallback', async () => {
    assert.equal((await call('production', '/api/production/dashboard/return-stock?period=year')).status, 400);
    assert.equal((await call('production', '/api/production/dashboard/return-stock?branchId=dha')).status, 400);
  });

  test('a branch user cannot reach the Production Dashboard at all', async () => {
    const r = await call('branch', '/api/production/dashboard/received-demand');
    assert.equal(r.status, 403);
  });
});
