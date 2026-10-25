import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * The Daily Ledger's Excel button, end to end: vouchers posted by the REAL
 * `post_finance_ledger_entry` from the baseline, read by the REAL route, and
 * the workbook it returns opened again with ExcelJS.
 *
 * DB_MAX_ROWS is set to 3, far under the number of vouchers, so the export
 * only gets every voucher — on the accounting sheets AND on the Daily Cash
 * Book sheet ahead of them — if it really pages through the book.
 */

const BASELINE = readFileSync(join(__dirname, '../../../prisma/migrations/0_baseline/migration.sql'), 'utf8');
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

let db: PGlite;
let server: Server;
let base: string;

const ACTORS = {
  auditor: { id: '30000000-0000-4000-8000-000000000001', email: 'auditor@mb.test', role: 'finance_auditor' },
  branch: { id: '30000000-0000-4000-8000-000000000002', email: 'branch@mb.test', role: 'branch_manager' },
} as const;
const TOKENS: Record<string, string> = {};
const GULBERG = '40000000-0000-4000-8000-000000000001';
const DHA = '40000000-0000-4000-8000-000000000002';
const TRANSFER = '50000000-0000-4000-8000-000000000001';
const HEAD: Record<string, string> = {};

async function post(
  date: string, code: string, side: 'debit' | 'credit', amount: number,
  o: { account?: string; method?: string | null; source?: string; sourceId?: string | null; branch?: [string, string] | null; description?: string } = {},
) {
  await db.query(
    `select post_finance_ledger_entry(
       p_entry_date => $1::date, p_ledger_head_id => $2::uuid, p_description => $3,
       p_debit => $4::numeric, p_credit => $5::numeric, p_account => $6::finance_account,
       p_source_type => $7::finance_ledger_source, p_source_id => $8::uuid,
       p_branch_id => $9::uuid, p_branch_name => $10, p_payment_method => $11,
       p_approved_by => null, p_approved_by_name => 'Test', p_created_by => null, p_created_by_name => 'Test',
       p_reverses_entry_id => null)`,
    [
      date, HEAD[code], o.description ?? `${code} ${amount}`,
      side === 'debit' ? amount : 0, side === 'credit' ? amount : 0,
      o.account ?? 'cash', o.source ?? 'manual', o.sourceId ?? null,
      o.branch?.[0] ?? null, o.branch?.[1] ?? null, o.method === undefined ? 'cash' : o.method,
    ],
  );
}

