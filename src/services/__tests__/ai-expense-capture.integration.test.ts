import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';
import { businessDateStr, businessDaysAgoStr } from '../../shared';
import { GeminiError, setGeminiCaller, type GeminiRequest } from '../ai/gemini';

/**
 * AI Expense Capture end to end (migration 20261030000001_ai_expense_capture):
 * the real baseline tables, the finance approval migrations and this one, the
 * real routes behind real access tokens — and Gemini replaced by canned
 * replies, so what is tested is everything around the model: which photos go,
 * how the reply becomes proposals, the server's own checks, duplicates, the
 * audit row, and saving a proposal through the ordinary entry create exactly
 * once.
 */

const PRISMA = join(__dirname, '../../../prisma/migrations');
const BASELINE = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
const MIGRATIONS = [
  '20261028000001_finance_approval_workflow',
  '20261028000002_cash_deposit_accounts_review',
  '20261030000001_ai_expense_capture',
].map((m) => readFileSync(join(PRISMA, m, 'migration.sql'), 'utf8'));
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
  'finance_transactions', 'attachments', 'cash_transfers', 'restriction_rules', 'restriction_requests', 'idempotency_keys',
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

const HEADS = {
  flour: '70000000-0000-4000-8000-000000000001',
  electricity: '70000000-0000-4000-8000-000000000002',
  grocery: '70000000-0000-4000-8000-000000000003',
};

interface Actor { id: string; email: string; role: string }
const ACTORS: Record<string, Actor> = {
  accountant: { id: '20000000-0000-4000-8000-000000000001', email: 'accountant@mb.test', role: 'accountant' },
  admin: { id: '20000000-0000-4000-8000-000000000002', email: 'fadmin@mb.test', role: 'finance_admin' },
  auditor: { id: '20000000-0000-4000-8000-000000000003', email: 'auditor@mb.test', role: 'finance_auditor' },
  branch: { id: '20000000-0000-4000-8000-000000000004', email: 'alpha@mb.test', role: 'branch_manager' },
};
const TOKENS: Record<string, string> = {};

const ANALYZE = '/api/finance/ai-capture/analyze';
const ENTRIES = '/api/finance/income/entries';
const TODAY = businessDateStr();
const YESTERDAY = businessDaysAgoStr(1);

let db: PGlite;
let server: Server;
let base: string;
/** The fake store's files, by path. */
const files = new Map<string, Buffer>();
/** What the stubbed Gemini was last sent. */
let lastRequest: GeminiRequest | null = null;
let reply: (req: GeminiRequest) => unknown = () => ({ photos: [], bills: [] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { Authorization: `Bearer ${TOKENS[as]}` } : {}), 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}
const ok = (r: { status: number; body: Json }, status = 200): Json => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

