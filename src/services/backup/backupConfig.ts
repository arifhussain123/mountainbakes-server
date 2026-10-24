import os from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { BackupError } from './errors';

/**
 * Backup configuration — read lazily, validated all at once, and NEVER at
 * import time. src/app.ts must keep booting on a host with no backup env at
 * all (the same rule the old src/config/s3.ts followed); only a backup command
 * or an admin backup endpoint ever calls getBackupSystemConfig().
 *
 * Every variable name is documented in .env.example under "Database backups".
 */

export const PRODUCTION_BUCKET_DEFAULT = 'mountainbakes-bucket';
export const DEFAULT_PREFIX = 'database-backups';
export const SUPPORTED_TIMEZONE = 'Asia/Karachi';

/** Fixed, documented schedule (Asia/Karachi); scheduler/database-backup.job.ts runs these. */
export const BACKUP_SCHEDULE = {
  timezone: SUPPORTED_TIMEZONE,
  daily: 'Every day at 03:00',
  weekly: 'Every Sunday at 03:45',
  monthly: 'First day of every month at 04:30',
} as const;

export interface RetentionDays {
  daily: number;
  weekly: number;
  monthly: number;
  manual: number;
}

export interface BackupSystemConfig {
  enabled: boolean;
  environment: string;
  isProduction: boolean;
  region: string;
  bucket: string;
  prefix: string;
  productionBucket: string;
  /** Present only when requireDatabase was true. Never log this. */
  dbUrl: string | null;
  /** The server the backup is taken from, as `host:port` — no credentials; safe to display. */
  databaseRef: string | null;
  databaseName: string;
  timezone: string;
  retentionDays: RetentionDays;
  retentionAuthority: 'lifecycle' | 'application';
  alertMessaging: boolean;
  staleLockMs: number;
  pgDumpTimeoutMs: number;
  tmpDir: string;
  pgBinDir: string | null;
  appVersion: string | null;
  /** Values that must never appear in a log line or a stored error. */
  secrets: string[];
}

export interface ConfigOptions {
  /** Require the database URL (anything that dumps or restores). Default true. */
  requireDatabase?: boolean;
  /** Require BACKUP_ENABLED=true (anything that writes to S3). Default true. */
  requireEnabled?: boolean;
  /** Override process.env (tests). */
  env?: NodeJS.ProcessEnv;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, errors: string[], min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    errors.push(`${name} must be an integer >= ${min} (got "${raw}")`);
    return fallback;
  }
  return n;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return /^(1|true|yes)$/i.test((env[name] ?? '').trim());
}

/** Which server a connection string names, without keeping the credentials. */
export function databaseRefFromUrl(dbUrl: string): string | null {
  try {
    const u = new URL(dbUrl);
    return u.hostname ? `${u.hostname}:${u.port || '5432'}` : null;
  } catch {
    return null;
  }
}

export function databaseNameFromUrl(dbUrl: string): string {
  try {
    const u = new URL(dbUrl);
    return decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  } catch {
    return 'postgres';
  }
}

/**
 * Strip credentials from any text before it is logged or stored. Handles
 * `scheme://user:password@host` URLs generically, plus every known secret
 * value (so a raw password that pg_dump echoes back on its own is caught too).
 */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text.replace(/(\w+:\/\/[^\s:@/]+):([^\s/]+)@/g, '$1:***@');
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  return out;
}

