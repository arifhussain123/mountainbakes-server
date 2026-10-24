import type { BackupErrorCategory } from '../../shared';

/**
 * A backup failure with a coarse, safe-to-display category. The category is
 * what lands in backup_jobs.error_category, the alert ticket and the log
 * line; the message is redacted before it goes anywhere.
 */
export class BackupError extends Error {
  readonly category: BackupErrorCategory;
  /** Whether the runner may retry the step that threw this. */
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(category: BackupErrorCategory, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'BackupError';
    this.category = category;
    this.retryable = opts.retryable ?? false;
    this.cause = opts.cause;
  }
}

export function isBackupError(err: unknown): err is BackupError {
  return err instanceof BackupError;
}

/** Best-effort classification of an arbitrary thrown value. */
export function categorize(err: unknown): BackupErrorCategory {
  if (isBackupError(err)) return err.category;
  const name = (err as { name?: string } | null)?.name ?? '';
  if (/^(SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|ExpiredToken|InvalidToken|TokenRefreshRequired)$/.test(name)) {
    return 'S3_AUTH_FAILED';
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOSPC|EACCES|EROFS|ENOENT|EMFILE/.test(msg)) return 'DISK_ERROR';
  if (/could not connect|connection refused|timeout expired|password authentication|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) {
    return 'DB_CONNECTION_FAILED';
  }
  return 'UNKNOWN';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