let photoSeq = 0;
/** A staged receipt photo with real bytes in the fake store, as POST /api/attachments leaves one. */
async function photo(as = 'accountant', bytes?: Buffer): Promise<string> {
  const n = ++photoSeq;
  const id = `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const data = bytes ?? Buffer.from(`receipt-${n}`);
  const path = `finance_transaction/${id}.jpg`;
  files.set(path, data);
  await db.query(
    `insert into attachments (id, entity, storage_path, mime_type, size_bytes, uploaded_by, content_sha256)
     values ($1, 'finance_transaction', $2, 'image/jpeg', $3, $4, $5)`,
    [id, path, data.length, ACTORS[as]!.id, createHash('sha256').update(data).digest('hex')],
  );
  return id;
}

/** A bill as the model returns one; fields default to a clean, legible receipt. */
const bill = (o: Record<string, unknown>) => ({
  photos: [1], merchant: 'Al-Madina Traders', invoiceNo: null, date: YESTERDAY, currency: 'PKR',
  subtotal: null, tax: null, discount: null, total: 5000, description: 'Flour purchase — Al-Madina Traders',
  descriptionOriginal: null, language: 'English', lineItems: [], ledgerHeadCode: 'EXP-FLOUR', confidence: 'high', unclear: null,
  ...o,
});

before(async () => {
  process.env['JWT_SECRET'] = 'ai-expense-capture-test-secret-long-enough';
  process.env['FILES_S3_BUCKET'] = 'test-bucket';
  process.env['PUBLIC_API_URL'] = 'https://api.test';
  process.env['GEMINI_API_KEY'] = 'test-key';

  db = new PGlite();
  await db.exec(STUBS);
  for (const t of TYPES) await db.exec(type(t));
  await db.exec(fn('app.next_finance_number'));
  await db.exec(fn('app.business_date'));
  for (const t of TABLES) await db.exec(table(t));
  await db.exec(`
    ${TABLES.filter((t) => !['finance_settings', 'finance_day_closings', 'restriction_rules', 'idempotency_keys'].includes(t))
      .map((t) => `alter table public.${t} add primary key (id);`).join('\n')}
    alter table public.finance_day_closings add primary key (business_date);
    alter table public.idempotency_keys add primary key (user_id, key);
    alter table public.attachments add constraint attachments_storage_path_key unique (storage_path);
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
    'public.claim_idempotency_key', 'public.complete_idempotency_key', 'public.release_idempotency_key',
  ]) {
    await db.exec(fn(f));
  }
  await db.exec(`begin;${AUTH}commit;`);
  await db.exec(`
    insert into counters (id, count) values
      ('finance_txn', 0), ('cash_transfer', 0), ('finance_receipt_voucher', 0), ('finance_payment_voucher', 0);
    insert into finance_settings default values;
    insert into ledger_heads (id, code, name, type, is_active) values
      ('${HEADS.flour}', 'EXP-FLOUR', 'Flour & Ingredients', 'expense', true),
      ('${HEADS.electricity}', 'EXP-ELECTRICITY', 'Electricity', 'expense', true),
      ('${HEADS.grocery}', 'EXP-GROCERY', 'Grocery', 'expense', true);
    insert into ledger_heads (code, name, type, is_active) values
      ('INC-OTHER', 'Other Income', 'income', true),
      ('EXP-OLD', 'Old Head', 'expense', false);
  `);
  for (const a of Object.values(ACTORS)) {
    await db.query(`insert into users (id, email, display_name, role) values ($1, $2, $2, $3)`, [a.id, a.email, a.role]);
  }
  for (const m of MIGRATIONS) await db.exec(`begin;${m}commit;`);

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
    upload: async (_bucket, path, body) => { files.set(path, body); },
    remove: async (_bucket, paths) => { for (const p of paths) files.delete(p); },
    signUrls: async (_bucket, paths) => new Map(paths.map((path) => [path, `https://signed.test/${path}`])),
    publicUrl: (_bucket, path) => `https://api.test/api/public/branding/${path}`,
    download: async (_bucket, path) => files.get(path) ?? null,
  });
  setGeminiCaller(async (req) => {
    lastRequest = req;
    return reply(req);
  });

  const express = (await import('express')).default;
  const { entriesRouter } = await import('../../routes/finance-income.routes');
  const { router: aiRouter } = await import('../../routes/finance-ai-capture.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/finance/ai-capture', aiRouter);
  app.use(ENTRIES, entriesRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  setGeminiCaller();
  server?.close();
  await db?.close();
});

beforeEach(() => {
  lastRequest = null;
  process.env['GEMINI_API_KEY'] = 'test-key';
});

// ─────────────────────────────────────────────────────────────────────────────
describe('who may run it', () => {
  test('a finance auditor and a branch manager are refused; nothing is sent to the AI', async () => {
    const id = await photo('accountant');
    for (const as of ['auditor', 'branch']) {
      const r = await call(as, 'POST', ANALYZE, { attachmentIds: [id] });
      assert.equal(r.status, 403, as);
    }
    assert.equal(lastRequest, null);
  });

  test('without a Gemini key the feature says so (503)', async () => {
    delete process.env['GEMINI_API_KEY'];
    const r = await call('accountant', 'POST', ANALYZE, { attachmentIds: [await photo()] });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /GEMINI_API_KEY/);
  });

  test('only the caller\'s own unused receipt photos can be read', async () => {
    const theirs = await photo('admin');
    const r = await call('accountant', 'POST', ANALYZE, { attachmentIds: [theirs] });
    assert.equal(r.status, 409);
    assert.equal(lastRequest, null);
  });

  test('more than ten photos at once is refused', async () => {
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push(await photo());
    assert.equal((await call('accountant', 'POST', ANALYZE, { attachmentIds: ids })).status, 400);
  });
});

