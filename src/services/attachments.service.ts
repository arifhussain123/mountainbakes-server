import { createHash, randomUUID } from 'node:crypto';
import { dbFor, type QueryBuilder } from '../db';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_ENTITY,
  ATTACHMENT_URL_TTL_SECONDS,
  RETURN_PHOTO_MAX_BYTES,
  type Attachment,
  type AttachmentEntity,
} from '../shared';
import { rowToApi } from '../utils/case';
import { fileStore } from './file-store';

const db = dbFor('attachments');

/**
 * Photo attachments — upload, bind, and read-time URL signing.
 *
 * Three things about this module are load-bearing:
 *
 *   1. **The bucket is private.** Nothing here ever returns a storage path to a
 *      client; it returns a signed URL with a one-hour life. `<img src>` cannot
 *      send an Authorization header, so a signed URL is the only way a private
 *      object renders in the browser — and the expiry is the point, since these
 *      are expense receipts and delivery photos.
 *   2. **Upload precedes the parent row.** A photo is required on the same
 *      request that creates its document, so it cannot be uploaded with the
 *      parent's id. `uploadAttachment` writes a STAGED row (entity_id null);
 *      `bindAttachments` claims it once the parent exists. See migration 67.
 *   3. **Signing is batched.** One call signs a whole list; a ledger page of
 *      100 entries must not become 100 round-trips to Storage.
 *
 * Where the bytes live is `file-store.ts`'s business (S3). This module only
 * ever names a file by its path.
 */

const BUCKET = 'attachments' as const;

/** Extension from the SNIFFED mimetype, never from the client's filename —
 *  same reasoning as the logo upload in settings.routes.ts. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * What the bytes actually are, from their first few — never what the client
 * said. Multer's `mimetype` is the part's Content-Type header, which is
 * whatever the sender wrote; a file stored and later served as an image has to
 * BE one.
 *
 * HEIC is recognised only so it can be refused by name. The phones and browsers
 * that capture one also decode it, and the clients re-encode every capture to
 * JPEG or WebP before upload; decoding HEIC here would need a native libheif
 * build for a case the clients already cover.
 */
export function sniffImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

