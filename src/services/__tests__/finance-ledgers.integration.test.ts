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
import { businessDateStr, SYSTEM_LEDGER_HEAD_CODES } from '../../shared';

/**
 * Salary Ledger, Company Transaction Details and employee resignation, end to
 * end, against the REAL schema, the REAL migration and the REAL routes.
 *
 * The finance tables, types and the ledger-posting function are lifted verbatim
 * from prisma/migrations/0_baseline, the new migration is applied on top, and
 * the two Express routers are mounted on a local server whose queries run in
 * that database. Every payslip and partner transaction below is created,
 * submitted and approved through the same endpoints the app uses — nothing is
 * inserted as "already posted" — so what the ledgers show is what the existing
 * approval workflow produced.
 *
 * Dates are relative to the day the suite runs: PAST is last year (every month
 * of it is over), THIS is the current year.
 */

const PRISMA = join(__dirname, '../../../prisma/migrations');
const BASELINE = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
const MIGRATION = readFileSync(join(PRISMA, '20261011000001_salary_ledger_resignations/migration.sql'), 'utf8');
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

const FINANCE_TABLES = [
  'finance_settings',
  'finance_day_closings',
  'finance_audit_logs',
  'ledger_heads',
  'ledger_entries',
  'finance_employees',
  'salary_revisions',
  'salary_payments',
  'employee_advances',
  'finance_partners',
  'partner_expenses',
  'attachments',
];

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create table counters (id text primary key, count bigint not null);
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table business_day_closures (business_date date primary key, status text not null);
  create table branches (id uuid primary key default gen_random_uuid(), name text, company_share_pct numeric);
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

interface Actor { id: string; email: string; role: string }
const ACTORS: Record<string, Actor> = {
  admin: { id: '20000000-0000-4000-8000-000000000001', email: 'fadmin@mb.test', role: 'finance_admin' },
  manager: { id: '20000000-0000-4000-8000-000000000002', email: 'fmanager@mb.test', role: 'finance_manager' },
  accountant: { id: '20000000-0000-4000-8000-000000000003', email: 'accountant@mb.test', role: 'accountant' },
  auditor: { id: '20000000-0000-4000-8000-000000000004', email: 'auditor@mb.test', role: 'finance_auditor' },
  branch: { id: '20000000-0000-4000-8000-000000000005', email: 'branch@mb.test', role: 'branch_manager' },
  owner: { id: '20000000-0000-4000-8000-000000000006', email: 'owner@mb.test', role: 'super_admin' },
};
const TOKENS: Record<string, string> = {};

const TODAY = businessDateStr();
const THIS = Number(TODAY.slice(0, 4));
const PAST = THIS - 1;
const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(as ? { Authorization: `Bearer ${TOKENS[as] ?? as}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const PAYROLL = '/api/finance/payroll';
const PARTNERS = '/api/finance/partner-expenses';

async function photo(as: string, entity: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into attachments (entity, storage_path, mime_type, size_bytes, uploaded_by)
     values ($1, $2, 'image/webp', 1, $3) returning id`,
    [entity, `${entity}/${Math.random().toString(36).slice(2)}.webp`, ACTORS[as]!.id],
  );
  return rows[0]!.id;
}

const scalar = async <T = number>(sql: string, params: unknown[] = []) =>
  (await db.query<{ v: T }>(sql, params)).rows[0]!.v;