export function getBackupSystemConfig(opts: ConfigOptions = {}): BackupSystemConfig {
  const env = opts.env ?? process.env;
  const requireDatabase = opts.requireDatabase ?? true;
  const requireEnabled = opts.requireEnabled ?? true;
  const errors: string[] = [];

  const environment = (env.NODE_ENV || 'development').trim();
  const isProduction = environment === 'production';
  const enabled = boolEnv(env, 'BACKUP_ENABLED');
  if (requireEnabled && !enabled) {
    errors.push('BACKUP_ENABLED is not "true" — backups are disabled by default outside an explicitly configured environment');
  }

  const region = (env.AWS_REGION || '').trim();
  if (!region) errors.push('AWS_REGION is required');
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    // The SDK's default provider chain (IAM role, shared config) is also
    // acceptable; only warn when neither is obviously present.
    if (!env.AWS_PROFILE && !env.AWS_ROLE_ARN && !env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
      errors.push('AWS credentials are required (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or an IAM role / AWS_PROFILE)');
    }
  }

  let bucket = (env.BACKUP_S3_BUCKET || '').trim();
  if (!bucket && env.AWS_S3_BUCKET_NAME) {
    bucket = env.AWS_S3_BUCKET_NAME.trim();
    console.warn('[backup] BACKUP_S3_BUCKET is unset — falling back to AWS_S3_BUCKET_NAME. Set BACKUP_S3_BUCKET explicitly.');
  }
  if (!bucket) errors.push('BACKUP_S3_BUCKET is required');

  const productionBucket = (env.BACKUP_PRODUCTION_BUCKET || PRODUCTION_BUCKET_DEFAULT).trim();
  const allowProdBucket = boolEnv(env, 'BACKUP_ALLOW_PRODUCTION_BUCKET');
  if (bucket) {
    if (isProduction && bucket !== productionBucket) {
      errors.push(`In production BACKUP_S3_BUCKET must be "${productionBucket}" (got "${bucket}")`);
    }
    if (!isProduction && bucket === productionBucket && !allowProdBucket) {
      errors.push(
        `BACKUP_S3_BUCKET is the production bucket "${productionBucket}" but NODE_ENV is "${environment}". ` +
          'Use a development bucket, or set BACKUP_ALLOW_PRODUCTION_BUCKET=true deliberately (and a test prefix).'
      );
    }
  }

  let prefix = (env.BACKUP_S3_PREFIX || DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '');
  if (!prefix) prefix = DEFAULT_PREFIX;
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix)) {
    errors.push(`BACKUP_S3_PREFIX "${prefix}" contains characters outside [A-Za-z0-9._-/]`);
  }

  const timezone = (env.BACKUP_TIMEZONE || SUPPORTED_TIMEZONE).trim();
  if (timezone !== SUPPORTED_TIMEZONE) {
    errors.push(`BACKUP_TIMEZONE must be "${SUPPORTED_TIMEZONE}" — the business-day helpers in shared/utils/timezone.ts are fixed to it`);
  }

  // Deliberately its own variable, not DATABASE_URL: the API logs in as a role
  // that owns nothing and is cut off after 8 seconds, and a dump needs the
  // administrator's login and as long as it takes.
  const dbUrl = (env.BACKUP_DB_URL || '').trim() || null;
  if (requireDatabase && !dbUrl) {
    errors.push('BACKUP_DB_URL is required (the administrator connection pg_dump uses; see .env.example)');
  }
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      if (!/^postgres(ql)?:$/.test(u.protocol)) errors.push('BACKUP_DB_URL must start with postgresql://');
    } catch {
      errors.push('BACKUP_DB_URL is not a valid URL');
    }
  }

  const retentionDays: RetentionDays = {
    daily: intEnv(env, 'BACKUP_DAILY_RETENTION_DAYS', 7, errors),
    weekly: intEnv(env, 'BACKUP_WEEKLY_RETENTION_DAYS', 35, errors),
    monthly: intEnv(env, 'BACKUP_MONTHLY_RETENTION_DAYS', 366, errors),
    manual: intEnv(env, 'BACKUP_MANUAL_RETENTION_DAYS', 90, errors),
  };

  const authorityRaw = (env.BACKUP_RETENTION_AUTHORITY || 'lifecycle').trim().toLowerCase();
  if (authorityRaw !== 'lifecycle' && authorityRaw !== 'application') {
    errors.push('BACKUP_RETENTION_AUTHORITY must be "lifecycle" or "application"');
  }

  const staleLockMs = intEnv(env, 'BACKUP_STALE_LOCK_MS', 90 * 60_000, errors, 60_000);
  const pgDumpTimeoutMs = intEnv(env, 'BACKUP_PG_DUMP_TIMEOUT_MS', 30 * 60_000, errors, 10_000);
  const tmpDir = (env.BACKUP_TMP_DIR || path.join(os.tmpdir(), 'mountainbakes-backups')).trim();
  const pgBinDir = (env.PG_BIN_DIR || '').trim() || null;

  const appVersion =
    (env.APP_VERSION || '').trim() ||
    (env.RAILWAY_GIT_COMMIT_SHA ? `railway-${env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7)}` : '') ||
    null;

  if (errors.length > 0) {
    throw new BackupError('CONFIG_INVALID', `Backup configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  }

  const secrets: string[] = [];
  if (env.AWS_SECRET_ACCESS_KEY) secrets.push(env.AWS_SECRET_ACCESS_KEY);
  if (dbUrl) {
    secrets.push(dbUrl);
    try {
      const pw = decodeURIComponent(new URL(dbUrl).password);
      if (pw) secrets.push(pw);
    } catch {
      /* already reported */
    }
  }

  return {
    enabled,
    environment,
    isProduction,
    region,
    bucket,
    prefix,
    productionBucket,
    dbUrl,
    databaseRef: dbUrl ? databaseRefFromUrl(dbUrl) : null,
    databaseName: dbUrl ? databaseNameFromUrl(dbUrl) : 'postgres',
    timezone,
    retentionDays,
    retentionAuthority: authorityRaw as 'lifecycle' | 'application',
    alertMessaging: boolEnv(env, 'BACKUP_ALERT_MESSAGING'),
    staleLockMs,
    pgDumpTimeoutMs,
    tmpDir,
    pgBinDir,
    appVersion,
    secrets,
  };
}

let cachedClient: S3Client | undefined;

/** Memoised S3 client. Uses explicit keys when set, otherwise the SDK default provider chain (IAM role etc.). */
export function getS3Client(region?: string): S3Client {
  if (cachedClient) return cachedClient;
  const r = region ?? getBackupSystemConfig({ requireDatabase: false, requireEnabled: false }).region;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  cachedClient = new S3Client({
    region: r,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  return cachedClient;
}

/** Test seam. */
export function resetS3Client(): void {
  cachedClient = undefined;
}
