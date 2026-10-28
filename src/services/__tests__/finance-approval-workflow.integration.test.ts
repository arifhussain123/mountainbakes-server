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
import { businessDateStr, businessDaysAgoStr } from '../../shared';

/**
 * The Accountant → Finance Admin approval workflow end to end
 * (migration 20261028000001_finance_approval_workflow): the REAL baseline
 * tables and posting functions, the migration applied as `prisma migrate
 * deploy` applies it, existing rows written before it, and the real routes
 * behind real access tokens.
 *
 * Income & Expense entries: draft → submit → reject (remarks required) →
 * correct → resubmit (same row, revision 2) → approve, which posts the voucher
 * and the entry together or not at all. Cash deposits: rejected → corrected and
 * resubmitted by the branch with its branch and date unchanged → approved.
 * Since 20261028000002_cash_deposit_accounts_review a deposit is with Accounts
 * first: the Accountant edits it and submits it for approval, and only then
 * may Finance Admin decide it; a resubmission returns to Accounts.
 *
 * Two approvers at the same instant cannot be shown here: pglite is one
 * connection. That case rests on the row lock in approve_finance_transaction
 * and was run against a real Postgres 18 (see the commit message).
 */

const PRISMA = join(__dirname, '../../../prisma/migrations');
const BASELINE = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
const MIGRATION = readFileSync(join(PRISMA, '20261028000001_finance_approval_workflow/migration.sql'), 'utf8');
const ACCOUNTS_REVIEW = readFileSync(join(PRISMA, '20261028000002_cash_deposit_accounts_review/migration.sql'), 'utf8');
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