interface AttachmentRow {
  id: string;
  entity: AttachmentEntity;
  entityId: string | null;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

const SELECT =
  'id, entity, entity_id, storage_path, mime_type, size_bytes, width, height, uploaded_by, uploaded_by_name, created_at';

function clientError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

/**
 * Entities held to a tighter ceiling than ATTACHMENT_MAX_BYTES.
 *
 * A return photo is compressed to ~200 KB on the device; one arriving near the
 * megabyte mark means that step did not run, and storing it anyway is exactly
 * the storage growth the limit exists to stop.
 */
const MAX_BYTES_BY_ENTITY: Partial<Record<AttachmentEntity, number>> = {
  branch_return: RETURN_PHOTO_MAX_BYTES,
};

/**
 * Mint short-lived URLs for a batch of rows.
 *
 * A row whose signing fails is dropped rather than throwing: a finance page that
 * 500s because one storage object went missing is worse than the same page
 * showing four photos instead of five. The failure is logged so it is not
 * silent.
 */
async function signRows(rows: AttachmentRow[]): Promise<Attachment[]> {
  if (rows.length === 0) return [];

  // Keyed by path, never by position — see the note in file-store.ts on why a
  // reordered response must not be able to attach one receipt to another row.
  const urlByPath = await fileStore().signUrls(
    BUCKET,
    rows.map((r) => r.storagePath),
    ATTACHMENT_URL_TTL_SECONDS,
  );

  return rows.flatMap((r) => {
    const url = urlByPath.get(r.storagePath);
    if (!url) return [];
    return [
      {
        id: r.id,
        entity: r.entity,
        entityId: r.entityId,
        url,
        mimeType: r.mimeType,
        sizeBytes: Number(r.sizeBytes),
        width: r.width,
        height: r.height,
        uploadedBy: r.uploadedBy,
        uploadedByName: r.uploadedByName,
        createdAt: r.createdAt,
      },
    ];
  });
}

/**
 * Store one captured photo and stage it against `entity`.
 *
 * The returned attachment's `id` is what the caller puts in the create request's
 * `attachmentIds`. Until that happens the row is an orphan and belongs to
 * nothing.
 */
export async function uploadAttachment(input: {
  entity: AttachmentEntity;
  buffer: Buffer;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  actor: { uid: string; email: string };
}): Promise<Attachment> {
  const sniffed = sniffImageType(input.buffer);
  if (sniffed === 'image/heic') {
    throw clientError('HEIC photos cannot be stored. Take the photo again in the app, or choose a JPEG or PNG.', 415);
  }
  const extension = sniffed ? EXTENSIONS[sniffed] : undefined;
  if (!sniffed || !extension) {
    throw clientError('A photo must be a JPEG, PNG or WebP image', 400);
  }
  if (input.buffer.length > (MAX_BYTES_BY_ENTITY[input.entity] ?? ATTACHMENT_MAX_BYTES)) {
    throw clientError('That photo is too large. Retake it and try again.', 413);
  }

  // Foldered by entity so the bucket stays browsable, named by UUID so nothing
  // about the path is guessable or derived from user input.
  const storagePath = `${input.entity}/${randomUUID()}.${extension}`;

  await fileStore().upload(BUCKET, storagePath, input.buffer, sniffed);

  const { data, error } = await db
    .from('attachments')
    .insert({
      entity: input.entity,
      storage_path: storagePath,
      mime_type: sniffed,
      size_bytes: input.buffer.length,
      width: input.width ?? null,
      height: input.height ?? null,
      uploaded_by: input.actor.uid,
      uploaded_by_name: input.actor.email,
    })
    .select(SELECT)
    .single();

  if (error) {
    // The row is what makes the file findable; a file with no row is invisible
    // to the app forever. Roll the upload back rather than leaving one behind.
    try {
      await fileStore().remove(BUCKET, [storagePath]);
    } catch (cleanupErr) {
      console.warn(`[attachments] orphaned ${storagePath} after a failed insert:`, (cleanupErr as Error).message);
    }
    throw error;
  }

  await recordFingerprint(data.id as string, input.buffer);

  const [signed] = await signRows([rowToApi<AttachmentRow>(data)]);
  if (!signed) throw new Error('Photo was stored but could not be read back');
  return signed;
}

/**
 * The bytes' sha256 on the staged row, so AI Expense Capture can tell a
 * receipt already attached to an entry when it is uploaded again (migration
 * 20261030000001_ai_expense_capture).
 *
 * Best effort and separate from the insert on purpose: the fingerprint only
 * feeds a warning, and a database the migration has not reached yet must not
 * stop every photo upload in the app. The row is still staged here, so the
 * immutability trigger allows it.
 */
async function recordFingerprint(id: string, buffer: Buffer): Promise<void> {
  const { error } = await db
    .from('attachments')
    .update({ content_sha256: createHash('sha256').update(buffer).digest('hex') })
    .eq('id', id)
    .is('entity_id', null);
  if (error) console.warn(`[attachments] could not record the fingerprint of ${id}:`, error.message);
}

/**
 * Claim staged attachments for a freshly created document.
 *
 * The `.is('entity_id', null)` and `.eq('uploaded_by', ...)` predicates are the
 * security of this whole flow, not defensive noise:
 *
 *   * `entity_id is null` makes binding a one-shot. An id already bound to
 *     voucher A cannot be re-bound to voucher B, so a receipt cannot be made to
 *     support two payments.
 *   * `uploaded_by = actor` stops one user's create request from claiming a
 *     photo another user uploaded. Attachment ids are UUIDs and not enumerable,
 *     but "unguessable" is not an authorization model.
 *   * `entity = <expected>` stops a demand photo being passed off as an expense
 *     receipt.
 *
 * Anything that fails those predicates simply does not update, so the count
 * comes back short and this throws. Callers run it AFTER inserting the parent;
 * a throw therefore leaves a parent row with no photo, which is why every caller
 * validates the ids are present before it starts writing.
 */
export async function bindAttachments(input: {
  entity: AttachmentEntity;
  entityId: string;
  attachmentIds: string[];
  actor: { uid: string };
}): Promise<Attachment[]> {
  const ids = [...new Set(input.attachmentIds)];
  if (ids.length === 0) return [];
  if (ids.length > ATTACHMENT_MAX_PER_ENTITY) {
    throw clientError(`At most ${ATTACHMENT_MAX_PER_ENTITY} photos may be attached`, 400);
  }

  const { data, error } = await db
    .from('attachments')
    .update({ entity_id: input.entityId, bound_at: new Date().toISOString() })
    .in('id', ids)
    .eq('entity', input.entity)
    .eq('uploaded_by', input.actor.uid)
    .is('entity_id', null)
    .select(SELECT);
  if (error) throw error;

  const bound = rowToApi<AttachmentRow[]>(data ?? []);
  if (bound.length !== ids.length) {
    throw clientError(
      'One of the attached photos is no longer available. Retake it and submit again.',
      409,
    );
  }
  return signRows(bound);
}

/**
 * Photos for one parent, newest last.
 *
 * Prefer `listAttachmentsFor` when reading more than one parent — this issues a
 * query and a signing call per call site.
 */
export async function listAttachments(
  entity: AttachmentEntity,
  entityId: string,
): Promise<Attachment[]> {
  const byId = await listAttachmentsFor(entity, [entityId]);
  return byId.get(entityId) ?? [];
}

/**
 * Photos for many parents of the SAME entity, keyed by parent id.
 *
 * One query and one signing call regardless of how many parents — this is what
 * a list endpoint should use.
 */
export async function listAttachmentsFor(
  entity: AttachmentEntity,
  entityIds: string[],
): Promise<Map<string, Attachment[]>> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  const byParent = new Map<string, Attachment[]>();
  if (ids.length === 0) return byParent;

