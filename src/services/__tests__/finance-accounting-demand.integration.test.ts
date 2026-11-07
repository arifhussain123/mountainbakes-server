import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';

/**
 * The Daily Ledger workbook's Balance Sheet against Finance → Demand Record,
 * end to end: the REAL baseline tables, the Demand Record migration, demands
 * that freeze their % through the real trigger, deposits posted to the ledger
 * by the real `post_finance_ledger_entry`, a Finance opening entry through the
 * real route — and then the workbook's branch balances compared with what the
 * Demand Record page's own endpoint returns for the same period and branch.
 *
 * Demand Record on from 2026-10-01. Bun Rs. 100. Global share 80%, Beta 50%.
 *
 *   Alpha  opening +1,000 (Finance)
 *          D1 10-02  10 × 100 = 1,000 × 80% = 800;  T1 10-03 pays 300
 *          D2 10-05   5 × 100 =   500 × 80% = 400;  T2 10-06 pays 200
 *          → 1,000 + 800 + 400 − 300 − 200 = 1,700 owed
 *          T0 10-01 05:00 (before D1) 150 — settles pre-October dues: income
 *          a cancelled demand and a pending one count for nothing
 *   Beta   B1 10-04  10 × 100 = 1,000 × 50% = 500;  T3 10-05 pays 500 → 0
 *          a pending and a deleted transfer count for nothing
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
  'finance_account', 'ledger_entry_status', 'ledger_head_type', 'finance_ledger_source',
];
const TABLES = [
  'branches', 'products', 'product_price_history', 'production_orders', 'production_order_items',
  'production_returns', 'branch_discounts', 'cash_transfers', 'orders', 'finance_settings', 'finance_audit_logs',
  'finance_day_closings', 'ledger_heads', 'ledger_entries',
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
  create sequence voucher_seq;
  create function app.next_finance_number(p_key text, p_prefix text) returns text language sql as $$
    select p_prefix || '-' || lpad(nextval('voucher_seq')::text, 6, '0') $$;
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
  admin: { id: '31000000-0000-4000-8000-000000000001', email: 'fadmin@mb.test', role: 'finance_admin' },
  branch: { id: '31000000-0000-4000-8000-000000000002', email: 'branch@mb.test', role: 'branch_manager' },
} as const;
type ActorName = keyof typeof ACTORS;
const TOKENS: Partial<Record<ActorName, string>> = {};

const ALPHA = '41000000-0000-4000-8000-00000000000a';
const BETA = '41000000-0000-4000-8000-00000000000b';
const BUN = '51000000-0000-4000-8000-000000000001';
const HEAD: Record<string, string> = {};
const FROM = '2026-10-01';
const TO = '2026-10-12';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(as: ActorName, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKENS[as]}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function order(branch: string, businessDate: string, submittedAt: string, demand: string, qty: number, finalStatus: string) {
  const id = randomUUID();
  await db.query(
    `insert into production_orders (id, branch_id, branch_name, business_date, submitted_at, demand_number, status)
     values ($1, $2, (select name from branches where id = $2), $3, $4, $5, 'pending')`,
    [id, branch, businessDate, submittedAt, demand]);
  await db.query(
    `insert into production_order_items (production_order_id, product_id, product_name, qty, approved_qty, unit_price, line_no)
     values ($1, $2, 'Bun', $3, $3, 100, 1)`, [id, BUN, qty]);
  // Through the statuses the app moves it through, so the trigger freezes the % as it leaves pending.
  const path = finalStatus === 'approved' ? ['awaiting_verification', 'verified', 'approved'] : [finalStatus];
  for (const s of path) await db.query(`update production_orders set status = $2::branch_production_order_status where id = $1`, [id, s]);
}

/** An approved deposit with its ledger voucher, as approve_cash_transfer leaves them; or a pending/deleted one with none. */
async function deposit(branch: string, amount: number, createdAt: string, opts: { status?: 'approved' | 'pending'; deleted?: boolean } = {}) {
  const id = randomUUID();
  const status = opts.status ?? 'approved';
  const date = createdAt.slice(0, 10);
  // Approval posts the voucher in the same transaction and stores its id on
  // the transfer (the table requires it); a deleted transfer's voucher is gone.
  let voucherId: string | null = null;
  if (status === 'approved') {
    if (opts.deleted) {
      voucherId = randomUUID();
    } else {
      const { rows } = await db.query<{ id: string }>(
        `select (post_finance_ledger_entry(
           p_entry_date => $1::date, p_ledger_head_id => $2::uuid, p_description => 'Payment received from branch',
           p_debit => $3::numeric, p_credit => 0, p_account => 'cash', p_source_type => 'cash_transfer',
           p_source_id => $4::uuid, p_branch_id => $5::uuid, p_branch_name => (select name from branches where id = $5),
           p_payment_method => 'cash', p_approved_by => null, p_approved_by_name => 'Test', p_created_by => null,
           p_created_by_name => 'Test', p_reverses_entry_id => null)).id as id`,
        [date, HEAD['INC-COMPANY-SHARE'], amount, id, branch]);
      voucherId = rows[0]!.id;
    }
  }
  await db.query(
    `insert into cash_transfers (id, branch_id, branch_name, amount, cash_amount, business_date, created_at, status,
                                 ledger_entry_id, approved_at, deleted_at)
     values ($1, $2, (select name from branches where id = $2), $3, $3, $4, $5, $6::cash_transfer_status,
             $8::uuid, case when $6 = 'approved' then $5::timestamptz end, case when $7 then now() end)`,
    [id, branch, amount, date, createdAt, status, opts.deleted ?? false, voucherId]);
}