const TYPES = [
  'finance_doc_status', 'finance_account', 'ledger_entry_status', 'ledger_head_type', 'finance_ledger_source',
  'attachment_entity', 'cash_transfer_status',
];
const TABLES = [
  'finance_settings', 'finance_day_closings', 'finance_audit_logs', 'ledger_heads', 'ledger_entries',
  'finance_transactions', 'attachments', 'cash_transfers', 'restriction_rules', 'restriction_requests',
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
  create table branches (id uuid primary key default gen_random_uuid(), name text, slug text, company_share_pct numeric);
  create table notifications (id uuid primary key default gen_random_uuid(), type text, title text, message text,
    target_role text, target_user_id uuid, branch_id uuid, related_id uuid, is_read boolean default false,
    created_at timestamptz default now());
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
`;

const ALPHA = '40000000-0000-4000-8000-00000000000a';
const BETA = '40000000-0000-4000-8000-00000000000b';
const HEADS = {
  sales: '70000000-0000-4000-8000-000000000001', // income
  rent: '70000000-0000-4000-8000-000000000002', // expense
  fuel: '70000000-0000-4000-8000-000000000003', // expense
  closed: '70000000-0000-4000-8000-000000000004', // expense, inactive
};

interface Actor { id: string; email: string; role: string; branchId?: string }
const ACTORS: Record<string, Actor> = {
  accountant: { id: '20000000-0000-4000-8000-000000000001', email: 'accountant@mb.test', role: 'accountant' },
  admin: { id: '20000000-0000-4000-8000-000000000002', email: 'fadmin@mb.test', role: 'finance_admin' },
  auditor: { id: '20000000-0000-4000-8000-000000000003', email: 'auditor@mb.test', role: 'finance_auditor' },
  branch: { id: '20000000-0000-4000-8000-000000000004', email: 'alpha@mb.test', role: 'branch_manager', branchId: ALPHA },
  other: { id: '20000000-0000-4000-8000-000000000005', email: 'beta@mb.test', role: 'branch_manager', branchId: BETA },
  owner: { id: '20000000-0000-4000-8000-000000000006', email: 'owner@mb.test', role: 'super_admin' },
};
const TOKENS: Record<string, string> = {};

const ENTRIES = '/api/finance/income/entries';
const FIN_CT = '/api/finance/cash-transfers';
const CT = '/api/cash-transfers';
const TODAY = businessDateStr();
const YESTERDAY = businessDaysAgoStr(1);
const PHOTO = '80000000-0000-4000-8000-000000000001';
const LEGACY_CT = { pending: '90000000-0000-4000-8000-000000000001', rejected: '90000000-0000-4000-8000-000000000002' };

let db: PGlite;
let server: Server;
let base: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(as: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
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

let photoSeq = 0;
/** A staged receipt photo, as POST /api/attachments leaves one, for a create to bind. */
async function stagedPhoto(entity: 'finance_transaction' | 'cash_transfer', uploader: string): Promise<string> {
  const id = `80000000-0000-4000-8000-${String(++photoSeq).padStart(12, '0')}`;
  await db.query(
    `insert into attachments (id, entity, storage_path, mime_type, size_bytes, uploaded_by)
     values ($1, $2, $3, 'image/jpeg', 100, $4)`,
    [id, entity, `staged/${id}.jpg`, ACTORS[uploader]!.id],
  );
  return id;
}

async function newEntry(as: string, input: Record<string, unknown>): Promise<Json> {
  const attachmentIds = [await stagedPhoto('finance_transaction', as)];
  return ok(await call(as, 'POST', ENTRIES, { account: 'cash', paymentMethod: 'cash', attachmentIds, ...input }), 201).entry;
}
const history = async (id: string, as = 'accountant') => ok(await call(as, 'GET', `${ENTRIES}/${id}/history`)).events as Json[];
const entry = async (id: string) => ok(await call('accountant', 'GET', `${ENTRIES}/${id}`)).entry;
const ledgerCount = async () => Number((await db.query<{ n: string }>(`select count(*) n from ledger_entries`)).rows[0]!.n);
const counter = async (key: string) =>
  Number((await db.query<{ count: string }>(`select count from counters where id = $1`, [key])).rows[0]?.count ?? 0);

before(async () => {
  process.env['JWT_SECRET'] = 'finance-approval-workflow-test-secret-long-enough';
  process.env['FILES_S3_BUCKET'] = 'test-bucket';
  process.env['PUBLIC_API_URL'] = 'https://api.test';

  db = new PGlite();
  await db.exec(STUBS);
  for (const t of TYPES) await db.exec(type(t));
  await db.exec(fn('app.next_finance_number'));
  await db.exec(fn('app.business_date'));
  for (const t of TABLES) await db.exec(table(t));
  await db.exec(`
    ${TABLES.filter((t) => !['finance_settings', 'finance_day_closings', 'restriction_rules'].includes(t))
      .map((t) => `alter table public.${t} add primary key (id);`).join('\n')}
    alter table public.finance_day_closings add primary key (business_date);
    alter table public.finance_transactions add constraint finance_transactions_txn_no_key unique (txn_no);
    create sequence public.ledger_entries_seq_seq;
    alter table public.ledger_entries alter column seq set default nextval('public.ledger_entries_seq_seq');
    create trigger finance_transactions_touch before update on public.finance_transactions
      for each row execute function app.touch_updated_at();
    create trigger cash_transfers_touch before update on public.cash_transfers
      for each row execute function app.touch_updated_at();
  `);
  for (const f of [
    'public.post_finance_ledger_entry', 'public.recompute_finance_ledger_balances', 'app.cash_transfer_slices',
    'app.edit_ledger_entry', 'app.sync_cash_transfer_entries', 'public.approve_cash_transfer', 'public.reject_cash_transfer',
  ]) {
    await db.exec(fn(f));
  }
  await db.exec(`begin;${AUTH}commit;`);

  await db.exec(`
    insert into counters (id, count) values
      ('finance_txn', 0), ('cash_transfer', 0), ('finance_receipt_voucher', 0), ('finance_payment_voucher', 0);
    insert into finance_settings default values;
    insert into branches (id, name, slug) values ('${ALPHA}', 'Alpha', 'alpha'), ('${BETA}', 'Beta', 'beta');
    insert into ledger_heads (id, code, name, type, is_active) values
      ('${HEADS.sales}', 'INC-OTHER', 'Other Income', 'income', true),
      ('${HEADS.rent}', 'EXP-RENT', 'Rent', 'expense', true),
      ('${HEADS.fuel}', 'EXP-FUEL', 'Fuel', 'expense', true),
      ('${HEADS.closed}', 'EXP-OLD', 'Old Head', 'expense', false);
    insert into ledger_heads (code, name, type, is_system) values
      ('INC-COMPANY-SHARE', 'Company Share', 'income', true),
      ('INC-FUEL', 'Fuel Charges', 'income', true);
  `);

  for (const [, a] of Object.entries(ACTORS)) {
    await db.query(`insert into users (id, email, display_name, role, branch_id) values ($1, $2, $2, $3, $4)`,
      [a.id, a.email, a.role, a.branchId ?? null]);
  }

  // Written before the migration exists: a rejection stored the old way (the
  // rejecter in approved_*), an entry raised straight into the queue, a draft.
  await db.query(`
    insert into finance_transactions (txn_no, txn_type, ledger_head_id, ledger_head_name, description, amount,
      payment_method, account, business_date, status, created_by, created_by_name, created_at,
      approved_by, approved_by_name, approved_at, rejection_reason)
    values
      ('FTX-LEGACY1', 'expense', '${HEADS.rent}', 'Rent', 'old rejected', 100, 'cash', 'cash', '${YESTERDAY}', 'rejected',
       '${ACTORS.accountant!.id}', 'accountant@mb.test', '2026-10-01T09:00:00+05',
       '${ACTORS.admin!.id}', 'fadmin@mb.test', '2026-10-01T10:00:00+05', 'wrong head'),
      ('FTX-LEGACY2', 'expense', '${HEADS.rent}', 'Rent', 'old pending', 200, 'cash', 'cash', '${YESTERDAY}', 'pending_approval',
       '${ACTORS.accountant!.id}', 'accountant@mb.test', '2026-10-02T09:00:00+05', null, null, null, null),
      ('FTX-LEGACY3', 'expense', '${HEADS.rent}', 'Rent', 'old draft', 300, 'cash', 'cash', '${YESTERDAY}', 'draft',
       '${ACTORS.accountant!.id}', 'accountant@mb.test', '2026-10-03T09:00:00+05', null, null, null, null);
  `);
  await db.exec(`
    alter table finance_transactions disable trigger finance_transactions_touch;
    update finance_transactions set updated_at = '2026-10-05T00:00:00Z';
    alter table finance_transactions enable trigger finance_transactions_touch;
  `);

  // Deposits raised before the Accounts step existed: one already in Finance
  // Admin's queue, one decided.
  await db.query(`
    insert into cash_transfers (id, branch_id, branch_name, amount, cash_amount, business_date, status, created_by, created_by_name, created_at,
      approved_at, rejection_reason)
    values
      ('${LEGACY_CT.pending}', '${ALPHA}', 'Alpha', 700, 700, '${YESTERDAY}', 'pending', '${ACTORS.branch!.id}', 'alpha@mb.test', '2026-10-20T09:00:00+05',
       null, null),
      ('${LEGACY_CT.rejected}', '${ALPHA}', 'Alpha', 800, 800, '${YESTERDAY}', 'rejected', '${ACTORS.branch!.id}', 'alpha@mb.test', '2026-10-21T09:00:00+05',
       '2026-10-21T10:00:00+05', 'no slip')
  `);

  // The migrations under test, each in one transaction, as `prisma migrate deploy` runs them.
  await db.exec(`begin;${MIGRATION}commit;`);
  await db.exec(`begin;${ACCOUNTS_REVIEW}commit;`);

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);
  for (const [name, a] of Object.entries(ACTORS)) {
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
  const { entriesRouter } = await import('../../routes/finance-income.routes');
  const { router: financeCt } = await import('../../routes/finance-cash-transfers.routes');
  const { router: branchCt } = await import('../../routes/cash-transfers.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(ENTRIES, entriesRouter);
  app.use(FIN_CT, financeCt);
  app.use(CT, branchCt);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the migration keeps what was there', () => {
  test('an old rejection moves to rejected_*, an old pending entry gets its submitter, updated_at untouched', async () => {
    const rows = (await db.query<Json>(
      `select txn_no, status, approved_by, rejected_by_name, to_char(rejected_at at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI') rejected_at,
              submitted_by_name, to_char(submitted_at at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI') submitted_at,
              revision, updated_at = '2026-10-05T00:00:00Z' as untouched
         from finance_transactions order by txn_no`)).rows;
    assert.deepEqual(rows.map((r) => [r.txn_no, r.approved_by, r.rejected_by_name, r.rejected_at, r.submitted_by_name, r.submitted_at, r.revision, r.untouched]), [
      ['FTX-LEGACY1', null, 'fadmin@mb.test', '2026-10-01 10:00', 'accountant@mb.test', '2026-10-01 09:00', 1, true],
      ['FTX-LEGACY2', null, null, null, 'accountant@mb.test', '2026-10-02 09:00', 1, true],
      ['FTX-LEGACY3', null, null, null, null, null, 1, true],
    ]);
    assert.equal((await db.query(`select 1 from finance_document_events`)).rows.length, 0, 'the backfill leaves no history rows');
  });
});

describe('Accountant: create, list, submit', () => {
  test('income, expense and a draft all appear in the list, none posted, no voucher issued', async () => {
    const income = await newEntry('accountant', { ledgerHeadId: HEADS.sales, description: 'Scrap sale', amount: 1500, businessDate: TODAY });
    const expense = await newEntry('accountant', { ledgerHeadId: HEADS.rent, description: 'Shop rent', amount: 20000, businessDate: TODAY, branchId: ALPHA });
    const draft = await newEntry('accountant', { ledgerHeadId: HEADS.fuel, description: 'Van fuel', amount: 3000, businessDate: TODAY, asDraft: true });

    assert.equal(income.status, 'pending_approval');
    assert.equal(income.txnType, 'income');
    assert.equal(income.submittedByName, 'accountant@mb.test', 'raised straight into the queue = submitted');
    assert.ok(income.submittedAt);
    assert.equal(expense.txnType, 'expense');
    assert.equal(expense.branchName, 'Alpha');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.submittedAt, null);

    const list = ok(await call('accountant', 'GET', `${ENTRIES}?limit=50`));
    const nos = list.entries.map((e: Json) => e.txnNo);
    for (const e of [income, expense, draft]) assert.ok(nos.includes(e.txnNo), `${e.txnNo} in the list`);
    for (const e of [income, expense, draft]) {
      assert.equal(e.ledgerEntryId, null);
      assert.equal((await entry(e.id)).voucherNo, null);
    }
    assert.equal(await ledgerCount(), 0, 'nothing reached the Daily Ledger');
    assert.equal(await counter('finance_receipt_voucher'), 0);
    assert.equal(await counter('finance_payment_voucher'), 0);

    assert.deepEqual((await history(income.id)).map((e) => e.event), ['created']);
    assert.deepEqual((await history(income.id)).map((e) => e.actorRole), ['accountant']);
  });

  test('a draft is edited, then submitted: submitter and time recorded, still unposted', async () => {
    const draft = await newEntry('accountant', { ledgerHeadId: HEADS.fuel, description: 'Generator fuel', amount: 1000, businessDate: TODAY, asDraft: true });
    const edited = ok(await call('accountant', 'PUT', `${ENTRIES}/${draft.id}`, { amount: 1200 })).entry;
    assert.equal(Number(edited.amount), 1200);
    assert.equal(edited.status, 'draft', 'a plain save does not submit');

    const submitted = ok(await call('accountant', 'POST', `${ENTRIES}/${draft.id}/submit`)).entry;
    assert.equal(submitted.status, 'pending_approval');
    assert.equal(submitted.submittedByName, 'accountant@mb.test');
    assert.equal(submitted.revision, 1);
    assert.equal(submitted.ledgerEntryId, null);

    const events = await history(draft.id);
    assert.deepEqual(events.map((e) => e.event), ['created', 'edited', 'submitted']);
    assert.deepEqual(events[1].changes, { amount: { from: 1000, to: 1200 } });
  });

  test('a pending entry cannot be edited or submitted again', async () => {
    const pending = await newEntry('accountant', { ledgerHeadId: HEADS.rent, description: 'Pending rent', amount: 500, businessDate: TODAY });
    const edit = await call('accountant', 'PUT', `${ENTRIES}/${pending.id}`, { amount: 1 });
    assert.equal(edit.status, 409);
    assert.match(edit.body.error, /awaiting approval/);
    assert.equal(Number((await entry(pending.id)).amount), 500);
    assert.equal((await call('accountant', 'POST', `${ENTRIES}/${pending.id}/submit`)).status, 409);
  });

  test('invalid input is refused: zero amount, missing head, missing photo', async () => {
    const photo = await stagedPhoto('finance_transaction', 'accountant');
    const base = { account: 'cash', paymentMethod: 'cash', description: 'x', businessDate: TODAY, attachmentIds: [photo] };
    assert.equal((await call('accountant', 'POST', ENTRIES, { ...base, ledgerHeadId: HEADS.rent, amount: 0 })).status, 400);
    assert.equal((await call('accountant', 'POST', ENTRIES, { ...base, amount: 10 })).status, 400);
    assert.equal((await call('accountant', 'POST', ENTRIES, { ...base, ledgerHeadId: HEADS.rent, amount: 10, attachmentIds: [] })).status, 400);
  });
});

describe('Finance Admin: reject, correct, resubmit, approve', () => {
  let rent: Json;

  test('the queue lists pending entries with who submitted them, and filters by submitter', async () => {
    rent = await newEntry('accountant', { ledgerHeadId: HEADS.rent, description: 'Warehouse rent', amount: 45000, businessDate: TODAY });
    const queue = ok(await call('admin', 'GET', `${ENTRIES}?status=pending_approval&submittedBy=${ACTORS.accountant!.id}&sortBy=submittedAt&sortDir=asc&limit=100`));
    assert.ok(queue.entries.every((e: Json) => e.status === 'pending_approval' && e.submittedBy === ACTORS.accountant!.id));
    assert.ok(queue.entries.some((e: Json) => e.id === rent.id));
    const submitters = ok(await call('admin', 'GET', `${ENTRIES}/submitters`)).submitters;
    assert.deepEqual(submitters, [{ id: ACTORS.accountant!.id, name: 'accountant@mb.test' }]);
  });

  test('only an approver may decide; an accountant, an auditor and a branch cannot', async () => {
    for (const as of ['accountant', 'auditor', 'branch']) {
      assert.equal((await call(as, 'POST', `${ENTRIES}/${rent.id}/approve`, {})).status, 403, `${as} approve`);
      assert.equal((await call(as, 'POST', `${ENTRIES}/${rent.id}/reject`, { reason: 'no' })).status, 403, `${as} reject`);
    }
    assert.equal((await call('branch', 'GET', ENTRIES)).status, 403, 'a branch cannot even read the entries');
    assert.equal((await entry(rent.id)).status, 'pending_approval');
  });

  test('rejection needs remarks; with them it is rejected, unposted, and the remarks are kept', async () => {
    assert.equal((await call('admin', 'POST', `${ENTRIES}/${rent.id}/reject`, { reason: '' })).status, 400);
    assert.equal((await call('admin', 'POST', `${ENTRIES}/${rent.id}/reject`, { reason: '   ' })).status, 400);
    assert.equal((await call('admin', 'POST', `${ENTRIES}/${rent.id}/reject`, {})).status, 400);

    const remarks = 'Incorrect ledger head. Please select the correct expense category and verify the amount.';
    const rejected = ok(await call('admin', 'POST', `${ENTRIES}/${rent.id}/reject`, { reason: remarks })).entry;
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectionReason, remarks);
    assert.equal(rejected.rejectedByName, 'fadmin@mb.test');
    assert.ok(rejected.rejectedAt);
    assert.equal(rejected.approvedBy, null, 'the rejecter is not recorded as an approver');
    assert.equal(rejected.ledgerEntryId, null);
    assert.equal(await ledgerCount(), 0);

    assert.equal((await call('admin', 'POST', `${ENTRIES}/${rent.id}/approve`, {})).status, 409, 'a rejected entry cannot be approved');
    assert.equal((await call('admin', 'POST', `${ENTRIES}/${rent.id}/reject`, { reason: 'again' })).status, 409);
  });

  test('a plain save keeps it rejected with its remarks; "save and resubmit" sends the same row back as revision 2', async () => {
    const saved = ok(await call('accountant', 'PUT', `${ENTRIES}/${rent.id}`, { ledgerHeadId: HEADS.fuel })).entry;
    assert.equal(saved.status, 'rejected');
    assert.match(saved.rejectionReason, /Incorrect ledger head/);

    const resubmitted = ok(await call('accountant', 'PUT', `${ENTRIES}/${rent.id}`, { amount: 44000, resubmit: true })).entry;
    assert.equal(resubmitted.id, rent.id);
    assert.equal(resubmitted.txnNo, rent.txnNo);
    assert.equal(resubmitted.status, 'pending_approval');
    assert.equal(resubmitted.revision, 2);
    assert.equal(resubmitted.rejectionReason, null);
    assert.equal(Number(resubmitted.amount), 44000);
    assert.equal(resubmitted.ledgerHeadName, 'Fuel');

    const count = Number((await db.query<{ n: string }>(`select count(*) n from finance_transactions where txn_no = $1`, [rent.txnNo])).rows[0]!.n);
    assert.equal(count, 1, 'no duplicate entry');

    const events = await history(rent.id, 'admin');
    assert.deepEqual(events.map((e) => [e.event, e.revision]), [
      ['created', 1], ['rejected', 1], ['edited', 1], ['resubmitted', 2],
    ]);
    assert.match(events[1].remarks, /Incorrect ledger head/, 'the rejection remarks survive the resubmission');
    assert.equal(events[1].actorRole, 'finance_admin');
    assert.deepEqual(events[2].changes, { ledgerHeadName: { from: 'Rent', to: 'Fuel' } });
    assert.deepEqual(events[3].changes, { amount: { from: 45000, to: 44000 } });
  });

  test('approval posts one PV- voucher with the corrected figures, exactly once', async () => {
    const before = await ledgerCount();
    const r = ok(await call('admin', 'POST', `${ENTRIES}/${rent.id}/approve`, { notes: 'Checked against the bill' }));
    assert.equal(r.entry.status, 'posted');
    assert.equal(r.entry.approvedByName, 'fadmin@mb.test');
    assert.equal(r.entry.approvalNote, 'Checked against the bill');
    assert.equal(r.entry.notes, null, "the approver's note does not overwrite the accountant's notes");
    assert.match(r.ledgerEntry.voucherNo, /^PV-/);
    assert.equal(r.entry.voucherNo, r.ledgerEntry.voucherNo);
    assert.equal(Number(r.ledgerEntry.credit), 44000);
    assert.equal(r.ledgerEntry.ledgerHeadName, 'Fuel');
    assert.equal(await ledgerCount(), before + 1);

    const again = await call('admin', 'POST', `${ENTRIES}/${rent.id}/approve`, {});
    assert.equal(again.status, 409);
    assert.match(again.body.error, /cannot be approved again/);
    assert.equal(await ledgerCount(), before + 1, 'a retry posts nothing');
    assert.equal(await counter('finance_payment_voucher'), 1, 'and spends no voucher number');

    const last = (await history(rent.id)).at(-1);
    assert.equal(last.event, 'approved');
    assert.equal(last.voucherNo, r.ledgerEntry.voucherNo);
    assert.equal(last.remarks, 'Checked against the bill');

    const listed = ok(await call('accountant', 'GET', `${ENTRIES}?status=posted`)).entries;
    assert.equal(listed.find((t: { id: string }) => t.id === rent.id)?.voucherNo, r.ledgerEntry.voucherNo, 'the list shows the voucher too');

    assert.equal((await call('accountant', 'PUT', `${ENTRIES}/${rent.id}`, { amount: 1 })).status, 409, 'a posted entry is not edited');
  });

  test('an income entry posts an RV- receipt', async () => {
    const income = await newEntry('accountant', { ledgerHeadId: HEADS.sales, description: 'Rent received', amount: 7000, businessDate: TODAY });
    const r = ok(await call('admin', 'POST', `${ENTRIES}/${income.id}/approve`, {}));
    assert.match(r.ledgerEntry.voucherNo, /^RV-/);
    assert.equal(Number(r.ledgerEntry.debit), 7000);
  });

  test('a draft cannot be approved before it is submitted', async () => {
    const draft = await newEntry('accountant', { ledgerHeadId: HEADS.rent, description: 'Draft only', amount: 10, businessDate: TODAY, asDraft: true });
    const r = await call('admin', 'POST', `${ENTRIES}/${draft.id}/approve`, {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /draft/);
  });

  test('a posting the ledger refuses rolls everything back: still pending, no voucher, no number spent', async () => {
    const closedDay = businessDaysAgoStr(3);
    const late = await newEntry('accountant', { ledgerHeadId: HEADS.rent, description: 'Back-dated', amount: 900, businessDate: closedDay });
    await db.query(
      `insert into finance_day_closings (business_date, opening_balance, opening_cash, opening_bank, total_income,
         total_expenses, net_balance, cash_in_hand, bank_balance, closing_balance, closed_by_name)
       values ($1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'test')`, [closedDay]);

    const pv = await counter('finance_payment_voucher');
    const before = await ledgerCount();
    const r = await call('admin', 'POST', `${ENTRIES}/${late.id}/approve`, {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /closed/);
    const now = await entry(late.id);
    assert.equal(now.status, 'pending_approval');
    assert.equal(now.approvedBy, null);
    assert.equal(now.ledgerEntryId, null);
    assert.equal(await ledgerCount(), before);
    assert.equal(await counter('finance_payment_voucher'), pv);
    assert.equal((await history(late.id)).at(-1).event, 'created', 'no approval in the history');

    // The way out: reject so the accountant can correct the date.
    ok(await call('admin', 'POST', `${ENTRIES}/${late.id}/reject`, { reason: 'That day is closed — use today' }));
    ok(await call('accountant', 'PUT', `${ENTRIES}/${late.id}`, { businessDate: TODAY, resubmit: true }));
    const posted = ok(await call('admin', 'POST', `${ENTRIES}/${late.id}/approve`, {}));
    assert.equal(posted.entry.status, 'posted');
    assert.equal(posted.ledgerEntry.entryDate, TODAY);
  });

  test('a head closed after submission fails the approval cleanly', async () => {
    const e = await newEntry('accountant', { ledgerHeadId: HEADS.fuel, description: 'Fuel', amount: 50, businessDate: TODAY });
    await db.query(`update ledger_heads set is_active = false where id = $1`, [HEADS.fuel]);
    try {
      const r = await call('admin', 'POST', `${ENTRIES}/${e.id}/approve`, {});
      assert.equal(r.status, 409);
      assert.equal((await entry(e.id)).status, 'pending_approval');
    } finally {
      await db.query(`update ledger_heads set is_active = true where id = $1`, [HEADS.fuel]);
    }
  });
});

describe('cash deposits: a rejected deposit is corrected and resubmitted by its branch', () => {
  let ct: Json;

  test('the branch raises a deposit; Finance rejects it with remarks', async () => {
    const photo = await stagedPhoto('cash_transfer', 'branch');
    ct = ok(await call('branch', 'POST', CT, { cashAmount: 5000, easypaisaAmount: 0, bankAmount: 0, fuelCharges: 0, attachmentIds: [photo], businessDate: YESTERDAY }), 201);
    assert.equal(ct.status, 'pending');
    assert.equal(ct.date, YESTERDAY);
    assert.equal(ct.revision, 1);

    assert.equal((await call('branch', 'POST', `${CT}/${ct.id}/resubmit`, { cashAmount: 1 })).status, 409, 'a pending deposit is not resubmitted');

    ok(await call('accountant', 'PUT', `${FIN_CT}/${ct.id}/forward`));
    const rejected = ok(await call('admin', 'PUT', `${FIN_CT}/${ct.id}/reject`, { reason: 'Slip shows Rs. 4,500, not 5,000' })).transfer;
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.voucherNo, null);
  });

  test('another branch cannot touch it; the owning branch corrects it — same CT-, branch and date kept, revision 2', async () => {
    assert.equal((await call('other', 'POST', `${CT}/${ct.id}/resubmit`, { cashAmount: 4500 })).status, 404);
    assert.equal((await call('other', 'GET', `${CT}/${ct.id}/history`)).status, 404);
    assert.equal((await call('branch', 'POST', `${CT}/${ct.id}/resubmit`, { cashAmount: 0 })).status, 400, 'an empty deposit is refused');

    const photo = await stagedPhoto('cash_transfer', 'branch');
    const fixed = ok(await call('branch', 'POST', `${CT}/${ct.id}/resubmit`, {
      cashAmount: 4500, easypaisaAmount: 0, bankAmount: 0, fuelCharges: 0, totalAmount: 4500,
      note: 'Corrected to the slip', attachmentIds: [photo],
      // Not in the schema, so ignored: a resubmission cannot move the deposit.
      businessDate: TODAY, branchId: BETA,
    }));
    assert.equal(fixed.id, ct.id);
    assert.equal(fixed.transferNo, ct.transferNo);
    assert.equal(fixed.status, 'pending');
    assert.equal(fixed.revision, 2);
    assert.equal(fixed.amount, 4500);
    assert.equal(fixed.date, YESTERDAY, 'the original business date');
    assert.equal(fixed.branchId, ALPHA, 'the original branch');
    assert.equal(fixed.rejectionReason, null);
    assert.equal(fixed.resubmittedByName, 'alpha@mb.test');
    assert.equal(fixed.attachments.length, 2, 'the new slip is added beside the old one');
    assert.equal(fixed.forwardedAt, null, 'a resubmission goes back to Accounts');

    const count = Number((await db.query<{ n: string }>(`select count(*) n from cash_transfers where transfer_no = $1`, [ct.transferNo])).rows[0]!.n);
    assert.equal(count, 1);
  });

  test('Finance sees the history, approves the corrected figures, and the voucher is issued only now', async () => {
    const events = ok(await call('admin', 'GET', `${FIN_CT}/${ct.id}/history`)).events as Json[];
    assert.deepEqual(events.map((e) => [e.event, e.revision]), [['created', 1], ['submitted', 1], ['rejected', 1], ['resubmitted', 2]]);
    assert.match(events[2].remarks, /Slip shows/);
    assert.deepEqual(events[3].changes, {
      amount: { from: 5000, to: 4500 }, cashAmount: { from: 5000, to: 4500 }, note: { from: null, to: 'Corrected to the slip' },
    });

    assert.equal((await call('admin', 'PUT', `${FIN_CT}/${ct.id}/approve`, {})).status, 409, 'back with Accounts, not yet decidable');
    ok(await call('accountant', 'PUT', `${FIN_CT}/${ct.id}/forward`));

    const approved = ok(await call('admin', 'PUT', `${FIN_CT}/${ct.id}/approve`, {}));
    assert.equal(approved.transfer.status, 'approved');
    assert.match(approved.transfer.voucherNo, /^RV-/);
    assert.equal(Number(approved.ledgerEntry.debit), 4500);
    assert.equal(approved.ledgerEntry.entryDate, YESTERDAY, 'posted on the deposit\'s own date');

    const branchView = ok(await call('branch', 'GET', `${CT}/${ct.id}/history`)).events as Json[];
    assert.equal(branchView.at(-1).event, 'approved');
    assert.equal((await call('branch', 'POST', `${CT}/${ct.id}/resubmit`, { cashAmount: 1 })).status, 409, 'an approved deposit is final');
  });
});

describe('cash deposits: with Accounts first, then Finance Admin', () => {
  let ct: Json;
  const pendingIds = async (status: string) =>
    (ok(await call('admin', 'GET', `${FIN_CT}?status=${status}`)).transfers as Json[]).map((t) => t.id);

  test('a deposit raised before the Accounts step stays in Finance Admin\'s queue; a decided one is untouched', async () => {
    const legacy = ok(await call('admin', 'GET', `${FIN_CT}/${LEGACY_CT.pending}`));
    assert.equal(new Date(legacy.forwardedAt).toISOString(), new Date('2026-10-20T09:00:00+05:00').toISOString(), 'forwarded when it was raised');
    assert.equal(legacy.forwardedByName, null);
    assert.equal(ok(await call('admin', 'GET', `${FIN_CT}/${LEGACY_CT.rejected}`)).forwardedAt, null);
    const events = ok(await call('admin', 'GET', `${FIN_CT}/${LEGACY_CT.pending}/history`)).events as Json[];
    assert.deepEqual(events, [], 'the backfill writes no history');
  });

  test('a new deposit lands with Accounts: listed there, not in Finance Admin\'s queue, and Accounts is notified', async () => {
    const photo = await stagedPhoto('cash_transfer', 'branch');
    ct = ok(await call('branch', 'POST', CT, { cashAmount: 3000, easypaisaAmount: 0, bankAmount: 0, fuelCharges: 200, attachmentIds: [photo], businessDate: YESTERDAY }), 201);
    assert.equal(ct.status, 'pending');
    assert.equal(ct.forwardedAt, null);

    assert.ok((await pendingIds('with_accounts')).includes(ct.id));
    assert.ok(!(await pendingIds('awaiting_approval')).includes(ct.id));
    assert.ok((await pendingIds('awaiting_approval')).includes(LEGACY_CT.pending));
    assert.ok((await pendingIds('pending')).includes(ct.id), 'plain pending still means both halves');

    const notes = (await db.query<{ target_role: string }>(`select target_role from notifications where related_id = $1`, [ct.id])).rows;
    assert.deepEqual(notes.map((n) => n.target_role), ['accountant']);
  });

  test('Finance Admin cannot approve or reject it while it is with Accounts', async () => {
    const approve = await call('admin', 'PUT', `${FIN_CT}/${ct.id}/approve`, {});
    assert.equal(approve.status, 409);
    assert.match(approve.body.error, /still with Accounts/);
    assert.equal((await call('admin', 'PUT', `${FIN_CT}/${ct.id}/reject`, { reason: 'too early' })).status, 409);
    assert.equal(ok(await call('admin', 'GET', `${FIN_CT}/${ct.id}`)).status, 'pending');
  });

  test('the Accountant edits it: figures and note change, the Total is recomputed, it stays with Accounts', async () => {
    assert.equal((await call('auditor', 'PUT', `${FIN_CT}/${ct.id}`, { cashAmount: 2500 })).status, 403);
    assert.equal((await call('branch', 'PUT', `${FIN_CT}/${ct.id}`, { cashAmount: 2500 })).status, 403);
    assert.equal((await call('accountant', 'PUT', `${FIN_CT}/${ct.id}`, { cashAmount: 0 })).status, 400, 'an empty deposit is refused');
    assert.equal((await call('accountant', 'PUT', `${FIN_CT}/${ct.id}`, { cashAmount: 2000, bankAmount: 500, totalAmount: 9 })).status, 400);

    const edited = ok(await call('accountant', 'PUT', `${FIN_CT}/${ct.id}`, {
      cashAmount: 2000, easypaisaAmount: 0, bankAmount: 500, fuelCharges: 200, totalAmount: 2500, note: 'Split per the slip',
    })).transfer;
    assert.equal(edited.amount, 2500);
    assert.equal(edited.bankAmount, 500);
    assert.equal(edited.note, 'Split per the slip');
    assert.equal(edited.updatedByName, 'accountant@mb.test');
    assert.equal(edited.forwardedAt, null);
    assert.equal(edited.attachments.length, 1, 'the branch\'s slip stays');
  });

  test('the Accountant submits it for approval: it moves to Finance Admin, who is notified', async () => {
    assert.equal((await call('auditor', 'PUT', `${FIN_CT}/${ct.id}/forward`)).status, 403);
    const sent = ok(await call('accountant', 'PUT', `${FIN_CT}/${ct.id}/forward`)).transfer;
    assert.ok(sent.forwardedAt);
    assert.equal(sent.forwardedByName, 'accountant@mb.test');
    assert.equal(sent.status, 'pending');

    assert.ok(!(await pendingIds('with_accounts')).includes(ct.id));
    assert.ok((await pendingIds('awaiting_approval')).includes(ct.id));

    const notes = (await db.query<{ target_role: string }>(`select target_role from notifications where related_id = $1 order by target_role`, [ct.id])).rows;
    assert.deepEqual(notes.map((n) => n.target_role), ['accountant', 'finance_admin', 'finance_manager']);

    assert.equal((await call('accountant', 'PUT', `${FIN_CT}/${ct.id}/forward`)).status, 409, 'submitted once');
    const late = await call('accountant', 'PUT', `${FIN_CT}/${ct.id}`, { cashAmount: 1 });
    assert.equal(late.status, 409, 'no edits once it is with Finance Admin');
    assert.match(late.body.error, /already been submitted/);
  });

  test('Finance Admin approves the edited figures; the history reads created → edited → submitted → approved', async () => {
    const approved = ok(await call('admin', 'PUT', `${FIN_CT}/${ct.id}/approve`, {}));
    assert.equal(approved.transfer.status, 'approved');
    assert.match(approved.transfer.voucherNo, /^RV-/);
    assert.equal(Number(approved.ledgerEntry.debit), 2500);

    const events = ok(await call('admin', 'GET', `${FIN_CT}/${ct.id}/history`)).events as Json[];
    assert.deepEqual(events.map((e) => e.event), ['created', 'edited', 'submitted', 'approved']);
    assert.equal(events[1].actorName, 'accountant@mb.test');
    assert.deepEqual(events[1].changes.bankAmount, { from: 0, to: 500 });
    assert.equal(events[2].actorName, 'accountant@mb.test');
    assert.equal(events[2].actorRole, 'accountant');

    assert.equal((await call('accountant', 'PUT', `${FIN_CT}/${ct.id}/forward`)).status, 409, 'a decided deposit cannot be sent again');
    assert.equal((await call('accountant', 'PUT', `${FIN_CT}/${ct.id}`, { cashAmount: 1 })).status, 409);
  });
});

describe('query-layer catalog', () => {
  test('src/db/catalog.generated.json describes the changed tables and new functions as the migration leaves them', async () => {
    const { CATALOG_QUERY, shapeCatalog } = await import('../../db/catalog-query');
    const committed = JSON.parse(readFileSync(join(__dirname, '../../db/catalog.generated.json'), 'utf8'));
    await db.exec(`set search_path = ''`);
    const live = shapeCatalog((await db.query<Json>(CATALOG_QUERY)).rows[0].json_build_object) as Json;
    await db.exec('reset search_path');
    for (const t of ['finance_transactions', 'cash_transfers', 'finance_document_events']) {
      assert.deepEqual(Object.keys(committed.tables[t]?.columns ?? {}), Object.keys(live.tables[t].columns), `table ${t} columns`);
    }
    for (const f of ['approve_finance_transaction', 'resubmit_cash_transfer']) {
      assert.deepEqual(committed.functions[f], live.functions[f], `function ${f}`);
    }
  });
});

// Last: pglite cannot survive a trigger that raises, so the database's own
// refusals run after everything else.
describe('the database refuses what the workflow does not have', () => {
  test('history rows cannot be changed or deleted', async () => {
    await assert.rejects(db.query(`delete from finance_document_events`), /append-only/);
  });
});
