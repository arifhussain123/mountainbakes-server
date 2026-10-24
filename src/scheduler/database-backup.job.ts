import cron from 'node-cron';
import { karachiMinutesOfDay, type BackupType } from '../shared';

/**
 * Automatic database backups (pg_dump → S3), run inside the API process.
 *
 * Until now the daily/weekly/monthly runs depended on an external scheduler
 * calling `pnpm backup:<type>`, which was never set up and does not exist on
 * Railway, so nothing ran unless an admin pressed "Run
 * backup". This arms the same runs here, at the times BACKUP_SCHEDULE documents:
 *
 *   daily    03:00 every day        — after the 02:00 day closing / stock roll
 *   weekly   03:45 every Sunday
 *   monthly  04:30 on the 1st       — labelled for the month that just ended
 *
 * plus a backup straight after the business day is closed (`backupAfterDailyClosing`),
 * so the stock the closing has just rolled over is in S3 at once.
 *
 * Safety rests on what `runBackup` already does, not on this file: a database
 * lock per backup id (a second API instance, or a second fire, finds it held or
 * completed and does nothing), the calendar gates for weekly/monthly, and a
 * verified read-back before anything is marked successful. Failures alert the
 * Admin through the backup system's own alerting.
 *
 * Runs are queued one at a time: three pg_dumps at once would compete for the
 * container's memory and the database's connections for no benefit.
 *
 * Armed only when BACKUP_ENABLED=true — the same switch every backup write
 * already requires — so a local or staging API never backs up by surprise.
 */

const TZ = 'Asia/Karachi';

const SCHEDULE: { type: Exclude<BackupType, 'manual'>; cron: string; atMinute: number }[] = [
  { type: 'daily', cron: '0 3 * * *', atMinute: 3 * 60 },
  { type: 'weekly', cron: '45 3 * * 0', atMinute: 3 * 60 + 45 },
  { type: 'monthly', cron: '30 4 1 * *', atMinute: 4 * 60 + 30 },
];

/** How long after boot the catch-up waits, so a restart loop does not dump the database each time. */
const CATCH_UP_DELAY_MS = 2 * 60_000;

let queue: Promise<void> = Promise.resolve();

function enqueue(type: BackupType, reason: string): Promise<void> {
  queue = queue.then(() => runOne(type, reason));
  return queue;
}

async function runOne(type: BackupType, reason: string): Promise<void> {
  // Loaded lazily, as the backup routes do: the AWS SDK and the backup modules
  // are not worth loading into a process that never backs up.
  const b = await import('../services/backup');
  let deps: ReturnType<typeof b.createBackupDeps>;
  try {
    deps = b.createBackupDeps();
  } catch (err) {
    console.error(`[backup-scheduler] ${type} (${reason}) not run — backup configuration is invalid: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  try {
    const result = await b.runBackup(type, { trigger: 'scheduler' }, deps);
    console.log(
      `[backup-scheduler] ${type} (${reason}): ${result.outcome} — ${result.backupId}` +
        ('reason' in result ? ` (${result.reason})` : ''),
    );
    // The day's daily backup was already taken before this closing: take one
    // more, under manual/, so the state right after the closing is still kept.
    if (reason === 'after day closing' && type === 'daily' && result.outcome === 'already_completed') {
      await runOne('manual', 'after day closing, daily already taken');
    }
  } catch (err) {
    // runBackup has already recorded the failure and alerted; this is the log line.
    console.error(
      `[backup-scheduler] ${type} (${reason}) failed:`,
      b.redactSecrets(err instanceof Error ? err.message : String(err), deps.config.secrets),
    );
  }
}

function enabled(): boolean {
  return (process.env.BACKUP_ENABLED || '').trim().toLowerCase() === 'true';
}

export function startDatabaseBackupScheduler(): void {
  if (!enabled()) {
    console.warn('[backup-scheduler] BACKUP_ENABLED is not true — automatic database backups are OFF.');
    return;
  }

  for (const job of SCHEDULE) {
    cron.schedule(job.cron, () => void enqueue(job.type, 'scheduled'), { timezone: TZ });
  }

  // Catch-up: a deploy or restart across the scheduled minute loses that run.
  // Anything due today whose time has passed is tried once; one that already
  // completed is a cheap no-op inside runBackup.
  setTimeout(() => {
    const minute = karachiMinutesOfDay();
    void (async () => {
      const { isDue } = await import('../services/backup');
      for (const job of SCHEDULE) {
        if (minute >= job.atMinute && isDue(job.type, new Date()).due) void enqueue(job.type, 'catch-up after restart');
      }
    })().catch((err) => console.error('[backup-scheduler] catch-up failed:', err));
  }, CATCH_UP_DELAY_MS).unref();

  console.log('[backup-scheduler] Armed (Asia/Karachi): daily 03:00, weekly Sunday 03:45, monthly 1st 04:30.');
}

/**
 * Back up straight after the business day is closed — the closing is what rolls
 * the day's stock over. Fire and forget: the closing has already succeeded and
 * must not wait on, or fail because of, a backup.
 */
export function backupAfterDailyClosing(): void {
  if (!enabled()) return;
  void enqueue('daily', 'after day closing');
}