async function workbook(query: string) {
  const res = await fetch(`${base}/api/finance/reports/accounting-workbook${query}`, {
    headers: { Authorization: `Bearer ${TOKENS.admin}` },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb;
}

/** The Balance Sheet sheet's branch table: name → [balance sheet, page]. */
function branchTable(wb: ExcelJS.Workbook): Map<string, [number, number]> {
  const bs = wb.getWorksheet('Balance Sheet')!;
  const rows: ExcelJS.Row[] = [];
  bs.eachRow((r) => rows.push(r));
  const head = rows.findIndex((r) => r.getCell(1).value === 'Branch' && r.getCell(3).value === 'Demand Record page');
  assert.ok(head >= 0, 'branch table missing');
  const out = new Map<string, [number, number]>();
  for (const r of rows.slice(head + 1)) {
    const name = r.getCell(1).value;
    if (typeof name !== 'string' || name.startsWith('Overall')) break;
    out.set(name, [Number(r.getCell(2).value), Number(r.getCell(3).value)]);
  }
  return out;
}
const statementValue = (wb: ExcelJS.Workbook, sheet: string, label: string) => {
  let out: unknown;
  wb.getWorksheet(sheet)!.eachRow((r) => {
    if (out === undefined && r.getCell(1).value === label) out = r.getCell(2).value ?? r.getCell(3).value;
  });
  return out;
};

before(async () => {
  process.env['JWT_SECRET'] = 'finance-accounting-demand-secret-long-enough';
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
    alter table ledger_heads add primary key (id);
    alter table ledger_entries add primary key (id);
    create sequence public.ledger_entries_seq_seq;
    alter table public.ledger_entries alter column seq set default nextval('public.ledger_entries_seq_seq');
  `);
  await db.exec(lift('CREATE FUNCTION public.post_finance_ledger_entry(', '$$;'));
  await db.exec(lift('CREATE FUNCTION public.finance_day_summary(', '$$;'));
  await db.exec(`begin;${AUTH}commit;`);
  await db.exec(`
    insert into finance_settings (company_share_pct, branch_share_pct) values (80, 20);
    insert into branches (id, name, slug) values ('${ALPHA}', 'Alpha', 'alpha');
    insert into branches (id, name, slug, company_share_pct) values ('${BETA}', 'Beta', 'beta', 50);
    insert into products (id, name, price) values ('${BUN}', 'Bun', 100);
    insert into ledger_heads (code, name, type, group_name, is_system) values
      ('INC-OPENING', 'Opening Balance', 'income', 'Opening', true),
      ('INC-COMPANY-SHARE', 'Company Share', 'income', 'Share Split', true);
  `);
  for (const r of (await db.query<{ id: string; code: string }>('select id, code from ledger_heads')).rows) HEAD[r.code] = r.id;
  await db.exec(`begin;${MIGRATION}commit;`);
  await db.exec(`update finance_settings set account_ledger_start = '${FROM}'`);

  // Cash the business opened October with, so cash stays positive.
  await db.query(
    `select post_finance_ledger_entry(p_entry_date => '${FROM}', p_ledger_head_id => $1::uuid, p_description => 'Opening',
       p_debit => 10000, p_credit => 0, p_account => 'cash', p_source_type => 'opening', p_source_id => null,
       p_branch_id => null, p_branch_name => null, p_payment_method => null, p_approved_by => null, p_approved_by_name => 'Test',
       p_created_by => null, p_created_by_name => 'Test', p_reverses_entry_id => null)`, [HEAD['INC-OPENING']]);

  await deposit(ALPHA, 150, '2026-10-01T05:00:00+05');                   // T0, before Alpha's first demand → income
  await order(ALPHA, '2026-10-02', '2026-10-02T09:00:00+05', 'DMD-A1', 10, 'approved');
  await deposit(ALPHA, 300, '2026-10-03T10:00:00+05');                   // T1
  await order(BETA, '2026-10-04', '2026-10-04T09:00:00+05', 'DMD-B1', 10, 'approved');
  await order(ALPHA, '2026-10-05', '2026-10-05T09:00:00+05', 'DMD-A2', 5, 'approved');
  await deposit(BETA, 500, '2026-10-05T10:00:00+05');                    // T3, pays Beta in full
  await deposit(BETA, 900, '2026-10-05T11:00:00+05', { status: 'pending' });
  await deposit(BETA, 700, '2026-10-05T12:00:00+05', { deleted: true });
  await deposit(ALPHA, 200, '2026-10-06T10:00:00+05');                   // T2
  await order(ALPHA, '2026-10-07', '2026-10-07T09:00:00+05', 'DMD-AX', 50, 'cancelled');
  await order(ALPHA, '2026-10-08', '2026-10-08T09:00:00+05', 'DMD-AP', 50, 'pending');

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
  const { router: reports } = await import('../../routes/finance-reports.routes');
  const { router: branchAccount } = await import('../../routes/finance-branch-account.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/finance/reports', reports);
  app.use('/api/finance/branch-account', branchAccount);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Alpha's opening balance, entered through Finance's own route.
  const opening = await call('admin', 'POST', '/api/finance/branch-account/adjustments', {
    requestId: randomUUID(), branchId: ALPHA, kind: 'opening', amount: 1000, businessDate: FROM, reason: 'September dues',
  });
  assert.equal(opening.status, 201, JSON.stringify(opening.body));
});

after(async () => {
  server?.close();
  await db?.close();
});

async function pageBalances(query: string): Promise<Map<string, number>> {
  const res = await call('admin', 'GET', `/api/finance/branch-account${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const out = new Map<string, number>();
  for (const b of res.body.branches ?? res.body.record?.branches ?? []) out.set(b.branchName, b.closingBalance);
  return out;
}

test('branch balances on the Balance Sheet equal the Demand Record page: partial payments, full payment', async () => {
  const wb = await workbook(`?from=${FROM}&to=${TO}`);
  const table = branchTable(wb);
  assert.deepEqual(table.get('Alpha'), [1700, 1700]);
  assert.deepEqual(table.get('Beta'), [0, 0]);
  const page = await pageBalances(`?from=${FROM}&to=${TO}`);
  assert.equal(page.get('Alpha'), 1700);
  assert.equal(page.get('Beta'), 0);
  assert.equal(statementValue(wb, 'Balance Sheet', 'Total branch receivables'), 1700);
});

test('the statements balance with the receivable in them, and the deposit is not income twice', async () => {
  const wb = await workbook(`?from=${FROM}&to=${TO}`);
  assert.equal(statementValue(wb, 'Balance Sheet', 'Balance check (assets − liabilities − equity)'), 0);
  // Cash 10,000 + 150 + 300 + 500 + 200; receivable 1,700.
  assert.equal(statementValue(wb, 'Balance Sheet', 'Total assets'), 11150 + 1700);
  // Revenue: the demands' share (800 + 400 + 500), plus the 150 the record does not count.
  assert.equal(statementValue(wb, 'Income Statement', 'Company Share — demands (Demand Record)'), 1700);
  assert.equal(statementValue(wb, 'Income Statement', 'Company Share'), 150);
  const tb = wb.getWorksheet('Trial Balance')!;
  tb.eachRow((r) => {
    if (r.getCell(1).value === 'TOTAL') {
      const res = (c: number) => (r.getCell(c).value as ExcelJS.CellFormulaValue).result;
      assert.equal(res(6), res(7)); // period debit = credit
      assert.equal(res(8), res(9)); // closing debit = credit
    }
  });
});

test('every demand is one journal entry; cancelled and pending demands, pending and deleted deposits are not in it', async () => {
  const wb = await workbook(`?from=${FROM}&to=${TO}`);
  const ids: string[] = [];
  wb.getWorksheet('General Entries')!.eachRow((r, n) => {
    if (n > 6 && typeof r.getCell(1).value === 'string') ids.push(r.getCell(1).value as string);
  });
  const entries = [...new Set(ids.filter((x) => !x.startsWith('TOTAL') && !x.startsWith('Difference')))];
  for (const d of ['DMD-A1', 'DMD-A2', 'DMD-B1']) assert.equal(ids.filter((x) => x === d).length, 2, d); // two lines each
  assert.ok(!entries.includes('DMD-AX') && !entries.includes('DMD-AP'));
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ledger_entries where deleted_at is null`);
  // Vouchers: opening + four approved deposits; demand entries: three; Finance's opening: one.
  assert.equal(entries.length, rows[0]!.n + 3 + 1);
});

test('as at an earlier date: equal where the page has no later payment, and a later payment is shown as a difference', async () => {
  const wb = await workbook(`?from=${FROM}&to=2026-10-04`);
  const table = branchTable(wb);
  assert.deepEqual(table.get('Alpha'), [1500, 1500]); // 1,000 + 800 − 300; T2 (10-06) falls in D2's row, after 10-04
  // Beta's 500 was paid on 10-05. The page puts that deposit in B1's still-open
  // row and shows 0; as at 10-04 the cash was not yet in hand, so the books
  // show 500 owed — and the workbook says why the two differ.
  assert.deepEqual(table.get('Beta'), [500, 0]);
  let warning = '';
  wb.getWorksheet('Balance Sheet')!.eachRow((r) => {
    if (r.getCell(1).value === 'Branch balances agree with the Demand Record page') warning = `${r.getCell(2).value} ${r.getCell(3).value}`;
  });
  assert.match(warning, /^WARN Different for: Beta \(books Rs 500\.00, page Rs 0\.00\)/);
});

test('a branch filter carries one branch only', async () => {
  const wb = await workbook(`?from=${FROM}&to=${TO}&branchId=${BETA}`);
  const table = branchTable(wb);
  assert.deepEqual([...table.keys()], ['Beta']);
  assert.deepEqual(table.get('Beta'), [0, 0]);
});

test('exporting again writes nothing and gives the same balances', async () => {
  const count = async () => (await db.query<{ n: number }>(`
    select (select count(*) from ledger_entries) + (select count(*) from branch_account_adjustments) as n`)).rows[0]!.n;
  const before = await count();
  const a = branchTable(await workbook(`?from=${FROM}&to=${TO}`));
  const b = branchTable(await workbook(`?from=${FROM}&to=${TO}`));
  assert.equal(await count(), before);
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test('a branch manager cannot export the books', async () => {
  const res = await fetch(`${base}/api/finance/reports/accounting-workbook?from=${FROM}&to=${TO}&branchId=${ALPHA}`, {
    headers: { Authorization: `Bearer ${TOKENS.branch}` },
  });
  assert.equal(res.status, 403);
});
