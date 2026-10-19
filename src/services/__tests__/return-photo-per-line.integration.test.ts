import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';
import { resolveReturnLinePhotos } from '../branch-returns.service';
import { sniffImageType } from '../attachments.service';

/**
 * One photo per returned product (migration 20261020000001).
 *
 * pglite runs the attachment migrations (67, the 122 trigger split, 147, 148)
 * and the new migration verbatim over stub tables, with `commit_branch_return`,
 * `apply_stock_movement` and the idempotency functions as the database defines
 * them. Requests go
 * through the real routers — auth, role, idempotency, validation, geofence —
 * so a refusal here is the API's own answer, and every "nothing moved" is read
 * back from the branch's stock ledger.
 *
 * Run: npx tsx --test src/services/__tests__/return-photo-per-line.integration.test.ts
 */

const HISTORY = join(__dirname, '../../../db/history/migrations');
const PRISMA = join(__dirname, '../../../prisma/migrations');
const read = (file: string) => readFileSync(join(HISTORY, file), 'utf8');
const NEW_MIGRATION = readFileSync(join(PRISMA, '20261020000001_return_photo_per_line/migration.sql'), 'utf8');

/** A stock function exactly as the live schema defines it. */
function fromBaseline(fn: string): string {
  const sql = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
  const start = sql.indexOf(`CREATE FUNCTION public.${fn}(`);
  const end = sql.indexOf('$$;', start) + 3;
  assert.ok(start > 0 && end > start, `${fn} not found in the baseline`);
  return sql.slice(start, end);
}

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app; create schema storage;
  create function app.can_read_finance() returns boolean language sql as $$ select false $$;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create table storage.buckets (
    id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text);
  alter table storage.objects enable row level security;

  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table business_day_closures (business_date date primary key, status text not null);
  create table settings (id int primary key default 1);
  create table branches (id uuid primary key default gen_random_uuid(), name text not null);
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table users (
    id uuid primary key default gen_random_uuid(), email text, display_name text, username text,
    role user_role, branch_id uuid, branch_name text,
    status user_status not null default 'active', must_change_password boolean default false);
  create table audit_logs (
    id uuid primary key default gen_random_uuid(), action text not null, admin_id uuid, admin_name text,
    target_user_id uuid, target_user_name text, target_user_role text, details text,
    created_at timestamptz not null default now());
  create table notifications (
    id uuid primary key default gen_random_uuid(), type text, title text, message text,
    target_user_id uuid, target_role text, branch_id uuid, related_id uuid);

  create table products (
    id uuid primary key default gen_random_uuid(), name text not null, sku text, stock_code text,
    is_active boolean not null default true, price numeric(14,2));
  create table product_price_history (
    id uuid primary key default gen_random_uuid(), product_id uuid not null,
    old_price numeric(14,2), new_price numeric(14,2) not null,
    effective_date date not null, status text not null, version_number int not null);
  create type stock_movement_type as enum ('sale', 'production', 'return', 'adjustment');
  create table stock (
    id uuid primary key default gen_random_uuid(), branch_id uuid not null, product_id uuid not null,
    product_name text, balance numeric not null default 0, unique (branch_id, product_id));
  create table stock_history (
    id uuid primary key default gen_random_uuid(), branch_id uuid not null, product_id uuid not null,
    product_name text, type stock_movement_type not null, delta numeric not null,
    balance_after numeric not null default 0, ref_id text, business_date date not null,
    created_at timestamptz not null default now(),
    unique (ref_id, product_id, type));

  create type production_return_status as enum ('pending', 'accepted', 'rejected', 'returned');
  -- As the table stood before migration 148 added the photo column.
  create table production_returns (
    id uuid primary key default gen_random_uuid(),
    branch_id uuid references branches (id), branch_name text,
    product_id uuid references products (id), product_name text not null,
    qty numeric(14,3) not null check (qty > 0), reason text,
    status production_return_status not null default 'pending',
    source text, business_date date not null default current_date,
    created_by uuid, created_by_name text,
    reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
    disposition text, disposition_note text, legacy_id text,
    created_at timestamptz not null default now());
`;

/** Migration 122 split the one trigger of 67 into these two; 148 relies on it. */
const TRIGGER_SPLIT_122 = `
  drop trigger if exists attachments_immutable on attachments;
  create trigger attachments_no_delete
    before delete on attachments
    for each row execute function app.attachments_immutable();
  create trigger attachments_immutable
    before update on attachments
    for each row
    when (coalesce(current_setting('app.allow_user_purge', true), 'off') <> 'on')
    execute function app.attachments_immutable();
