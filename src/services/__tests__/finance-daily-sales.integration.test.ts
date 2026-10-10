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
 * Finance Daily Closing reads each branch's Daily Sale Record — end to end,
 * against the REAL tables, the REAL `daily_sale_figures` and the REAL routers.
 *
 * The sales tables, the record tables, the deposit table and the SQL that
 * aggregates a day are lifted verbatim from prisma/migrations/0_baseline. Both
 * routers are mounted side by side, so every "Finance sees what the branch sees"
 * assertion compares the two endpoints' answers about the same database rather
 * than a fixture against itself.
 *
 * What is NOT exercised: approving a deposit. `approve_cash_transfer` posts to
 * the ledger, and the ledger is not part of this schema; an approved deposit is
 * written as the row that function leaves behind. The read under test only ever
 * sees that row.
 *
 * Dates are fixed and past, so the suite does not depend on the day it runs.
 *
 *   D1 = 2026-09-10 — the day most of the suite is about
 *   D2 = 2026-09-11 — the day after, for the 02:00 rollover
 */

const PRISMA = join(__dirname, '../../../prisma/migrations');
const BASELINE = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
const AUTH = readFileSync(join(__dirname, '../../../db/history/migrations/20261009000149_custom_auth.sql'), 'utf8');

/** One statement out of the baseline, from `head` to the first `tail` after it. */
function lift(head: string, tail: string): string {
  const start = BASELINE.indexOf(head);
  assert.ok(start >= 0, `not in the baseline: ${head}`);
  const end = BASELINE.indexOf(tail, start);
  assert.ok(end > start, `no end found for: ${head}`);
  return `${BASELINE.slice(start, end + tail.length)}\n`;
}
const type = (name: string) => lift(`CREATE TYPE public.${name} AS ENUM (`, ');');
const table = (name: string) => lift(`CREATE TABLE public.${name} (`, '\n);');
const fn = (signature: string) => lift(`CREATE FUNCTION ${signature}(`, '$$;');

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.next_finance_number(p_key text, p_prefix text) returns text language sql as
    $$ select p_prefix || '-' || substr(gen_random_uuid()::text, 1, 8) $$;
  create function public.next_expense_number() returns text language sql as
    $$ select 'EXP-' || substr(gen_random_uuid()::text, 1, 8) $$;
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table branches (
    id uuid primary key default gen_random_uuid(), name text, address text, phone text, city text,
    company_share_pct numeric, is_active boolean not null default true);
  create table finance_income_approvals (
    id uuid primary key default gen_random_uuid(), branch_id uuid, business_date date,
    company_share_pct numeric, deleted_at timestamptz);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
`;

const A = '30000000-0000-4000-8000-00000000000a';
const B = '30000000-0000-4000-8000-00000000000b';
const UNKNOWN_BRANCH = '30000000-0000-4000-8000-0000000000ff';
const D1 = '2026-09-10';
const D2 = '2026-09-11';
const EMPTY_DAY = '2026-08-01';

let db: PGlite;
let server: Server;
let base: string;

interface Actor { id: string; email: string; role: string; branchId?: string; branchName?: string }
const ACTORS: Record<string, Actor> = {
  finance: { id: '20000000-0000-4000-8000-000000000001', email: 'fadmin@mb.test', role: 'finance_admin' },
  auditor: { id: '20000000-0000-4000-8000-000000000002', email: 'auditor@mb.test', role: 'finance_auditor' },
  accountant: { id: '20000000-0000-4000-8000-000000000003', email: 'accountant@mb.test', role: 'accountant' },
  owner: { id: '20000000-0000-4000-8000-000000000004', email: 'owner@mb.test', role: 'super_admin' },
  branchA: { id: '20000000-0000-4000-8000-000000000005', email: 'a@mb.test', role: 'branch_manager', branchId: A, branchName: 'Gulberg' },
  branchB: { id: '20000000-0000-4000-8000-000000000006', email: 'b@mb.test', role: 'branch_manager', branchId: B, branchName: 'Saddar' },
  production: { id: '20000000-0000-4000-8000-000000000007', email: 'prod@mb.test', role: 'production_user' },
};
const TOKENS: Record<string, string> = {};

const FINANCE = '/api/finance/daily-sales';
const BRANCH = '/api/daily-sale-records';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(as ? { Authorization: `Bearer ${TOKENS[as] ?? as}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

