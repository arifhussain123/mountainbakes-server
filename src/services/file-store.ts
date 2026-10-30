import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { getS3Client } from './backup/backupConfig';
import type { S3Like } from './backup/s3BackupStorage';

/**
 * Where uploaded files live — photo attachments and the branding logo: the
 * company's S3 bucket, under FILES_S3_PREFIX.
 *
 * A file is addressed by a (bucket, path) pair and its object key is
 * `<prefix>/<bucket>/<path>`. `attachments.storage_path` and
 * `settings.logo_path` hold the path; nothing in the database knows the bucket
 * or the prefix, so either can change without a row being rewritten.
 */

export type FileBucket = 'attachments' | 'branding';

export interface FileStore {
  upload(bucket: FileBucket, path: string, body: Buffer, contentType: string): Promise<void>;
  /** Throws if the store refuses; a path that is already gone is not an error. */
  remove(bucket: FileBucket, paths: string[]): Promise<void>;
  /**
   * Short-lived read URLs, keyed by path. A path that could not be signed is
   * simply absent from the map — the caller decides what a missing photo means.
   */
  signUrls(bucket: FileBucket, paths: string[], ttlSeconds: number): Promise<Map<string, string>>;
  /** A permanent, unauthenticated URL. Only meaningful for `branding`. */
  publicUrl(bucket: FileBucket, path: string): string;
  /**
   * The stored bytes, or null if there is no such file. Only the server reads
   * them (AI Expense Capture sends a receipt to the model, and copies one when
   * a bill is split); a client always gets a signed URL instead. Optional so a
   * test store that never reads need not implement it.
   */
  download?(bucket: FileBucket, path: string): Promise<Buffer | null>;
}

// ── S3 ─────────────────────────────────────────────────────────────────────

export interface S3FileConfig {
  bucket: string;
  prefix: string;
  /** This API's own public origin — the branding logo is served through it. */
  publicApiUrl: string;
}

/** The API path the public logo is served from. Mounted in routes/index.ts. */
export const PUBLIC_BRANDING_PATH = '/api/public/branding';

/**
 * S3 settings from the environment. Throws, naming every problem at once,
 * rather than start storing files somewhere half-configured.
 *
 * FILES_S3_BUCKET has no fallback to the backup bucket on purpose. That bucket
 * carries lifecycle rules that EXPIRE objects; a receipt photo quietly deleted
 * by a rule written for database dumps is not recoverable. Whoever sets this
 * has to name the bucket and own that question.
 */
export function s3FileConfig(env: NodeJS.ProcessEnv = process.env): S3FileConfig {
  const errors: string[] = [];
  const bucket = (env.FILES_S3_BUCKET || '').trim();
  if (!bucket) errors.push('FILES_S3_BUCKET is required');

  const prefix = (env.FILES_S3_PREFIX || 'files').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix)) {
    errors.push(`FILES_S3_PREFIX "${prefix}" contains characters outside [A-Za-z0-9._-/]`);
  }

  const publicApiUrl = (env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(publicApiUrl)) {
    errors.push('PUBLIC_API_URL must be this API\'s public origin, e.g. https://api.example.com (the logo is served from it)');
  }

  if (errors.length > 0) throw new Error(`File storage is misconfigured: ${errors.join('; ')}`);
  return { bucket, prefix, publicApiUrl };
}

export function s3Key(cfg: Pick<S3FileConfig, 'prefix'>, bucket: FileBucket, path: string): string {
  return `${cfg.prefix}/${bucket}/${path}`;
}

/** S3's batch delete takes at most this many keys per request. */
const DELETE_BATCH = 1000;

