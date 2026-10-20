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
import { businessDaysAgoStr } from '../../shared';

/**
 * The figures above Finance's Cash Transfers board —
 * GET /api/finance/cash-transfers/summary — run for real in pglite over the
 * baseline's own `cash_transfers`, through the real router and middleware.
 *
 * The point of the endpoint is that it counts the rows the list shows, so most
 * of these ask the list and the summary the same question and compare: the
 * rolling 30-day default (and its absence for a pending queue), the channel
 * filter, search, branch, and soft-deleted rows out of both.
 *
 * Dates are relative to today, because the default window is.
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

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create function app.next_finance_number(p_key text, p_prefix text) returns text language sql as
    $$ select p_prefix || '-' || substr(gen_random_uuid()::text, 1, 8) $$;
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table business_day_closures (business_date date primary key, status text not null);
  create table branches (id uuid primary key default gen_random_uuid(), name text not null, is_active boolean not null default true);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
`;

const A = '40000000-0000-4000-8000-00000000000a'; // Gulberg
const B = '40000000-0000-4000-8000-00000000000b'; // Saddar

let db: PGlite;
let server: Server;
let base: string;

interface Actor { id: string; email: string; role: string; branchId: string | null; branchName: string | null }
const ACTORS: Record<string, Actor> = {
  finance: { id: '50000000-0000-4000-8000-000000000001', email: 'fadmin@mb.test', role: 'finance_admin', branchId: null, branchName: null },
  auditor: { id: '50000000-0000-4000-8000-000000000002', email: 'auditor@mb.test', role: 'finance_auditor', branchId: null, branchName: null },
  admin: { id: '50000000-0000-4000-8000-000000000003', email: 'admin@mb.test', role: 'super_admin', branchId: null, branchName: null },
  'branch-a': { id: '50000000-0000-4000-8000-000000000004', email: 'a@mb.test', role: 'branch_manager', branchId: A, branchName: 'Gulberg' },
  production: { id: '50000000-0000-4000-8000-000000000005', email: 'prod@mb.test', role: 'production_user', branchId: null, branchName: null },
};
const TOKENS: Record<string, string> = {};

const PATH = '/api/finance/cash-transfers';

async function call(as: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKENS[as]}` } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function summary(query = '') {
  const res = await call('finance', `${PATH}/summary${query ? `?${query}` : ''}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function list(query = '') {
  const res = await call('finance', `${PATH}?limit=200${query ? `&${query}` : ''}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { transfers: { transferNo: string; amount: number }[]; total: number };
}

let seq = 0;
/** One deposit, in a state the decision CHECK accepts. Returns its transfer number. */
async function addTransfer(
  branch: string,
  ch: { cash?: number; easypaisa?: number; bank?: number; fuel?: number },
  status: 'pending' | 'approved' | 'rejected',
  daysAgo: number,
  opts: { note?: string; deleted?: boolean } = {},
): Promise<string> {
  const cash = ch.cash ?? 0, easypaisa = ch.easypaisa ?? 0, bank = ch.bank ?? 0;
  const transferNo = `CT-${String(++seq).padStart(6, '0')}`;
  const decided = status !== 'pending';
  await db.query(
    `insert into cash_transfers (transfer_no, branch_id, branch_name, amount, cash_amount, easypaisa_amount, bank_amount,
                                 fuel_charges, status, business_date, note, voucher_no, ledger_entry_id, approved_at,
                                 rejection_reason, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      transferNo, branch, branch === A ? 'Gulberg' : 'Saddar', cash + easypaisa + bank, cash, easypaisa, bank, ch.fuel ?? 0,
      status, businessDaysAgoStr(daysAgo), opts.note ?? null,
      status === 'approved' ? `RV-${String(seq).padStart(6, '0')}` : null,
      status === 'approved' ? '60000000-0000-4000-8000-000000000001' : null,
      decided ? new Date().toISOString() : null,
      status === 'rejected' ? 'slip unreadable' : null,
      opts.deleted ? new Date().toISOString() : null,
    ],
  );
  return transferNo;
}

before(async () => {
  process.env['JWT_SECRET'] = 'finance-cash-transfers-summary-test-secret-0123456789';

  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(type('cash_transfer_status'));
  await db.exec(type('attachment_entity'));
  for (const t of ['cash_transfers', 'attachments', 'finance_settings']) await db.exec(table(t));
  await db.exec('insert into finance_settings default values;');
  await db.exec(`begin;${AUTH}commit;`);

  await db.query(`insert into branches (id, name) values ($1, 'Gulberg'), ($2, 'Saddar')`, [A, B]);

  // Inside the default 30-day window
  await addTransfer(A, { cash: 10000, bank: 5000, fuel: 300 }, 'approved', 2, { note: 'morning drop' }); // CT-000001
  await addTransfer(A, { easypaisa: 1500.5, fuel: 200 }, 'pending', 3, { note: 'evening' }); //            CT-000002
  await addTransfer(A, { cash: 700 }, 'rejected', 4); //                                                    CT-000003
  await addTransfer(A, { fuel: 400 }, 'approved', 5); // fuel only, Total 0                               CT-000004
  await addTransfer(B, { cash: 2000, easypaisa: 250 }, 'pending', 1, { note: 'float return' }); //         CT-000005
  await addTransfer(B, { easypaisa: 3000 }, 'approved', 6); //                                              CT-000006
  // Before the window
  await addTransfer(A, { cash: 9000 }, 'pending', 60); // an old pending handover                         CT-000007
  await addTransfer(B, { bank: 800 }, 'approved', 45); //                                                   CT-000008
  // Soft-deleted through the Help Desk: in no figure and no list
  await addTransfer(A, { cash: 6000 }, 'pending', 2, { deleted: true }); //                                CT-000009

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
  const { router } = await import('../../routes/finance-cash-transfers.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(PATH, router);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

describe('summary — the default window', () => {
  test('totals per channel, with fuel apart from the Total, over the last 30 business days', async () => {
    const s = await summary();
    assert.equal(s.from, businessDaysAgoStr(29));
    assert.equal(s.to, null);
    assert.deepEqual(s.totals, {
      count: 6,
      amount: 22450.5, // 12,700 cash + 4,750.50 Easypaisa + 5,000 bank
      cash: 12700,
      easypaisa: 4750.5,
      bank: 5000,
      fuel: 900,
    });
  });

  test('status buckets split the same rows, and add up to the totals', async () => {
    const s = await summary();
    assert.deepEqual(s.pending, { count: 2, amount: 3750.5 });
    assert.deepEqual(s.approved, { count: 3, amount: 18000 }, 'the fuel-only deposit is counted at a Total of 0');
    assert.deepEqual(s.rejected, { count: 1, amount: 700 });
    assert.equal(s.pending.count + s.approved.count + s.rejected.count, s.totals.count);
    assert.equal(s.pending.amount + s.approved.amount + s.rejected.amount, s.totals.amount);
  });

  test('every figure is a JSON number, never a numeric string', async () => {
    const s = await summary();
    for (const v of [...Object.values(s.totals), ...Object.values(s.pending), ...Object.values(s.approved), ...Object.values(s.rejected)]) {
      assert.equal(typeof v, 'number');
    }
  });

  test('an empty match is zeros, not missing figures', async () => {
    const s = await summary('search=nothing-matches-this');
    assert.deepEqual(s.totals, { count: 0, amount: 0, cash: 0, easypaisa: 0, bank: 0, fuel: 0 });
    assert.deepEqual(s.pending, { count: 0, amount: 0 });
    assert.deepEqual(s.approved, { count: 0, amount: 0 });
    assert.deepEqual(s.rejected, { count: 0, amount: 0 });
  });
});

describe('summary — filters', () => {
  test('status=pending drops the 30-day default: an old handover is still in the queue', async () => {
    const s = await summary('status=pending');
    assert.equal(s.from, null);
    assert.deepEqual(s.totals, { count: 3, amount: 12750.5, cash: 11000, easypaisa: 1750.5, bank: 0, fuel: 200 });
    assert.deepEqual(s.pending, { count: 3, amount: 12750.5 });
    assert.deepEqual(s.approved, { count: 0, amount: 0 });
  });

  test('any other status keeps the default window', async () => {
    const s = await summary('status=approved');
    assert.equal(s.from, businessDaysAgoStr(29));
    assert.deepEqual(s.approved, { count: 3, amount: 18000 }, 'not the approved deposit from 45 days ago');
  });

  test('an explicit range wins over the default', async () => {
    const s = await summary(`from=${businessDaysAgoStr(60)}&to=${businessDaysAgoStr(40)}`);
    assert.equal(s.from, businessDaysAgoStr(60));
    assert.equal(s.to, businessDaysAgoStr(40));
    assert.deepEqual(s.totals, { count: 2, amount: 9800, cash: 9000, easypaisa: 0, bank: 800, fuel: 0 });
  });

  test('paymentMethod=easypaisa counts only deposits that carried Easypaisa money', async () => {
    const s = await summary('paymentMethod=easypaisa');
    assert.deepEqual(s.totals, { count: 3, amount: 6750.5, cash: 2000, easypaisa: 4750.5, bank: 0, fuel: 200 });
  });

  test('search narrows over transfer no, voucher no, branch and note', async () => {
    assert.equal((await summary('search=Saddar')).totals.count, 2);
    assert.equal((await summary('search=CT-000003')).totals.count, 1);
    assert.equal((await summary('search=RV-000006')).totals.amount, 3000);
    assert.equal((await summary('search=float')).totals.count, 1);
    assert.equal((await summary('search=(Saddar)')).totals.count, 2, 'filter syntax is stripped, as the list strips it');
  });

  test('branchId narrows to one branch', async () => {
    const s = await summary(`branchId=${B}`);
    assert.deepEqual(s.totals, { count: 2, amount: 5250, cash: 2000, easypaisa: 3250, bank: 0, fuel: 0 });
  });

  test('a soft-deleted deposit is in no figure', async () => {
    // Gulberg's pending queue: CT-000002 and the old CT-000007 — never the deleted CT-000009.
    const s = await summary(`status=pending&branchId=${A}`);
    assert.deepEqual(s.pending, { count: 2, amount: 10500.5 });
  });
});

describe('summary and list agree', () => {
  const QUERIES = [
    '',
    'status=pending',
    'status=approved',
    'status=rejected',
    'paymentMethod=cash',
    'paymentMethod=easypaisa',
    'paymentMethod=bank_account',
    'search=Saddar',
    'search=CT-00000',
    'search=(Saddar)',
    `branchId=${A}`,
    `branchId=${B}&status=pending`,
    `from=${businessDaysAgoStr(90)}`,
    `from=${businessDaysAgoStr(60)}&to=${businessDaysAgoStr(40)}`,
    'status=nonsense&paymentMethod=nonsense',
  ];

  for (const q of QUERIES) {
    test(`same rows for ?${q || '(defaults)'}`, async () => {
      const [s, l] = await Promise.all([summary(q), list(q)]);
      assert.equal(s.totals.count, l.total);
      assert.equal(l.transfers.length, l.total, 'the whole list fits one page here');
      const listed = Math.round(l.transfers.reduce((t, r) => t + r.amount, 0) * 100) / 100;
      assert.equal(s.totals.amount, listed);
      assert.ok(!l.transfers.some((r) => r.transferNo === 'CT-000009'), 'the deleted deposit is not listed');
    });
  }
});

describe('who may read it', () => {
  test('every finance role and super_admin may view it', async () => {
    for (const who of ['finance', 'auditor', 'admin']) {
      const res = await call(who, `${PATH}/summary`);
      assert.equal(res.status, 200, `${who}: ${JSON.stringify(res.body)}`);
    }
  });

  test('a branch manager and a production user are refused', async () => {
    assert.equal((await call('branch-a', `${PATH}/summary`)).status, 403);
    assert.equal((await call('branch-a', `${PATH}/summary?branchId=${A}`)).status, 403);
    assert.equal((await call('production', `${PATH}/summary`)).status, 403);
  });

  test('"summary" is not read as a transfer id', async () => {
    const res = await call('finance', `${PATH}/summary`);
    assert.equal(res.status, 200);
    assert.ok('totals' in res.body);
  });
});