const window = (from: string, to: string, branchId?: string) =>
  `?from=${from}&to=${to}${branchId ? `&branchId=${branchId}` : ''}`;

async function financeList(from: string, to: string, branchId?: string): Promise<Json> {
  const res = await call('finance', 'GET', `${FINANCE}${window(from, to, branchId)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

const rowOf = (list: Json, branchId: string, date: string): Json =>
  list.records.find((r: Json) => r.branchId === branchId && r.businessDate === date);

/**
 * A record as both endpoints must agree on it.
 *
 * `generatedAt` is dropped because a day with no stored record has none, and the
 * service fills the column with the time of the request.
 */
function sourceValues(row: Json): Json {
  const { reconciliation: _reconciliation, generatedAt: _generatedAt, ...rest } = row;
  return rest;
}

// ── Seeding ──────────────────────────────────────────────────────────────────
let orderSeq = 0;
async function order(o: {
  branch: string;
  method: string;
  total: number;
  at: string;
  discount?: number;
  status?: string;
}): Promise<string> {
  orderSeq += 1;
  const { rows } = await db.query<{ id: string }>(
    `insert into orders (order_number, branch_id, subtotal, discount_total, grand_total, payment_method, status, business_date, created_at)
     values ($1, $2, $3, $4, $5, $6::payment_method, $7::order_status, app.business_date($8::timestamptz), $8::timestamptz)
     returning id`,
    [`ORD-${orderSeq}`, o.branch, o.total + (o.discount ?? 0), o.discount ?? 0, o.total, o.method, o.status ?? 'delivered', o.at],
  );
  return rows[0]!.id;
}

let depositSeq = 0;
async function deposit(d: {
  branch: string;
  date: string;
  status: 'pending' | 'approved' | 'rejected';
  cash?: number;
  easypaisa?: number;
  bank?: number;
  fuel?: number;
}): Promise<string> {
  depositSeq += 1;
  const cash = d.cash ?? 0;
  const easypaisa = d.easypaisa ?? 0;
  const bank = d.bank ?? 0;
  const { rows } = await db.query<{ id: string }>(
    `insert into cash_transfers
       (transfer_no, branch_id, branch_name, amount, cash_amount, easypaisa_amount, bank_amount, fuel_charges,
        business_date, status, approved_at, ledger_entry_id, voucher_no, rejection_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::cash_transfer_status,
             case when $10 = 'pending' then null else now() end,
             case when $10 = 'approved' then gen_random_uuid() end,
             case when $10 = 'approved' then $11 end,
             case when $10 = 'rejected' then 'slip unreadable' end)
     returning id`,
    [
      `CT-${depositSeq}`, d.branch, d.branch === A ? 'Gulberg' : 'Saddar',
      cash + easypaisa + bank, cash, easypaisa, bank, d.fuel ?? 0, d.date, d.status, `RV-${depositSeq}`,
    ],
  );
  return rows[0]!.id;
}

/** What must not move when Finance only looks. */
async function footprint(): Promise<Json> {
  const { rows } = await db.query(
    `select (select count(*) from orders)::int as orders,
            (select coalesce(sum(grand_total), 0) from orders)::float8 as order_value,
            (select count(*) from daily_sale_records)::int as records,
            (select count(*) from daily_sale_record_audits)::int as audits,
            (select count(*) from cash_transfers)::int as deposits`,
  );
  return rows[0];
}

const ORDER: Record<string, string> = {};

before(async () => {
  process.env['JWT_SECRET'] = 'finance-daily-sales-test-secret-0123456789abcdef';

  db = new PGlite();
  await db.exec(STUBS);
  for (const t of [
    'payment_method', 'order_status', 'expense_payment_method',
    'daily_sale_record_status', 'daily_sale_audit_action', 'cash_transfer_status',
  ]) {
    await db.exec(type(t));
  }
  await db.exec(fn('app.business_date'));
  for (const t of [
    'orders', 'expenses', 'daily_sale_records', 'daily_sale_record_audits',
    'payment_method_settings', 'cash_transfers', 'finance_settings',
  ]) {
    await db.exec(table(t));
  }
  await db.exec(`
    alter table public.daily_sale_records add primary key (id);
    alter table public.daily_sale_records
      add constraint daily_sale_records_branch_date_key unique (branch_id, business_date);
    insert into finance_settings default values;
  `);
  await db.exec(fn('public.daily_sale_figures'));
  await db.exec(fn('public.ensure_daily_sale_record'));
  await db.exec(`begin;${AUTH}commit;`);

  await db.exec(`
    insert into branches (id, name, address, phone, city) values
      ('${A}', 'Gulberg', '12 Main Boulevard', '042-111', 'Lahore'),
      ('${B}', 'Saddar', '4 Bank Road', '051-222', 'Rawalpindi');
  `);

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);

  for (const [name, a] of Object.entries(ACTORS)) {
    await db.query(
      `insert into users (id, email, display_name, role, branch_id, branch_name) values ($1, $2, $3, $4, $5, $6)`,
      [a.id, a.email, name, a.role, a.branchId ?? null, a.branchName ?? null],
    );
    const session = await prisma.auth_sessions.create({
      data: { user_id: a.id, client: 'web', expires_at: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    TOKENS[name] = signAccessToken(a.id, session.id).token;
  }

  // ── D1 at Gulberg: every payment method, a staff sale and a void ──────────
  // Midday Karachi, well inside the business day.
  const noon = `${D1}T07:00:00Z`;
  ORDER['cash'] = await order({ branch: A, method: 'cash', total: 1000, discount: 50, at: noon });
  ORDER['easypaisa'] = await order({ branch: A, method: 'easypaisa', total: 400, at: noon });
  ORDER['foodpanda'] = await order({ branch: A, method: 'foodpanda', total: 300, at: noon });
  ORDER['bank'] = await order({ branch: A, method: 'bank_account', total: 200, at: noon });
  await order({ branch: A, method: 'staff', total: 150, at: noon });
  await order({ branch: A, method: 'cash', total: 999, at: noon, status: 'cancelled' });
  await db.exec(`
    insert into expenses (branch_id, branch_name, business_date, description, payment_method, amount, category) values
      ('${A}', 'Gulberg', '${D1}', 'Milk', 'cash', 100, 'supplies'),
      ('${A}', 'Gulberg', '${D1}', 'Rider', 'easypaisa', 30, 'delivery');
  `);

  // ── Saddar: one ordinary sale, and one either side of the 02:00 rollover ──
  // Karachi 01:59 on the 11th is still the 10th's business day; 02:00 is not.
  await order({ branch: B, method: 'cash', total: 500, at: noon });
  await order({ branch: B, method: 'cash', total: 70, at: '2026-09-10T20:59:00Z' });
  await order({ branch: B, method: 'cash', total: 80, at: '2026-09-10T21:00:00Z' });

  const express = (await import('express')).default;
  const { router: finance } = await import('../../routes/finance-daily-sales.routes');
  const { router: branch } = await import('../../routes/daily-sale.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(FINANCE, finance);
  app.use(BRANCH, branch);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('who may read it', () => {
  test('no token → 401', async () => {
    assert.equal((await call(null, 'GET', `${FINANCE}${window(D1, D1)}`)).status, 401);
    assert.equal((await call(null, 'GET', `${FINANCE}/day?branchId=${A}&date=${D1}`)).status, 401);
  });

  test('a branch manager and a production user are refused — on the list and on a day', async () => {
    for (const who of ['branchA', 'production']) {
      assert.equal((await call(who, 'GET', `${FINANCE}${window(D1, D1)}`)).status, 403, who);
      assert.equal((await call(who, 'GET', `${FINANCE}/day?branchId=${B}&date=${D1}`)).status, 403, who);
    }
  });

  test('every finance role and the super admin may look', async () => {
    for (const who of ['finance', 'auditor', 'accountant', 'owner']) {
      assert.equal((await call(who, 'GET', `${FINANCE}${window(D1, D1)}`)).status, 200, who);
    }
  });

  test('finance roles still cannot reach the branch router, where records are written', async () => {
    assert.equal((await call('finance', 'GET', `${BRANCH}${window(D1, D1)}`)).status, 403);
    assert.equal(
      (await call('finance', 'POST', `${BRANCH}/generate`, { businessDate: D1, branchId: A })).status,
      403,
    );
  });
});

describe('Finance sees the day the branch recorded', () => {
  test('a saved sale appears without anyone re-entering it, with the branch page\'s figures', async () => {
    const list = await financeList(D1, D1);
    const a = rowOf(list, A, D1);
    assert.ok(a, 'Gulberg has a row for D1');
    assert.equal(a.branchName, 'Gulberg');
    assert.equal(a.autoTotalSale, 1900); // staff and the void are not sales
    assert.equal(a.autoCash, 1000);
    assert.equal(a.autoEasypaisa, 400);
    assert.equal(a.autoFoodpanda, 300);
    assert.equal(a.autoBank, 200);
    assert.equal(a.autoStaff, 150);
    assert.equal(a.discount, 50);
    assert.equal(a.cashExpense, 100);
    assert.equal(a.expenseTotal, 130);
    assert.equal(a.expectedCashInHand, 900);
    assert.equal(a.orderCount, 4);
    assert.equal(a.id, null);
    assert.equal(a.status, 'open');
  });

  test('one row per branch per day — a branch is never listed twice', async () => {
    const list = await financeList(D1, D2);
    const keys = list.records.map((r: Json) => `${r.branchId}|${r.businessDate}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual([...keys].sort(), [`${A}|${D1}`, `${B}|${D1}`, `${B}|${D2}`].sort());
  });

  test('the same source values as the branch manager\'s own endpoint', async () => {
    const mine = await call('branchA', 'GET', `${BRANCH}${window(D1, D1)}`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.records.length, 1);

    const finance = await financeList(D1, D1, A);
    assert.equal(finance.records.length, 1);
    assert.deepEqual(sourceValues(finance.records[0]), sourceValues(mine.body.records[0]));
    assert.deepEqual(finance.summary, mine.body.summary);
  });

  test('the same rows, in the same order, as the super admin\'s consolidated view', async () => {
    const admin = await call('owner', 'GET', `${BRANCH}${window(D1, D2)}`);
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const finance = await financeList(D1, D2);
    assert.deepEqual(finance.records.map(sourceValues), admin.body.records.map(sourceValues));
    assert.deepEqual(finance.summary, admin.body.summary);
  });

  test('asking again returns the same thing and writes nothing', async () => {
    const before = await footprint();
    const first = await financeList(D1, D2);
    const second = await financeList(D1, D2);
    const third = await financeList(D1, D2);
    assert.deepEqual(second.records.map(sourceValues), first.records.map(sourceValues));
    assert.deepEqual(third.reconciliation, first.reconciliation);
    assert.deepEqual(await footprint(), before);
    // Looking is not generating: no record was created on Finance's behalf.
    assert.equal(before.records, 0);
  });
});

