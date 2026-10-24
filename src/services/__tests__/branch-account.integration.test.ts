import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';

/**
 * The Demand Record end to end: the REAL baseline tables for every record it
 * reads, the migration under test applied the way `prisma migrate deploy`
 * applies it, and the real routes behind real access tokens.
 *
 * One branch (Alpha) is set up with every kind of record in and out of the
 * record, and the money worked out by hand below; Beta checks a `verified`
 * demand and a branch's own share %.
 *
 *   Alpha, go-live 2026-09-01, Bun Rs. 100 until a change to Rs. 120 on 09-10.
 *   Opening row   Finance opening +1,000, deposit T4 −200            → 800
 *   D1 09-02 80%  1,000 − return 100 − discount 50 = 850 → share 680,
 *                 deposit T1 −500                        800+680−500 → 980
 *   D2 09-12 70%  600 (no line price: 5 × 120 on 09-12) − discount 30
 *                 = 570 → share 399                          980+399 → 1,379
 */

const PRISMA = join(__dirname, '../../../prisma/migrations');
const BASELINE = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
const MIGRATION = readFileSync(join(PRISMA, '20261024000001_branch_account_ledger/migration.sql'), 'utf8');
const AUTH = readFileSync(join(__dirname, '../../../db/history/migrations/20261009000149_custom_auth.sql'), 'utf8');

function lift(head: string, tail: string): string {
  const start = BASELINE.indexOf(head);
  assert.ok(start >= 0, `not in the baseline: ${head}`);
  const end = BASELINE.indexOf(tail, start);
  assert.ok(end > start, `no end found for: ${head}`);
  return `${BASELINE.slice(start, end + tail.length)}\n`;
}
const type = (name: string) => lift(`CREATE TYPE public.${name} AS ENUM (`, ');');
const table = (name: string) => lift(`CREATE TABLE public.${name} (`, '\n);');