describe('reading receipts', () => {
  test('separate bills become separate expenses; a grocery bill keeps its items as detail, not as expenses', async () => {
    const ids = [await photo(), await photo(), await photo(), await photo()];
    reply = () => ({
      photos: [1, 2, 3, 4].map((n) => ({ photo: n, readable: true, note: null })),
      bills: [
        bill({ photos: [1], total: 5000 }),
        bill({ photos: [2], merchant: 'Sugar House', total: 2000, description: 'Sugar purchase — Sugar House' }),
        bill({ photos: [3], merchant: 'LESCO', total: 8000, description: 'Electricity bill — October', ledgerHeadCode: 'EXP-ELECTRICITY', invoiceNo: 'REF-77' }),
        bill({
          photos: [4], merchant: 'Karachi General Store', total: 1450, subtotal: 1450, ledgerHeadCode: 'EXP-GROCERY',
          description: 'Grocery — Karachi General Store', language: 'Urdu', descriptionOriginal: 'کریانہ',
          lineItems: [
            { description: 'چینی', descriptionEnglish: 'Sugar', quantity: 2, amount: 400 },
            { description: 'دودھ', descriptionEnglish: 'Milk', quantity: 5, amount: 1050 },
          ],
        }),
      ],
    });
    const out = ok(await call('accountant', 'POST', ANALYZE, { attachmentIds: ids }));

    // The model got every photo's bytes, in order, and the active expense heads.
    assert.deepEqual(lastRequest!.images.map((i) => i.data.toString()), ids.map((_, i) => `receipt-${photoSeq - 3 + i}`));
    assert.match(lastRequest!.prompt, /EXP-ELECTRICITY — Electricity/);
    assert.doesNotMatch(lastRequest!.prompt, /EXP-OLD|INC-OTHER/);

    assert.equal(out.expenses.length, 4);
    assert.deepEqual(out.expenses.map((e: Json) => [e.photoIds, e.total]), [[[ids[0]], 5000], [[ids[1]], 2000], [[ids[2]], 8000], [[ids[3]], 1450]]);
    assert.deepEqual(out.expenses.map((e: Json) => e.suggestedLedgerHeadId), [HEADS.flour, HEADS.flour, HEADS.electricity, HEADS.grocery]);
    const grocery = out.expenses[3];
    assert.equal(grocery.lineItems.length, 2);
    assert.equal(grocery.lineItems[0].description, 'چینی'); // the original script, kept
    assert.equal(grocery.descriptionOriginal, 'کریانہ');
    assert.deepEqual(grocery.issues, []);
    assert.equal(grocery.needsReview, false);

    // The run is recorded, with what was proposed.
    const run = (await db.query<Json>(`select status, model, attachment_ids::text[] ids, result from finance_ai_captures where id = $1`, [out.captureId])).rows[0];
    assert.equal(run.status, 'ok');
    assert.equal(run.model, 'gemini-2.5-flash');
    assert.deepEqual(run.ids, ids);
    assert.equal(run.result.expenses.length, 4);
  });

  test('one bill over two photos is one expense carrying both photos', async () => {
    const ids = [await photo(), await photo()];
    reply = () => ({ photos: [], bills: [bill({ photos: [1, 2], total: 12000 })] });
    const out = ok(await call('accountant', 'POST', ANALYZE, { attachmentIds: ids }));
    assert.equal(out.expenses.length, 1);
    assert.deepEqual(out.expenses[0].photoIds, ids);
  });

  test('what could not be read stays empty and is flagged; a wrong total is flagged, not fixed', async () => {
    const ids = [await photo(), await photo(), await photo(), await photo()];
    reply = () => ({
      photos: [{ photo: 4, readable: false, note: 'Blurred' }],
      bills: [
        bill({ photos: [1], date: null, total: null, confidence: 'low', unclear: 'Total smudged' }),
        bill({ photos: [2], total: 900, lineItems: [{ description: 'A', amount: 500 }, { description: 'B', amount: 300 }] }),
        bill({ photos: [3], date: '2099-01-01', total: 100 }),
        bill({ photos: [9], total: 100 }), // a photo number not in the run
      ],
    });
    const out = ok(await call('accountant', 'POST', ANALYZE, { attachmentIds: ids }));
    assert.equal(out.expenses.length, 3, 'a bill tied to no photo of the run is dropped');
    const [missing, wrong, future] = out.expenses;
    assert.deepEqual(missing.issues, ['missing_date', 'missing_amount', 'unreadable', 'low_confidence']);
    assert.equal(missing.total, null);
    assert.equal(missing.businessDate, null);
    assert.equal(missing.needsReview, true);
    assert.deepEqual(wrong.issues, ['total_mismatch']);
    assert.equal(wrong.total, 900);
    assert.deepEqual(future.issues, ['future_date']);
    assert.deepEqual(out.photos.find((p: Json) => p.id === ids[3]), { id: ids[3], readable: false, note: 'Blurred' });
  });

  test('a Gemini timeout is a clear 504, and the failed run is recorded', async () => {
    reply = () => { throw new GeminiError('The AI took too long to read these receipts.', 504, 'timeout'); };
    const r = await call('accountant', 'POST', ANALYZE, { attachmentIds: [await photo()] });
    assert.equal(r.status, 504);
    assert.match(r.body.error, /took too long/);
    const last = (await db.query<Json>(`select status, error from finance_ai_captures order by created_at desc limit 1`)).rows[0];
    assert.deepEqual(last, { status: 'failed', error: 'timeout' });
  });

  test('a reply in the wrong shape is refused rather than guessed at', async () => {
    reply = () => ({ bills: 'nonsense' });
    const r = await call('accountant', 'POST', ANALYZE, { attachmentIds: [await photo()] });
    assert.equal(r.status, 502);
  });
});