describe('business dates', () => {
  test('a sale at 01:59 belongs to the day before; one at 02:00 starts the next', async () => {
    const list = await financeList(D1, D2);
    assert.equal(rowOf(list, B, D1).autoCash, 570);
    assert.equal(rowOf(list, B, D2).autoCash, 80);
    assert.equal(rowOf(list, A, D2), undefined);
  });

  test('changing the date replaces the rows, and going back restores them', async () => {
    const first = await financeList(D1, D1);
    const next = await financeList(D2, D2);
    const back = await financeList(D1, D1);

    assert.ok(first.records.every((r: Json) => r.businessDate === D1));
    assert.ok(next.records.every((r: Json) => r.businessDate === D2));
    assert.equal(next.records.length, 1);
    assert.deepEqual(back.records.map(sourceValues), first.records.map(sourceValues));
  });

  test('a day nobody traded is empty, with zero totals', async () => {
    const list = await financeList(EMPTY_DAY, EMPTY_DAY);
    assert.deepEqual(list.records, []);
    assert.equal(list.summary.totalSale, 0);
    assert.equal(list.reconciliation.expected, 0);
    assert.deepEqual(list.unmatchedDeposits, []);
  });

  test('with no dates the window is one business day', async () => {
    const res = await call('finance', 'GET', FINANCE);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.from, res.body.to);
  });

  test('one date stands for both ends', async () => {
    const res = await call('finance', 'GET', `${FINANCE}?from=${D1}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.from, D1);
    assert.equal(res.body.to, D1);
  });

  test('a bad window is refused, not guessed at', async () => {
    assert.equal((await call('finance', 'GET', `${FINANCE}${window(D2, D1)}`)).status, 400);
    assert.equal((await call('finance', 'GET', `${FINANCE}?from=10-09-2026&to=${D1}`)).status, 400);
    assert.equal((await call('finance', 'GET', `${FINANCE}${window('2026-01-01', D1)}`)).status, 400);
  });
});

describe('the branch filter', () => {
  test('one branch shows only that branch', async () => {
    const list = await financeList(D1, D2, B);
    assert.equal(list.branchId, B);
    assert.equal(list.branchName, 'Saddar');
    assert.equal(list.records.length, 2);
    assert.ok(list.records.every((r: Json) => r.branchId === B));
    assert.equal(list.summary.totalSale, 650);
  });

  test('an unknown branch is a 404 and a malformed id a 400', async () => {
    assert.equal((await call('finance', 'GET', `${FINANCE}${window(D1, D1, UNKNOWN_BRANCH)}`)).status, 404);
    assert.equal((await call('finance', 'GET', `${FINANCE}${window(D1, D1, 'gulberg')}`)).status, 400);
  });

  test('every branch over a window too wide to read whole is refused rather than truncated', async () => {
    const prior = process.env['DB_MAX_ROWS'];
    process.env['DB_MAX_ROWS'] = '10';
    try {
      // Two branches × (six days + the two-day lead-in) is sixteen possible rows
      // against a ceiling of ten.
      const all = await call('finance', 'GET', `${FINANCE}${window('2026-09-06', D2)}`);
      assert.equal(all.status, 400, JSON.stringify(all.body));
      assert.match(all.body.error, /Choose one branch/);
      const one = await call('finance', 'GET', `${FINANCE}${window('2026-09-06', D2, A)}`);
      assert.equal(one.status, 200, JSON.stringify(one.body));
    } finally {
      if (prior === undefined) delete process.env['DB_MAX_ROWS'];
      else process.env['DB_MAX_ROWS'] = prior;
    }
  });
});

describe('changes to a sale', () => {
  test('an edited sale and a voided one are reflected on the next read', async () => {
    await db.query(`update orders set grand_total = 1200, subtotal = 1250 where id = $1`, [ORDER['cash']]);
    await db.query(`update orders set status = 'cancelled' where id = $1`, [ORDER['bank']]);

    const a = rowOf(await financeList(D1, D1), A, D1);
    assert.equal(a.autoCash, 1200);
    assert.equal(a.autoBank, 0);
    assert.equal(a.autoTotalSale, 1900);
    assert.equal(a.expectedCashInHand, 1100);
    assert.equal(a.orderCount, 3);

    const mine = await call('branchA', 'GET', `${BRANCH}${window(D1, D1)}`);
    assert.deepEqual(sourceValues(a), sourceValues(mine.body.records[0]));
  });
});

// Gulberg's D1 now records a Total Sale of 1,900. At the default 75% that is a
// Company Share of 1,425 — what the branch owes for the day, and what its deposit
// is looked for by. Saddar's D1 share is 427.50.
describe('the Company Share against the deposit that paid it', () => {
  let recordBefore: Json;
  let ordersBefore: Json;
  let first: string;
  let extra: string;

  const reconciliation = async () => rowOf(await financeList(D1, D1), A, D1).reconciliation;

  test('nothing deposited → not received, and the whole share is outstanding', async () => {
    const a = rowOf(await financeList(D1, D1), A, D1);
    recordBefore = sourceValues(a);
    ordersBefore = await footprint();

    assert.equal(a.companyShare, 1425);
    assert.equal(a.reconciliation.status, 'not_received');
    assert.equal(a.reconciliation.expected, 1425);
    assert.equal(a.reconciliation.difference, 1425);
    assert.equal(a.reconciliation.match, 'none');
    assert.equal(a.reconciliation.provisional, true);
  });

  test('a deposit of the same amount handed over the NEXT day is found, and while pending is not counted', async () => {
    first = await deposit({ branch: A, date: D2, status: 'pending', cash: 1025, easypaisa: 400 });
    const r = await reconciliation();
    assert.equal(r.status, 'pending');
    assert.equal(r.received, 0);
    assert.equal(r.pending, 1425);
    assert.equal(r.difference, 1425);
    assert.equal(r.deposits.length, 1);
    assert.equal(r.deposits[0].businessDate, D2);
    assert.equal(r.deposits[0].status, 'pending');
  });

  test('once Finance has approved it the day is matched', async () => {
    await db.query(
      `update cash_transfers set status = 'approved', approved_at = now(), ledger_entry_id = gen_random_uuid(), voucher_no = 'RV-1' where id = $1`,
      [first],
    );
    const r = await reconciliation();
    assert.equal(r.status, 'matched');
    assert.equal(r.match, 'amount');
    assert.equal(r.received, 1425);
    assert.equal(r.difference, 0);
    assert.equal(r.deposits[0].voucherNo, 'RV-1');
    assert.equal(r.approvedCount, 1);
  });

  test('the deposit that paid D1 is not also set against the day it was handed over', async () => {
    // Saddar is the only branch with a row on D2; Gulberg's deposit is dated D2.
    const list = await financeList(D2, D2);
    assert.equal(rowOf(list, B, D2).reconciliation.deposits.length, 0);
    // Claimed by D1, just outside this window — so it is not "unmatched" either.
    assert.deepEqual(list.unmatchedDeposits, []);
  });

  test('a second deposit that matches nothing is reported as unmatched, and the day stays matched', async () => {
    extra = await deposit({ branch: A, date: D1, status: 'approved', cash: 50 });
    const list = await financeList(D1, D1);
    assert.equal(rowOf(list, A, D1).reconciliation.status, 'matched');
    assert.equal(rowOf(list, A, D1).reconciliation.received, 1425);
    assert.deepEqual(list.unmatchedDeposits.map((d: Json) => d.id), [extra]);
  });

  test('a deposit deleted through the Help Desk drops out', async () => {
    await db.query(`update cash_transfers set deleted_at = now() where id = $1`, [extra]);
    const list = await financeList(D1, D1);
    assert.deepEqual(list.unmatchedDeposits, []);
    assert.equal(rowOf(list, A, D1).reconciliation.status, 'matched');
  });

  test('a rejected deposit and a fuel-only one are not receipts', async () => {
    await deposit({ branch: A, date: D1, status: 'rejected', cash: 1425 });
    await deposit({ branch: A, date: D1, status: 'approved', fuel: 200 });
    const list = await financeList(D1, D1);
    const r = rowOf(list, A, D1).reconciliation;
    assert.equal(r.status, 'matched');
    assert.equal(r.deposits.length, 1);
    assert.deepEqual(list.unmatchedDeposits, []);
  });

  test('a deposit of a different amount is shown as the nearest one and flagged', async () => {
    await db.query(`update cash_transfers set cash_amount = 925, amount = 1325 where id = $1`, [first]);
    const r = await reconciliation();
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.match, 'nearest');
    assert.equal(r.received, 1325);
    assert.equal(r.difference, 100);
  });

  test('none of that changed the record, the sales, or created anything', async () => {
    const a = rowOf(await financeList(D1, D1), A, D1);
    assert.deepEqual(sourceValues(a), recordBefore);

    const now = await footprint();
    assert.equal(now.orders, ordersBefore.orders);
    assert.equal(now.order_value, ordersBefore.order_value);
    assert.equal(now.records, 0);
    assert.equal(now.audits, 0);
  });

  test('another branch\'s deposits never land on this one', async () => {
    const list = await financeList(D1, D1);
    assert.equal(rowOf(list, B, D1).reconciliation.status, 'not_received');
    assert.equal(rowOf(list, B, D1).reconciliation.expected, 427.5);
    assert.equal(rowOf(list, B, D1).reconciliation.deposits.length, 0);
  });

  test('the window\'s totals count each branch day once', async () => {
    const list = await financeList(D1, D1);
    assert.deepEqual(list.reconciliation.counts, {
      nothing_due: 0, not_received: 1, pending: 0, matched: 0, discrepancy: 1,
    });
    assert.equal(list.reconciliation.expected, 1852.5);
    assert.equal(list.reconciliation.received, 1325);
    assert.equal(list.reconciliation.difference, 527.5);
  });

  test('a deposit dated on the window\'s first day that paid the day BEFORE the window is not given to that first day', async () => {
    // Saddar traded the day before D1 for 400 — a share of 300 — and handed it
    // over on D1. Asked about D1 alone, that 300 must not be read as D1's money.
    const D0 = '2026-09-09';
    await order({ branch: B, method: 'cash', total: 400, at: `${D0}T07:00:00Z` });
    const paid = await deposit({ branch: B, date: D1, status: 'approved', cash: 300 });

    const d1 = await financeList(D1, D1);
    assert.equal(rowOf(d1, B, D1).reconciliation.status, 'not_received');
    assert.equal(rowOf(d1, B, D1).reconciliation.deposits.length, 0);
    assert.deepEqual(d1.unmatchedDeposits, []);
    assert.ok(d1.records.every((r: Json) => r.businessDate === D1));

    const d0 = await financeList(D0, D0);
    const r = rowOf(d0, B, D0).reconciliation;
    assert.equal(r.status, 'matched');
    assert.equal(r.deposits[0].id, paid);
    assert.equal(r.deposits[0].businessDate, D1);
  });

  test('a deposit that matches no day is reported, not forced onto one', async () => {
    const orphan = await deposit({ branch: A, date: EMPTY_DAY, status: 'approved', cash: 250 });
    const list = await financeList(EMPTY_DAY, EMPTY_DAY);
    assert.deepEqual(list.records, []);
    assert.equal(list.unmatchedDeposits.length, 1);
    assert.equal(list.unmatchedDeposits[0].id, orphan);
    assert.equal(list.unmatchedDeposits[0].branchName, 'Gulberg');
    assert.equal(list.unmatchedDeposits[0].businessDate, EMPTY_DAY);

    // And it does not leak into another day.
    assert.equal(rowOf(await financeList(D1, D1), A, D1).reconciliation.deposits.length, 1);
  });
});

describe('a day the branch has opened and signed off', () => {
  let recordId: string;

  test('once the branch generates the record, Finance shows that same record', async () => {
    const made = await call('branchA', 'POST', `${BRANCH}/generate`, { businessDate: D1 });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    recordId = made.body.record.id;
    assert.ok(recordId);

    const a = rowOf(await financeList(D1, D1), A, D1);
    assert.equal(a.id, recordId);
    assert.equal(a.autoCash, 1200);
    assert.equal((await financeList(D1, D1)).records.filter((r: Json) => r.branchId === A).length, 1);
  });

  test('generating it twice leaves one record', async () => {
    const again = await call('branchA', 'POST', `${BRANCH}/generate`, { businessDate: D1 });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.record.id, recordId);
    assert.equal((await footprint()).records, 1);
  });

  test('a signed-off record keeps its figures when a late sale arrives', async () => {
    // The sign-off itself is the branch's and is covered by its own functions;
    // here the record is put in the state they leave it in.
    await db.query(`update daily_sale_records set status = 'verified', verified_at = now() where id = $1`, [recordId]);
    await order({ branch: A, method: 'cash', total: 999, at: `${D1}T09:00:00Z` });

    const a = rowOf(await financeList(D1, D1), A, D1);
    assert.equal(a.status, 'verified');
    assert.equal(a.autoCash, 1200);
    assert.equal(a.reconciliation.provisional, false);

    const mine = await call('branchA', 'GET', `${BRANCH}${window(D1, D1)}`);
    assert.deepEqual(sourceValues(a), sourceValues(mine.body.records[0]));
  });
});

describe('one day in full', () => {
  test('a day with a stored record comes with its history and the branch header', async () => {
    const res = await call('auditor', 'GET', `${FINANCE}/day?branchId=${A}&date=${D1}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.record.branchId, A);
    assert.equal(res.body.record.businessDate, D1);
    assert.ok(res.body.record.id);
    assert.ok(res.body.audits.length >= 1);
    assert.equal(res.body.audits.at(-1).action, 'generated');
    assert.deepEqual(res.body.branch, {
      id: A, name: 'Gulberg', address: '12 Main Boulevard', phone: '042-111', city: 'Lahore',
    });

    const mine = await call('branchA', 'GET', `${BRANCH}/${res.body.record.id}`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(sourceValues(res.body.record), sourceValues(mine.body.record));
  });

  test('a day with sales but no record is shown live, and no record is created for it', async () => {
    const before = await footprint();
    const res = await call('auditor', 'GET', `${FINANCE}/day?branchId=${B}&date=${D1}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.record.id, null);
    assert.equal(res.body.record.autoCash, 570);
    assert.deepEqual(res.body.audits, []);
    assert.equal(res.body.branch.name, 'Saddar');
    assert.deepEqual(await footprint(), before);
  });

  test('a day with nothing recorded is a 404; a missing or malformed branch a 400; an unknown one a 404', async () => {
    assert.equal((await call('auditor', 'GET', `${FINANCE}/day?branchId=${B}&date=${EMPTY_DAY}`)).status, 404);
    assert.equal((await call('auditor', 'GET', `${FINANCE}/day?date=${D1}`)).status, 400);
    assert.equal((await call('auditor', 'GET', `${FINANCE}/day?branchId=saddar&date=${D1}`)).status, 400);
    assert.equal((await call('auditor', 'GET', `${FINANCE}/day?branchId=${UNKNOWN_BRANCH}&date=${D1}`)).status, 404);
    assert.equal((await call('auditor', 'GET', `${FINANCE}/day?branchId=${B}&date=yesterday`)).status, 400);
  });
});
