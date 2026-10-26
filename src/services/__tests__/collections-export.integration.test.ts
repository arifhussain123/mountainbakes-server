import { test, before, after } from 'node:test';
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
 * The Collections Excel export against the Demand Record page, cell for cell,
 * on the owner's worked example for 01–03 Oct 2026 (Bun at Rs. 100, so a
 * return of n pieces is Rs. n × 100). Saddar and Gulberg are the example's own
 * rows; Blue Area and F-7 (its own 75%) stand in for DMD-000126 and
 * DMD-000128, which the example gives only through its totals.
 *
 *   Saddar  123 10-01  45,000 − 1,200 − 1,000 = 42,800 → 34,240, rec 28,000 → 6,240
 *           124 10-02  50,000 −     0 − 2,000 = 48,000 → 38,400, rec 42,200 → 2,440
 *           125 10-03  39,000 −   500 − 1,000 = 37,500 → 30,000, rec 20,000 → 12,440
 *   Blue    126 10-01 106,000 −   600 −   600 = 104,800 → 83,840, rec 80,000 → 3,840
 *   Gulberg 127 10-01  13,500 −   400 −   600 = 12,500 → 10,000, rec 12,000 → −2,000
 *           129 10-03  31,500 − 1,000 −   500 = 30,000 → 24,000, rec 18,000 → 4,000
 *   F-7     128 10-02  26,500 −   400 −   600 = 25,500 → 19,125 (75%), rec 11,405 → 7,720
 *   Totals  311,500 · 4,100 · 6,300 · 301,100 · 239,605 · received 211,605
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
    `insert into production_orders (id, branch_id, branch_name, business_date, submitted_at, submitted_time, demand_number, status)
     values ($1, $2, (select name from branches where id = $2), $3, $4,
             to_char($4::timestamptz at time zone 'Asia/Karachi', 'HH24:MI'), $5, 'pending')`,
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

const SADDAR = '40000000-0000-4000-8000-000000000001';
const BLUE = '40000000-0000-4000-8000-000000000002';
const GULBERG = '40000000-0000-4000-8000-000000000003';
const F7 = '40000000-0000-4000-8000-000000000004';
const BUN = '50000000-0000-4000-8000-000000000001';

/** demand, branch, date, hour submitted, pieces delivered, pieces returned, discount, received. */
const DEMANDS: [string, string, string, number, number, number, number, number][] = [
  ['DMD-000123', SADDAR, '2026-10-01', 9, 450, 12, 1000, 28000],
  ['DMD-000124', SADDAR, '2026-10-02', 9, 500, 0, 2000, 42200],
  ['DMD-000125', SADDAR, '2026-10-03', 9, 390, 5, 1000, 20000],
  ['DMD-000126', BLUE, '2026-10-01', 10, 1060, 6, 600, 80000],
  ['DMD-000127', GULBERG, '2026-10-01', 11, 135, 4, 600, 12000],
  ['DMD-000128', F7, '2026-10-02', 10, 265, 4, 600, 11405],
  ['DMD-000129', GULBERG, '2026-10-03', 11, 315, 10, 500, 18000],
];