// ── Payroll helpers ──────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function employee(name: string, joinedOn: string, department = 'Production'): Promise<Json> {
  const res = await call('admin', 'POST', `${PAYROLL}/employees`, {
    name, department, designation: 'Baker', baseSalary: 30000, joinedOn,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.employee;
}

/** Raised by the accountant; `pending_approval` unless `asDraft`. */
async function payslip(employeeId: string, salaryMonth: string, grossSalary: number, extra: Json = {}) {
  return call('accountant', 'POST', `${PAYROLL}/salaries`, {
    employeeId, salaryMonth, grossSalary, bonus: 0, deductions: 0,
    paymentMethod: 'cash', account: 'cash',
    attachmentIds: [await photo('accountant', 'salary_payment')],
    ...extra,
  });
}

async function paid(employeeId: string, salaryMonth: string, grossSalary: number, extra: Json = {}): Promise<Json> {
  const created = await payslip(employeeId, salaryMonth, grossSalary, extra);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const approved = await call('manager', 'POST', `${PAYROLL}/salaries/${created.body.salary.id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body.salary;
}

async function salaryLedger(year: number, query = ''): Promise<Json> {
  const res = await call('auditor', 'GET', `${PAYROLL}/ledger?year=${year}&pageSize=200${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.ledger;
}
const rowOf = (ledger: Json, employeeId: string) => ledger.rows.find((r: Json) => r.employeeId === employeeId);
const cell = (row: Json, month: number) => row.cells[month - 1];

// ── Partner helpers ──────────────────────────────────────────────────────────
let PARTNER: Record<string, Json> = {};

async function partnerTxn(partnerId: string, txnKind: string, amount: number, businessDate: string, extra: Json = {}) {
  return call('accountant', 'POST', PARTNERS, {
    partnerId, txnKind, amount, businessDate,
    paymentMethod: 'cash', account: 'cash',
    attachmentIds: [await photo('accountant', 'partner_expense')],
    ...extra,
  });
}
async function partnerPaid(partnerId: string, txnKind: string, amount: number, businessDate: string): Promise<Json> {
  const created = await partnerTxn(partnerId, txnKind, amount, businessDate);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const approved = await call('manager', 'POST', `${PARTNERS}/${created.body.expense.id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body.expense;
}
async function partnerLedger(year: number, query = ''): Promise<Json> {
  const res = await call('auditor', 'GET', `${PARTNERS}/ledger?year=${year}${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.ledger;
}
const partnerRow = (ledger: Json, partnerId: string) => ledger.rows.find((r: Json) => r.partnerId === partnerId);

before(async () => {
  process.env['JWT_SECRET'] = 'finance-ledgers-test-secret-that-is-long-enough';
  process.env['FILES_S3_BUCKET'] = 'test-bucket';
  process.env['PUBLIC_API_URL'] = 'https://api.test';

  db = new PGlite();
  await db.exec(STUBS);
  for (const t of ['finance_doc_status', 'finance_account', 'ledger_entry_status', 'ledger_head_type', 'finance_ledger_source', 'attachment_entity']) {
    await db.exec(type(t));
  }
  await db.exec(lift('CREATE FUNCTION app.next_finance_number(', '$$;'));
  for (const t of FINANCE_TABLES) await db.exec(table(t));
  await db.exec(`
    ${FINANCE_TABLES.filter((t) => !['finance_settings', 'finance_day_closings'].includes(t))
      .map((t) => `alter table public.${t} add primary key (id);`).join('\n')}
    create sequence public.ledger_entries_seq_seq;
    alter table public.ledger_entries alter column seq set default nextval('public.ledger_entries_seq_seq');
    alter table public.finance_partners add constraint finance_partners_name_key unique (name);
  `);
  await db.exec(lift('CREATE UNIQUE INDEX salary_payments_employee_month_idx', ';'));
  await db.exec(lift('CREATE FUNCTION public.post_finance_ledger_entry(', '$$;'));
  await db.exec(`begin;${AUTH}commit;`);

  // Configuration the finance module expects to find, and the four partners as
  // they exist before the migration gives them their codes.
  await db.exec(`
    insert into counters (id, count) values
      ('finance_employee', 0), ('finance_salary', 0), ('finance_advance', 0), ('finance_partner', 0),
      ('finance_receipt_voucher', 0), ('finance_payment_voucher', 0);
    insert into finance_settings default values;
    insert into ledger_heads (code, name, type, is_system) values
      ('${SYSTEM_LEDGER_HEAD_CODES.SALARIES}', 'Salaries', 'expense', true),
      ('${SYSTEM_LEDGER_HEAD_CODES.PARTNER_WITHDRAWAL}', 'Partner Withdrawal', 'expense', true);
    insert into finance_partners (name, share_pct) values
      ('Mohsin Abbas', 25), ('Muhammad Saleem', 25), ('Muhammad Shahid', 25), ('Salqlain Hussain', 25);
  `);

  // The migration under test, in one transaction, as `prisma migrate deploy` runs it.
  await db.exec(`begin;${MIGRATION}commit;`);

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);

  for (const [name, a] of Object.entries(ACTORS)) {
    await db.query(`insert into users (id, email, role) values ($1, $2, $3)`, [a.id, a.email, a.role]);
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
  const { router: payroll } = await import('../../routes/finance-payroll.routes');
  const { router: partners } = await import('../../routes/finance-partners.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(PAYROLL, payroll);
  app.use(PARTNERS, partners);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const list = await call('auditor', 'GET', `${PARTNERS}/partners`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  PARTNER = Object.fromEntries(list.body.partners.map((p: Json) => [p.partnerCode, p]));
});

after(async () => {
  server?.close();
  await db?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Salary Ledger', () => {
  let ahmad: Json;

  test('only an approved payslip is on the ledger — pending, draft and rejected are not', async () => {
    ahmad = await employee('Ahmad Sha', `${PAST}-01-01`);

    await paid(ahmad.id, ym(PAST, 1), 30000);
    assert.equal((await payslip(ahmad.id, ym(PAST, 2), 30000)).status, 201); // left pending
    const rejected = await payslip(ahmad.id, ym(PAST, 3), 30000);
    assert.equal(
      (await call('manager', 'POST', `${PAYROLL}/salaries/${rejected.body.salary.id}/reject`, { reason: 'Amount did not match attendance' })).status,
      200,
    );
    assert.equal((await payslip(ahmad.id, ym(PAST, 4), 30000, { asDraft: true })).status, 201);

    const row = rowOf(await salaryLedger(PAST), ahmad.id);
    assert.equal(cell(row, 1).state, 'paid');
    assert.equal(cell(row, 1).amount, 30000);
    for (const m of [2, 3, 4]) {
      assert.equal(cell(row, m).amount, 0, `month ${m} must carry no amount`);
      assert.notEqual(cell(row, m).state, 'paid');
    }
    assert.equal(cell(row, 2).pendingCount, 1);
    assert.equal(cell(row, 4).pendingCount, 1, 'a draft is waiting too');
    assert.equal(cell(row, 3).pendingCount, 0, 'a rejected payslip is not waiting for anything');
    assert.equal(row.total, 30000);
  });

  test('an approved payslip appears once the existing approval marks it — and not before', async () => {
    const before = rowOf(await salaryLedger(PAST), ahmad.id);
    assert.equal(cell(before, 2).state, 'unpaid');

    const pending = await call('auditor', 'GET', `${PAYROLL}/salaries?employeeId=${ahmad.id}&salaryMonth=${ym(PAST, 2)}`);
    const id = pending.body.salaries[0].id;
    assert.equal((await call('manager', 'POST', `${PAYROLL}/salaries/${id}/approve`, {})).status, 200);

    const row = rowOf(await salaryLedger(PAST), ahmad.id);
    assert.equal(cell(row, 2).state, 'paid');
    assert.equal(cell(row, 2).amount, 30000);
    assert.equal(row.total, 60000);
  });

  test('the month is the salary period, not the day it was paid', async () => {
    // May's salary, paid on 3 June.
    await paid(ahmad.id, ym(PAST, 5), 31000.5, { paymentDate: `${PAST}-06-03` });
    const row = rowOf(await salaryLedger(PAST), ahmad.id);
    assert.equal(cell(row, 5).amount, 31000.5);
    assert.equal(cell(row, 6).amount, 0);
  });

  test('the figure is net paid: salary + bonus − deduction', async () => {
    await paid(ahmad.id, ym(PAST, 7), 30000, { bonus: 5000, deductions: 10000.25 });
    const row = rowOf(await salaryLedger(PAST), ahmad.id);
    assert.equal(cell(row, 7).amount, 24999.75);
  });

  test('a second payslip for the same employee and month is refused, and nothing is duplicated', async () => {
    const again = await payslip(ahmad.id, ym(PAST, 1), 30000);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already has a salary record/);
    assert.equal(
      await scalar(`select count(*)::int as v from salary_payments where employee_id = $1 and salary_month = $2`, [ahmad.id, ym(PAST, 1)]),
      1,
    );
  });

  test('approving twice posts one voucher and counts once', async () => {
    const zahid = await employee('Zahid Iqbal', `${PAST}-01-01`);
    const created = await payslip(zahid.id, ym(PAST, 1), 45000);
    const id = created.body.salary.id;

    const [first, second] = await Promise.all([
      call('manager', 'POST', `${PAYROLL}/salaries/${id}/approve`, {}),
      call('admin', 'POST', `${PAYROLL}/salaries/${id}/approve`, {}),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal((await call('manager', 'POST', `${PAYROLL}/salaries/${id}/approve`, {})).status, 409);

    assert.equal(await scalar(`select count(*)::int as v from ledger_entries where source_id = $1`, [id]), 1);
    const row = rowOf(await salaryLedger(PAST), zahid.id);
    assert.equal(cell(row, 1).amount, 45000);
    assert.equal(cell(row, 1).count, 1);
  });

  test('one row per employee, keyed by id — two people with the same name stay two rows', async () => {
    const a = await employee('Muhammad Ali', `${PAST}-01-01`);
    const b = await employee('Muhammad Ali', `${PAST}-01-01`, 'Sales');
    await paid(a.id, ym(PAST, 1), 5000);
    await paid(a.id, ym(PAST, 2), 5000);
    await paid(b.id, ym(PAST, 1), 25000);

    const ledger = await salaryLedger(PAST);
    const ids = ledger.rows.map((r: Json) => r.employeeId);
    assert.equal(new Set(ids).size, ids.length, 'an employee must never appear twice');
    assert.equal(rowOf(ledger, a.id).total, 10000);
    assert.equal(rowOf(ledger, b.id).total, 25000);
    assert.notEqual(rowOf(ledger, a.id).employeeCode, rowOf(ledger, b.id).employeeCode);
  });

  test('refreshing changes nothing', async () => {
    const counts = () => scalar(`select (select count(*) from salary_payments)::int + (select count(*) from ledger_entries)::int as v`);
    const before = await counts();
    const first = await salaryLedger(PAST);
    const second = await salaryLedger(PAST);
    assert.deepEqual(second, first);
    assert.equal(await counts(), before);
  });

  test('each year stands alone: nothing is carried into the next one', async () => {
    const past = rowOf(await salaryLedger(PAST), ahmad.id);
    assert.ok(past.total > 0);

    const current = rowOf(await salaryLedger(THIS), ahmad.id);
    assert.ok(current, 'an active employee is on this year\'s ledger');
    assert.equal(current.total, 0);
    assert.ok(current.cells.every((c: Json) => c.amount === 0 && c.state !== 'paid'));

    const next = await salaryLedger(THIS + 1);
    assert.equal(next.rows.length, 0, 'next year is empty until something for it is approved');
    assert.equal(next.yearTotal, 0);
    assert.ok(next.years.some((y: Json) => y.year === THIS + 1 && !y.hasRecords));
    assert.ok(next.years.some((y: Json) => y.year === PAST && y.hasRecords));
  });

  test('a salary-rate change does not rewrite what was already paid', async () => {
    const before = rowOf(await salaryLedger(PAST), ahmad.id);
    const revised = await call('admin', 'POST', `${PAYROLL}/employees/${ahmad.id}/salary-revisions`, {
      newSalary: 90000, reason: 'Annual increment', effectiveFrom: `${PAST}-01-01`,
    });
    assert.equal(revised.status, 201, JSON.stringify(revised.body));
    assert.deepEqual(rowOf(await salaryLedger(PAST), ahmad.id), before);
  });

  test('an unpaid month is a marker, never an amount', async () => {
    const row = rowOf(await salaryLedger(PAST), ahmad.id);
    // Jan, Feb, May, Jul are paid; the other eight months of a finished year are unpaid.
    assert.equal(row.unpaidMonths, 8);
    assert.ok(row.cells.filter((c: Json) => c.state === 'unpaid').every((c: Json) => c.amount === 0 && c.count === 0));
  });

  test('the footer and the cards add up to the rows', async () => {
    const ledger = await salaryLedger(PAST);
    const sum = (list: number[]) => Math.round(list.reduce((t, v) => t + v * 100, 0)) / 100;
    for (let m = 1; m <= 12; m++) {
      assert.equal(ledger.monthTotals[m - 1], sum(ledger.rows.map((r: Json) => cell(r, m).amount)));
    }
    assert.equal(ledger.yearTotal, sum(ledger.monthTotals));
    assert.equal(ledger.yearTotal, sum(ledger.rows.map((r: Json) => r.total)));
    assert.equal(ledger.summary.totalApproved, ledger.yearTotal);
    for (const row of ledger.rows) assert.equal(row.total, sum(row.cells.map((c: Json) => c.amount)));
  });

  test('a cell is exactly the sum of the payslips behind it', async () => {
    const detail = await call('auditor', 'GET', `${PAYROLL}/ledger/payments?employeeId=${ahmad.id}&year=${PAST}`);
    assert.equal(detail.status, 200);
    const row = rowOf(await salaryLedger(PAST), ahmad.id);
    assert.equal(detail.body.countedTotal, row.total);
    for (let m = 1; m <= 12; m++) {
      const counted = detail.body.payments.filter((p: Json) => p.month === m && p.counted);
      assert.equal(counted.reduce((t: number, p: Json) => t + p.countedAmount, 0), cell(row, m).amount);
    }
    // Excluded payslips are listed, with the reason, and carry nothing.
    const march = detail.body.payments.find((p: Json) => p.month === 3);
    assert.equal(march.exclusion, 'rejected');
    assert.equal(march.countedAmount, 0);
    const jan = detail.body.payments.find((p: Json) => p.month === 1);
    assert.match(jan.salaryNo, /^SAL-\d{6}$/);
    assert.match(jan.voucherNo, /^PV-\d{6}$/);
    assert.equal(jan.approvedByName, 'fmanager@mb.test');
    assert.ok(jan.approvedAt);
  });

  test('a voucher corrected or removed in the Daily Ledger is what the ledger shows', async () => {
    const kosar = await employee('Kosar Meer', `${PAST}-01-01`);
    const feb = await paid(kosar.id, ym(PAST, 2), 65000);
    const mar = await paid(kosar.id, ym(PAST, 3), 65000);

    // The voucher's amount is corrected in place; the payslip still reads 65,000.
    await db.query(`update ledger_entries set credit = 60000 where id = $1`, [feb.ledgerEntryId]);
    // The voucher is removed from the book; the payslip still reads "posted".
    await db.query(`update ledger_entries set deleted_at = now(), delete_reason = 'entered twice' where id = $1`, [mar.ledgerEntryId]);

    const row = rowOf(await salaryLedger(PAST), kosar.id);
    assert.equal(cell(row, 2).amount, 60000);
    assert.equal(cell(row, 3).amount, 0);
    assert.equal(cell(row, 3).state, 'unpaid');
    assert.equal(row.total, 60000);

    const detail = await call('auditor', 'GET', `${PAYROLL}/ledger/payments?employeeId=${kosar.id}&year=${PAST}&month=3`);
    assert.equal(detail.body.payments[0].status, 'posted');
    assert.equal(detail.body.payments[0].exclusion, 'voucher_removed');
    assert.equal(detail.body.countedTotal, 0);
  });

  test('search, department, status, sort and paging are applied by the server', async () => {
    const all = await salaryLedger(PAST);

    const byCode = await salaryLedger(PAST, `&search=${all.rows[0].employeeCode.toLowerCase()}`);
    assert.deepEqual(byCode.rows.map((r: Json) => r.employeeId), [all.rows[0].employeeId]);

    const byName = await salaryLedger(PAST, '&search=muhammad');
    assert.equal(byName.rows.length, 2);
    assert.equal(byName.total, 2);
    // Cards describe the year; the footer describes what is listed.
    assert.equal(byName.summary.totalApproved, all.summary.totalApproved);
    assert.equal(byName.yearTotal, 35000);

    assert.deepEqual((await salaryLedger(PAST, '&department=sales')).rows.map((r: Json) => r.department), ['Sales']);
    assert.ok((await salaryLedger(PAST, '&status=unpaid')).rows.every((r: Json) => r.unpaidMonths > 0));
    assert.equal((await salaryLedger(PAST, '&status=resigned')).rows.length, 0);

    const byTotal = (await salaryLedger(PAST, '&sort=total')).rows.map((r: Json) => r.total);
    assert.deepEqual(byTotal, [...byTotal].sort((a, b) => b - a));

    const paged = await call('auditor', 'GET', `${PAYROLL}/ledger?year=${PAST}&pageSize=2&page=2`);
    assert.equal(paged.body.ledger.rows.length, 2);
    assert.equal(paged.body.ledger.total, all.rows.length);
    assert.deepEqual(paged.body.ledger.monthTotals, all.monthTotals, 'totals cover every page');
    assert.equal(paged.body.ledger.rows[0].employeeId, all.rows[2].employeeId);
  });

  test('the ledger cannot be written to: no create, edit or delete exists', async () => {
    for (const path of [`${PAYROLL}/ledger`, `${PAYROLL}/ledger/payments`, `${PAYROLL}/ledger/${ahmad.id}`]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await call('admin', method, path, { amount: 1 });
        assert.equal(res.status, 405, `${method} ${path}`);
      }
    }
  });

  test('who may do what is decided by the server', async () => {
    assert.equal((await call(null, 'GET', `${PAYROLL}/ledger`)).status, 401);
    assert.equal((await call(null, 'POST', `${PAYROLL}/salaries`, {})).status, 401);
    assert.equal((await call('branch', 'GET', `${PAYROLL}/ledger`)).status, 403);
    assert.equal((await call('branch', 'GET', `${PAYROLL}/ledger/payments`)).status, 403);
    // Reading is open to every finance role and to the owner.
    for (const who of ['auditor', 'accountant', 'manager', 'admin', 'owner']) {
      assert.equal((await call(who, 'GET', `${PAYROLL}/ledger?year=${PAST}`)).status, 200, who);
    }

    const pending = await payslip(ahmad.id, ym(PAST, 8), 30000);
    const id = pending.body.salary.id;
    // An auditor may not raise a payslip; an accountant may not approve one; the
    // owner may only look, unless the grant in Finance Settings is on.
    assert.equal((await call('auditor', 'POST', `${PAYROLL}/salaries`, { employeeId: ahmad.id })).status, 403);
    assert.equal((await call('accountant', 'POST', `${PAYROLL}/salaries/${id}/approve`, {})).status, 403);
    assert.equal((await call('auditor', 'POST', `${PAYROLL}/salaries/${id}/approve`, {})).status, 403);
    assert.equal((await call('owner', 'POST', `${PAYROLL}/salaries/${id}/approve`, {})).status, 403);
    assert.equal((await call('owner', 'POST', `${PAYROLL}/salaries/${id}/reject`, { reason: 'no' })).status, 403);

    const row = rowOf(await salaryLedger(PAST), ahmad.id);
    assert.equal(cell(row, 8).amount, 0, 'a refused approval approved nothing');
    await call('manager', 'POST', `${PAYROLL}/salaries/${id}/reject`, { reason: 'Test clean-up' });
  });

  test('a bad query is a 400, not a guess', async () => {
    assert.equal((await call('auditor', 'GET', `${PAYROLL}/ledger?year=banana`)).status, 400);
    assert.equal((await call('auditor', 'GET', `${PAYROLL}/ledger?status=everyone`)).status, 400);
    assert.equal((await call('auditor', 'GET', `${PAYROLL}/ledger/payments?month=13`)).status, 400);
    assert.equal((await call('auditor', 'GET', `${PAYROLL}/ledger/payments?employeeId=not-a-uuid`)).status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. Resignation', () => {
  let shabbir: Json;
  const resign = (id: string, body: Json, as = 'admin') => call(as, 'POST', `${PAYROLL}/employees/${id}/resignation`, body);
  const SEPT_15 = { resignationDate: `${PAST}-09-15`, resignationTime: '11:20', reason: 'Better opportunity' };

  test('the employee is found by code or by name, and their biodata is what is on record', async () => {
    shabbir = await employee('Shabbir Ali', `${PAST}-01-05`, 'Bakery');
    for (let m = 1; m <= 9; m++) await paid(shabbir.id, ym(PAST, m), 30000);

    const byCode = await call('auditor', 'GET', `${PAYROLL}/employees?includeInactive=true&search=${shabbir.employeeCode}`);
    assert.deepEqual(byCode.body.employees.map((e: Json) => e.id), [shabbir.id]);
    const byName = await call('auditor', 'GET', `${PAYROLL}/employees?includeInactive=true&search=shabbir`);
    assert.deepEqual(byName.body.employees.map((e: Json) => e.id), [shabbir.id]);

    const profile = await call('auditor', 'GET', `${PAYROLL}/employees/${shabbir.id}`);
    assert.equal(profile.status, 200);
    const e = profile.body.profile.employee;
    assert.deepEqual(
      [e.employeeCode, e.name, e.department, e.designation, e.joinedOn, e.isActive, e.phone, e.resignation],
      [shabbir.employeeCode, 'Shabbir Ali', 'Bakery', 'Baker', `${PAST}-01-05`, true, null, null],
    );
    assert.deepEqual(profile.body.profile.lastApprovedSalary.salaryMonth, ym(PAST, 9));
    assert.equal(profile.body.profile.allTimeApproved, 270000);
    assert.equal((await call('auditor', 'GET', `${PAYROLL}/employees/00000000-0000-4000-8000-00000000dead`)).status, 404);
  });

  test('a resignation needs a real date, a time and a reason', async () => {
    assert.equal((await resign(shabbir.id, { ...SEPT_15, reason: '' })).status, 400);
    assert.equal((await resign(shabbir.id, { resignationDate: `${PAST}-09-15`, reason: 'Health' })).status, 400);
    assert.equal((await resign(shabbir.id, { ...SEPT_15, resignationDate: `${PAST}-02-31` })).status, 400);
    assert.equal((await resign(shabbir.id, { ...SEPT_15, resignationTime: '25:00' })).status, 400);
    assert.equal((await resign(shabbir.id, { ...SEPT_15, reason: 'Other' })).status, 400, '"Other" needs remarks');

    const beforeJoining = await resign(shabbir.id, { ...SEPT_15, resignationDate: `${PAST - 1}-12-31` });
    assert.equal(beforeJoining.status, 400);
    assert.match(beforeJoining.body.error, /before .* joining date/);

    const future = await resign(shabbir.id, { ...SEPT_15, resignationDate: `${THIS + 1}-01-01` });
    assert.equal(future.status, 400);
    assert.match(future.body.error, /future/);

    assert.equal((await resign('00000000-0000-4000-8000-00000000dead', SEPT_15)).status, 404);
    assert.equal(await scalar(`select count(*)::int as v from employee_resignations`), 0);
  });

  test('only someone who may manage employees can record one', async () => {
    for (const who of ['manager', 'accountant', 'auditor', 'owner', 'branch']) {
      assert.equal((await resign(shabbir.id, SEPT_15, who)).status, 403, who);
    }
    assert.equal((await resign(shabbir.id, SEPT_15, null as unknown as string)).status, 401);
    assert.equal(await scalar(`select count(*)::int as v from employee_resignations`), 0);
  });

  test('recording it stores the date, time, reason and the signed-in user, and writes the audit trail', async () => {
    const res = await resign(shabbir.id, { ...SEPT_15, remarks: 'Moving to Lahore' });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const r = res.body.resignation;
    assert.deepEqual(
      [r.employeeId, r.employeeCode, r.employeeName, r.resignationDate, r.resignationTime, r.reason, r.remarks, r.status],
      [shabbir.id, shabbir.employeeCode, 'Shabbir Ali', `${PAST}-09-15`, '11:20', 'Better opportunity', 'Moving to Lahore', 'recorded'],
    );
    // Who and when come from the session and the database, not from the request.
    assert.equal(r.submittedBy, ACTORS['admin']!.id);
    assert.equal(r.submittedByName, 'fadmin@mb.test');
    assert.ok(Math.abs(Date.parse(r.createdAt) - Date.now()) < 60_000, 'createdAt is the server clock');
    assert.notEqual(r.createdAt.slice(0, 10), r.resignationDate, 'the entered date is kept apart from the timestamp');

    assert.equal(res.body.employee.isActive, false);
    assert.equal(res.body.employee.resignation.id, r.id);
    assert.deepEqual(res.body.impact, { approvedAfter: [], pendingAfter: [] });

    const audit = (await db.query<Json>(
      `select actor_id, actor_name, actor_role, entity, entity_ref, new_values from finance_audit_logs
        where action = 'resigned' and entity_id = $1`, [shabbir.id])).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(
      [audit[0].actor_id, audit[0].actor_name, audit[0].actor_role, audit[0].entity, audit[0].entity_ref],
      [ACTORS['admin']!.id, 'fadmin@mb.test', 'finance_admin', 'employee', shabbir.employeeCode],
    );
    assert.equal(audit[0].new_values.resignationDate, `${PAST}-09-15`);
    assert.equal(audit[0].new_values.reason, 'Better opportunity');
  });

  test('history is untouched: January to September stay, September is kept, October to December close', async () => {
    assert.equal(await scalar(`select count(*)::int as v from salary_payments where employee_id = $1 and status = 'posted'`, [shabbir.id]), 9);
    assert.equal(await scalar(`select count(*)::int as v from finance_employees where id = $1`, [shabbir.id]), 1, 'never deleted');

    const row = rowOf(await salaryLedger(PAST), shabbir.id);
    assert.ok(row, 'the resigned employee keeps their row');
    for (let m = 1; m <= 9; m++) {
      assert.equal(cell(row, m).state, 'paid', `month ${m}`);
      assert.equal(cell(row, m).amount, 30000);
      assert.equal(cell(row, m).flagged, false);
    }
    for (let m = 10; m <= 12; m++) {
      assert.equal(cell(row, m).state, 'closed', `month ${m}`);
      assert.equal(cell(row, m).amount, 0);
    }
    assert.equal(row.total, 270000);
    assert.equal(row.unpaidMonths, 0, 'closed months are not "unpaid"');
    assert.equal(row.resignation.resignationDate, `${PAST}-09-15`);
    assert.equal(row.isActive, false);

    assert.deepEqual((await salaryLedger(PAST, '&status=resigned')).rows.map((r: Json) => r.employeeId), [shabbir.id]);
    // Someone who left last year is not an empty row on this year's ledger.
    assert.equal(rowOf(await salaryLedger(THIS), shabbir.id), undefined);
  });

  test('submitting it again does not create a second resignation', async () => {
    const again = await resign(shabbir.id, SEPT_15);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already recorded/);
    assert.equal(await scalar(`select count(*)::int as v from employee_resignations where employee_id = $1`, [shabbir.id]), 1);

    // Two at the same instant: one is recorded, one is refused.
    const wajid = await employee('Wajid', `${PAST}-09-01`);
    const both = await Promise.all([
      resign(wajid.id, { resignationDate: `${PAST}-10-10`, resignationTime: '09:00', reason: 'Relocation' }),
      resign(wajid.id, { resignationDate: `${PAST}-10-10`, resignationTime: '09:00', reason: 'Relocation' }),
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await scalar(`select count(*)::int as v from employee_resignations where employee_id = $1`, [wajid.id]), 1);
    assert.equal(await scalar(`select count(*)::int as v from finance_audit_logs where action = 'resigned' and entity_id = $1`, [wajid.id]), 1);
  });

  test('no ordinary salary after the resignation month; the resignation month itself is still payable', async () => {
    const dilber = await employee('Dilber Khaplu', `${PAST}-03-05`);
    await paid(dilber.id, ym(PAST, 7), 3000);
    const august = await payslip(dilber.id, ym(PAST, 8), 3000); // pending when the resignation lands
    const november = await payslip(dilber.id, ym(PAST, 11), 3000); // pending, for a later month

    const res = await resign(dilber.id, { resignationDate: `${PAST}-09-28`, resignationTime: '17:40', reason: 'Relocation' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.impact.pendingAfter.map((p: Json) => p.salaryMonth), [ym(PAST, 11)]);
    assert.deepEqual(res.body.impact.approvedAfter, []);

    // A new payslip for a later month is refused…
    const october = await payslip(dilber.id, ym(PAST, 10), 3000);
    assert.equal(october.status, 400);
    assert.match(october.body.error, /resigned on 28 Sep/);
    // …and the one already waiting for a later month cannot be approved. It is not deleted.
    const blocked = await call('manager', 'POST', `${PAYROLL}/salaries/${november.body.salary.id}/approve`, {});
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /after the resignation month/);
    assert.equal(await scalar<string>(`select status::text as v from salary_payments where id = $1`, [november.body.salary.id]), 'pending_approval');
    assert.equal(await scalar(`select count(*)::int as v from ledger_entries where source_id = $1`, [november.body.salary.id]), 0);

    // August (before) and September (the resignation month) are real salary.
    assert.equal((await call('manager', 'POST', `${PAYROLL}/salaries/${august.body.salary.id}/approve`, {})).status, 200);
    await paid(dilber.id, ym(PAST, 9), 2800);

    const row = rowOf(await salaryLedger(PAST), dilber.id);
    assert.deepEqual(
      [7, 8, 9, 10, 11, 12].map((m) => [cell(row, m).state, cell(row, m).amount]),
      [['paid', 3000], ['paid', 3000], ['paid', 2800], ['closed', 0], ['closed', 0], ['closed', 0]],
    );
    assert.equal(cell(row, 11).pendingCount, 1, 'the stranded payslip is still visible as pending');
    assert.equal(cell(row, 9).flagged, false);

    // Advances stop too: the employee is no longer active.
    const advance = await call('accountant', 'POST', `${PAYROLL}/advances`, {
      employeeId: dilber.id, advanceAmount: 500, bonusAmount: 0, loanAmount: 0,
      paymentMethod: 'cash', account: 'cash', attachmentIds: [await photo('accountant', 'employee_advance')],
    });
    assert.equal(advance.status, 400);
  });

  test('a salary already approved for a later month is kept and flagged for review', async () => {
    const faisal = await employee('Faisal Karim', `${PAST}-02-15`);
    for (const m of [8, 9, 10]) await paid(faisal.id, ym(PAST, m), 18000);

    // Recorded late: he left on 20 August, but September and October were paid.
    const res = await resign(faisal.id, { resignationDate: `${PAST}-08-20`, resignationTime: '16:05', reason: 'Personal reasons' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.impact.approvedAfter.map((p: Json) => [p.salaryMonth, p.amount]), [[ym(PAST, 9), 18000], [ym(PAST, 10), 18000]]);

    const ledger = await salaryLedger(PAST);
    const row = rowOf(ledger, faisal.id);
    assert.deepEqual(
      [8, 9, 10, 11].map((m) => [cell(row, m).state, cell(row, m).amount, cell(row, m).flagged]),
      [['paid', 18000, false], ['paid', 18000, true], ['paid', 18000, true], ['closed', 0, false]],
    );
    assert.equal(row.total, 54000, 'nothing was removed or altered');
    assert.equal(row.flaggedMonths, 2);
    assert.equal(ledger.summary.flaggedMonths, 2);
    assert.equal(await scalar(`select count(*)::int as v from salary_payments where employee_id = $1 and status = 'posted' and deleted_at is null`, [faisal.id]), 3);

    const detail = await call('auditor', 'GET', `${PAYROLL}/ledger/payments?employeeId=${faisal.id}&year=${PAST}&month=10`);
    assert.equal(detail.body.payments[0].afterResignation, true);
    assert.equal(detail.body.payments[0].counted, true);

    const audit = await scalar<Json>(`select new_values as v from finance_audit_logs where action = 'resigned' and entity_id = $1`, [faisal.id]);
    assert.equal(audit.approvedAfter.length, 2, 'the trail records what was left standing');
  });

  test('a resigned employee cannot simply be switched back to active', async () => {
    const res = await call('admin', 'PUT', `${PAYROLL}/employees/${shabbir.id}`, { isActive: true });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Cancel the resignation/);
    assert.equal(await scalar<boolean>(`select is_active as v from finance_employees where id = $1`, [shabbir.id]), false);
  });

  test('cancelling is controlled, and the original record stays in the history', async () => {
    const cancel = (as: string, body: Json) => call(as, 'POST', `${PAYROLL}/employees/${shabbir.id}/resignation/cancel`, body);
    assert.equal((await cancel('manager', { reason: 'Recorded for the wrong person' })).status, 403);
    assert.equal((await cancel('admin', { reason: '' })).status, 400);

    const res = await cancel('admin', { reason: 'Recorded for the wrong person' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      [res.body.resignation.status, res.body.resignation.cancelledBy, res.body.resignation.cancelReason, res.body.resignation.resignationDate],
      ['cancelled', ACTORS['admin']!.id, 'Recorded for the wrong person', `${PAST}-09-15`],
    );
    assert.ok(res.body.resignation.cancelledAt);
    assert.equal(res.body.employee.isActive, true);
    assert.equal(res.body.employee.resignation, null);
    assert.equal((await cancel('admin', { reason: 'Again' })).status, 409, 'nothing left to cancel');

    // The correction: record the right date. Both records remain.
    const corrected = await resign(shabbir.id, { resignationDate: `${PAST}-09-30`, resignationTime: '18:00', reason: 'Better opportunity' });
    assert.equal(corrected.status, 201);
    const profile = await call('auditor', 'GET', `${PAYROLL}/employees/${shabbir.id}`);
    assert.deepEqual(
      profile.body.profile.resignations.map((r: Json) => [r.status, r.resignationDate]),
      [['recorded', `${PAST}-09-30`], ['cancelled', `${PAST}-09-15`]],
    );
    assert.equal(await scalar(`select count(*)::int as v from finance_audit_logs where entity_id = $1 and action in ('resigned', 'resignation_cancelled')`, [shabbir.id]), 3);
    assert.equal(rowOf(await salaryLedger(PAST), shabbir.id).total, 270000);
  });

  // LAST in this block on purpose: a trigger that raises can unsettle pglite.
  test('the database itself refuses an approval that slips past the API', async () => {
    const stranded = await scalar<string>(
      `select sp.id::text as v from salary_payments sp
         join employee_resignations r on r.employee_id = sp.employee_id and r.status = 'recorded'
        where sp.status = 'pending_approval' and sp.salary_month > to_char(r.resignation_date, 'YYYY-MM')
        limit 1`,
    );
    await assert.rejects(
      db.query(`update salary_payments set status = 'approved' where id = $1`, [stranded]),
      /after the resignation month/,
    );
    assert.equal(await scalar<string>(`select status::text as v from salary_payments where id = $1`, [stranded]), 'pending_approval');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C. Company Transaction Details', () => {
  const p = (n: number) => PARTNER[`PT-00000${n}`]!;

  test('every partner has a permanent ID', () => {
    assert.deepEqual(Object.keys(PARTNER).sort(), ['PT-000001', 'PT-000002', 'PT-000003', 'PT-000004']);
    assert.equal(p(1).name, 'Mohsin Abbas');
  });

  test('three approved transactions in March are one row and one figure: 30,000', async () => {
    await partnerPaid(p(1).id, 'draw', 10000, `${PAST}-03-04`);
    await partnerPaid(p(1).id, 'draw', 15000, `${PAST}-03-14`);
    await partnerPaid(p(1).id, 'advance', 5000, `${PAST}-03-27`);

    const ledger = await partnerLedger(PAST);
    assert.equal(ledger.rows.filter((r: Json) => r.partnerId === p(1).id).length, 1);
    const row = partnerRow(ledger, p(1).id);
    assert.deepEqual([row.partnerCode, row.partnerName], ['PT-000001', 'Mohsin Abbas']);
    assert.equal(row.cells[2].amount, 30000);
    assert.equal(row.cells[2].count, 3);
    assert.equal(row.total, 30000);

    const detail = await call('auditor', 'GET', `${PARTNERS}/ledger/transactions?partnerId=${p(1).id}&year=${PAST}&month=3`);
    assert.equal(detail.body.transactions.length, 3);
    assert.equal(detail.body.countedTotal, 30000);
    assert.ok(detail.body.transactions.every((t: Json) => /^PEX-\d{6}$/.test(t.expenseNo) && /^PV-\d{6}$/.test(t.voucherNo) && t.approvedByName === 'fmanager@mb.test'));
    assert.equal(await scalar(`select count(*)::int as v from partner_expenses where partner_id = $1`, [p(1).id]), 3, 'three source records, untouched');
  });

  test('pending, draft and rejected transactions are not counted', async () => {
    assert.equal((await partnerTxn(p(2).id, 'draw', 30000, `${PAST}-05-06`)).status, 201); // pending
    assert.equal((await partnerTxn(p(2).id, 'draw', 7000, `${PAST}-05-07`, { asDraft: true })).status, 201);
    const rejected = await partnerTxn(p(2).id, 'draw', 15000, `${PAST}-05-22`);
    assert.equal((await call('manager', 'POST', `${PARTNERS}/${rejected.body.expense.id}/reject`, { reason: 'Not agreed' })).status, 200);
    await partnerPaid(p(2).id, 'draw', 20000.1, `${PAST}-05-10`);
    await partnerPaid(p(2).id, 'draw', 0.2, `${PAST}-05-11`);

    const row = partnerRow(await partnerLedger(PAST), p(2).id);
    assert.equal(row.cells[4].amount, 20000.3, 'paisa add up exactly');
    assert.equal(row.cells[4].count, 2);
    assert.equal(row.cells[4].pendingCount, 2);
    assert.equal(row.hasPending, true);

    const detail = await call('auditor', 'GET', `${PARTNERS}/ledger/transactions?partnerId=${p(2).id}&year=${PAST}&month=5`);
    assert.deepEqual(
      detail.body.transactions.map((t: Json) => t.exclusion).sort(),
      [null, null, 'draft', 'pending', 'rejected'].sort(),
    );
    assert.equal(detail.body.countedTotal, 20000.3);
    assert.equal(detail.body.countedCount, 2);
  });

  test('the year total is the sum of the months, and the months are the sum of the rows', async () => {
    await partnerPaid(p(3).id, 'advance', 55000, `${PAST}-06-28`);
    await partnerPaid(p(3).id, 'draw', 12345.67, `${PAST}-12-31`);

    const ledger = await partnerLedger(PAST);
    const sum = (list: number[]) => Math.round(list.reduce((t, v) => t + v * 100, 0)) / 100;
    for (const row of ledger.rows) assert.equal(row.total, sum(row.cells.map((c: Json) => c.amount)));
    for (let m = 0; m < 12; m++) assert.equal(ledger.monthTotals[m], sum(ledger.rows.map((r: Json) => r.cells[m].amount)));
    assert.equal(ledger.yearTotal, sum(ledger.monthTotals));
    assert.equal(ledger.yearTotal, 30000 + 20000.3 + 55000 + 12345.67);
    assert.equal(ledger.summary.yearTotal, ledger.yearTotal);
    assert.equal(ledger.summary.transactionCount, 7);
    assert.equal(ledger.summary.partners, 3);
    assert.deepEqual(ledger.summary.highestMonth, { month: 6, amount: 55000 });

    const all = await call('auditor', 'GET', `${PARTNERS}/ledger/transactions?year=${PAST}&limit=500`);
    assert.equal(all.body.countedTotal, ledger.yearTotal);
  });

  test('advances and draws can be looked at separately', async () => {
    const advances = await partnerLedger(PAST, '&txnKind=advance');
    assert.equal(partnerRow(advances, p(1).id).cells[2].amount, 5000);
    assert.equal(advances.yearTotal, 60000);
    assert.equal(partnerRow(advances, p(2).id), undefined);
    const draws = await partnerLedger(PAST, '&txnKind=draw');
    assert.equal(partnerRow(draws, p(1).id).cells[2].amount, 25000);
  });

  test('a removed voucher drops out; a re-dated one moves to the month it now sits in', async () => {
    const removed = await partnerPaid(p(4).id, 'draw', 9000, `${PAST}-02-10`);
    const moved = await partnerPaid(p(4).id, 'draw', 4000, `${PAST}-02-20`);
    assert.equal(partnerRow(await partnerLedger(PAST), p(4).id).cells[1].amount, 13000);

    await db.query(`update ledger_entries set deleted_at = now(), delete_reason = 'paid twice' where id = $1`, [removed.ledgerEntryId]);
    await db.query(`update ledger_entries set entry_date = $2 where id = $1`, [moved.ledgerEntryId, `${PAST}-04-02`]);

    const row = partnerRow(await partnerLedger(PAST), p(4).id);
    assert.equal(row.cells[1].amount, 0);
    assert.equal(row.cells[3].amount, 4000);
    assert.equal(row.total, 4000);

    const detail = await call('auditor', 'GET', `${PARTNERS}/ledger/transactions?partnerId=${p(4).id}&year=${PAST}`);
    const gone = detail.body.transactions.find((t: Json) => t.id === removed.id);
    assert.deepEqual([gone.status, gone.exclusion, gone.countedAmount], ['posted', 'voucher_removed', 0]);
  });

  test('a transaction with no partner on record is reported, not hidden and not guessed', async () => {
    const head = await scalar<string>(`select id::text as v from ledger_heads where code = '${SYSTEM_LEDGER_HEAD_CODES.PARTNER_WITHDRAWAL}'`);
    await db.query(
      `insert into partner_expenses (partner_name, ledger_head_id, ledger_head_name, description, amount, payment_method, account, business_date, status)
       values ('saleem bhai', $1, 'Partner Withdrawal', 'Old entry', 2500, 'cash', 'cash', $2, 'posted')`,
      [head, `${PAST}-01-15`],
    );
    const ledger = await partnerLedger(PAST);
    assert.deepEqual(ledger.summary.unassigned, { count: 1, amount: 2500 });
    assert.equal(ledger.rows.length, 4);
    assert.equal(ledger.monthTotals[0], 0, 'it belongs to no row, so to no row total');
  });

  test('other years are separate and stay as they were', async () => {
    const past = await partnerLedger(PAST);
    await partnerPaid(p(1).id, 'draw', 1000, `${THIS}-01-02`);

    assert.deepEqual(await partnerLedger(PAST), { ...past, years: (await partnerLedger(PAST)).years });
    const current = await partnerLedger(THIS);
    assert.deepEqual(current.rows.map((r: Json) => [r.partnerCode, r.total]), [['PT-000001', 1000]]);
    assert.equal((await partnerLedger(PAST - 5)).rows.length, 0);
    assert.ok(current.years.some((y: Json) => y.year === PAST && y.hasRecords));
    assert.ok(current.years.some((y: Json) => y.year === THIS + 1 && !y.hasRecords));
  });

  test('search and sort', async () => {
    assert.deepEqual((await partnerLedger(PAST, '&search=pt-000002')).rows.map((r: Json) => r.partnerCode), ['PT-000002']);
    assert.deepEqual((await partnerLedger(PAST, '&search=shahid')).rows.map((r: Json) => r.partnerCode), ['PT-000003']);
    const byTotal = (await partnerLedger(PAST, '&sort=total')).rows.map((r: Json) => r.total);
    assert.deepEqual(byTotal, [...byTotal].sort((a, b) => b - a));
  });

  test('read-only: nothing under the ledger accepts a write, and roles are enforced', async () => {
    for (const path of [`${PARTNERS}/ledger`, `${PARTNERS}/ledger/transactions`]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal((await call('admin', method, path, { amount: 1 })).status, 405, `${method} ${path}`);
      }
    }
    assert.equal((await call(null, 'GET', `${PARTNERS}/ledger`)).status, 401);
    assert.equal((await call('branch', 'GET', `${PARTNERS}/ledger`)).status, 403);
    assert.equal((await call('owner', 'GET', `${PARTNERS}/ledger?year=${PAST}`)).status, 200);

    const before = await scalar(`select count(*)::int as v from partner_expenses`);
    assert.equal((await call('auditor', 'POST', PARTNERS, { partnerId: p(1).id, txnKind: 'draw', amount: 1 })).status, 403);
    const pending = await partnerTxn(p(1).id, 'draw', 500, `${PAST}-08-01`);
    assert.equal((await call('accountant', 'POST', `${PARTNERS}/${pending.body.expense.id}/approve`, {})).status, 403);
    assert.equal((await call('owner', 'POST', `${PARTNERS}/${pending.body.expense.id}/approve`, {})).status, 403);
    assert.equal(await scalar(`select count(*)::int as v from partner_expenses`), before + 1);
    assert.equal(partnerRow(await partnerLedger(PAST), p(1).id).cells[7].amount, 0);

    // Approving twice counts once.
    const id = pending.body.expense.id;
    assert.equal((await call('manager', 'POST', `${PARTNERS}/${id}/approve`, {})).status, 200);
    assert.equal((await call('manager', 'POST', `${PARTNERS}/${id}/approve`, {})).status, 409);
    assert.equal(await scalar(`select count(*)::int as v from ledger_entries where source_id = $1`, [id]), 1);
    assert.equal(partnerRow(await partnerLedger(PAST), p(1).id).cells[7].amount, 500);
  });
});