  const { data, error } = await db
    .from('attachments')
    .select(SELECT)
    .eq('entity', entity)
    .in('entity_id', ids)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const signed = await signRows(rowToApi<AttachmentRow[]>(data ?? []));
  for (const a of signed) {
    if (!a.entityId) continue;
    const list = byParent.get(a.entityId);
    if (list) list.push(a);
    else byParent.set(a.entityId, [a]);
  }
  return byParent;
}

/**
 * Photos for parents spanning SEVERAL entity types, keyed by `${entity}:${id}`.
 *
 * The ledger needs exactly this: one page mixes vouchers sourced from manual
 * entries, salaries, partner expenses and branch shares, and reading them as
 * four separate round-trips per page would be four times the latency for the
 * same rows.
 */
export async function listAttachmentsAcross(
  refs: { entity: AttachmentEntity; entityId: string }[],
): Promise<Map<string, Attachment[]>> {
  const byKey = new Map<string, Attachment[]>();
  if (refs.length === 0) return byKey;

  // Group by entity so each type is one `in (...)` predicate. The query
  // builder has no tuple-IN, and the alternative is an `or(and(...),and(...))`
  // filter string with one branch per ref — a hundred of them for one page.
  const idsByEntity = new Map<AttachmentEntity, Set<string>>();
  for (const ref of refs) {
    if (!ref.entityId) continue;
    const set = idsByEntity.get(ref.entity);
    if (set) set.add(ref.entityId);
    else idsByEntity.set(ref.entity, new Set([ref.entityId]));
  }

  const perEntity = await Promise.all(
    [...idsByEntity.entries()].map(async ([entity, ids]) => ({
      entity,
      byParent: await listAttachmentsFor(entity, [...ids]),
    })),
  );

  for (const { entity, byParent } of perEntity) {
    for (const [entityId, list] of byParent) {
      byKey.set(`${entity}:${entityId}`, list);
    }
  }
  return byKey;
}

/** The key `listAttachmentsAcross` returns its map under. */
export function attachmentKey(entity: AttachmentEntity, entityId: string): string {
  return `${entity}:${entityId}`;
}

/**
 * Confirm that every id is a photo this caller staged for `entity` and has not
 * used yet — the same three predicates `bindAttachments` applies, checked
 * WITHOUT writing.
 *
 * For a caller that must do something irreversible between "the photo is good"
 * and "the photo is bound". A return moves stock before its rows exist, so
 * finding out at bind time that the photo was never usable would leave units
 * off the branch balance with nothing recorded against them.
 */
export async function assertStagedAttachments(input: {
  entity: AttachmentEntity;
  attachmentIds: string[];
  actor: { uid: string };
}): Promise<void> {
  const ids = [...new Set(input.attachmentIds)];
  if (ids.length === 0) return;

  const { data, error } = await db
    .from('attachments')
    .select('id')
    .in('id', ids)
    .eq('entity', input.entity)
    .eq('uploaded_by', input.actor.uid)
    .is('entity_id', null);
  if (error) throw error;

  const found = new Set((data ?? []).map((r) => r.id as string));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw Object.assign(
      new Error(
        missing.length === 1
          ? 'An attached photo is no longer available. Take it again and resubmit.'
          : `${missing.length} attached photos are no longer available. Take them again and resubmit.`,
      ),
      // `details.code` is read by the mobile sync queue, which answers it by
      // uploading the photos it still holds again rather than parking the return
      // as a conflict; `attachmentIds` says which ones. (`details` is the one
      // extra field errorHandler passes on.)
      { status: 409, details: { code: 'attachment_unavailable', attachmentIds: missing } },
    );
  }
}