async function download(as: keyof typeof ACTORS | null, query: string) {
  const res = await fetch(`${base}/api/finance/reports/accounting-workbook${query}`, {
    headers: as ? { Authorization: `Bearer ${TOKENS[as]}` } : {},
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

async function open(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** Entry IDs (column A) on General Entries, one per journal entry. */
function entryIds(wb: ExcelJS.Workbook): string[] {
  const ids = new Set<string>();
  wb.getWorksheet('General Entries')!.eachRow((row, n) => {
    const v = row.getCell(1).value;
    if (n > 6 && typeof v === 'string' && /^(RV|PV)-/.test(v)) ids.add(v);
  });
  return [...ids];
}

before(async () => {
  process.env['JWT_SECRET'] = 'finance-accounting-test-secret-that-is-long-enough';
  process.env['DB_MAX_ROWS'] = '3';

  db = new PGlite();
  await db.exec(STUBS);
  for (const t of ['finance_account', 'ledger_entry_status', 'ledger_head_type', 'finance_ledger_source']) {
    await db.exec(type(t));
  }
  await db.exec(lift('CREATE FUNCTION app.next_finance_number(', '$$;'));
  for (const t of ['finance_settings', 'finance_day_closings', 'ledger_heads', 'ledger_entries']) await db.exec(table(t));
  await db.exec(`
    alter table public.ledger_heads add primary key (id);
    alter table public.ledger_entries add primary key (id);
    create sequence public.ledger_entries_seq_seq;
    alter table public.ledger_entries alter column seq set default nextval('public.ledger_entries_seq_seq');
  `);
  await db.exec(lift('CREATE FUNCTION public.post_finance_ledger_entry(', '$$;'));
  await db.exec(lift('CREATE FUNCTION public.finance_day_summary(', '$$;'));
  await db.exec(`begin;${AUTH}commit;`);

  await db.exec(`
    insert into counters (id, count) values ('finance_receipt_voucher', 0), ('finance_payment_voucher', 0);
    insert into finance_settings default values;
    insert into branches (id, name) values ('${GULBERG}', 'Gulberg'), ('${DHA}', 'DHA');
    insert into cash_transfers (id, cash_amount, easypaisa_amount, bank_amount) values ('${TRANSFER}', 7000, 2000, 1000);
    insert into ledger_heads (code, name, type, group_name, is_system) values
      ('INC-OPENING', 'Opening Balance', 'income', 'Opening', true),
      ('INC-COMPANY-SHARE', 'Company Share', 'income', 'Share Split', true),
      ('INC-EASYPAISA', 'Easypaisa Collection', 'income', 'Branch Collection', false),
      ('INC-INVESTMENT', 'Investment', 'income', 'Capital', false),
      ('EXP-SALARIES', 'Salaries', 'expense', 'Payroll', true),
      ('EXP-PARTNER', 'Partner Withdrawals', 'expense', 'Partners', true),
      ('EXP-ELECTRICITY', 'Electricity', 'expense', 'Utilities', false);
  `);
  for (const r of (await db.query<{ id: string; code: string }>('select id, code from ledger_heads')).rows) HEAD[r.code] = r.id;

  // Before the period.
  await post('2026-10-01', 'INC-OPENING', 'debit', 50000, { source: 'opening', method: null });
  await post('2026-10-01', 'INC-OPENING', 'debit', 20000, { source: 'opening', account: 'bank', method: null });
  await post('2026-10-02', 'INC-COMPANY-SHARE', 'debit', 4000, { branch: [GULBERG, 'Gulberg'] });
  // The period, 10–11 Oct.
  await post('2026-10-10', 'INC-COMPANY-SHARE', 'debit', 10000, {
    source: 'cash_transfer', sourceId: TRANSFER, method: 'cash+easypaisa+bank_account', branch: [GULBERG, 'Gulberg'],
  });
  await post('2026-10-10', 'INC-EASYPAISA', 'debit', 1500, { method: 'easypaisa', branch: [DHA, 'DHA'] });
  await post('2026-10-10', 'INC-INVESTMENT', 'debit', 5000, { account: 'bank', method: 'bank_transfer' });
  await post('2026-10-11', 'EXP-SALARIES', 'credit', 6000, { source: 'salary' });
  await post('2026-10-11', 'EXP-PARTNER', 'credit', 2000, { source: 'partner_expense' });
  await post('2026-10-11', 'EXP-ELECTRICITY', 'credit', 1200, {
    account: 'bank', method: 'bank_transfer', branch: [DHA, 'DHA'], description: '=1+1 electricity',
  });
  // After the period.
  await post('2026-10-12', 'EXP-ELECTRICITY', 'credit', 999);

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

  const express = (await import('express')).default;
  const { router } = await import('../../routes/finance-reports.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use('/api/finance/reports', router);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  delete process.env['DB_MAX_ROWS'];
  server?.close();
  await db?.close();
});

describe('access', () => {
  test('no token is 401; a branch manager is refused the finance books', async () => {
    assert.equal((await download(null, '')).res.status, 401);
    assert.equal((await download('branch', '?from=2026-10-10&to=2026-10-11')).res.status, 403);
  });

  test('a bad range or an unknown branch is refused with a reason', async () => {
    assert.equal((await download('auditor', '?from=2026-10-11&to=2026-10-10')).res.status, 400);
    assert.equal((await download('auditor', '?from=2026-02-31')).res.status, 400);
    assert.equal((await download('auditor', '?branchId=not-a-uuid')).res.status, 400);
    assert.equal((await download('auditor', '?branchId=40000000-0000-4000-8000-0000000000ff')).res.status, 404);
  });
});

describe('the workbook', () => {
  test('is a real .xlsx: the existing cash book sheet, then the five sheets in order, with a meaningful name', async () => {
    const { res, buf } = await download('auditor', '?from=2026-10-10&to=2026-10-11');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
    assert.match(res.headers.get('content-disposition') ?? '', /Mountain_Bakes_Daily_Ledger_2026-10-10_to_2026-10-11\.xlsx/);
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    const wb = await open(buf);
    assert.deepEqual(wb.worksheets.map((s) => s.name), [
      'Daily Cash Book', 'General Entries', 'Ledger', 'Trial Balance', 'Income Statement', 'Balance Sheet',
    ]);
  });

  test('the Daily Cash Book sheet lists the same vouchers as General Entries, past the row cap', async () => {
    const wb = await open((await download('auditor', '?from=2026-10-10&to=2026-10-11')).buf);
    const cb = wb.getWorksheet('Daily Cash Book')!;
    const vouchers: string[] = [];
    cb.eachRow((row) => {
      const v = row.getCell(2).value;
      if (typeof v === 'string' && /^(RV|PV)-/.test(v)) vouchers.push(v);
    });
    assert.deepEqual(vouchers.sort(), entryIds(wb).sort());
    assert.equal(vouchers.length, 6);
  });

  test('holds every voucher in the period — read across several pages — and none outside it', async () => {
    const wb = await open((await download('auditor', '?from=2026-10-10&to=2026-10-11')).buf);
    const ids = entryIds(wb);
    assert.equal(ids.length, 6);
    const { rows } = await db.query<{ voucher_no: string }>(
      `select voucher_no from ledger_entries where entry_date between '2026-10-10' and '2026-10-11' order by seq`,
    );
    assert.deepEqual(ids.sort(), rows.map((r) => r.voucher_no).sort());
  });

  test('Easypaisa goes under Bank and the mixed transfer is split by channel', async () => {
    const wb = await open((await download('auditor', '?from=2026-10-10&to=2026-10-11')).buf);
    const accounts: string[] = [];
    wb.getWorksheet('General Entries')!.eachRow((row, n) => {
      if (n > 6) accounts.push(String(row.getCell(4).value ?? ''));
    });
    assert.equal(accounts.filter((a) => a === 'Bank — Easypaisa').length, 2); // the transfer's share and the collection

    // Closing: cash 50 000 + 4 000 + 7 000 − 6 000 − 2 000; bank 20 000 + 1 000 + 5 000 − 1 200; Easypaisa 2 000 + 1 500.
    const tb = wb.getWorksheet('Trial Balance')!;
    const closing = new Map<string, number>();
    tb.eachRow((row) => {
      const name = row.getCell(1).value;
      if (typeof name === 'string') closing.set(name, Number(row.getCell(8).value ?? 0) - Number(row.getCell(9).value ?? 0));
    });
    assert.equal(closing.get('Cash in Hand'), 53000);
    assert.equal(closing.get('Bank — Bank Account'), 24800);
    assert.equal(closing.get('Bank — Easypaisa'), 3500);
  });

  test('balance sheet balances: assets = General Fund + retained earnings + period profit', async () => {
    const wb = await open((await download('auditor', '?from=2026-10-10&to=2026-10-11')).buf);
    const bs = wb.getWorksheet('Balance Sheet')!;
    const value = (label: string) => {
      let out: unknown;
      bs.eachRow((row) => {
        if (out === undefined && row.getCell(1).value === label) out = row.getCell(3).value;
      });
      return out;
    };
    assert.equal(value('Total assets'), 53000 + 24800 + 3500);
    assert.equal(value('Total General Fund'), 50000 + 20000 + 5000 - 2000);
    assert.equal(value('Balance check (assets − liabilities − equity)'), 0);
  });

  test('a typed formula is stored as text', async () => {
    const wb = await open((await download('auditor', '?from=2026-10-10&to=2026-10-11')).buf);
    let found = false;
    wb.getWorksheet('General Entries')!.eachRow((row) => {
      if (row.getCell(5).value === "'=1+1 electricity") found = true;
    });
    assert.ok(found);
  });

  test('General Entries holds only its seven columns: no line, posted-at, source, code, channel, status or author', async () => {
    const wb = await open((await download('auditor', '?from=2026-10-10&to=2026-10-11')).buf);
    const ge = wb.getWorksheet('General Entries')!;
    assert.deepEqual((ge.getRow(6).values as unknown[]).filter(Boolean), [
      'Entry ID', 'Business Date', 'Branch', 'Account Name', 'Narration', 'Debit (DR)', 'Credit (CR)',
    ]);
    ge.eachRow((row, n) => {
      if (n > 6) assert.equal(row.getCell(8).value, null);
    });
  });

  test('a branch filter applies to every voucher in the file', async () => {
    const { res, buf } = await download('auditor', `?from=2026-10-10&to=2026-10-11&branchId=${DHA}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /_DHA\.xlsx/);
    const wb = await open(buf);
    const { rows } = await db.query<{ voucher_no: string }>(
      `select voucher_no from ledger_entries where branch_id = $1 and entry_date between '2026-10-10' and '2026-10-11'`,
      [DHA],
    );
    assert.deepEqual(entryIds(wb).sort(), rows.map((r) => r.voucher_no).sort());
    assert.equal(rows.length, 2);
  });

  test('exporting again writes nothing and gives the same figures', async () => {
    const snapshot = async () =>
      (await db.query<{ n: number; s: string }>(`select count(*)::int as n, coalesce(sum(debit - credit), 0)::text as s from ledger_entries`)).rows[0];
    const before = await snapshot();
    const a = await download('auditor', '?from=2026-10-10&to=2026-10-11');
    const b = await download('auditor', '?from=2026-10-10&to=2026-10-11');
    assert.deepEqual(await snapshot(), before);
    const tbTotals = async (buf: Buffer) => {
      const tb = (await open(buf)).getWorksheet('Trial Balance')!;
      let out: unknown[] = [];
      tb.eachRow((row) => {
        if (row.getCell(1).value === 'TOTAL') out = [4, 5, 6, 7, 8, 9].map((c) => (row.getCell(c).value as ExcelJS.CellFormulaValue).result);
      });
      return out;
    };
    assert.deepEqual(await tbTotals(a.buf), await tbTotals(b.buf));
    assert.equal(a.res.headers.get('x-accounting-status'), b.res.headers.get('x-accounting-status'));
  });

  test('an empty period still downloads all six sheets', async () => {
    const { res, buf } = await download('auditor', '?from=2026-09-01&to=2026-09-02');
    assert.equal(res.status, 200);
    const wb = await open(buf);
    assert.equal(wb.worksheets.length, 6);
    assert.equal(entryIds(wb).length, 0);
  });
});