describe('duplicates', () => {
  test('the same invoice, the same amount a day apart, the same photo, and a repeat inside the run are all flagged', async () => {
    // An entry already saved from an earlier receipt photo.
    const oldBytes = Buffer.from('the-same-receipt');
    const oldPhoto = await photo('accountant', oldBytes);
    const saved = ok(await call('accountant', 'POST', ENTRIES, {
      ledgerHeadId: HEADS.electricity, description: 'Electricity', amount: 7300, paymentMethod: 'cash', account: 'cash',
      businessDate: YESTERDAY, referenceNo: 'INV-555', attachmentIds: [oldPhoto],
    }), 201).entry;

    const ids = [await photo('accountant', Buffer.from('the-same-receipt')), await photo(), await photo()];
    reply = () => ({
      photos: [],
      bills: [
        bill({ photos: [1], invoiceNo: 'inv-555 ', total: 7300, date: TODAY }),
        bill({ photos: [2], merchant: 'Gas Co', invoiceNo: 'G-1', total: 640, date: TODAY }),
        bill({ photos: [3], merchant: 'Gas Co', invoiceNo: 'G-1', total: 640, date: TODAY }),
      ],
    });
    const out = ok(await call('accountant', 'POST', ANALYZE, { attachmentIds: ids }));
    assert.deepEqual(out.expenses[0].duplicates.map((d: Json) => [d.kind, d.txnNo]), [
      ['same_photo', saved.txnNo], ['reference', saved.txnNo], ['amount_date', saved.txnNo],
    ]);
    assert.equal(out.expenses[0].needsReview, true);
    assert.deepEqual(out.expenses[1].duplicates.map((d: Json) => [d.kind, d.otherKey]), [['same_batch', 'e3']]);
    assert.deepEqual(out.expenses[2].duplicates.map((d: Json) => [d.kind, d.otherKey]), [['same_batch', 'e2']]);
  });
});

