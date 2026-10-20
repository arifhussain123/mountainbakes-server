import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { usePglite } from '../../db/testing';

/**
 * Return photos (migrations 147 + 148) and the attachment-service functions the
 * return route leans on.
 *
 * Runs migration 67 (attachments), the trigger split from 122, then 147 and 148
 * verbatim in pglite over stub tables. The service functions are the real ones:
 * their `db.from` calls run in that database through the real query layer
 * (src/db), and the file store is swapped for an in-memory one — so
 * what is asserted is what the service asks Postgres for, and what Postgres
 * (including the immutability trigger) answers.
 *
 * Run: npx tsx --test src/services/__tests__/return-photo.integration.test.ts
 */

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app; create schema storage;
  create function app.can_read_finance() returns boolean language sql as $$ select false $$;
  create table storage.buckets (
    id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text);
  alter table storage.objects enable row level security;

  create table users (id uuid primary key default gen_random_uuid());
  create table production_returns (
    id uuid primary key default gen_random_uuid(),
    product_name text not null, qty numeric not null);
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

const MIGRATIONS = join(__dirname, '../../../db/history/migrations');
const migration = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');

let db: PGlite;
let removedFromStorage: string[] = [];
let uploadedToStorage: string[] = [];
let me: string;
let someoneElse: string;

const fakeStore: import('../file-store').FileStore = {
  async upload(_bucket, path) { uploadedToStorage.push(path); },
  async remove(_bucket, paths) { removedFromStorage.push(...paths); },
  async signUrls(_bucket, paths) { return new Map(paths.map((path) => [path, `https://signed.test/${path}`])); },
  publicUrl: (_bucket, path) => `https://api.test/api/public/branding/${path}`,
};

let svc: typeof import('../attachments.service');

/** Stage one photo straight into the table, as an upload would have. */
async function stage(opts: { by?: string; entity?: string; ageDays?: number } = {}): Promise<{ id: string; path: string }> {
  const path = `${opts.entity ?? 'branch_return'}/${crypto.randomUUID()}.webp`;
  const r = await db.query<{ id: string }>(
    `insert into attachments (entity, storage_path, mime_type, size_bytes, uploaded_by, created_at)
     values ($1, $2, 'image/webp', 1000, $3, now() - ($4 || ' days')::interval) returning id`,
    [opts.entity ?? 'branch_return', path, opts.by ?? me, String(opts.ageDays ?? 0)],
  );
  return { id: r.rows[0]!.id, path };
}

