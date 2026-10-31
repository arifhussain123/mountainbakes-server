import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rupeesInWords } from '../../utils/amountInWords';
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
 *
 * On top of the example (owner's rules, 2026-10-29): each branch opens the
 * window with an Opening Stock row worth the stock it held that morning —
 * Saddar 20 Bun on 1 Oct (Rs. 2,000 → 1,600 share), 30 after 10 more on
 * 2 Oct — and a demand is placed by its required date: Blue Area's
 * DMD-000130, submitted 3 Oct for 4 Oct, is 4 Oct's. Committee Chowk is the
 * owner's case of the same day: 5 Bun of stock (Rs. 500 → 400) and
 * DMD-000093, submitted on 30 Sep — before the record — for 1 Oct
 * (Rs. 300 → 240), which follows the stock: Previous 400, Closing 640.
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
  'stock_movement_type',
];
const TABLES = [
  'branches', 'products', 'product_price_history', 'production_orders', 'production_order_items',
  'production_returns', 'branch_discounts', 'cash_transfers', 'orders', 'finance_settings', 'finance_audit_logs',
  'stock', 'stock_history',
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
const CHOWK = '40000000-0000-4000-8000-000000000005';
const BUN = '50000000-0000-4000-8000-000000000001';
const D130 = '60000000-0000-4000-8000-000000000130';
const D131 = '60000000-0000-4000-8000-000000000131';
const D093 = '60000000-0000-4000-8000-000000000904';

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
    insert into branches (id, name, slug) values ('${CHOWK}', 'Committee Chowk', 'committee-chowk');
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

  // Submitted on 3 Oct, required on 4 Oct.
  await order(D130, BLUE, '2026-10-03', '2026-10-03T20:00:00+05', 'DMD-000130', [{ qty: 10, approved: 10, unitPrice: 100 }]);
  await db.query(`update production_orders set required_date = '2026-10-04' where id = $1`, [D130]);
  await setStatus(D130, 'awaiting_verification');
  await setStatus(D130, 'approved');
  // Delivered already, required on a day long after today.
  await order(D131, GULBERG, '2026-10-03', '2026-10-03T21:00:00+05', 'DMD-000131', [{ qty: 5, approved: 5, unitPrice: 100 }]);
  await db.query(`update production_orders set required_date = '2099-01-02' where id = $1`, [D131]);
  await setStatus(D131, 'awaiting_verification');
  await setStatus(D131, 'approved');

  // Submitted late on 30 Sep, before the record began, for 1 Oct.
  await order(D093, CHOWK, '2026-09-30', '2026-09-30T23:31:00+05', 'DMD-000093', [{ qty: 3, approved: 3, unitPrice: 100 }]);
  await db.query(`update production_orders set required_date = '2026-10-01' where id = $1`, [D093]);
  await setStatus(D093, 'awaiting_verification');
  await setStatus(D093, 'approved');

  // Saddar holds 30 Bun now, 10 of them made on 2 Oct: 20 on the morning of 1 Oct.
  await db.exec(`
    insert into stock (branch_id, product_id, product_name, balance) values ('${SADDAR}', '${BUN}', 'Bun', 30);
    insert into stock (branch_id, product_id, product_name, balance) values ('${CHOWK}', '${BUN}', 'Bun', 5);
    -- Bun goes up to Rs. 120 on 31 Oct: the month's closing stock is valued at
    -- that day's price, every earlier day at the old Rs. 100.
    insert into product_price_history (product_id, product_name, old_price, new_price, effective_date, source, status, version_number)
      values ('${BUN}', 'Bun', 100, 120, '2026-10-31', 'manual', 'active', 2);
    insert into stock_history (branch_id, product_id, product_name, type, delta, balance_after, ref_id, business_date)
      values ('${SADDAR}', '${BUN}', 'Bun', 'production', 10, 30, 'test', '2026-10-02');
  `);

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

const HEADERS = ['Date', 'Demand No.', 'Branch', 'Delivered', 'Return', 'Discount', 'G. Total', 'Co. Share',
  'Received', 'Previous', 'Closing'];
/** The main sheet's rows without the note under it. */
const tableOf = (ws: Parameters<typeof valuesOf>[0]) => valuesOf(ws).filter((r) => !isNote(r));
/** A branch's tab: the same columns without Branch. */
const BRANCH_HEADERS = HEADERS.filter((h) => h !== 'Branch');
/** A branch's tab split at its header row: the lines above it, then the table. */
const isNote = (r: Json[]) => typeof r[0] === 'object' && r[0] !== null && 'richText' in r[0];
/** A note as plain text. */
const noteText = (r: Json[]) => (r[0].richText as { text: string }[]).map((p) => p.text).join('');
/** A branch's tab split at its header row: the lines above it, the table, then the notes under it. */
const branchTab = (ws: Parameters<typeof valuesOf>[0], firstHeader = 'Date') => {
  const all = valuesOf(ws);
  const at = all.findIndex((r) => r[0] === firstHeader);
  return { preamble: all.slice(0, at), table: all.slice(at).filter((r) => !isNote(r)), notes: all.filter(isNote).map(noteText) };
};

test('the Collections sheet is the Demand Record page, row for row, in the page\'s columns', async () => {
  const page = ok(await call('accountant', 'GET', `${API}?from=2026-10-01&to=2026-10-03&sortDir=asc&pageSize=500`));
  const wb = await workbook('&from=2026-10-01&to=2026-10-03');
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Collections', 'By Branch', 'Blue Area', 'Committee Chowk', 'F-7', 'Gulberg', 'Saddar']);
  const main = tableOf(wb.getWorksheet('Collections')!);
  assert.deepEqual(main[0], HEADERS);
  // The note under it too, on every branch's balance added together (By Branch's Closing).
  const closings = tableOf(wb.getWorksheet('By Branch')!).slice(1, -1).reduce((a, r) => a + (r[9] as number), 0);
  const mainNotes = valuesOf(wb.getWorksheet('Collections')!).filter(isNote).map(noteText);
  assert.equal(mainNotes.length, 5);
  assert.equal(mainNotes[0], 'Note:');
  assert.equal(mainNotes[3], `Balance Amount Rs. ${closings.toLocaleString('en-US')} (${rupeesInWords(closings)}) is deposited through the application of the cash deposit procedure followed.`);

  const data = main.slice(1, -1);
  // Each branch's Opening Stock row first (1 Oct, "Opening Stock" in Demand No.), then the demands.
  assert.deepEqual(data.map((r) => (r[1] === 'Opening Stock' ? `${r[1]} ${r[2]}` : r[1])), [
    'Opening Stock Blue Area', 'Opening Stock Committee Chowk', 'Opening Stock F-7', 'Opening Stock Gulberg', 'Opening Stock Saddar',
    'DMD-000093', 'DMD-000123', 'DMD-000126', 'DMD-000127', 'DMD-000124', 'DMD-000128', 'DMD-000125', 'DMD-000129']);
  // DMD-000130 and 131 were submitted on 3 Oct but are required later: not in this window.
  const pageRows = (page.rows as Json[]).filter((p) => !['DMD-000130', 'DMD-000131'].includes(p.demandNumber));
  assert.equal(pageRows.length, 7);
  for (const p of pageRows) {
    const r = data.find((x) => x[1] === p.demandNumber)!;
    assert.equal((r[0] as Date).toISOString().slice(0, 10), p.businessDate);
    // The demand's own figures are the page's; the balance is the sheet's own (Saddar's opening stock adds 1,600).
    assert.deepEqual(r.slice(2, 9), [p.branchName, p.delivered, p.returns, p.discount, p.gTotal, p.companyShare, p.received], p.demandNumber);
    const lift = p.branchName === 'Saddar' ? 1600 : 0;
    assert.deepEqual(r.slice(9, 11), [p.previousBalance + lift, p.closingBalance + lift], p.demandNumber);
  }

  const opening = (b: string) => data.find((x) => x[1] === 'Opening Stock' && x[2] === b)!;
  assert.equal((opening('Saddar')[0] as Date).toISOString().slice(0, 10), '2026-10-01');
  // The Opening Stock row opens the chain: its Closing is the first demand's Previous.
  //                                            Delivered Ret Disc G.Total Share Received Previous Closing
  assert.deepEqual(opening('Saddar').slice(3), [2000, 0, 0, 2000, 1600, 0, 0, 1600]);
  assert.deepEqual(opening('Gulberg').slice(3), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(opening('Committee Chowk').slice(3), [500, 0, 0, 500, 400, 0, 0, 400]);

  const row = (d: string) => data.find((x) => x[1] === d)!;
  //                                            Co. Share Received  Previous Closing
  assert.deepEqual(row('DMD-000123').slice(7), [34240, 28000, 1600, 7840]);
  assert.deepEqual(row('DMD-000124').slice(7), [38400, 42200, 7840, 4040]);
  assert.deepEqual(row('DMD-000127').slice(7), [10000, 12000, 0, -2000]);
  assert.deepEqual(row('DMD-000129').slice(7), [24000, 18000, -2000, 4000]);
  assert.deepEqual(row('DMD-000128').slice(7), [19125, 11405, 0, 7720]); // F-7 at 75%
  // Submitted before the record, required on 1 Oct: after the stock, no Received.
  assert.deepEqual(row('DMD-000093').slice(2), ['Committee Chowk', 300, 0, 0, 300, 240, 0, 400, 640]);

  assert.deepEqual(main.at(-1), ['TOTAL', '', '', 314300, 4100, 6300, 303900, 241845, 211605, '', '']);
});

test('cells stay numeric and carry the page\'s formats', async () => {
  const ws = (await workbook('&from=2026-10-01&to=2026-10-03')).getWorksheet('Collections')!;
  const r124 = ws.getRow(11); // header, five Opening Stock rows, 093, 123, 126, 127, then 124
  assert.equal(r124.getCell(2).value, 'DMD-000124');
  assert.ok(r124.getCell(1).value instanceof Date);
  assert.equal(r124.getCell(1).numFmt, 'dd mmm yyyy');
  assert.equal(r124.getCell(5).value, 0); // no return: a numeric 0, shown blank
  assert.equal(r124.getCell(5).numFmt, '#,##0;-#,##0;');
  assert.equal(r124.getCell(11).numFmt, '#,##0;-#,##0;'); // Closing: no "Rs." on a row
  assert.ok(r124.getCell(11).border?.top, 'the table has borders');
  assert.notEqual(r124.getCell(11).font?.color?.argb, 'FFDC2626'); // red only on a finished month's final balance
  const total = ws.getRow(ws.rowCount - 6); // then a blank line and the five note lines
  assert.equal(total.getCell(1).value, 'TOTAL');
  assert.equal(total.getCell(4).font?.bold, true);
  assert.equal(total.getCell(4).numFmt, '"Rs. "#,##0;-"Rs. "#,##0;'); // only the TOTAL carries "Rs."
});

test('each branch keeps its own chain; By Branch adds up to the same totals', async () => {
  const wb = await workbook('&from=2026-10-01&to=2026-10-03');
  const gulberg = branchTab(wb.getWorksheet('Gulberg')!);
  // Headed by the branch, the period (from the 1st of the month) and a summary of the chain.
  assert.deepEqual(gulberg.preamble, [
    ['Mountain Bakes - Gulberg'],
    ['Period: 01 Oct 2026 to 03 Oct 2026'],
    ['Summary'],
    ['Total Demands', '', 2],
    ['Total Demand Amount', '', 45000],
    ['Total Company Share', '', 34000],
    ['Total Received', '', 30000],
    ['Balance', '', 4000],
  ]);
  assert.deepEqual(gulberg.table[0], BRANCH_HEADERS);
  assert.deepEqual(gulberg.table.slice(1, -1).map((r) => [r[1], r[8], r[9]]),
    [['Opening Stock', 0, 0], ['DMD-000127', 0, -2000], ['DMD-000129', -2000, 4000]]);
  assert.deepEqual(gulberg.table.at(-1), ['TOTAL', '', 45000, 1400, 1100, 42500, 34000, 30000, '', '']);
  // Mid-month too: the whole note, on the balance at the To date.
  assert.deepEqual(gulberg.notes, [
    'Note:',
    'This computer-generated statement does not require a signature.',
    'This detail is not valid for any legal or law requirement.',
    'Balance Amount Rs. 4,000 (Rupees Four Thousand Only) is deposited through the application of the cash deposit procedure followed.',
    'When the amount is deposited with a back date on the last month of date 03 Oct 2026, submit the application to the admin for access on the back date.',
  ]);
  const ws = wb.getWorksheet('Gulberg')!;
  const totalAt = ws.rowCount - 6; // TOTAL, a blank line, then the five note lines
  assert.equal(ws.getRow(totalAt).getCell(1).value, 'TOTAL');
  assert.equal(ws.getRow(totalAt).getCell(3).font?.bold, true); // the TOTAL, below the preamble
  assert.equal(ws.getRow(totalAt).getCell(3).numFmt, '"Rs. "#,##0;-"Rs. "#,##0;');

  const byBranch = valuesOf(wb.getWorksheet('By Branch')!);
  assert.deepEqual(byBranch[0], ['Branch', 'Demands', 'Delivered', 'Return', 'Discount', 'G. Total', 'Co. Share', 'Received', 'Previous', 'Closing']);
  // Saddar's Delivered and Co. Share include its opening stock (2,000 → 1,600).
  assert.deepEqual(byBranch.find((r) => r[0] === 'Saddar'), ['Saddar', 3, 136000, 1700, 4000, 130300, 104240, 90200, 0, 14040]);
  assert.deepEqual(byBranch.at(-1), ['GRAND TOTAL', 8, 314300, 4100, 6300, 303900, 241845, 211605, 0, 30240]);
});

test('From is taken as picked: a window from 3 Oct opens on that morning\'s stock', async () => {
  const picked = tableOf((await workbook('&from=2026-10-03&to=2026-10-03')).getWorksheet('Collections')!);
  const day = (r: unknown[]) => (r[0] as Date).toISOString().slice(0, 10);
  // Nothing before 3 Oct: DMD-000123/124/126/127/128 (1–2 Oct) are carried in, not listed.
  assert.ok(picked.slice(1, -1).every((r) => day(r) === '2026-10-03'));
  //                                Delivered Ret Disc G.Total Share Rec  Previous Closing
  assert.deepEqual(picked.find((r) => r[1] === 'Opening Stock' && r[2] === 'Saddar')!.slice(3),
    [3000, 0, 0, 3000, 2400, 0, 2440, 4840]); // 30 Bun that morning; 2,440 carried from DMD-000124
  assert.deepEqual(picked.find((r) => r[1] === 'DMD-000125')!.slice(3), [39000, 500, 1000, 37500, 30000, 20000, 4840, 14840]);
  assert.deepEqual(picked.find((r) => r[1] === 'Opening Stock' && r[2] === 'Gulberg')!.slice(9), [-2000, -2000]);
  assert.deepEqual(picked.map((r) => r[1]).filter((n) => String(n).startsWith('DMD-')), ['DMD-000125', 'DMD-000129']);
});

test('a later month starts each branch from its own carried balance, with that morning\'s stock', async () => {
  const main = tableOf((await workbook('&from=2026-11-01&to=2026-11-05')).getWorksheet('Collections')!);
  // No demand is required in 1–5 Nov; each branch carries October's balance in.
  assert.deepEqual(main.slice(1, -1).map((r) => [(r[0] as Date).toISOString().slice(0, 10), r[1], r[2], r[9], r[10]]), [
    ['2026-11-01', 'Opening Stock', 'Blue Area', 4640, 4640],
    ['2026-11-01', 'Opening Stock', 'Committee Chowk', 0, 480], // DMD-000093 had no balance of the record's to carry
    ['2026-11-01', 'Opening Stock', 'F-7', 7720, 7720],
    ['2026-11-01', 'Opening Stock', 'Gulberg', 4000, 4000],
    ['2026-11-01', 'Opening Stock', 'Saddar', 12440, 15320], // 30 Bun at 1 Nov's Rs. 120 = 3,600 → 2,880
  ]);
  assert.deepEqual(main.find((r) => r[2] === 'Saddar')!.slice(3, 8), [3600, 0, 0, 3600, 2880]);
});

test('a demand is placed and dated by its required date, not the day it was submitted', async () => {
  const wb = await workbook('&from=2026-10-04&to=2026-10-04');
  const main = tableOf(wb.getWorksheet('Collections')!);
  const r = main.find((x) => x[1] === 'DMD-000130')!;
  assert.equal((r[0] as Date).toISOString().slice(0, 10), '2026-10-04');
  //                            Delivered        Share Received Previous Closing
  assert.deepEqual(r.slice(2), ['Blue Area', 1000, 0, 0, 1000, 800, 0, 3840, 4640]);
});

test('To may run past today: a demand required later is shown on its required date', async () => {
  const main = tableOf((await workbook('&from=2099-01-01&to=2099-01-05')).getWorksheet('Collections')!);
  const r = main.find((x) => x[1] === 'DMD-000131')!;
  assert.ok(r, 'DMD-000131 is in the window');
  assert.equal((r[0] as Date).toISOString().slice(0, 10), '2099-01-02');
  assert.deepEqual(r.slice(2, 8), ['Gulberg', 500, 0, 0, 500, 400]);
});

test('July–September, before the Demand Record began: each demand\'s figures, no Received or balance', async () => {
  const wb = await workbook('&from=2026-07-01&to=2026-09-30');
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Collections', 'By Branch', 'F-7', 'Saddar']);
  const main = tableOf(wb.getWorksheet('Collections')!);
  assert.deepEqual(main[0], ['Date', 'Demand No.', 'Branch', 'Delivered', 'Return', 'Discount', 'G. Total', 'Co. Share']);
  assert.deepEqual(main.slice(1, 4).map((r) => r.slice(1)), [
    ['DMD-000090', 'Saddar', 1000, 100, 50, 850, 680],
    ['DMD-000091', 'F-7', 2000, 0, 0, 2000, 1500],
    ['DMD-000092', 'Saddar', 500, 100, 0, 400, 320],
  ]);
  assert.deepEqual(main[4]!.slice(0, 8), ['TOTAL', '', '', 3500, 200, 50, 3250, 2500]);
  const saddar = valuesOf(wb.getWorksheet('Saddar')!);
  assert.deepEqual(saddar[0], ['Date', 'Demand No.', 'Delivered', 'Return', 'Discount', 'G. Total', 'Co. Share']);
  assert.deepEqual(saddar[1]!.slice(1), ['DMD-000090', 1000, 100, 50, 850, 680]);
  assert.match(String(main[5]![0]), /^Before 01 Oct 2026 cash was not recorded in the app, so there is no Received or balance/);
  const byBranch = valuesOf(wb.getWorksheet('By Branch')!);
  assert.deepEqual(byBranch.slice(1), [
    ['F-7', 1, 2000, 0, 0, 2000, 1500],
    ['Saddar', 2, 1500, 200, 50, 1250, 1000],
    ['GRAND TOTAL', 3, 3500, 200, 50, 3250, 2500],
  ]);
});

test('a demand submitted before the record for its first day follows the opening stock on the branch\'s tab', async () => {
  const wb = await workbook('&from=2026-10-01&to=2026-10-03');
  assert.ok(!wb.worksheets.some((w) => w.name.startsWith('Before')));
  const chowk = branchTab(wb.getWorksheet('Committee Chowk')!);
  assert.deepEqual(chowk.preamble, [
    ['Mountain Bakes - Committee Chowk'],
    ['Period: 01 Oct 2026 to 03 Oct 2026'],
    ['Summary'],
    ['Total Demands', '', 1],
    ['Total Demand Amount', '', 300], // the demand only, not the stock
    ['Total Company Share', '', 640], // stock 400 + demand 240
    ['Total Received', '', 0],
    ['Balance', '', 640],
  ]);
  assert.deepEqual(chowk.table[0], BRANCH_HEADERS);
  //                          Delivered Ret Disc G.Total Share Received Previous Closing
  assert.deepEqual(chowk.table.slice(1).map((r) => r.slice(1)), [
    ['Opening Stock', 500, 0, 0, 500, 400, 0, 0, 400],
    ['DMD-000093', 300, 0, 0, 300, 240, 0, 400, 640],
    ['', 800, 0, 0, 800, 640, 0, '', ''],
  ]);
  assert.equal(chowk.table.at(-1)![0], 'TOTAL');
  assert.ok(!wb.worksheets.some((w) => valuesOf(w).some((r) => String(r[0]).startsWith('TOTAL BEFORE'))));
  const ws = wb.getWorksheet('Committee Chowk')!;
  assert.equal(ws.getRow(1).font?.bold, true);
  assert.equal(ws.getRow(8).getCell(3).numFmt, '"Rs. "#,##0;-"Rs. "#,##0;'); // Total Received: a zero, shown blank like every zero
});

test('every column is sized to its text, and rows are left to size themselves', async () => {
  const wb = await workbook('&from=2026-10-01&to=2026-10-03');
  for (const ws of wb.worksheets) {
    const widths = new Map<number, number>();
    ws.eachRow((row) => {
      let valued = 0;
      row.eachCell((cell) => { if (cell.value !== '' && cell.value !== null) valued++; });
      if (isNote([row.getCell(1).value])) {
        // A note is merged across the table and wrapped, so its row is sized to its text.
        assert.ok(row.getCell(1).alignment?.wrapText, `${ws.name} row ${row.number}: the note does not wrap`);
        assert.ok(row.height! >= 15, `${ws.name} row ${row.number}: the note has no height`);
        return;
      }
      if (valued <= 1) return; // a title spills across instead
      row.eachCell((cell, col) => {
        const fmt = String(cell.numFmt ?? '');
        const text = cell.value instanceof Date ? 'dd mmm yyyy'
          : typeof cell.value === 'number'
            ? `${fmt.includes('Rs.') ? 'Rs. ' : ''}${cell.value.toLocaleString('en-US', fmt.includes('0.00') ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {})}`
            : String(cell.value ?? '');
        widths.set(col, Math.max(widths.get(col) ?? 0, text.length));
      });
      assert.equal(row.height, undefined, `${ws.name} row ${row.number} has a fixed height`);
    });
    for (const [col, len] of widths) assert.ok(ws.getColumn(col).width! >= len, `${ws.name} column ${col}: ${ws.getColumn(col).width} < ${len}`);
  }
  // Narrow columns stay narrow: Date is not padded out to a long title above it.
  const chowk = wb.getWorksheet('Committee Chowk')!;
  assert.ok(chowk.getColumn(1).width! < 'Mountain Bakes - Committee Chowk'.length);
  assert.ok(chowk.getColumn(2).width! >= 'Opening Stock'.length);
});

test('a finished month takes its Closing Stock off the last demand, valued at that day\'s price, its balance in bold red, with Note 3', async () => {
  const wb = await workbook('&from=2026-10-01&to=2026-10-31');
  const saddar = branchTab(wb.getWorksheet('Saddar')!);
  //                                       Delivered  Ret  Disc  G.Total  Share  Received Previous Closing
  assert.deepEqual(saddar.table.slice(1, -1).map((r) => [(r[0] as Date).toISOString().slice(0, 10), ...r.slice(1)]), [
    ['2026-10-01', 'Opening Stock', 2000, 0, 0, 2000, 1600, 0, 0, 1600],
    ['2026-10-01', 'DMD-000123', 45000, 1200, 1000, 42800, 34240, 28000, 1600, 7840],
    ['2026-10-02', 'DMD-000124', 50000, 0, 2000, 48000, 38400, 42200, 7840, 4040],
    // 30 Bun left at the end of 31 Oct, at that day's Rs. 120 (not today's Rs. 100): 3,600 off the
    // month's last demand (owner's rule, 2026-11-01), written as the sum: 39,000 − 3,600 = 35,400.
    ['2026-10-03', 'DMD-000125', { formula: '39000-3600', result: 35400 }, 500, 1000, 33900, 27120, 20000, 4040, 11160],
    // The amount only: no share, no balance.
    ['2026-10-31', 'Closing Stock', 3600, '', '', '', '', '', '', ''],
  ]);
  // The Closing Stock row is not in the totals; its amount is, through the last demand: 2,000 in, 3,600 out.
  assert.deepEqual(saddar.table.at(-1), ['TOTAL', '', 132400, 1700, 4000, 126700, 101360, 90200, '', '']);
  assert.deepEqual(saddar.preamble.slice(1, 2), [['Period: 01 Oct 2026 to 31 Oct 2026']]);
  assert.deepEqual(saddar.preamble.slice(3), [
    ['Total Demands', '', 3],
    ['Total Demand Amount', '', 134000], // the demands as delivered: neither stock row
    ['Total Company Share', '', 101360], // 1,600 + 102,640 − 2,880: Balance = 101,360 − 90,200
    ['Total Received', '', 90200],
    ['Balance', '', 11160],
  ]);
  assert.deepEqual(saddar.notes, [
    'Note:',
    'This computer-generated statement does not require a signature.',
    'This detail is not valid for any legal or law requirement.',
    'Balance Amount Rs. 11,160 (Rupees Eleven Thousand One Hundred Sixty Only) is deposited through the application of the cash deposit procedure followed.',
    'When the amount is deposited with a back date on the last month of date 31 Oct 2026, submit the application to the admin for access on the back date.',
  ]);

  // Bold red: the last demand's Closing and the summary's Balance, nothing else.
  const ws = wb.getWorksheet('Saddar')!;
  const red: string[] = [];
  ws.eachRow((row) => row.eachCell((cell) => { if (cell.font?.color?.argb === 'FFDC2626') red.push(`${cell.address}=${cell.value}`); }));
  const lastDemand = [...Array(ws.rowCount).keys()].map((i) => ws.getRow(i + 1)).find((r) => r.getCell(2).value === 'DMD-000125')!;
  assert.deepEqual(red, ['A9=Balance', 'C9=11160', `J${lastDemand.number}=11160`]);
  assert.equal(ws.getRow(9).getCell(3).font?.bold, true);
  assert.equal(lastDemand.getCell(10).font?.bold, true);

  // A branch with no stock still shows the month's Closing Stock, at zero, and nothing is taken off.
  const blue = branchTab(wb.getWorksheet('Blue Area')!);
  assert.deepEqual(blue.table.at(-2)!.slice(1), ['Closing Stock', 0, '', '', '', '', '', '', '']);
  assert.equal(typeof blue.table.at(-3)![2], 'number');
  assert.equal(blue.table.at(-3)![9], 4640);
  const chowk = branchTab(wb.getWorksheet('Committee Chowk')!);
  assert.deepEqual(chowk.table.at(-2)!.slice(1), ['Closing Stock', 600, '', '', '', '', '', '', '']);
  assert.match(chowk.notes[3]!, /Rs\. 160 \(Rupees One Hundred Sixty Only\)/);

  // The main sheet: each branch's Closing Stock last on 31 Oct, the amount only.
  const main = tableOf(wb.getWorksheet('Collections')!);
  assert.deepEqual(main.filter((r) => r[1] === 'Closing Stock').map((r) => [r[2], r[3], r[10]]),
    [['Blue Area', 0, ''], ['Committee Chowk', 600, ''], ['F-7', 0, ''], ['Gulberg', 0, ''], ['Saddar', 3600, '']]);
  assert.equal(main.at(-2)![1], 'Closing Stock');

  // The Month-End tab works each branch's closing through on one line, and it agrees with the tabs.
  assert.deepEqual(wb.worksheets.map((w) => w.name).slice(0, 3), ['Collections', 'By Branch', 'Month-End']);
  const recon = branchTab(wb.getWorksheet('Month-End')!, 'Branch');
  assert.deepEqual(recon.preamble[0], ['Mountain Bakes - Month-End Closing, 31 Oct 2026']);
  assert.deepEqual(recon.table[0], ['Branch', 'Last-Day Demand', 'Closing Stock', 'Last-Day Net', 'Previous', 'Opening Stock', 'Co. Share', 'Adjustments', 'Received', 'Final Balance', 'Check']);
  //                                                       LastDay Stock  Net    Prev Open  Share   Adj Received Final
  assert.deepEqual(recon.table.find((r) => r[0] === 'Saddar'), ['Saddar', 0, 3600, -3600, 0, 2000, 101360, 0, 90200, 11160, 'OK']);
  assert.deepEqual(recon.table.find((r) => r[0] === 'Committee Chowk'), ['Committee Chowk', 0, 600, -600, 0, 500, 160, 0, 0, 160, 'OK']);
  assert.deepEqual(recon.table.at(-1)!.slice(0, 1).concat(recon.table.at(-1)!.slice(-2)), ['GRAND TOTAL', 4640 + 160 + 7720 + 4000 + 11160, 'OK']);
  assert.equal(recon.notes.length, 2);
  // A month still running has no Month-End tab.
  assert.ok(!(await workbook('&from=2026-10-01&to=2026-10-03')).getWorksheet('Month-End'));

  // Worked out from the records each time: a second export is the same file's figures, nothing deducted twice.
  const again = await workbook('&from=2026-10-01&to=2026-10-31');
  assert.deepEqual(valuesOf(again.getWorksheet('Saddar')!), valuesOf(ws));
  assert.deepEqual(tableOf(again.getWorksheet('Collections')!), main);
});