export function createS3FileStore(
  cfg: S3FileConfig,
  client: S3Like,
  // Injected so a test can sign without credentials.
  sign: (key: string, ttlSeconds: number) => Promise<string> = (key, ttlSeconds) =>
    getSignedUrl(client as never, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: ttlSeconds }),
): FileStore {
  return {
    async upload(bucket, path, body, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: s3Key(cfg, bucket, path),
        Body: body,
        ContentType: contentType,
        // Explicit, as for backups: encrypted at rest whatever the bucket default is.
        ServerSideEncryption: 'AES256',
      }));
    },

    async remove(bucket, paths) {
      for (let i = 0; i < paths.length; i += DELETE_BATCH) {
        const batch = paths.slice(i, i + DELETE_BATCH);
        const out = await client.send(new DeleteObjectsCommand({
          Bucket: cfg.bucket,
          Delete: { Objects: batch.map((p) => ({ Key: s3Key(cfg, bucket, p) })), Quiet: true },
        }));
        // A batch delete answers 200 even when individual keys were refused.
        const failed = (out?.Errors ?? []) as { Key?: string; Message?: string }[];
        if (failed.length > 0) {
          throw new Error(`S3 refused to delete ${failed.length} object(s): ${failed[0]?.Key} — ${failed[0]?.Message}`);
        }
      }
    },

    /**
     * Signing is local arithmetic over the credentials — no request is made, so
     * a page of 100 photos costs nothing on the network. The other side of that:
     * S3 is never asked whether the object exists, so a missing file is NOT
     * dropped here; its URL is minted and 404s when opened.
     */
    async signUrls(bucket, paths, ttlSeconds) {
      const urlByPath = new Map<string, string>();
      await Promise.all(paths.map(async (path) => {
        try {
          urlByPath.set(path, await sign(s3Key(cfg, bucket, path), ttlSeconds));
        } catch (err) {
          console.warn(`[files] could not sign ${bucket}/${path}:`, err instanceof Error ? err.message : err);
        }
      }));
      return urlByPath;
    },

    async download(bucket, path) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: s3Key(cfg, bucket, path) }));
        const body = out?.Body as { transformToByteArray?: () => Promise<Uint8Array> } | Readable | undefined;
        if (!body) return null;
        if ('transformToByteArray' in body && typeof body.transformToByteArray === 'function') {
          return Buffer.from(await body.transformToByteArray());
        }
        const chunks: Buffer[] = [];
        for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer));
        return Buffer.concat(chunks);
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },

    // The bucket is private, so there is no S3 URL a signed-out login page or a
    // printed receipt could load. The logo is served by this API instead.
    publicUrl(bucket, path) {
      if (bucket !== 'branding') throw new Error(`${bucket} files are private and have no public URL`);
      return `${cfg.publicApiUrl}${PUBLIC_BRANDING_PATH}/${path}`;
    },
  };
}

// ── The store ──────────────────────────────────────────────────────────────

let store: FileStore | undefined;

/** The file store, built from the environment the first time it is needed. */
export function fileStore(): FileStore {
  if (!store) store = createS3FileStore(s3FileConfig(), getS3Client(process.env.AWS_REGION));
  return store;
}

/** Test seam: hand in a store, or nothing to go back to the configured one. */
export function setFileStore(next?: FileStore): void {
  store = next;
}

// ── Public branding ────────────────────────────────────────────────────────

/**
 * The only shape a logo path ever has (settings.routes.ts writes it). The
 * public route serves nothing that does not match, so it cannot be walked to
 * any other object under the prefix.
 */
export const LOGO_PATH_PATTERN = /^settings\/logo-\d{1,16}\.(png|jpg|webp|svg)$/;

export interface PublicFile {
  body: Readable;
  contentType: string;
  contentLength: number | null;
}

/** Open a branding file for streaming, or null if there is no such file. */
export async function openPublicBrandingFile(path: string): Promise<PublicFile | null> {
  if (!LOGO_PATH_PATTERN.test(path)) return null;
  const cfg = s3FileConfig();
  try {
    const out = await getS3Client(process.env.AWS_REGION).send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: s3Key(cfg, 'branding', path) }),
    );
    if (!out.Body) return null;
    return {
      body: out.Body as Readable,
      contentType: out.ContentType || 'application/octet-stream',
      contentLength: typeof out.ContentLength === 'number' ? out.ContentLength : null,
    };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Size of an object under the store's key scheme, or null if absent. Used by the copy script. */
export async function s3ObjectSize(cfg: S3FileConfig, client: S3Like, bucket: FileBucket, path: string): Promise<number | null> {
  try {
    const out = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: s3Key(cfg, bucket, path) }));
    return typeof out?.ContentLength === 'number' ? out.ContentLength : null;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}
