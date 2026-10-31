import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';

/**
 * Refundable & Receivable Loans end to end (migration
 * 20261031000001_finance_loans): the real migration over the baseline's
 * finance tables, the real routes behind real access tokens, and the two
 * exports — the loan ledger's own PDF/Excel and the Daily Ledger's accounting
 * workbook, whose Balance Sheet carries the loans as a memorandum.
 *
 * The client is the loan spec's §18 scenario: loans 100 000 + 50 000 +
 * 25 000, payments 30 000 + 20 000 → debit 175 000, credit 50 000,
 * balance 125 000.
 *
 * DB_MAX_ROWS is 3 so the client list only comes back whole if it pages.
 */

const PRISMA = join(__dirname, '../../../prisma/migrations');
const BASELINE = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
const MIGRATION = readFileSync(join(PRISMA, '20261031000001_finance_loans/migration.sql'), 'utf8');
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
const fn = (signature: string) => lift(`CREATE FUNCTION ${signature}(`, '$$;');

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create table counters (id text primary key, count bigint not null);
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table branches (id uuid primary key default gen_random_uuid(), name text, company_share_pct numeric);
  create table cash_transfers (
    id uuid primary key default gen_random_uuid(),
    cash_amount numeric not null default 0, easypaisa_amount numeric not null default 0,
    bank_amount numeric not null default 0, deleted_at timestamptz);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