async function newReturn(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into production_returns (product_name, qty) values ('Cream Puff', 2) returning id`,
  );
  return r.rows[0]!.id;
}

const exists = async (id: string) =>
  (await db.query(`select 1 from attachments where id = $1`, [id])).rows.length === 1;

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(migration('20260814000067_attachments.sql'));
  await db.exec(TRIGGER_SPLIT_122);
  // Separate exec calls: a value added to an enum cannot be used in the
  // transaction that added it, which is the whole reason 147 is its own file.
  await db.exec(migration('20261007000147_branch_return_attachment_enum.sql'));
  await db.exec(migration('20261007000148_return_photo.sql'));

  await usePglite(db);
  (await import('../file-store')).setFileStore(fakeStore);
  svc = await import('../attachments.service');

  const users = await db.query<{ id: string }>(`insert into users default values returning id`);
  me = users.rows[0]!.id;
  someoneElse = (await db.query<{ id: string }>(`insert into users default values returning id`)).rows[0]!.id;
});

beforeEach(() => {
  removedFromStorage = [];
  uploadedToStorage = [];
});

describe('migration 148', () => {
  test('adds production_returns.photo_attachment_id and can be applied twice', async () => {
    await db.exec(migration('20261007000148_return_photo.sql'));
    const col = await db.query(
      `select is_nullable from information_schema.columns
        where table_name = 'production_returns' and column_name = 'photo_attachment_id'`,
    );
    assert.equal(col.rows.length, 1);
    assert.equal((col.rows[0] as { is_nullable: string }).is_nullable, 'YES');
  });

  test('a return cannot cite an attachment that does not exist', async () => {
    await assert.rejects(
      db.query(`insert into production_returns (product_name, qty, photo_attachment_id) values ('X', 1, gen_random_uuid())`),
      /foreign key/i,
    );
  });

  test('a STAGED attachment can be deleted', async () => {
    const { id } = await stage();
    await db.query(`delete from attachments where id = $1`, [id]);
    assert.equal(await exists(id), false);
  });

  test('a BOUND attachment still cannot be deleted or re-pointed', async () => {
    const { id } = await stage();
    await db.query(`update attachments set entity_id = gen_random_uuid(), bound_at = now() where id = $1`, [id]);
    await assert.rejects(db.query(`delete from attachments where id = $1`, [id]), /cannot be deleted/);
    await assert.rejects(
      db.query(`update attachments set entity_id = gen_random_uuid() where id = $1`, [id]),
      /immutable/,
    );
    assert.equal(await exists(id), true);
  });
});

describe('assertStagedAttachments — the check made before any stock moves', () => {
  const refused = (p: Promise<void>) =>
    assert.rejects(p, (err: { status?: number; details?: { code?: string } }) => {
      assert.equal(err.status, 409);
      assert.equal(err.details?.code, 'attachment_unavailable');
      return true;
    });

  test("accepts the caller's own unused return photo", async () => {
    const { id } = await stage();
    await svc.assertStagedAttachments({ entity: 'branch_return', attachmentIds: [id], actor: { uid: me } });
  });

  test('an empty list is not a refusal — requiring a photo is the route\'s rule', async () => {
    await svc.assertStagedAttachments({ entity: 'branch_return', attachmentIds: [], actor: { uid: me } });
  });

  test("refuses another user's photo", async () => {
    const { id } = await stage({ by: someoneElse });
    await refused(svc.assertStagedAttachments({ entity: 'branch_return', attachmentIds: [id], actor: { uid: me } }));
  });

  test('refuses a photo staged for a different kind of document', async () => {
    const { id } = await stage({ entity: 'finance_transaction' });
    await refused(svc.assertStagedAttachments({ entity: 'branch_return', attachmentIds: [id], actor: { uid: me } }));
  });

  test('refuses a photo an earlier return already used', async () => {
    const { id } = await stage();
    await svc.bindAttachments({ entity: 'branch_return', entityId: await newReturn(), attachmentIds: [id], actor: { uid: me } });
    await refused(svc.assertStagedAttachments({ entity: 'branch_return', attachmentIds: [id], actor: { uid: me } }));
  });

  test('refuses an id that was swept or never existed', async () => {
    await refused(
      svc.assertStagedAttachments({ entity: 'branch_return', attachmentIds: [crypto.randomUUID()], actor: { uid: me } }),
    );
  });
});

describe('getAttachmentsByIds — what a return list signs', () => {
  test('returns a bound return photo, keyed by its own id, with a signed URL', async () => {
    const { id, path } = await stage();
    await svc.bindAttachments({ entity: 'branch_return', entityId: await newReturn(), attachmentIds: [id], actor: { uid: me } });

    const photos = await svc.getAttachmentsByIds('branch_return', [id, id, null, undefined]);
    assert.equal(photos.size, 1);
    assert.equal(photos.get(id)?.url, `https://signed.test/${path}`);
  });

  test('never signs a staged upload or another entity\'s photo', async () => {
    const staged = await stage();
    const receipt = await stage({ entity: 'finance_transaction' });
    await svc.bindAttachments({ entity: 'finance_transaction', entityId: crypto.randomUUID(), attachmentIds: [receipt.id], actor: { uid: me } });

    const photos = await svc.getAttachmentsByIds('branch_return', [staged.id, receipt.id]);
    assert.equal(photos.size, 0);
  });
});