`;

const BRANCH_A = '00000000-0000-4000-8000-00000000000a';
const BROWNIE = '20000000-0000-4000-8000-000000000001';
const FUDGE = '20000000-0000-4000-8000-000000000002';
const LOTUS = '20000000-0000-4000-8000-000000000003';

interface Actor { id: string; email: string; role: string; branchId: string | null; branchName: string | null }
const ACTORS: Record<string, Actor> = {
  'branch-a': { id: '10000000-0000-4000-8000-000000000001', email: 'a@mb.test', role: 'branch_manager', branchId: BRANCH_A, branchName: 'DHA Branch' },
  'branch-a2': { id: '10000000-0000-4000-8000-000000000002', email: 'a2@mb.test', role: 'branch_manager', branchId: BRANCH_A, branchName: 'DHA Branch' },
  production: { id: '10000000-0000-4000-8000-000000000003', email: 'prod@mb.test', role: 'production_user', branchId: null, branchName: null },
};
const TOKENS: Record<string, string> = {};

let db: PGlite;
let server: Server;
let base: string;

/** The smallest bytes each sniffer accepts as that image type. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(64)]);

async function call(as: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKENS[as]}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

/** POST /api/attachments, multipart, exactly as the clients send it. */
async function upload(as: string, bytes: Buffer, claimedType = 'image/jpeg') {
  const form = new FormData();
  form.append('entity', 'branch_return');
  form.append('photo', new Blob([bytes], { type: claimedType }), 'photo');
  const res = await fetch(`${base}/api/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKENS[as]}` },
    body: form,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function photo(as = 'branch-a'): Promise<string> {
  const res = await upload(as, JPEG);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.attachment.id as string;
}

const returnIt = (body: unknown, headers: Record<string, string> = {}, as = 'branch-a') =>
  call(as, 'POST', '/api/stock/return', body, headers);

const num = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string | number }>(sql, params)).rows[0]!.n);
const returnRows = () => num(`select count(*) as n from production_returns`);
const ledgerRows = () => num(`select count(*) as n from stock_history`);
const balance = (productId: string) =>
  num(`select coalesce(sum(balance), 0) as n from stock where branch_id = $1 and product_id = $2`, [BRANCH_A, productId]);

/** Put the branch back at a known stock position before each test. */
async function stockUp() {
  await db.query(`delete from stock where branch_id = $1`, [BRANCH_A]);
  await db.query(
    `insert into stock (branch_id, product_id, product_name, balance) values
       ($1, $2, 'Classic Brownie', 10), ($1, $3, 'Fudge Pastry', 10), ($1, $4, 'Lotus Pastry', 10)`,
    [BRANCH_A, BROWNIE, FUDGE, LOTUS],
  );
}

// Legacy fixtures, written BEFORE the new migration runs.
const legacy = { shared: '', single: '', sharedRows: [] as string[], singleRow: '', bareRow: '' };

before(async () => {
  process.env['JWT_SECRET'] = 'return-photo-per-line-test-secret-long-enough';
  process.env['FILES_S3_BUCKET'] = 'test-bucket';
  process.env['PUBLIC_API_URL'] = 'https://api.test';

  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(fromBaseline('commit_branch_return'));
  await db.exec(fromBaseline('apply_stock_movement'));
  // Every geofenced request logs its check; the table only has to exist.
  const baseline = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
  const logs = baseline.indexOf('CREATE TABLE public.geofence_logs (');
  await db.exec(baseline.slice(logs, baseline.indexOf(');', logs) + 2));
  await db.exec(read('20260818000084_idempotency_keys.sql'));
  await db.exec(read('20260814000067_attachments.sql'));
  await db.exec(TRIGGER_SPLIT_122);
  // Separate execs: an enum value cannot be used in the transaction that added it.
  await db.exec(read('20261007000147_branch_return_attachment_enum.sql'));
  await db.exec(read('20261007000148_return_photo.sql'));
  await db.exec(`begin;${read('20261009000149_custom_auth.sql')}commit;`);

  await db.query(`insert into branches (id, name) values ($1, 'DHA Branch')`, [BRANCH_A]);
  await db.query(
    `insert into products (id, name, sku, price) values
       ($1, 'Classic Brownie', 'CB-01', 120), ($2, 'Fudge Pastry', 'FP-01', 200), ($3, 'Lotus Pastry', 'LP-01', 150)`,
    [BROWNIE, FUDGE, LOTUS],
  );
  for (const a of Object.values(ACTORS)) {
    await db.query(
      `insert into users (id, email, role, branch_id, branch_name) values ($1, $2, $3, $4, $5)`,
      [a.id, a.email, a.role, a.branchId, a.branchName],
    );
  }

  // A two-product return from before this change: one photo, cited by both rows,
  // bound to the first. A one-product return with its own photo. And a return
  // from before photos existed at all.
  const stageLegacy = async () =>
    (await db.query<{ id: string }>(
      `insert into attachments (entity, storage_path, mime_type, size_bytes, uploaded_by)
       values ('branch_return', $1, 'image/webp', 1000, $2) returning id`,
      [`branch_return/${randomUUID()}.webp`, ACTORS['branch-a']!.id],
    )).rows[0]!.id;
  const addLegacyRow = async (productId: string, name: string, photoId: string | null) =>
    (await db.query<{ id: string }>(
      `insert into production_returns (branch_id, branch_name, product_id, product_name, qty, source, business_date, photo_attachment_id)
       values ($1, 'DHA Branch', $2, $3, 2, 'branch', '2026-10-10', $4) returning id`,
      [BRANCH_A, productId, name, photoId],
    )).rows[0]!.id;
  legacy.shared = await stageLegacy();
  legacy.sharedRows = [
    await addLegacyRow(BROWNIE, 'Classic Brownie', legacy.shared),
    await addLegacyRow(FUDGE, 'Fudge Pastry', legacy.shared),
  ];
  legacy.single = await stageLegacy();
  legacy.singleRow = await addLegacyRow(LOTUS, 'Lotus Pastry', legacy.single);
  legacy.bareRow = await addLegacyRow(BROWNIE, 'Classic Brownie', null);
  await db.query(`update attachments set entity_id = $1, bound_at = now() where id = $2`, [legacy.sharedRows[0], legacy.shared]);
  await db.query(`update attachments set entity_id = $1, bound_at = now() where id = $2`, [legacy.singleRow, legacy.single]);

  await db.exec(NEW_MIGRATION);

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
  const { router: stockRouter } = await import('../../routes/stock.routes');
  const { router: attachmentsRouter } = await import('../../routes/attachments.routes');
  const { router: productionReturnsRouter } = await import('../../routes/production-returns.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/stock', stockRouter);
  app.use('/api/attachments', attachmentsRouter);
  app.use('/api/production-returns', productionReturnsRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

beforeEach(async () => {
  delete process.env['RETURN_PHOTO_PER_LINE'];
  delete process.env['RETURN_PHOTO_REQUIRED'];
  await stockUp();
});

// ── The rule, without a database ─────────────────────────────────────────────
describe('resolveReturnLinePhotos', () => {
  const brownie = { productId: BROWNIE, productName: 'Classic Brownie', qty: 2 };
  const fudge = { productId: FUDGE, productName: 'Fudge Pastry', qty: 3 };
  const base = { legacyAttachmentIds: [], required: true, strict: false };

  test('every line with its own photo is accepted, each keeping its own', () => {
    const r = resolveReturnLinePhotos({ ...base, lines: [{ ...brownie, attachmentId: 'p1' }, { ...fudge, attachmentId: 'p2' }] });
    assert.ok(r.ok);
    assert.deepEqual(r.lines.map((l) => l.photoId), ['p1', 'p2']);
  });

  test('a line without a photo is refused, naming the product', () => {
    const r = resolveReturnLinePhotos({ ...base, lines: [{ ...brownie, attachmentId: 'p1' }, fudge] });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
    assert.equal(r.code, 'photo_required');
    assert.equal(r.error, 'Photo missing for Fudge Pastry');
  });

  test('several missing photos are named together', () => {
    const r = resolveReturnLinePhotos({ ...base, lines: [brownie, fudge] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'Photo missing for Classic Brownie, Fudge Pastry');
  });

  test('RETURN_PHOTO_REQUIRED=false lets a line through without one', () => {
    const r = resolveReturnLinePhotos({ ...base, required: false, lines: [brownie] });
    assert.ok(r.ok);
    assert.equal(r.lines[0]!.photoId, null);
  });

  test('the old one-photo shape is read for a one-product return', () => {
    const r = resolveReturnLinePhotos({ ...base, legacyAttachmentIds: ['old'], lines: [brownie] });
    assert.ok(r.ok);
    assert.equal(r.lines[0]!.photoId, 'old');
  });

  test('the old shape is refused for several products, and in strict mode for one', () => {
    const multi = resolveReturnLinePhotos({ ...base, legacyAttachmentIds: ['old'], lines: [brownie, fudge] });
    assert.equal(multi.ok, false);
    if (!multi.ok) assert.equal(multi.code, 'photo_per_line_required');
    const strict = resolveReturnLinePhotos({ ...base, strict: true, legacyAttachmentIds: ['old'], lines: [brownie] });
    assert.equal(strict.ok, false);
  });

  test('both shapes at once are refused', () => {
    const r = resolveReturnLinePhotos({ ...base, legacyAttachmentIds: ['old'], lines: [{ ...brownie, attachmentId: 'p1' }] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'photo_shape_mixed');
  });
});

describe('sniffImageType — what the bytes are, not what the client says', () => {
  test('recognises JPEG, PNG, WebP and HEIC', () => {
    assert.equal(sniffImageType(JPEG), 'image/jpeg');
    assert.equal(sniffImageType(PNG), 'image/png');
    assert.equal(sniffImageType(WEBP), 'image/webp');
    assert.equal(sniffImageType(HEIC), 'image/heic');
  });

  test('anything else is not an image', () => {
    assert.equal(sniffImageType(Buffer.from('%PDF-1.7 not a photo')), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });
});

// ── The migration ────────────────────────────────────────────────────────────
describe('migration 20261020000001', () => {
  const flag = async (id: string) =>
    (await db.query<{ legacy_single_photo: boolean }>(`select legacy_single_photo from production_returns where id = $1`, [id]))
      .rows[0]!.legacy_single_photo;

  test('flags only the rows that share one photo; keeps every photo as it was', async () => {
    for (const id of legacy.sharedRows) assert.equal(await flag(id), true);
    assert.equal(await flag(legacy.singleRow), false, 'a one-product return already has its own photo');
    assert.equal(await flag(legacy.bareRow), false, 'no photo, nothing to flag — and nothing backfilled');
    const photos = await db.query<{ photo_attachment_id: string | null }>(
      `select photo_attachment_id from production_returns where id = any($1::uuid[]) order by created_at`,
      [[...legacy.sharedRows, legacy.bareRow]],
    );
    assert.deepEqual(photos.rows.map((r) => r.photo_attachment_id), [legacy.shared, legacy.shared, null]);
  });

  test('can be applied twice', async () => {
    await db.exec(NEW_MIGRATION);
    assert.equal(await flag(legacy.sharedRows[0]!), true);
  });

  test('a new row cannot cite a photo another non-legacy row already cites', async () => {
    await assert.rejects(
      db.query(
        `insert into production_returns (branch_id, product_id, product_name, qty, photo_attachment_id)
         values ($1, $2, 'Lotus Pastry', 1, $3)`,
        [BRANCH_A, LOTUS, legacy.single],
      ),
      /duplicate key|unique/i,
    );
  });
});

// ── Uploading ────────────────────────────────────────────────────────────────
describe('POST /api/attachments — a return photo', () => {
  test('a JPEG mislabelled by the client is stored as what it is', async () => {
    const res = await upload('branch-a', JPEG, 'image/png');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.attachment.mimeType, 'image/jpeg');
  });

  test('HEIC is refused by name', async () => {
    const res = await upload('branch-a', HEIC, 'image/heic');
    assert.equal(res.status, 415);
    assert.match(res.body.error, /HEIC/);
  });

  test('something that is not an image is refused, whatever it claims', async () => {
    const res = await upload('branch-a', Buffer.from('%PDF-1.7 not a photo'), 'image/jpeg');
    assert.equal(res.status, 400);
  });
});

// ── Saving a return ──────────────────────────────────────────────────────────
describe('POST /api/stock/return — one photo per line', () => {
  test('two products, two photos: two rows, each with its own photo bound to it', async () => {
    const [p1, p2] = [await photo(), await photo()];
    const res = await returnIt({
      items: [{ productId: BROWNIE, qty: 2, attachmentId: p1 }, { productId: FUDGE, qty: 3, attachmentId: p2 }],
      reason: 'End of day',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.ids.length, 2);

    const rows = await db.query<{ id: string; product_id: string; photo_attachment_id: string; legacy_single_photo: boolean }>(
      `select id, product_id, photo_attachment_id, legacy_single_photo from production_returns where id = any($1::uuid[])`,
      [res.body.ids],
    );
    const byProduct = new Map(rows.rows.map((r) => [r.product_id, r]));
    assert.equal(byProduct.get(BROWNIE)!.photo_attachment_id, p1);
    assert.equal(byProduct.get(FUDGE)!.photo_attachment_id, p2);
    for (const r of rows.rows) {
      assert.equal(r.legacy_single_photo, false);
      const bound = await db.query<{ entity_id: string }>(`select entity_id from attachments where id = $1`, [r.photo_attachment_id]);
      assert.equal(bound.rows[0]!.entity_id, r.id, 'each photo is bound to its own row');
    }
    assert.equal(await balance(BROWNIE), 8);
    assert.equal(await balance(FUDGE), 7);

    const audit = await db.query<{ action: string; admin_id: string; details: string }>(
      `select action, admin_id, details from audit_logs where action = 'return_created' order by created_at desc limit 1`,
    );
    assert.equal(audit.rows[0]!.admin_id, ACTORS['branch-a']!.id);
    for (const id of [p1, p2, ...res.body.ids]) assert.ok(audit.rows[0]!.details.includes(id), `audit names ${id}`);
  });

  test('a line without a photo refuses the whole return, naming it — nothing moves', async () => {
    const [rowsBefore, ledgerBefore] = [await returnRows(), await ledgerRows()];
    const res = await returnIt({
      items: [{ productId: BROWNIE, qty: 2, attachmentId: await photo() }, { productId: FUDGE, qty: 1 }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'photo_required');
    assert.equal(res.body.error, 'Photo missing for Fudge Pastry');
    assert.equal(await returnRows(), rowsBefore);
    assert.equal(await ledgerRows(), ledgerBefore);
    assert.equal(await balance(BROWNIE), 10);
  });

  test("another user's photo is refused before any stock moves, and named", async () => {
    const theirs = await photo('branch-a2');
    const ledgerBefore = await ledgerRows();
    const res = await returnIt({
      items: [{ productId: BROWNIE, qty: 1, attachmentId: await photo() }, { productId: FUDGE, qty: 1, attachmentId: theirs }],
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.details.code, 'attachment_unavailable');
    assert.deepEqual(res.body.details.attachmentIds, [theirs]);
    assert.equal(await ledgerRows(), ledgerBefore);
  });

  test('an unknown photo id is refused the same way', async () => {
    const res = await returnIt({ items: [{ productId: BROWNIE, qty: 1, attachmentId: randomUUID() }] });
    assert.equal(res.status, 409);
    assert.equal(res.body.details.code, 'attachment_unavailable');
  });

  test('a photo already used by an earlier return cannot be used again', async () => {
    const p = await photo();
    assert.equal((await returnIt({ items: [{ productId: BROWNIE, qty: 1, attachmentId: p }] })).status, 201);
    const again = await returnIt({ items: [{ productId: FUDGE, qty: 1, attachmentId: p }] });
    assert.equal(again.status, 409);
  });

  test('the same photo on two lines is refused', async () => {
    const p = await photo();
    const res = await returnIt({
      items: [{ productId: BROWNIE, qty: 1, attachmentId: p }, { productId: FUDGE, qty: 1, attachmentId: p }],
    });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /its own photo/);
  });

  test('a line left at 0 needs no photo and is not saved', async () => {
    const rowsBefore = await returnRows();
    const res = await returnIt({
      items: [{ productId: BROWNIE, qty: 2, attachmentId: await photo() }, { productId: FUDGE, qty: 0 }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.ids.length, 1);
    assert.equal(await returnRows(), rowsBefore + 1);
    assert.equal(await balance(FUDGE), 10);
  });

  test('a return of nothing but 0 lines is refused', async () => {
    const res = await returnIt({ items: [{ productId: BROWNIE, qty: 0 }] });
    assert.equal(res.status, 400);
  });

  test('a retried submit under one Idempotency-Key saves once', async () => {
    const body = {
      items: [{ productId: BROWNIE, qty: 1, attachmentId: await photo() }, { productId: LOTUS, qty: 2, attachmentId: await photo() }],
    };
    const key = `stock_return-${randomUUID()}`;
    const rowsBefore = await returnRows();
    const first = await returnIt(body, { 'Idempotency-Key': key });
    const again = await returnIt(body, { 'Idempotency-Key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(again.body.ids, first.body.ids);
    assert.equal(await returnRows(), rowsBefore + 2, 'no duplicate lines');
    assert.equal(await balance(LOTUS), 8, 'stock moved once');
    assert.equal(
      await num(`select count(*) as n from attachments where id = any($1::uuid[])`, [body.items.map((i) => i.attachmentId)]),
      2,
      'no duplicate photos',
    );
  });

  test('an app still sending one photo for a one-product return is served', async () => {
    const p = await photo();
    const res = await returnIt({ items: [{ productId: LOTUS, qty: 1 }], attachmentIds: [p] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await db.query<{ photo_attachment_id: string; legacy_single_photo: boolean }>(
      `select photo_attachment_id, legacy_single_photo from production_returns where id = $1`,
      [res.body.ids[0]],
    );
    assert.deepEqual(row.rows[0], { photo_attachment_id: p, legacy_single_photo: false });
  });

  test('…but told to update for several products, and in strict mode for one', async () => {
    const p = await photo();
    const multi = await returnIt({ items: [{ productId: BROWNIE, qty: 1 }, { productId: FUDGE, qty: 1 }], attachmentIds: [p] });
    assert.equal(multi.status, 400);
    assert.equal(multi.body.code, 'photo_per_line_required');
    assert.match(multi.body.error, /Update the app/);

    process.env['RETURN_PHOTO_PER_LINE'] = 'strict';
    const one = await returnIt({ items: [{ productId: BROWNIE, qty: 1 }], attachmentIds: [p] });
    assert.equal(one.status, 400);
    assert.equal(await balance(BROWNIE), 10);
  });
});

// ── Reading returns back ─────────────────────────────────────────────────────
describe('reading returns: each line shows its own photo', () => {
  test("Production's queue gives each line its own signed photo, and marks the legacy ones", async () => {
    const [p1, p2] = [await photo(), await photo()];
    const saved = await returnIt({
      items: [{ productId: BROWNIE, qty: 1, attachmentId: p1 }, { productId: FUDGE, qty: 1, attachmentId: p2 }],
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));

    const res = await call('production', 'GET', '/api/production-returns?limit=200');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = new Map<string, any>(res.body.returns.map((r: any) => [r.id, r]));

    const [a, b] = saved.body.ids.map((id: string) => byId.get(id));
    assert.deepEqual(new Set([a.photo.id, b.photo.id]), new Set([p1, p2]));
    assert.match(a.photo.url, /^https:\/\/signed\.test\/branch_return\//);
    assert.equal(a.legacySinglePhoto, false);

    for (const id of legacy.sharedRows) {
      assert.equal(byId.get(id).photo.id, legacy.shared, 'a legacy row still shows its one shared photo');
      assert.equal(byId.get(id).legacySinglePhoto, true);
    }
    assert.equal(byId.get(legacy.singleRow).legacySinglePhoto, false);
    assert.equal(byId.get(legacy.bareRow).photo, null);
  });

  test("the branch's own list carries the same per-line photos", async () => {
    const res = await call('branch-a', 'GET', '/api/stock/returns?from=2026-10-01');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyRow = res.body.returns.find((r: any) => r.id === legacy.sharedRows[1]);
    assert.equal(legacyRow.photo.id, legacy.shared);
    assert.equal(legacyRow.legacySinglePhoto, true);
  });
});

describe('PUT /api/stock/returns/:id — a correction is audited with its photo', () => {
  test('the Audit Trail names the quantity change and the photo', async () => {
    const p = await photo();
    const saved = await returnIt({ items: [{ productId: BROWNIE, qty: 3, attachmentId: p }] });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const id = saved.body.ids[0] as string;

    const res = await call('branch-a', 'PUT', `/api/stock/returns/${id}`, { qty: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const audit = await db.query<{ details: string }>(
      `select details from audit_logs where action = 'return_revised' order by created_at desc limit 1`,
    );
    assert.match(audit.rows[0]!.details, new RegExp(`Return ${id}.*3 → 2.*photo ${p}`));
  });
});