`;

const GULBERG = '40000000-0000-4000-8000-000000000001';
const ACTORS = {
  accountant: { id: '20000000-0000-4000-8000-000000000001', email: 'accountant@mb.test', role: 'accountant' },
  admin: { id: '20000000-0000-4000-8000-000000000002', email: 'fadmin@mb.test', role: 'finance_admin' },
  auditor: { id: '20000000-0000-4000-8000-000000000003', email: 'auditor@mb.test', role: 'finance_auditor' },
  branch: { id: '20000000-0000-4000-8000-000000000004', email: 'branch@mb.test', role: 'branch_manager' },
} as const;
type Who = keyof typeof ACTORS;
const TOKENS: Record<string, string> = {};
const HEAD: Record<string, string> = {};

const LOANS = '/api/finance/loans';

let db: PGlite;
let server: Server;
let base: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(as: Who | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { Authorization: `Bearer ${TOKENS[as]}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const ok = (r: { status: number; body: Json }, status = 200): Json => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
async function download(as: Who, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKENS[as]}` } });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}
async function open(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}
function findRow(sheet: ExcelJS.Worksheet, col: number, pred: (v: string) => boolean): ExcelJS.Row | undefined {
  let found: ExcelJS.Row | undefined;
  sheet.eachRow((row) => {
    if (!found && pred(String(row.getCell(col).value ?? ''))) found = row;
  });
  return found;
}
const resultOf = (v: ExcelJS.CellValue) => (v && typeof v === 'object' && 'result' in v ? v.result : v);
const ledgerCount = async () => Number((await db.query<{ n: string }>(`select count(*) n from ledger_entries`)).rows[0]!.n);

let ali = '';
let aliTwin = '';
const entry = (input: Record<string, unknown>) => ({ requestId: randomUUID(), clientId: ali, ...input });

before(async () => {
  process.env['JWT_SECRET'] = 'finance-loans-test-secret-that-is-long-enough';
  process.env['FILES_S3_BUCKET'] = 'test-bucket';
  process.env['PUBLIC_API_URL'] = 'https://api.test';
  process.env['DB_MAX_ROWS'] = '3';

  db = new PGlite();
  await db.exec(STUBS);
  for (const t of ['finance_account', 'ledger_entry_status', 'ledger_head_type', 'finance_ledger_source', 'attachment_entity']) {
    await db.exec(type(t));
  }
  await db.exec(fn('app.next_finance_number'));
  await db.exec(fn('app.karachi_business_date'));
  for (const t of ['finance_settings', 'finance_day_closings', 'finance_audit_logs', 'ledger_heads', 'ledger_entries', 'attachments']) {
    await db.exec(table(t));
  }
  await db.exec(`
    alter table public.ledger_heads add primary key (id);
    alter table public.ledger_entries add primary key (id);
    alter table public.attachments add primary key (id);
    alter table public.finance_audit_logs add primary key (id);
    create sequence public.ledger_entries_seq_seq;
    alter table public.ledger_entries alter column seq set default nextval('public.ledger_entries_seq_seq');
  `);
  await db.exec(fn('public.post_finance_ledger_entry'));
  await db.exec(fn('public.finance_day_summary'));
  await db.exec(`begin;${AUTH}commit;`);

  await db.exec(`
    insert into counters (id, count) values ('finance_receipt_voucher', 0), ('finance_payment_voucher', 0);
    insert into finance_settings default values;
    alter table finance_settings add column account_ledger_start date;
    insert into branches (id, name) values ('${GULBERG}', 'Gulberg');
    insert into ledger_heads (code, name, type, group_name, is_system, is_active) values
      ('INC-OPENING', 'Opening Balance', 'income', 'Opening', true, true),
      ('INC-LOAN', 'Loan Receivable', 'income', 'Loans', false, true),
      ('EXP-LOAN', 'Loan Refundable', 'expense', 'Loans', false, true),
      ('EXP-OLD', 'Old Head', 'expense', 'Loans', false, false);
  `);
  for (const r of (await db.query<{ id: string; code: string }>('select id, code from ledger_heads')).rows) HEAD[r.code] = r.id;

  // One ordinary General Ledger voucher, so "the book is untouched" has something to keep.
  await db.query(
    `select post_finance_ledger_entry(
       p_entry_date => '2026-10-01'::date, p_ledger_head_id => $1::uuid, p_description => 'opening',
       p_debit => 50000::numeric, p_credit => 0::numeric, p_account => 'cash'::finance_account,
       p_source_type => 'opening'::finance_ledger_source, p_source_id => null,
       p_branch_id => null, p_branch_name => null, p_payment_method => null,
       p_approved_by => null, p_approved_by_name => 'Test', p_created_by => null, p_created_by_name => 'Test',
       p_reverses_entry_id => null)`,
    [HEAD['INC-OPENING']],
  );

  // The migration under test, in one transaction, as `prisma migrate deploy` runs it.
  await db.exec(`begin;${MIGRATION}commit;`);

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);
  for (const [name, a] of Object.entries(ACTORS)) {
    await db.query(`insert into users (id, email, display_name, role) values ($1, $2, $2, $3)`, [a.id, a.email, a.role]);
    const session = await prisma.auth_sessions.create({
      data: { user_id: a.id, client: 'web', expires_at: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    TOKENS[name] = signAccessToken(a.id, session.id).token;
  }

  const { setFileStore } = await import('../file-store');
  setFileStore({
    upload: async () => undefined,
    remove: async () => undefined,
    signUrls: async (_bucket, paths) => new Map(paths.map((path) => [path, `https://signed.test/${path}`])),
    publicUrl: (_bucket, path) => `https://api.test/api/public/branding/${path}`,
  });

  const express = (await import('express')).default;
  const { router: loans } = await import('../../routes/finance-loans.routes');
  const { router: reports } = await import('../../routes/finance-reports.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(LOANS, loans);
  app.use('/api/finance/reports', reports);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  delete process.env['DB_MAX_ROWS'];
  server?.close();
  await db?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('access', () => {
  test('no token is 401, a branch manager 403, an auditor reads but cannot write', async () => {
    assert.equal((await call(null, 'GET', `${LOANS}/clients`)).status, 401);
    assert.equal((await call('branch', 'GET', `${LOANS}/clients`)).status, 403);
    ok(await call('auditor', 'GET', `${LOANS}/clients`));
    assert.equal((await call('auditor', 'POST', `${LOANS}/clients`, { clientName: 'Nope' })).status, 403);
  });
});

describe('Detail of Clients', () => {
  test('a client gets an LC- code and a normalised mobile; a bad number is refused', async () => {
    const { client } = ok(await call('accountant', 'POST', `${LOANS}/clients`, {
      clientName: 'Ali Traders', companyName: 'Ali & Sons', mobileNumber: '0300-1234567', address: 'Mall Road',
    }), 201);
    ali = client.id;
    assert.equal(client.clientCode, 'LC-000001');
    assert.equal(client.mobileNumber, '03001234567');
    assert.equal(client.isActive, true);
    assert.equal((await call('accountant', 'POST', `${LOANS}/clients`, { clientName: 'X Y', mobileNumber: '12ab' })).status, 400);
    assert.equal((await call('accountant', 'POST', `${LOANS}/clients`, { clientName: '' })).status, 400);
  });

  test('the same name or mobile warns first, and is saved once confirmed', async () => {
    const dup = await call('accountant', 'POST', `${LOANS}/clients`, { clientName: 'ali traders' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.details.code, 'duplicate_client');
    assert.equal(dup.body.details.existing.clientCode, 'LC-000001');
    const byMobile = await call('accountant', 'POST', `${LOANS}/clients`, { clientName: 'Someone Else', mobileNumber: '0300 1234567' });
    assert.equal(byMobile.status, 409);
    const { client } = ok(await call('accountant', 'POST', `${LOANS}/clients`, { clientName: 'Ali Traders', confirmDuplicate: true }), 201);
    aliTwin = client.id;
    assert.equal(client.clientCode, 'LC-000002');
  });

  test('more clients than one read returns are all listed', async () => {
    for (const name of ['Bilal Foods', 'Chaudhry Mills']) ok(await call('accountant', 'POST', `${LOANS}/clients`, { clientName: name }), 201);
    const { clients } = ok(await call('auditor', 'GET', `${LOANS}/clients`));
    assert.equal(clients.length, 4, 'DB_MAX_ROWS is 3: the list must page');
  });

  test('editing keeps the id (history stays attached); only adjust may deactivate', async () => {
    const { client } = ok(await call('accountant', 'PUT', `${LOANS}/clients/${ali}`, { address: 'Liberty Market' }));
    assert.equal(client.address, 'Liberty Market');
    assert.equal(client.id, ali);
    assert.equal((await call('accountant', 'PUT', `${LOANS}/clients/${ali}/status`, { isActive: false })).status, 403);
  });
});

describe('posting — the §18 client', () => {
  let glBefore = 0;

  test('three entry types post at once with LN- vouchers, sides fixed by the type', async () => {
    glBefore = await ledgerCount();
    const posts = [
      entry({ entryType: 'refundable_loan', ledgerHeadId: HEAD['EXP-LOAN'], businessDate: '2026-10-01', amount: 100000, description: 'Loan given' }),
      entry({ entryType: 'receivable_loan', ledgerHeadId: HEAD['INC-LOAN'], businessDate: '2026-10-02', amount: 50000, description: 'Receivable', branchId: GULBERG }),
      entry({ entryType: 'paid_payment', ledgerHeadId: HEAD['EXP-LOAN'], businessDate: '2026-10-03', amount: 30000, paymentMethod: 'cash', description: 'Paid back' }),
      entry({ entryType: 'paid_payment', ledgerHeadId: HEAD['EXP-LOAN'], businessDate: '2026-10-04', amount: 20000, paymentMethod: 'bank_transfer', description: 'Paid back 2' }),
      entry({ entryType: 'refundable_loan', ledgerHeadId: HEAD['EXP-LOAN'], businessDate: '2026-10-05', amount: 25000, description: 'Second loan' }),
    ];
    const out: Json[] = [];
    for (const p of posts) out.push(ok(await call('accountant', 'POST', `${LOANS}/entries`, p), 201).entry);
    assert.deepEqual(out.map((e) => e.voucherNo), ['LN-000001', 'LN-000002', 'LN-000003', 'LN-000004', 'LN-000005']);
    assert.deepEqual(out.map((e) => [e.debit, e.credit]), [[100000, 0], [50000, 0], [0, 30000], [0, 20000], [25000, 0]]);
    assert.equal(out[1].branchName, 'Gulberg');
    assert.equal(out[0].branchName, null, 'a branch is only kept on a Receivable Loan');
    assert.equal(out[2].paymentMethod, 'cash');
  });

  test('the ledger: debit 175 000, credit 50 000, balance 125 000, running down the page', async () => {
    const page = ok(await call('auditor', 'GET', `${LOANS}/ledger?from=2026-10-01&to=2026-10-31&clientId=${ali}`));
    assert.equal(page.openingBalance, 0);
    assert.equal(page.totalDebit, 175000);
    assert.equal(page.totalCredit, 50000);
    assert.equal(page.closingBalance, 125000);
    assert.deepEqual(page.entries.map((e: Json) => e.balance), [100000, 150000, 120000, 100000, 125000]);
    assert.equal(page.entries.at(-1).balance, page.closingBalance);
  });

  test('a later From carries the opening balance forward', async () => {
    const page = ok(await call('auditor', 'GET', `${LOANS}/ledger?from=2026-10-03&to=2026-10-31&clientId=${ali}`));
    assert.equal(page.openingBalance, 150000);
    assert.equal(page.entries[0].balance, 120000);
    assert.equal(page.closingBalance, 125000);
  });

  test('search and filters narrow the set together', async () => {
    const byVoucher = ok(await call('auditor', 'GET', `${LOANS}/ledger?from=2026-10-01&to=2026-10-31&search=LN-000003`));
    assert.deepEqual(byVoucher.entries.map((e: Json) => e.voucherNo), ['LN-000003']);
    const payments = ok(await call('auditor', 'GET', `${LOANS}/ledger?from=2026-10-01&to=2026-10-31&entryType=paid_payment`));
    assert.equal(payments.totalCredit, 50000);
    const branch = ok(await call('auditor', 'GET', `${LOANS}/ledger?from=2026-10-01&to=2026-10-31&branchId=${GULBERG}`));
    assert.deepEqual(branch.entries.map((e: Json) => e.voucherNo), ['LN-000002']);
    const paged = ok(await call('auditor', 'GET', `${LOANS}/ledger?from=2026-10-01&to=2026-10-31&limit=2&offset=2`));
    assert.equal(paged.total, 5);
    assert.deepEqual(paged.entries.map((e: Json) => e.balance), [120000, 100000], 'a later page keeps the running balance');
  });

  test('the same request twice is one entry', async () => {
    const body = entry({ entryType: 'refundable_loan', ledgerHeadId: HEAD['EXP-LOAN'], businessDate: '2026-10-06', amount: 1, description: 'retry' });
    const a = ok(await call('accountant', 'POST', `${LOANS}/entries`, body), 201).entry;
    const b = ok(await call('accountant', 'POST', `${LOANS}/entries`, body), 201).entry;
    assert.equal(a.id, b.id);
    assert.equal(a.voucherNo, 'LN-000006');
  });

  test('refused: wrong head list, inactive head, payment with no method, future date, auditor', async () => {
    const r = (o: Record<string, unknown>) => call('accountant', 'POST', `${LOANS}/entries`,
      entry({ entryType: 'refundable_loan', ledgerHeadId: HEAD['EXP-LOAN'], businessDate: '2026-10-07', amount: 10, description: 'bad', ...o }));
    assert.match((await r({ entryType: 'receivable_loan' })).body.error, /income ledger head/);
    assert.equal((await r({ ledgerHeadId: HEAD['INC-LOAN'] })).status, 409);
    assert.equal((await r({ ledgerHeadId: HEAD['EXP-OLD'] })).status, 409);
    assert.equal((await r({ entryType: 'paid_payment' })).status, 400);
    assert.equal((await r({ businessDate: '2099-01-01' })).status, 409);
    assert.equal((await r({ amount: 0 })).status, 400);
    assert.equal((await call('auditor', 'POST', `${LOANS}/entries`,
      entry({ entryType: 'refundable_loan', ledgerHeadId: HEAD['EXP-LOAN'], businessDate: '2026-10-07', amount: 10, description: 'x' }))).status, 403);
  });

  test('an inactive client takes no entries until reactivated', async () => {
    ok(await call('admin', 'PUT', `${LOANS}/clients/${aliTwin}/status`, { isActive: false }));
    const refused = await call('accountant', 'POST', `${LOANS}/entries`,
      entry({ clientId: aliTwin, entryType: 'refundable_loan', ledgerHeadId: HEAD['EXP-LOAN'], businessDate: '2026-10-07', amount: 10, description: 'inactive' }));
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /inactive/);
    ok(await call('admin', 'PUT', `${LOANS}/clients/${aliTwin}/status`, { isActive: true }));
  });

  test('cancel: adjust only, reason required; the row stays and leaves every total', async () => {
    const { entry: retry } = ok(await call('auditor', 'GET', `${LOANS}/ledger?from=2026-10-06&to=2026-10-06`)).entries
      .map((e: Json) => ({ entry: e }))[0];
    assert.equal((await call('accountant', 'POST', `${LOANS}/entries/${retry.id}/cancel`, { reason: 'test entry' })).status, 403);
    assert.equal((await call('admin', 'POST', `${LOANS}/entries/${retry.id}/cancel`, { reason: '' })).status, 400);
    const { entry: cancelled } = ok(await call('admin', 'POST', `${LOANS}/entries/${retry.id}/cancel`, { reason: 'test entry' }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelReason, 'test entry');
    assert.equal((await call('admin', 'POST', `${LOANS}/entries/${retry.id}/cancel`, { reason: 'again' })).status, 409);

    const page = ok(await call('auditor', 'GET', `${LOANS}/ledger?from=2026-10-01&to=2026-10-31&clientId=${ali}`));
    assert.equal(page.total, 6, 'the cancelled row is still listed');
    assert.equal(page.closingBalance, 125000);
    assert.equal(page.entries.at(-1).balance, 125000, 'it carries the balance before it');
  });

  test('client balances; the General Ledger is untouched', async () => {
    const { clients } = ok(await call('auditor', 'GET', `${LOANS}/clients`));
    const a = clients.find((c: Json) => c.id === ali);
    assert.deepEqual([a.totalRefundable, a.totalReceivable, a.totalDebit, a.totalCredit, a.balance], [125000, 50000, 175000, 50000, 125000]);
    assert.equal(clients.find((c: Json) => c.id === aliTwin).balance, 0);
    const detail = ok(await call('auditor', 'GET', `${LOANS}/clients/${ali}`));
    assert.equal(detail.balance.balance, 125000);
    assert.equal(await ledgerCount(), glBefore, 'no loan entry reached ledger_entries');
    const audit = (await db.query<{ entity: string; n: string }>(
      `select entity, count(*) n from finance_audit_logs group by entity order by entity`)).rows;
    assert.deepEqual(audit.map((r) => r.entity), ['loan_client', 'loan_entry']);
  });
});

describe('exports', () => {
  test('the loan ledger report matches the screen, and downloads as Excel and PDF', async () => {
    const { report } = ok(await call('auditor', 'GET', `/api/finance/reports?type=loan_ledger&from=2026-10-01&to=2026-10-31&clientId=${ali}`));
    assert.deepEqual(report.summary.map((s: Json) => [s.label, s.value]), [
      ['Opening Balance', 0], ['Total Loan Payment', 175000], ['Loan Paid', 50000], ['Closing Balance', 125000],
    ]);
    assert.equal(report.rows[0].description, 'Opening balance brought forward');
    assert.match(report.subtitle, /^Ali Traders/);

    const xlsx = await download('auditor', `/api/finance/reports/export?type=loan_ledger&format=excel&from=2026-10-01&to=2026-10-31&clientId=${ali}`);
    assert.equal(xlsx.res.status, 200);
    const sheet = (await open(xlsx.buf)).worksheets[0]!;
    assert.ok(findRow(sheet, 2, (v) => v === 'LN-000005'));

    const pdf = await download('auditor', `/api/finance/reports/export?type=loan_ledger&format=pdf&from=2026-10-01&to=2026-10-31&clientId=${ali}`);
    assert.equal(pdf.res.status, 200);
    assert.equal(pdf.res.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
  });

  test('the Daily Ledger workbook: loans under Liabilities as a memorandum, a Loan Ledger sheet, balance check still 0', async () => {
    const { res, buf } = await download('auditor', '/api/finance/reports/accounting-workbook?from=2026-10-01&to=2026-10-31');
    assert.equal(res.status, 200);
    const wb = await open(buf);
    assert.deepEqual(wb.worksheets.map((s) => s.name).slice(-2), ['Balance Sheet', 'Loan Ledger']);

    const bs = wb.getWorksheet('Balance Sheet')!;
    assert.ok(findRow(bs, 1, (v) => v.startsWith('Refundable & Receivable Loans — separate loan register')));
    assert.equal(findRow(bs, 1, (v) => v.startsWith('LC-000001 — Ali Traders'))!.getCell(2).value, 125000);
    assert.equal(findRow(bs, 1, (v) => v.startsWith('Total loans outstanding'))!.getCell(3).value, 125000);
    assert.equal(findRow(bs, 1, (v) => v === 'Total liabilities')!.getCell(3).value, 0, 'loans are not in Total liabilities');
    assert.equal(findRow(bs, 1, (v) => v === 'Balance check (assets − liabilities − equity)')!.getCell(3).value, 0);
    assert.equal(findRow(bs, 1, (v) => v === 'Loan register agrees with the Loan Ledger')!.getCell(2).value, 'PASS');

    const ll = wb.getWorksheet('Loan Ledger')!;
    assert.equal(findRow(ll, 2, (v) => v === 'LN-000005')!.getCell(10).value, 125000);
    assert.equal(findRow(ll, 1, (v) => v.startsWith('Closing balance'))!.getCell(10).value, 125000);
    const total = findRow(ll, 1, (v) => v.startsWith('TOTAL'))!;
    assert.equal(resultOf(total.getCell(8).value), 175000);
    assert.equal(resultOf(total.getCell(9).value), 50000);
    const clients = findRow(ll, 1, (v) => v.startsWith('Total outstanding'))!;
    assert.equal(resultOf(clients.getCell(8).value), 125000);
  });
});

describe('query-layer catalog', () => {
  test('src/db/catalog.generated.json describes the loan tables and functions as the migration leaves them', async () => {
    const { CATALOG_QUERY, shapeCatalog } = await import('../../db/catalog-query');
    const committed = JSON.parse(readFileSync(join(__dirname, '../../db/catalog.generated.json'), 'utf8'));
    await db.exec(`set search_path = ''`);
    const live = shapeCatalog((await db.query<Json>(CATALOG_QUERY)).rows[0].json_build_object) as Json;
    await db.exec('reset search_path');
    for (const t of ['finance_loan_clients', 'finance_loan_entries']) {
      assert.deepEqual(committed.tables[t], live.tables[t], `table ${t}`);
    }
    for (const f of ['post_finance_loan_entry', 'cancel_finance_loan_entry', 'finance_loan_ledger', 'finance_loan_client_balances']) {
      assert.deepEqual(committed.functions[f], live.functions[f], `function ${f}`);
    }
  });
});