describe('discardStagedAttachment — cleanup after a refused return', () => {
  test("removes the caller's own unused photo, row and file", async () => {
    const { id, path } = await stage();
    assert.equal(await svc.discardStagedAttachment({ id, actor: { uid: me } }), true);
    assert.equal(await exists(id), false);
    assert.deepEqual(removedFromStorage, [path]);
  });

  test("leaves another user's photo alone", async () => {
    const { id } = await stage({ by: someoneElse });
    assert.equal(await svc.discardStagedAttachment({ id, actor: { uid: me } }), false);
    assert.equal(await exists(id), true);
    assert.deepEqual(removedFromStorage, []);
  });

  test('leaves a photo a successful return cites alone — row AND file', async () => {
    const { id } = await stage();
    await svc.bindAttachments({ entity: 'branch_return', entityId: await newReturn(), attachmentIds: [id], actor: { uid: me } });

    assert.equal(await svc.discardStagedAttachment({ id, actor: { uid: me } }), false);
    assert.equal(await exists(id), true);
    assert.deepEqual(removedFromStorage, []);
  });
});

describe('purgeStagedAttachments — the sweep', () => {
  test('takes only old, unused return photos', async () => {
    const oldUnused = await stage({ ageDays: 30 });
    const fresh = await stage({ ageDays: 1 });
    const oldOtherEntity = await stage({ ageDays: 30, entity: 'finance_transaction' });
    const oldButUsed = await stage({ ageDays: 30 });
    await svc.bindAttachments({ entity: 'branch_return', entityId: await newReturn(), attachmentIds: [oldButUsed.id], actor: { uid: me } });

    const before = await svc.purgeStagedAttachments({ entity: 'branch_return', olderThanDays: 14, dryRun: true });
    assert.equal(await exists(oldUnused.id), true, 'a dry run deletes nothing');

    const removed = await svc.purgeStagedAttachments({ entity: 'branch_return', olderThanDays: 14 });
    assert.equal(removed, before);
    assert.equal(await exists(oldUnused.id), false);
    assert.ok(removedFromStorage.includes(oldUnused.path));

    for (const kept of [fresh, oldOtherEntity, oldButUsed]) {
      assert.equal(await exists(kept.id), true);
      assert.equal(removedFromStorage.includes(kept.path), false);
    }
  });
});

describe('uploadAttachment — the storage ceiling', () => {
  const actor = { uid: '', email: 'till@branch.test' };
  before(() => { actor.uid = me; });

  /** `bytes` long and, by its first bytes, really the image type named. */
  const image = (bytes: number, type: 'jpeg' | 'webp') => {
    const head = type === 'jpeg'
      ? Buffer.from([0xff, 0xd8, 0xff, 0xe0])
      : Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    return Buffer.concat([head, Buffer.alloc(bytes - head.length)]);
  };

  test('refuses a return photo over 1 MB, and stores nothing', async () => {
    await assert.rejects(
      svc.uploadAttachment({ entity: 'branch_return', buffer: image(1024 * 1024 + 1, 'jpeg'), mimeType: 'image/jpeg', actor }),
      (err: { status?: number }) => err.status === 413,
    );
    assert.deepEqual(uploadedToStorage, []);
  });

  test('stores a compressed return photo, staged', async () => {
    const a = await svc.uploadAttachment({
      entity: 'branch_return', buffer: image(180 * 1024, 'webp'), mimeType: 'image/webp', width: 1280, height: 960, actor,
    });
    assert.equal(a.entityId, null);
    assert.equal(a.sizeBytes, 180 * 1024);
    assert.match(uploadedToStorage[0]!, /^branch_return\/[0-9a-f-]{36}\.webp$/);
  });

  test('leaves the 5 MB ceiling in place for every other entity', async () => {
    const a = await svc.uploadAttachment({ entity: 'finance_transaction', buffer: image(2 * 1024 * 1024, 'jpeg'), mimeType: 'image/jpeg', actor });
    assert.equal(a.sizeBytes, 2 * 1024 * 1024);
  });
});