const TYPES = [
  'price_change_source', 'price_change_status', 'branch_production_order_status', 'production_return_disposition',
  'production_return_status', 'branch_discount_status', 'cash_transfer_status', 'order_status', 'payment_method',
];
const TABLES = [
  'branches', 'products', 'product_price_history', 'production_orders', 'production_order_items',
  'production_returns', 'branch_discounts', 'cash_transfers', 'orders', 'finance_settings', 'finance_audit_logs',
];

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create function public.next_demand_number() returns text language sql as $$ select 'DMD-' || substr(md5(random()::text), 1, 6) $$;
  create function public.next_stock_number() returns text language sql as $$ select 'SKU-' || substr(md5(random()::text), 1, 6) $$;
  create function public.next_price_number() returns text language sql as $$ select 'PRC-' || substr(md5(random()::text), 1, 6) $$;
  create function app.next_finance_number(p_key text, p_prefix text) returns text language sql as $$ select p_prefix || '-' || substr(md5(random()::text), 1, 6) $$;
  create table counters (id text primary key, count bigint not null);
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table business_day_closures (business_date date primary key, status text not null);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
`;

let db: PGlite;
let server: Server;
let base: string;

const ACTORS = {
  admin: { id: '30000000-0000-4000-8000-000000000001', email: 'fadmin@mb.test', role: 'finance_admin' },
  accountant: { id: '30000000-0000-4000-8000-000000000002', email: 'accountant@mb.test', role: 'accountant' },
  branch: { id: '30000000-0000-4000-8000-000000000003', email: 'branch@mb.test', role: 'branch_manager' },
  production: { id: '30000000-0000-4000-8000-000000000004', email: 'prod@mb.test', role: 'production_user' },
  owner: { id: '30000000-0000-4000-8000-000000000005', email: 'owner@mb.test', role: 'super_admin' },
} as const;
type ActorName = keyof typeof ACTORS;
const TOKENS: Partial<Record<ActorName, string>> = {};

const ALPHA = '40000000-0000-4000-8000-00000000000a';
const BETA = '40000000-0000-4000-8000-00000000000b';
const BUN = '50000000-0000-4000-8000-000000000001';
const ORD = {
  d0: '60000000-0000-4000-8000-000000000000', // 08-31, before go-live
  d1: '60000000-0000-4000-8000-000000000001',
  d2: '60000000-0000-4000-8000-000000000002',
  d3: '60000000-0000-4000-8000-000000000003', // pending — never delivered
  d4: '60000000-0000-4000-8000-000000000004', // rejected
  b1: '60000000-0000-4000-8000-0000000000b1', // Beta, verified
};
const API = '/api/finance/branch-account';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(as: ActorName | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { Authorization: `Bearer ${TOKENS[as]}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const ok = (r: { status: number; body: Json }, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

async function order(id: string, branch: string, businessDate: string, submittedAt: string, demand: string,
  lines: { qty: number; approved: number; unitPrice: number | null }[]) {
  await db.query(
    `insert into production_orders (id, branch_id, branch_name, business_date, submitted_at, demand_number, status)
     values ($1, $2, (select name from branches where id = $2), $3, $4, $5, 'pending')`,
    [id, branch, businessDate, submittedAt, demand]);
  let n = 0;
  for (const l of lines) {
    await db.query(
      `insert into production_order_items (production_order_id, product_id, product_name, qty, approved_qty, unit_price, line_no)
       values ($1, $2, 'Bun', $3, $4, $5, $6)`, [id, BUN, l.qty, l.approved, l.unitPrice, ++n]);
  }
}
const setStatus = (id: string, status: string) =>
  db.query(`update production_orders set status = $2::branch_production_order_status where id = $1`, [id, status]);
const setGlobalPct = (pct: number) =>
  db.query(`update finance_settings set company_share_pct = $1::numeric, branch_share_pct = 100 - $1::numeric`, [pct]);

async function returnRow(branch: string, status: string, businessDate: string, createdAt: string, qty: number) {
  await db.query(
    `insert into production_returns (branch_id, branch_name, product_id, product_name, qty, status, business_date, created_at)
     values ($1, 'x', $2, 'Bun', $3, $4::production_return_status, $5, $6)`, [branch, BUN, qty, status, businessDate, createdAt]);
}
async function discount(branch: string, orderId: string, amount: number, status: string, createdAt: string) {
  await db.query(
    `insert into branch_discounts (branch_id, production_order_id, amount, reason, status, business_date, created_at)
     values ($1, $2, $3, 'test', $4::branch_discount_status, $5::timestamptz::date, $5)`, [branch, orderId, amount, status, createdAt]);
}
async function transfer(branch: string, amount: number, status: 'approved' | 'pending', createdAt: string, deleted = false) {
  await db.query(
    `insert into cash_transfers (branch_id, branch_name, amount, cash_amount, business_date, created_at, status,
                                 ledger_entry_id, approved_at, deleted_at)
     values ($1, 'x', $2, $2, $3::timestamptz::date, $3, $4::cash_transfer_status,
             case when $4 = 'approved' then gen_random_uuid() end, case when $4 = 'approved' then $3::timestamptz end,
             case when $5 then now() end)`, [branch, amount, createdAt, status, deleted]);
}
async function sale(branch: string, amount: number, method: string, status: string, createdAt: string) {
  await db.query(
    `insert into orders (order_number, branch_id, subtotal, grand_total, payment_method, status, business_date, created_at)
     values (substr(md5(random()::text), 1, 8), $1, $2, $2, $3::payment_method, $4::order_status, $5::timestamptz::date, $5)`,
    [branch, amount, method, status, createdAt]);
}

before(async () => {
  process.env['JWT_SECRET'] = 'branch-account-test-secret-that-is-long-enough';
  db = new PGlite();
  await db.exec(STUBS);
  for (const t of TYPES) await db.exec(type(t));
  for (const t of TABLES) await db.exec(table(t));
  await db.exec(`
    alter table branches add primary key (id);
    alter table products add primary key (id);
    alter table production_orders add primary key (id);
    alter table production_order_items add primary key (id);
    alter table production_returns add primary key (id);
    alter table branch_discounts add primary key (id);
    alter table cash_transfers add primary key (id);
    alter table orders add primary key (id);
    alter table finance_audit_logs add primary key (id);
    -- The Collections export's slip path embeds items in orders, which needs the link.
    alter table production_order_items add foreign key (production_order_id) references production_orders (id);
  `);
  await db.exec(`begin;${AUTH}commit;`);
  await db.exec(`
    insert into finance_settings (company_share_pct, branch_share_pct) values (80, 20);
    insert into branches (id, name, slug) values ('${ALPHA}', 'Alpha', 'alpha');
    insert into branches (id, name, slug, company_share_pct) values ('${BETA}', 'Beta', 'beta', 50);
    insert into products (id, name, price) values ('${BUN}', 'Bun', 120);
    insert into product_price_history (product_id, product_name, old_price, new_price, effective_date, source, status, version_number)
      values ('${BUN}', 'Bun', 100, 120, '2026-09-10', (enum_range(null::price_change_source))[1], 'active', 1);
  `);

  // Delivered BEFORE the migration exists: no trigger, so nothing frozen —
  // the go-live switch has to freeze these.
  await order(ORD.d0, ALPHA, '2026-08-31', '2026-08-31T09:00:00+05', 'DMD-000100', [{ qty: 10, approved: 10, unitPrice: 100 }]);
  await setStatus(ORD.d0, 'approved');
  await order(ORD.d2, ALPHA, '2026-09-12', '2026-09-12T09:00:00+05', 'DMD-000102', [{ qty: 5, approved: 5, unitPrice: null }]);
  await setStatus(ORD.d2, 'approved');

  // The migration under test, in one transaction, as `prisma migrate deploy` runs it.
  await db.exec(`begin;${MIGRATION}commit;`);

  // Delivered after it: the trigger freezes 80% as D1 leaves pending.
  await order(ORD.d1, ALPHA, '2026-09-02', '2026-09-02T09:00:00+05', 'DMD-000101', [{ qty: 12, approved: 10, unitPrice: 100 }]);
  await setStatus(ORD.d1, 'awaiting_verification');
  await setStatus(ORD.d1, 'verified');
  await setStatus(ORD.d1, 'approved');
  await order(ORD.d3, ALPHA, '2026-09-13', '2026-09-13T09:00:00+05', 'DMD-000103', [{ qty: 99, approved: 99, unitPrice: 100 }]);
  await order(ORD.d4, ALPHA, '2026-09-11', '2026-09-11T09:00:00+05', 'DMD-000104', [{ qty: 99, approved: 0, unitPrice: 100 }]);
  await setStatus(ORD.d4, 'rejected');
  await order(ORD.b1, BETA, '2026-09-20', '2026-09-20T09:00:00+05', 'DMD-000201', [{ qty: 10, approved: 10, unitPrice: 100 }]);
  await setStatus(ORD.b1, 'awaiting_verification');
  await setStatus(ORD.b1, 'verified');

  // Admin moves the global % to 70 — D1 keeps its 80; D2 is frozen at go-live.
  await setGlobalPct(70);

  // Alpha's records. Opening window: go-live 09-01 02:00 → D1 09-02 09:00.
  await transfer(ALPHA, 999, 'approved', '2026-09-01T01:00:00+05');       // before go-live: opening balance's business
  await transfer(ALPHA, 200, 'approved', '2026-09-01T03:00:00+05');       // T4 → opening row
  await returnRow(ALPHA, 'accepted', '2026-09-03', '2026-09-03T10:00:00+05', 1); // 100 on 09-03 → D1
  await returnRow(ALPHA, 'pending', '2026-09-04', '2026-09-04T10:00:00+05', 5);  // not accepted → nowhere
  await returnRow(ALPHA, 'rejected', '2026-09-04', '2026-09-04T11:00:00+05', 5); // nowhere
  await transfer(ALPHA, 500, 'approved', '2026-09-05T10:00:00+05');       // T1 → D1
  await transfer(ALPHA, 700, 'approved', '2026-09-05T11:00:00+05', true); // deleted → nowhere
  await transfer(ALPHA, 800, 'pending', '2026-09-05T12:00:00+05');        // not approved → nowhere
  await sale(ALPHA, 900, 'cash', 'delivered', '2026-09-03T12:00:00+05');  // → D1 sales
  await sale(ALPHA, 400, 'staff', 'delivered', '2026-09-03T13:00:00+05'); // staff → nowhere
  await sale(ALPHA, 300, 'cash', 'cancelled', '2026-09-03T14:00:00+05');  // cancelled → nowhere
  await discount(ALPHA, ORD.d1, 50, 'approved', '2026-09-15T10:00:00+05'); // claimed against D1 → D1, though after D2
  await discount(ALPHA, ORD.d0, 30, 'approved', '2026-09-13T10:00:00+05'); // against a pre-go-live demand → by time → D2
  await discount(ALPHA, ORD.d1, 40, 'pending', '2026-09-06T10:00:00+05');  // not approved → nowhere

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);
  for (const [name, a] of Object.entries(ACTORS)) {
    await db.query(`insert into users (id, email, role, branch_id) values ($1, $2, $3, $4)`,
      [a.id, a.email, a.role, a.role === 'branch_manager' ? ALPHA : null]);
    const session = await prisma.auth_sessions.create({
      data: { user_id: a.id, client: 'web', expires_at: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    TOKENS[name as ActorName] = signAccessToken(a.id, session.id).token;
  }

  const express = (await import('express')).default;
  const { router } = await import('../../routes/finance-branch-account.routes');
  const { router: reportsRouter } = await import('../../routes/production-reports.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(API, router);
  app.use('/api/production-reports', reportsRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

const rowsOf = async (query = '') => ok(await call('accountant', 'GET', `${API}?pageSize=500&sortDir=asc${query}`));
const alphaRows = async (query = '') => (await rowsOf(`&branchId=${ALPHA}${query}`)).rows as Json[];

test('nothing is shown until Finance sets the go-live date', async () => {
  const r = await call('accountant', 'GET', API);
  assert.equal(r.status, 409, JSON.stringify(r.body));
});

/** The Collections workbook as a production user downloads it, sheet name → rows (header first). */
async function collectionsWorkbook(query: string): Promise<Map<string, Json[][]>> {
  const res = await fetch(`${base}/api/production-reports/export?report=collections&type=excel${query}`, {
    headers: { Authorization: `Bearer ${TOKENS.production}` },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200, buf.toString());
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const out = new Map<string, Json[][]>();
  for (const ws of wb.worksheets) {
    const rows: Json[][] = [];
    ws.eachRow((r) => rows.push((r.values as Json[]).slice(1)));
    out.set(ws.name, rows);
  }
  return out;
}

test('before go-live the Collections export keeps the slip figures and says so', async () => {
  const wb = await collectionsWorkbook('&from=2026-09-01&to=2026-09-30');
  const main = wb.get('Collections')!;
  assert.equal(main[0]![0], 'Branch');
  assert.ok(main.some((r) => String(r[0]).includes('Demand Record (Finance) is not switched on yet')));
});

test('Test 10 — only finance roles read it; only `configure` switches it on; only `approve` posts', async () => {
  for (const who of ['branch', 'production'] as const) {
    assert.equal((await call(who, 'GET', `${API}/settings`)).status, 403);
  }
  assert.equal((await call(null, 'GET', `${API}/settings`)).status, 401);
  assert.equal((await call('accountant', 'PUT', `${API}/settings`, { startDate: '2026-09-01' })).status, 403);
  assert.equal((await call('owner', 'PUT', `${API}/settings`, { startDate: '2026-09-01' })).status, 403);

  const on = ok(await call('admin', 'PUT', `${API}/settings`, { startDate: '2026-09-01' }));
  // D2 was delivered before the trigger existed; D0 is before go-live; D1 and B1 froze on delivery.
  assert.equal(on.frozen, 1);
  const snap = await db.query<{ id: string; pct: number; source: string }>(
    `select production_order_id::text as id, company_share_pct::float8 as pct, source from production_order_share_snapshots`);
  const byId = new Map(snap.rows.map((r) => [r.id, r]));
  assert.deepEqual(byId.get(ORD.d1), { id: ORD.d1, pct: 80, source: 'delivery' });
  assert.deepEqual(byId.get(ORD.d2), { id: ORD.d2, pct: 70, source: 'go_live' });
  assert.deepEqual(byId.get(ORD.b1), { id: ORD.b1, pct: 50, source: 'delivery' });
  assert.equal(byId.has(ORD.d0), false);

  // Read by the auditor-style accountant and the owner; never by branch or production.
  assert.equal((await call('owner', 'GET', API)).status, 200);
  assert.equal((await call('branch', 'GET', `${API}?branchId=${ALPHA}`)).status, 403);
  assert.equal((await call('branch', 'GET', `${API}/detail?branchId=${ALPHA}&orderId=${ORD.d1}`)).status, 403);
  const post = { requestId: randomUUID(), branchId: ALPHA, kind: 'opening', amount: 1000, reason: 'Agreed opening' };
  assert.equal((await call('accountant', 'POST', `${API}/adjustments`, post)).status, 403);
  assert.equal((await call('branch', 'POST', `${API}/adjustments`, post)).status, 403);
});

test('Test 6 — the same opening submitted twice posts once; a second opening is refused', async () => {
  const body = { requestId: randomUUID(), branchId: ALPHA, kind: 'opening', amount: 1000, reason: 'Agreed opening' };
  const first = ok(await call('admin', 'POST', `${API}/adjustments`, body), 201);
  const again = ok(await call('admin', 'POST', `${API}/adjustments`, body), 200);
  assert.equal(again.replayed, true);
  assert.equal(again.entry.id, first.entry.id);
  assert.equal(first.entry.businessDate, '2026-09-01');
  const other = await call('admin', 'POST', `${API}/adjustments`, { ...body, requestId: randomUUID() });
  assert.equal(other.status, 409, JSON.stringify(other.body));
  const count = await db.query<{ n: number }>(`select count(*)::int as n from branch_account_adjustments`);
  assert.equal(count.rows[0]!.n, 1);
});

test('rows, shares and the carried balance match the hand-worked figures', async () => {
  const rows = await alphaRows();
  assert.deepEqual(rows.map((r: Json) => r.demandNumber), [null, 'DMD-000101', 'DMD-000102']);
  const [opening, d1, d2] = rows;

  assert.equal(opening.adjustments, 1000);
  assert.equal(opening.received, 200);
  assert.equal(opening.companyShare, 0);
  assert.equal(opening.closingBalance, 800);

  assert.equal(d1.delivered, 1000);   // approved 10 of 12 ordered, at the line's own Rs. 100
  assert.equal(d1.returns, 100);      // priced on 09-03, before the change to 120
  assert.equal(d1.discount, 50);
  assert.equal(d1.gTotal, 850);
  assert.equal(d1.sharePct, 80);
  assert.equal(d1.pctFrozen, true);
  assert.equal(d1.companyShare, 680);
  assert.equal(d1.received, 500);
  assert.equal(d1.sales, 900);
  assert.equal(d1.shareOnSales, 720);
  assert.equal(d1.previousBalance, 800);
  assert.equal(d1.closingBalance, 980);
  assert.equal(d1.open, false);

  assert.equal(d2.delivered, 600);    // no line price: 5 × Rs. 120 in force on 09-12
  assert.equal(d2.discount, 30);
  assert.equal(d2.sharePct, 70);
  assert.equal(d2.companyShare, 399);
  assert.equal(d2.previousBalance, 980);
  assert.equal(d2.closingBalance, 1379);
  assert.equal(d2.open, true);
});

test('Test 8 — later price and % changes leave recorded demands as they were', async () => {
  await setGlobalPct(60);
  await db.query(`update products set price = 500 where id = $1`, [BUN]);
  await db.query(`update branches set company_share_pct = 10 where id = $1`, [BETA]);
  const [, d1, d2] = await alphaRows();
  assert.equal(d1.companyShare, 680);
  assert.equal(d2.delivered, 600);
  assert.equal(d2.closingBalance, 1379);
  // A frozen snapshot cannot be edited or removed.
  await assert.rejects(db.query(`update production_order_share_snapshots set company_share_pct = 1`), /append-only/);
  await assert.rejects(db.query(`delete from production_order_share_snapshots`), /append-only/);
  await db.query(`update products set price = 120 where id = $1`, [BUN]);
});

test('verified demands count, at the branch\'s own %; pending and rejected demands do not', async () => {
  const beta = (await rowsOf(`&branchId=${BETA}`)).rows as Json[];
  assert.equal(beta.length, 1);
  assert.equal(beta[0].status, 'verified');
  assert.equal(beta[0].sharePct, 50);
  assert.equal(beta[0].companyShare, 500);
  const alpha = await alphaRows();
  assert.equal(alpha.some((r: Json) => r.demandNumber === 'DMD-000103' || r.demandNumber === 'DMD-000104'), false);
});

test('View Details lists exactly the records behind each figure', async () => {
  const d = ok(await call('accountant', 'GET', `${API}/detail?branchId=${ALPHA}&orderId=${ORD.d1}`));
  assert.deepEqual(d.lines.map((l: Json) => [l.deliveredQty, l.unitPrice, l.priceSource, l.amount]), [[10, 100, 'order', 1000]]);
  assert.deepEqual(d.returns.map((r: Json) => [r.qty, r.unitPrice, r.amount]), [[1, 100, 100]]);
  assert.deepEqual(d.discounts.map((x: Json) => [x.amount, x.linked]), [[50, true]]);
  assert.deepEqual(d.payments.map((p: Json) => p.amount), [500]);
  assert.deepEqual(d.sales, { count: 1, amount: 900 });
  assert.equal(d.row.closingBalance, 980);

  const d2 = ok(await call('accountant', 'GET', `${API}/detail?branchId=${ALPHA}&orderId=${ORD.d2}`));
  assert.deepEqual(d2.lines.map((l: Json) => [l.unitPrice, l.priceSource]), [[120, 'price_history']]);
  assert.deepEqual(d2.discounts.map((x: Json) => [x.amount, x.linked]), [[30, false]]);

  const open = ok(await call('accountant', 'GET', `${API}/detail?branchId=${ALPHA}`));
  assert.deepEqual(open.payments.map((p: Json) => p.amount), [200]);
  assert.deepEqual(open.adjustments.map((a: Json) => [a.kind, a.amount]), [['opening', 1000]]);

  assert.equal((await call('accountant', 'GET', `${API}/detail?branchId=${ALPHA}&orderId=${ORD.d3}`)).status, 404);
});

test('a period carries its opening balance in and does not re-add it', async () => {
  const p = await rowsOf(`&branchId=${ALPHA}&from=2026-09-10&to=2026-09-30`);
  assert.deepEqual(p.rows.map((r: Json) => r.demandNumber), ['DMD-000102']);
  assert.deepEqual(p.branches.map((b: Json) => [b.openingBalance, b.closingBalance]), [[980, 1379]]);
  assert.equal(p.totals.openingBalance, 980);
  assert.equal(p.totals.companyShare, 399);
  assert.equal(p.totals.closingBalance, 1379);
  const t = p.totals;
  assert.equal(t.openingBalance + t.companyShare + t.adjustments - t.received, t.closingBalance);

  // The month before closes where this one opens.
  const before = await rowsOf(`&branchId=${ALPHA}&from=2026-09-01&to=2026-09-09`);
  assert.equal(before.totals.closingBalance, p.totals.openingBalance);

  // Every branch at once: balances summed per branch, once.
  const all = await rowsOf('');
  assert.equal(all.totals.closingBalance, 1379 + 500);
});

test('Test 9 — a backdated correction re-flows later balances and keeps its history', async () => {
  const fix = ok(await call('admin', 'POST', `${API}/adjustments`, {
    requestId: randomUUID(), branchId: ALPHA, kind: 'adjustment', amount: -79, businessDate: '2026-09-05',
    reason: 'Rider short-changed on 09-05, agreed credit',
  }), 201);
  let [, d1, d2] = await alphaRows();
  assert.equal(d1.adjustments, -79);  // dated 09-05: inside D1's window
  assert.equal(d1.closingBalance, 901);
  assert.equal(d2.previousBalance, 901);
  assert.equal(d2.closingBalance, 1300);

  const rev = ok(await call('admin', 'POST', `${API}/adjustments/${fix.entry.id}/reverse`, {
    requestId: randomUUID(), reason: 'Entered against the wrong branch',
  }), 201);
  assert.equal(rev.entry.amount, 79);
  [, d1, d2] = await alphaRows();
  // The reversal is dated today, so it sits in the open last row; the 09-05 entry stays where it was.
  assert.equal(d1.closingBalance, 901);
  assert.equal(d2.adjustments, 79);
  assert.equal(d2.closingBalance, 1379);

  const again = await call('admin', 'POST', `${API}/adjustments/${fix.entry.id}/reverse`, { requestId: randomUUID(), reason: 'twice' });
  assert.equal(again.status, 409);
  const list = ok(await call('accountant', 'GET', `${API}/adjustments?branchId=${ALPHA}`)).adjustments as Json[];
  const original = list.find((a) => a.id === fix.entry.id);
  assert.equal(original.amount, -79);
  assert.equal(original.reversedBy, rev.entry.id);
  await assert.rejects(db.query(`delete from branch_account_adjustments`), /append-only/);
  await assert.rejects(db.query(`update branch_account_adjustments set amount = 1`), /append-only/);
  await assert.rejects(
    db.query(`insert into branch_account_adjustments (branch_id, kind, amount, effective_at, business_date, reason, reversal_of, request_id)
              values ($1, 'reversal', 5, now(), current_date, 'not the opposite', $2, gen_random_uuid())`, [ALPHA, list.find((a) => a.kind === 'opening').id]),
    /exact opposite/);
  const audit = await db.query<{ n: number }>(`select count(*)::int as n from finance_audit_logs where entity = 'branch_account'`);
  assert.equal(audit.rows[0]!.n, 4); // go-live, opening, adjustment, reversal
});

test('Test 7 — concurrent postings: none lost, one opening wins, a repeated request posts once', async () => {
  const sameRequest = { requestId: randomUUID(), branchId: BETA, kind: 'adjustment', amount: 10, reason: 'Concurrent same request' };
  const results = await Promise.all([
    call('admin', 'POST', `${API}/adjustments`, { requestId: randomUUID(), branchId: BETA, kind: 'opening', amount: 100, reason: 'Opening A' }),
    call('admin', 'POST', `${API}/adjustments`, { requestId: randomUUID(), branchId: BETA, kind: 'opening', amount: 200, reason: 'Opening B' }),
    call('admin', 'POST', `${API}/adjustments`, sameRequest),
    call('admin', 'POST', `${API}/adjustments`, sameRequest),
    call('admin', 'POST', `${API}/adjustments`, { requestId: randomUUID(), branchId: BETA, kind: 'adjustment', amount: 5, reason: 'Concurrent other' }),
  ]);
  const openings = results.slice(0, 2).map((r) => r.status).sort();
  assert.deepEqual(openings, [201, 409]);
  assert.deepEqual(results.slice(2, 4).map((r) => r.status).sort(), [200, 201]);
  assert.equal(results[4]!.status, 201);
  const beta = ok(await call('accountant', 'GET', `${API}/adjustments?branchId=${BETA}`)).adjustments as Json[];
  assert.equal(beta.length, 3);
  const opening = beta.find((a) => a.kind === 'opening').amount;
  const [b1] = (await rowsOf(`&branchId=${BETA}`)).rows as Json[];
  // Opening and both adjustments are before or in B1's open row; nothing counted twice.
  const all = (await rowsOf(`&branchId=${BETA}`)).totals;
  assert.equal(all.closingBalance, opening + 500 + 15);
  assert.ok(b1);
});

test('requests are validated', async () => {
  const bad = [
    { requestId: 'nope', branchId: ALPHA, kind: 'adjustment', amount: 5, reason: 'x y z' },
    { requestId: randomUUID(), branchId: ALPHA, kind: 'adjustment', amount: 0, reason: 'zero' },
    { requestId: randomUUID(), branchId: ALPHA, kind: 'adjustment', amount: 1.005, reason: 'three decimals' },
    { requestId: randomUUID(), branchId: ALPHA, kind: 'adjustment', amount: 5, reason: '' },
    { requestId: randomUUID(), branchId: ALPHA, kind: 'bonus', amount: 5, reason: 'wrong kind' },
  ];
  for (const body of bad) assert.equal((await call('admin', 'POST', `${API}/adjustments`, body)).status, 400, JSON.stringify(body));
  const early = await call('admin', 'POST', `${API}/adjustments`, {
    requestId: randomUUID(), branchId: ALPHA, kind: 'adjustment', amount: 5, businessDate: '2026-08-01', reason: 'before go-live',
  });
  assert.equal(early.status, 400);
  assert.equal((await call('accountant', 'GET', `${API}?from=yesterday`)).status, 400);
});

test('the Collections export carries the Demand Record figures, per branch', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const record = await rowsOf(`&from=2026-09-01&to=${today}`);
  const wb = await collectionsWorkbook(`&from=2026-08-01&to=${today}`);
  assert.deepEqual([...wb.keys()], ['Collections', 'By Branch', 'Alpha', 'Beta']);

  const main = wb.get('Collections')!;
  const h = main[0]!;
  assert.equal(h.includes('Actual Sales'), false); // production users never see sales
  const at = (name: string) => h.indexOf(name);
  for (const r of record.rows as Json[]) {
    const line = main.find((x) => x[at('Branch')] === r.branchName && x[at('Demand Number')] === (r.demandNumber ?? 'Opening'));
    assert.ok(line, `no line for ${r.branchName} ${r.demandNumber}`);
    for (const [col, key] of [['G. Total', 'gTotal'], ['Company Share', 'companyShare'], ['Share Received', 'received'],
      ['Previous Balance', 'previousBalance'], ['Closing Balance', 'closingBalance']] as const) {
      assert.equal(line[at(col)], r[key], `${r.demandNumber} ${col}`);
    }
  }
  assert.ok(main.some((x) => String(x[0]).startsWith('The Demand Record starts on 2026-09-01')));
  const total = main.find((x) => x[0] === 'TOTAL')!;
  assert.equal(total[at('Closing Balance')], record.totals.closingBalance);
  assert.match(String(main[main.indexOf(total) + 1]![0]), /: OK$/);

  // Each branch tab ends on that branch's own balance, and its sums reconcile.
  for (const b of record.branches as Json[]) {
    const tab = wb.get(b.branchName)!;
    const tabTotal = tab.find((x) => x[0] === 'TOTAL')!;
    assert.equal(tabTotal[tab[0]!.indexOf('Previous Balance')], b.openingBalance);
    assert.equal(tabTotal[tab[0]!.indexOf('Closing Balance')], b.closingBalance);
    assert.match(String(tab[tab.indexOf(tabTotal) + 1]![0]), /: OK$/);
  }
  const byBranch = wb.get('By Branch')!;
  assert.equal(byBranch.at(-1)![0], 'GRAND TOTAL');
  assert.equal(byBranch.at(-1)![byBranch[0]!.indexOf('Closing Balance')], record.totals.closingBalance);
});