describe('saving a proposal', () => {
  test('saved through the ordinary create, linked to its run, and only once however often it is retried', async () => {
    const id = await photo();
    reply = () => ({ photos: [], bills: [bill({ photos: [1], total: 3100, invoiceNo: 'SAVE-1' })] });
    const run = ok(await call('accountant', 'POST', ANALYZE, { attachmentIds: [id] }));
    const p = run.expenses[0];
    const body = {
      ledgerHeadId: p.suggestedLedgerHeadId, description: p.description, amount: p.total, paymentMethod: 'cash', account: 'cash',
      businessDate: p.businessDate, referenceNo: p.invoiceNo, notes: 'Read by AI', attachmentIds: p.photoIds, aiCaptureId: run.captureId,
    };
    const key = { 'Idempotency-Key': 'ai-capture-test-key-0001' };
    const first = ok(await call('accountant', 'POST', ENTRIES, body, key), 201).entry;
    const again = ok(await call('accountant', 'POST', ENTRIES, body, key), 201).entry;
    assert.equal(again.id, first.id, 'the retry returns the entry already made');
    const rows = (await db.query<Json>(`select status, ai_capture_id::text, reference_no from finance_transactions where reference_no = 'SAVE-1'`)).rows;
    assert.deepEqual(rows, [{ status: 'pending_approval', ai_capture_id: run.captureId, reference_no: 'SAVE-1' }]);
    // Bound now: the same photo cannot be read for another proposal.
    assert.equal((await call('accountant', 'POST', ANALYZE, { attachmentIds: [id] })).status, 409);
  });

  test('an entry cannot cite another user\'s run', async () => {
    reply = () => ({ photos: [], bills: [bill({ photos: [1] })] });
    const run = ok(await call('admin', 'POST', ANALYZE, { attachmentIds: [await photo('admin')] }));
    const r = await call('accountant', 'POST', ENTRIES, {
      ledgerHeadId: HEADS.flour, description: 'Flour', amount: 10, paymentMethod: 'cash', account: 'cash',
      attachmentIds: [await photo()], aiCaptureId: run.captureId,
    });
    assert.equal(r.status, 400);
  });

  test('a split bill: the photo is copied for the second entry, same fingerprint, own file, and both save', async () => {
    // A JPEG's first bytes: the copy is stored like any upload, type checked again.
    const id = await photo('accountant', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('split-bill')]));
    const copy = ok(await call('accountant', 'POST', `/api/finance/ai-capture/photos/${id}/copy`), 201).attachment;
    assert.notEqual(copy.id, id);
    const [orig, dup] = (await db.query<Json>(
      `select storage_path, content_sha256, entity_id from attachments where id = any($1::uuid[]) order by created_at`, [[id, copy.id]])).rows;
    assert.notEqual(orig.storage_path, dup.storage_path);
    assert.equal(orig.content_sha256, dup.content_sha256);
    assert.equal(dup.entity_id, null, 'staged, ready to bind');
    assert.deepEqual(files.get(dup.storage_path), files.get(orig.storage_path));
    for (const [photoId, amount] of [[id, 600], [copy.id, 400]] as const) {
      ok(await call('accountant', 'POST', ENTRIES, {
        ledgerHeadId: HEADS.grocery, description: 'Grocery (split)', amount, paymentMethod: 'cash', account: 'cash', attachmentIds: [photoId],
      }), 201);
    }
    // Someone else's photo cannot be copied.
    assert.equal((await call('admin', 'POST', `/api/finance/ai-capture/photos/${id}/copy`)).status, 404);
  });

  test('a manual entry without an Idempotency-Key is saved exactly as before', async () => {
    const r = ok(await call('admin', 'POST', ENTRIES, {
      ledgerHeadId: HEADS.flour, description: 'Hand-keyed', amount: 55, paymentMethod: 'cash', account: 'cash', attachmentIds: [await photo('admin')],
    }), 201).entry;
    assert.equal(r.status, 'draft');
    assert.equal(r.aiCaptureId, null);
  });
});

describe('query-layer catalog', () => {
  test('src/db/catalog.generated.json describes the new table and columns as the migration leaves them', async () => {
    const { CATALOG_QUERY, shapeCatalog } = await import('../../db/catalog-query');
    const committed = JSON.parse(readFileSync(join(__dirname, '../../db/catalog.generated.json'), 'utf8'));
    await db.exec(`set search_path = ''`);
    const live = shapeCatalog((await db.query<Json>(CATALOG_QUERY)).rows[0].json_build_object) as Json;
    await db.exec('reset search_path');
    for (const t of ['finance_ai_captures', 'finance_transactions', 'attachments']) {
      assert.deepEqual(committed.tables[t]?.columns, live.tables[t].columns, `table ${t} columns`);
    }
    const fks = (c: Json) => c.foreignKeys.filter((f: Json) => ['finance_ai_captures_created_by_fkey', 'finance_transactions_ai_capture_id_fkey'].includes(f.name));
    assert.deepEqual(fks(committed), fks(live));
  });
});