/**
 * Photos by their own id, keyed by that id — for a parent that points AT its
 * attachment (`production_returns.photo_attachment_id`) instead of being
 * pointed at by `entity_id`.
 *
 * Only BOUND rows of the named entity are returned. That is the authorization:
 * the caller has already decided the reader may see the parent rows, and this
 * refuses to sign anything those rows could not legitimately cite — a staged
 * upload, or another document's receipt whose id was written into the column.
 */
export async function getAttachmentsByIds(
  entity: AttachmentEntity,
  attachmentIds: (string | null | undefined)[],
): Promise<Map<string, Attachment>> {
  const ids = [...new Set(attachmentIds.filter((id): id is string => Boolean(id)))];
  const byId = new Map<string, Attachment>();
  if (ids.length === 0) return byId;

  const { data, error } = await db
    .from('attachments')
    .select(SELECT)
    .eq('entity', entity)
    .in('id', ids)
    .not('entity_id', 'is', null);
  if (error) throw error;

  for (const a of await signRows(rowToApi<AttachmentRow[]>(data ?? []))) byId.set(a.id, a);
  return byId;
}

/**
 * Remove files and rows for STAGED attachments only.
 *
 * The row goes first. Its delete is guarded on `entity_id is null` in the same
 * statement, so a photo that was bound a moment ago simply does not match and
 * nothing is touched — and only the paths of rows that really went are then
 * removed from the bucket. The reverse order could delete the file behind a row
 * that was bound in between, leaving a return citing a photo that is gone.
 *
 * A file whose row is gone but whose removal failed is an invisible orphan; it
 * is logged so it can be found, and costs one photo of storage.
 */
async function removeStaged(
  filter: (q: QueryBuilder) => PromiseLike<{
    data: { storage_path: string }[] | null;
    error: { message: string } | null;
  }>,
): Promise<number> {
  const { data, error } = await filter(db.from('attachments').delete());
  if (error) throw error;

  const paths = (data ?? []).map((r) => r.storage_path);
  if (paths.length === 0) return 0;

  try {
    await fileStore().remove(BUCKET, paths);
  } catch (removeErr) {
    console.warn(`[attachments] ${paths.length} staged file(s) lost their row but stayed in storage:`, (removeErr as Error).message, paths);
  }
  return paths.length;
}

/**
 * Discard one photo the caller uploaded and never used — the cleanup a client
 * runs when the document it was taken for was refused.
 *
 * Returns false when nothing matched: not this caller's, already bound, or
 * already gone. All three mean "there is nothing for you to delete", and the
 * caller is not told which.
 */
export async function discardStagedAttachment(input: {
  id: string;
  actor: { uid: string };
}): Promise<boolean> {
  const removed = await removeStaged((q) =>
    q.eq('id', input.id).eq('uploaded_by', input.actor.uid).is('entity_id', null).select('storage_path'),
  );
  return removed > 0;
}

/**
 * Sweep staged photos of one entity that nothing claimed within the window
 * (`olderThanHours`, or `olderThanDays`).
 *
 * Scoped to an entity and to an age, never "everything staged". A return photo
 * gets 24 hours (RETURN_PHOTO_STAGED_TTL_HOURS): the mobile app keeps an offline
 * return's photos on the phone and uploads them only as it sends the return, and
 * one swept from under a queued return is answered with `attachment_unavailable`,
 * which makes the app upload it again — so a short window costs nothing.
 */
export async function purgeStagedAttachments(input: {
  entity: AttachmentEntity;
  olderThanDays?: number;
  olderThanHours?: number;
  dryRun?: boolean;
}): Promise<number> {
  const hours = input.olderThanHours ?? (input.olderThanDays ?? NaN) * 24;
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('purgeStagedAttachments needs a positive window');
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  if (input.dryRun) {
    const { count, error } = await db
      .from('attachments')
      .select('id', { count: 'exact', head: true })
      .eq('entity', input.entity)
      .is('entity_id', null)
      .lt('created_at', cutoff);
    if (error) throw error;
    return count ?? 0;
  }

  return removeStaged((q) =>
    q.eq('entity', input.entity).is('entity_id', null).lt('created_at', cutoff).select('storage_path'),
  );
}