before(async () => {
  process.env['JWT_SECRET'] = 'collections-export-test-secret-that-is-long-enough';
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
    alter table production_order_items add foreign key (production_order_id) references production_orders (id);
  `);
  await db.exec(`begin;${AUTH}commit;`);
  await db.exec(`
    insert into finance_settings (company_share_pct, branch_share_pct) values (80, 20);
    insert into branches (id, name, slug) values ('${SADDAR}', 'Saddar', 'saddar'), ('${BLUE}', 'Blue Area', 'blue-area'),
      ('${GULBERG}', 'Gulberg', 'gulberg');
    insert into branches (id, name, slug, company_share_pct) values ('${F7}', 'F-7', 'f-7', 75);
    insert into products (id, name, price) values ('${BUN}', 'Bun', 100);
  `);
  await db.exec(`begin;${MIGRATION}commit;`);

  // Each demand's return, discount and deposit land after it and before the
  // branch's next demand, so they are that demand's.
  let n = 0;
  for (const [demand, branch, date, hour, pieces, returned, disc, received] of DEMANDS) {
    const id = `60000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const at = (h: number) => `${date}T${String(h).padStart(2, '0')}:00:00+05`;
    await order(id, branch, date, at(hour), demand, [{ qty: pieces, approved: pieces, unitPrice: 100 }]);
    await setStatus(id, 'awaiting_verification');
    await setStatus(id, 'approved');
    if (returned) await returnRow(branch, 'accepted', date, at(hour + 4), returned);
    await discount(branch, id, disc, 'approved', at(hour + 5));
    await transfer(branch, received, 'approved', at(hour + 6));
  }

  // September, before the Demand Record's 1 Oct start: demand figures only.
  //   Saddar 090 09-10  1,000 − 100 (return 09-11) − 50 = 850 → 680
  //   F-7    091 09-20  2,000                            → 1,500 (75%)
  //   Saddar 092 09-25    500 − 100 (return 01:00 on 10-01, still before the
  //                                  02:00 start)      = 400 → 320
  // A September deposit is not Received anywhere: cash then was not in the app.
  const SEP = { s90: '60000000-0000-4000-8000-000000000901', f91: '60000000-0000-4000-8000-000000000902', s92: '60000000-0000-4000-8000-000000000903' };
  for (const [id, branch, date, demand, pieces] of [
    [SEP.s90, SADDAR, '2026-09-10', 'DMD-000090', 10], [SEP.f91, F7, '2026-09-20', 'DMD-000091', 20], [SEP.s92, SADDAR, '2026-09-25', 'DMD-000092', 5],
  ] as const) {
    await order(id, branch, date, `${date}T09:00:00+05`, demand, [{ qty: pieces, approved: pieces, unitPrice: 100 }]);
    await setStatus(id, 'awaiting_verification');
    await setStatus(id, 'approved');
  }
  await returnRow(SADDAR, 'accepted', '2026-09-11', '2026-09-11T10:00:00+05', 1);
  await discount(SADDAR, SEP.s90, 50, 'approved', '2026-09-11T11:00:00+05');
  await transfer(SADDAR, 300, 'approved', '2026-09-12T10:00:00+05');
  await returnRow(SADDAR, 'accepted', '2026-09-30', '2026-10-01T01:00:00+05', 1);

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);
  for (const [name, a] of Object.entries(ACTORS)) {
    await db.query(`insert into users (id, email, role) values ($1, $2, $3)`, [a.id, a.email, a.role]);
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
  ok(await call('admin', 'PUT', `${API}/settings`, { startDate: '2026-10-01' }));
});

after(async () => {
  server?.close();
  await db?.close();
});

/** The workbook as a production user downloads it from the web's Collections dialog. */
async function workbook(query: string) {
  const res = await fetch(`${base}/api/production-reports/export?report=collections&type=excel${query}`, {
    headers: { Authorization: `Bearer ${TOKENS.production}` },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200, buf.toString());
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}
const valuesOf = (ws: { eachRow: (cb: (r: { values: unknown }) => void) => void }) => {
  const rows: Json[][] = [];
  ws.eachRow((r) => rows.push((r.values as Json[]).slice(1)));
  return rows;
};

const HEADERS = ['Date', 'Demand No.', 'Slip No.', 'Branch', 'Delivered', 'Return', 'Discount', 'G. Total', 'Co. Share',
  'Received', 'Previous', 'Closing', 'Closing Status'];

test('the Collections sheet is the Demand Record page, row for row, in the page\'s columns', async () => {
  const page = ok(await call('accountant', 'GET', `${API}?from=2026-10-01&to=2026-10-03&sortDir=asc&pageSize=500`));
  const wb = await workbook('&from=2026-10-01&to=2026-10-03');
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Collections', 'By Branch', 'Blue Area', 'F-7', 'Gulberg', 'Saddar']);
  const main = valuesOf(wb.getWorksheet('Collections')!);
  assert.deepEqual(main[0], HEADERS);

  const data = main.slice(1, -1);
  assert.deepEqual(data.map((r) => r[1]),
    ['DMD-000123', 'DMD-000126', 'DMD-000127', 'DMD-000124', 'DMD-000128', 'DMD-000125', 'DMD-000129']);
  assert.equal(page.rows.length, data.length);
  for (const p of page.rows as Json[]) {
    const r = data.find((x) => x[1] === p.demandNumber)!;
    assert.equal((r[0] as Date).toISOString().slice(0, 10), p.businessDate);
    // The slip's number: PO-, the business date, the submitted time.
    assert.match(String(r[2]), new RegExp(`^PO-${String(p.businessDate).replace(/-/g, '')}-\\d{4}$`), p.demandNumber);
    assert.deepEqual(r.slice(3), [p.branchName, p.delivered, p.returns, p.discount, p.gTotal, p.companyShare,
      p.received, p.previousBalance, p.closingBalance, p.closingBalance > 0 ? 'OUTSTANDING' : p.closingBalance < 0 ? 'CREDIT' : 'SETTLED'],
    p.demandNumber);
  }

  const row = (d: string) => data.find((x) => x[1] === d)!;
  //                                            Co. Share Received  Previous Closing
  assert.deepEqual(row('DMD-000123').slice(8), [34240, 28000, 0, 6240, 'OUTSTANDING']);
  assert.deepEqual(row('DMD-000124').slice(8), [38400, 42200, 6240, 2440, 'OUTSTANDING']);
  assert.deepEqual(row('DMD-000127').slice(8), [10000, 12000, 0, -2000, 'CREDIT']);
  assert.deepEqual(row('DMD-000129').slice(8), [24000, 18000, -2000, 4000, 'OUTSTANDING']);
  assert.deepEqual(row('DMD-000128').slice(8), [19125, 11405, 0, 7720, 'OUTSTANDING']); // F-7 at 75%

  assert.deepEqual(main.at(-1), ['TOTAL', '', '', '', 311500, 4100, 6300, 301100, 239605, 211605, '', '', '']);
});

test('cells stay numeric and carry the page\'s formats', async () => {
  const ws = (await workbook('&from=2026-10-01&to=2026-10-03')).getWorksheet('Collections')!;
  const r124 = ws.getRow(5); // header, 123, 126, 127, then 124
  assert.equal(r124.getCell(2).value, 'DMD-000124');
  assert.ok(r124.getCell(1).value instanceof Date);
  assert.equal(r124.getCell(1).numFmt, 'dd mmm yyyy');
  assert.equal(r124.getCell(6).value, 0); // no return: a numeric 0 shown blank
  assert.equal(r124.getCell(6).numFmt, '#,##0;-#,##0;');
  assert.equal(r124.getCell(12).numFmt, '#,##0;-#,##0;'); // Closing: no "Rs." on a row, blank at zero
  const total = ws.getRow(ws.rowCount);
  assert.equal(total.getCell(1).value, 'TOTAL');
  assert.equal(total.getCell(5).font?.bold, true);
  assert.equal(total.getCell(5).numFmt, '"Rs. "#,##0;-"Rs. "#,##0;'); // only the TOTAL carries "Rs."
});

test('each branch keeps its own chain; By Branch adds up to the same totals', async () => {
  const wb = await workbook('&from=2026-10-01&to=2026-10-03');
  const gulberg = valuesOf(wb.getWorksheet('Gulberg')!);
  assert.deepEqual(gulberg[0], HEADERS);
  assert.deepEqual(gulberg.slice(1, -1).map((r) => [r[1], r[10], r[11]]), [['DMD-000127', 0, -2000], ['DMD-000129', -2000, 4000]]);
  assert.deepEqual(gulberg.at(-1), ['TOTAL', '', '', '', 45000, 1400, 1100, 42500, 34000, 30000, '', '', '']);

  const byBranch = valuesOf(wb.getWorksheet('By Branch')!);
  assert.deepEqual(byBranch[0], ['Branch', 'Demands', 'Delivered', 'Return', 'Discount', 'G. Total', 'Co. Share', 'Received', 'Previous', 'Closing', 'Closing Status']);
  assert.deepEqual(byBranch.find((r) => r[0] === 'Saddar'), ['Saddar', 3, 134000, 1700, 4000, 128300, 102640, 90200, 0, 12440, 'OUTSTANDING']);
  assert.deepEqual(byBranch.at(-1), ['GRAND TOTAL', 7, 311500, 4100, 6300, 301100, 239605, 211605, 0, 28000, 'OUTSTANDING']);
});

test('a later period starts each branch from its own carried balance', async () => {
  const main = valuesOf((await workbook('&from=2026-10-03&to=2026-10-03')).getWorksheet('Collections')!);
  assert.deepEqual(main.slice(1, -1).map((r) => [r[1], r[10], r[11]]), [['DMD-000125', 2440, 12440], ['DMD-000129', -2000, 4000]]);
});

test('July–September, before the Demand Record began: each demand\'s figures, no Received or balance', async () => {
  const wb = await workbook('&from=2026-07-01&to=2026-09-30');
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Collections', 'By Branch', 'F-7', 'Saddar']);
  const main = valuesOf(wb.getWorksheet('Collections')!);
  assert.deepEqual(main[0], ['Date', 'Demand No.', 'Slip No.', 'Branch', 'Delivered', 'Return', 'Discount', 'G. Total', 'Co. Share']);
  assert.deepEqual(main.slice(1, 4).map((r) => r.slice(1)), [
    ['DMD-000090', 'PO-20260910-0900', 'Saddar', 1000, 100, 50, 850, 680],
    ['DMD-000091', 'PO-20260920-0900', 'F-7', 2000, 0, 0, 2000, 1500],
    ['DMD-000092', 'PO-20260925-0900', 'Saddar', 500, 100, 0, 400, 320],
  ]);
  assert.deepEqual(main[4]!.slice(0, 9), ['TOTAL', '', '', '', 3500, 200, 50, 3250, 2500]);
  const saddar = valuesOf(wb.getWorksheet('Saddar')!);
  assert.deepEqual(saddar[0], ['Date', 'Demand No.', 'Slip No.', 'Delivered', 'Return', 'Discount', 'G. Total', 'Co. Share']);
  assert.deepEqual(saddar[1]!.slice(1), ['DMD-000090', 'PO-20260910-0900', 1000, 100, 50, 850, 680]);
  assert.match(String(main[5]![0]), /^Before 01 Oct 2026 cash was not recorded in the app, so there is no Received or balance/);
  const byBranch = valuesOf(wb.getWorksheet('By Branch')!);
  assert.deepEqual(byBranch.slice(1), [
    ['F-7', 1, 2000, 0, 0, 2000, 1500],
    ['Saddar', 2, 1500, 200, 50, 1250, 1000],
    ['GRAND TOTAL', 3, 3500, 200, 50, 3250, 2500],
  ]);
});

test('a window running into October keeps October as the Demand Record and adds the earlier demands on their own tab', async () => {
  const wb = await workbook('&from=2026-09-01&to=2026-10-03');
  assert.equal(wb.worksheets[0]!.name, 'Collections');
  assert.ok(wb.getWorksheet('Before 01 Oct 2026'));
  const main = valuesOf(wb.getWorksheet('Collections')!);
  assert.deepEqual(main[0], HEADERS);
  // October's demands as before, then the pointer to the other tab.
  assert.ok(main.some((r) => r[1] === 'DMD-000123'));
  assert.ok(!main.some((r) => r[1] === 'DMD-000090'));
  assert.match(String(main[main.length - 1]![0]), /^Demands before 01 Oct 2026 are on the "Before 01 Oct 2026" tab and at the top of each branch's tab/);
  const before = valuesOf(wb.getWorksheet('Before 01 Oct 2026')!);
  assert.deepEqual(before.slice(1, 4).map((r) => r[1]), ['DMD-000090', 'DMD-000091', 'DMD-000092']);

  // Each branch's tab holds every demand of the window: September first, with
  // its own total and no Received or balance, then October as the record.
  const saddar = valuesOf(wb.getWorksheet('Saddar')!);
  assert.deepEqual(saddar[0], HEADERS);
  assert.deepEqual(saddar.slice(1, 4), [
    [saddar[1]![0], 'DMD-000090', 'PO-20260910-0900', 'Saddar', 1000, 100, 50, 850, 680, '', '', '', ''],
    [saddar[2]![0], 'DMD-000092', 'PO-20260925-0900', 'Saddar', 500, 100, 0, 400, 320, '', '', '', ''],
    ['TOTAL BEFORE 01 OCT 2026', '', '', '', 1500, 200, 50, 1250, 1000, '', '', '', ''],
  ]);
  assert.equal(saddar[4]![1], 'DMD-000123');
  assert.equal(saddar.at(-1)![0], 'TOTAL');
  const ws = wb.getWorksheet('Saddar')!;
  assert.equal(ws.getRow(4).getCell(5).font?.bold, true); // the September total
  assert.equal(ws.getRow(ws.rowCount).getCell(5).font?.bold, true); // October's
  const f7 = valuesOf(wb.getWorksheet('F-7')!);
  assert.deepEqual(f7.slice(1, 3).map((r) => r[1] || r[0]), ['DMD-000091', 'TOTAL BEFORE 01 OCT 2026']);

  // Every delivered demand of the window is somewhere in the file, by its demand number.
  const everywhere = new Set(wb.worksheets.flatMap((w) => valuesOf(w).map((r) => r[1])));
  for (const d of ['DMD-000090', 'DMD-000091', 'DMD-000092', 'DMD-000123', 'DMD-000124', 'DMD-000125', 'DMD-000126', 'DMD-000127', 'DMD-000128', 'DMD-000129']) {
    assert.ok(everywhere.has(d), d);
  }
});
