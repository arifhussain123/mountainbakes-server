import 'dotenv/config';
import type { BackupJob, BackupType } from '../shared';
import { dbFor } from '../db';
import {
  BACKUP_SCHEDULE,
  BackupError,
  applyRetention,
  computeHealth,
  createBackupDeps,
  getBackupSystemConfig,
  planRetention,
  runBackup,
  verifyBackup,
  isBackupError,
  redactSecrets,
  type BackupDeps,
} from '../services/backup';

const db = dbFor('scripts');

/**
 * Mountain Bakes — database backup CLI (pg_dump → S3).
 *
 * Usage (from backend/):
 *   pnpm backup:daily                    daily run (the API schedules it itself at 03:00 PKT)
 *   pnpm backup:weekly                   runs only on a Karachi Sunday; otherwise exits 0 "not due"
 *   pnpm backup:monthly                  runs only on the Karachi 1st; otherwise exits 0 "not due"
 *   pnpm backup:weekly -- --force        run regardless of the calendar gate
 *   pnpm backup:manual                   one-off backup under manual/ (90-day retention, outside the daily/weekly/monthly pools)
 *   pnpm backup:status                   health report: last success per type, S3 + database connectivity, failures
 *   pnpm backup:verify [-- --backup-id backup-daily-2026-09-21]
 *                                        re-check the latest (or named) backup against S3: manifest, sizes, checksums
 *   pnpm backup:list [-- --type daily --limit 20]
 *   pnpm backup:retention                DRY RUN: what S3 Lifecycle will expire / has expired (deletes nothing)
 *   pnpm backup:retention -- --confirm   delete expired objects — ONLY with BACKUP_RETENTION_AUTHORITY=application
 *
 * Every write requires BACKUP_ENABLED=true and a bucket that passes the
 * production/development gate in backupConfig.ts. Nothing here ever prints
 * BACKUP_DB_URL or an AWS key.
 *
 * Exit codes:
 *   0  success, or nothing to do (not due / already completed / dry run)
 *   1  the backup, verification or retention run FAILED (see the [backup] lines; an alert was raised)
 *   2  configuration invalid (nothing ran)
 *   3  lock held — another run of this type is in progress
 */

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function banner(title: string): void {
  console.log(`Mountain Bakes ERP — ${title}`);
  console.log('='.repeat(title.length + 21));
}

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Abort on SIGTERM/SIGINT so pg_dump is killed, the upload aborted, the lock released and temp cleaned. */
function installSignalHandlers(controller: AbortController): void {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      console.error(`[backup] received ${sig} — stopping the current step and marking the run interrupted`);
      controller.abort();
      // Second signal: hard exit
      process.once(sig, () => process.exit(130));
    });
  }
}

async function cmdRun(type: BackupType): Promise<number> {
  banner(`${type} database backup`);
  const controller = new AbortController();
  installSignalHandlers(controller);
  const deps = createBackupDeps({ signal: controller.signal });
  const result = await runBackup(type, { trigger: type === 'manual' ? 'manual' : 'scheduler', force: flag('force'), triggeredByName: type === 'manual' ? 'cli' : 'scheduler' }, deps);
  switch (result.outcome) {
    case 'success':
      console.log(`\n✔ ${result.backupId} verified in ${fmtDuration(result.durationMs)} — s3://${deps.config.bucket}/${result.plan.mainKey}`);
      return 0;
    case 'not_due':
      console.log(`\n· not due — ${result.reason}`);
      return 0;
    case 'already_completed':
      console.log(`\n· already completed — ${result.reason}`);
      return 0;
    case 'in_progress':
      console.log(`\n· skipped — ${result.reason}`);
      return 3;
    case 'failed':
      console.error(`\n✖ ${result.backupId} FAILED [${result.category}] ${result.message}`);
      return 1;
  }
}

function describeJob(j: BackupJob | null): string[] {
  if (!j) return ['  (none)'];
  return [
    `  Last run:        ${j.startedAt}  [${j.status.toUpperCase()}]${j.errorCategory ? ` ${j.errorCategory}` : ''}`,
    `  Backup ID:       ${j.backupId}`,
    `  Size:            ${fmtBytes(j.fileSize)}${j.authFileSize ? ` + auth ${fmtBytes(j.authFileSize)}` : ''}`,
    `  Duration:        ${fmtDuration(j.durationMs)} (dump ${fmtDuration(j.dumpMs)}, upload ${fmtDuration(j.uploadMs)})`,
    `  S3 key:          ${j.s3Key ?? '—'}`,
    `  SHA-256:         ${j.checksumSha256 ?? '—'}`,
    `  Retention until: ${j.retentionUntil ?? '—'}`,
  ];
}

async function cmdStatus(): Promise<number> {
  banner('Database Backup Status');
  const deps = createBackupDeps({ requireDatabase: false, requireEnabled: false });
  const [latest, latestVerified, running, failures, s3, restoreTest] = await Promise.all([
    deps.repo.latestByType(),
    deps.repo.latestVerifiedByType(),
    deps.repo.running(),
    deps.repo.countFailedSince(new Date(Date.now() - 7 * 86_400_000).toISOString()),
    deps.storage.ping(),
    deps.repo.latestRestoreTest(),
  ]);
  const health = computeHealth({ latest, latestVerified, recentFailures: failures });
  let dbOk = 'Connected';
  try {
    const { error } = await db.rpc('backup_database_info');
    if (error) dbOk = `ERROR: ${error.message}`;
  } catch (err) {
    dbOk = `ERROR: ${redactSecrets(String(err), deps.config.secrets)}`;
  }

  console.log(`\nBucket: s3://${deps.config.bucket}/${deps.config.prefix}/   Region: ${deps.config.region}   Timezone: ${BACKUP_SCHEDULE.timezone}`);
  for (const type of ['daily', 'weekly', 'monthly'] as const) {
    const h = health[type];
    console.log(`\n${type.toUpperCase()}  — ${BACKUP_SCHEDULE[type]}`);
    console.log(`  Health:          ${h.status.toUpperCase()}${h.ageHours !== null ? ` (last verified ${h.ageHours}h ago, expected within ${h.expectedWithinHours}h)` : ''}`);
    console.log(`  Last successful: ${h.lastSuccessfulAt ?? 'never'}`);
    for (const line of describeJob(latest[type])) console.log(line);
  }
  console.log('\nMANUAL');
  for (const line of describeJob(latest.manual)) console.log(line);
  console.log(`\nRunning now:        ${running.length === 0 ? 'none' : running.map((r) => r.backupId).join(', ')}`);
  console.log(`Failures (7 days):  ${failures}`);
  console.log(`S3:                 ${s3.ok ? 'Connected' : `ERROR: ${s3.detail}`}`);
  console.log(`Database:           ${dbOk}`);
  console.log(`Last restore test:  ${restoreTest ? `${restoreTest.startedAt} [${restoreTest.status.toUpperCase()}] on ${restoreTest.backupId}` : 'never'}`);
  const unhealthy = (['daily', 'weekly', 'monthly'] as const).filter((t) => health[t].status !== 'healthy');
  if (unhealthy.length > 0) console.log(`\n⚠ Not healthy: ${unhealthy.join(', ')}`);
  return unhealthy.length > 0 || !s3.ok || dbOk !== 'Connected' ? 1 : 0;
}

async function cmdVerify(): Promise<number> {
  banner('Verify database backups');
  const deps = createBackupDeps({ requireDatabase: false, requireEnabled: false });
  const id = opt('backup-id');
  let jobs: BackupJob[];
  if (id) {
    const j = await deps.repo.getByBackupId(id);
    if (!j) {
      console.error(`No backup_jobs row for ${id}`);
      return 1;
    }
    jobs = [j];
  } else {
    const latest = await deps.repo.latestVerifiedByType();
    jobs = (['daily', 'weekly', 'monthly', 'manual'] as const).map((t) => latest[t]).filter((j): j is BackupJob => !!j);
  }
  const s3 = await deps.storage.ping();
  console.log(`S3: ${s3.ok ? 'Connected' : `ERROR ${s3.detail}`}`);
  if (jobs.length === 0) console.log('No verified backups to check yet.');
  let allOk = s3.ok;
  for (const job of jobs) {
    const res = await verifyBackup(job, deps);
    console.log(`\n${res.ok ? '✔' : '✖'} ${job.backupId} (${job.backupType}, ${fmtBytes(job.fileSize)})`);
    for (const c of res.checks) console.log(`   ${c.ok ? '✔' : '✖'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    allOk = allOk && res.ok;
  }
  return allOk ? 0 : 1;
}

async function cmdList(): Promise<number> {
  banner('Database backups');
  const deps = createBackupDeps({ requireDatabase: false, requireEnabled: false });
  const type = opt('type') as BackupType | undefined;
  const limit = Number(opt('limit') ?? 20);
  const { jobs, total } = await deps.repo.history({ page: 1, pageSize: Number.isFinite(limit) && limit > 0 ? limit : 20, type });
  console.log(`${jobs.length} of ${total} runs${type ? ` (${type})` : ''}\n`);
  for (const j of jobs) {
    console.log(`${j.startedAt}  ${j.backupType.padEnd(7)}  ${j.status.toUpperCase().padEnd(9)}  ${fmtBytes(j.fileSize).padStart(9)}  ${fmtDuration(j.durationMs).padStart(7)}  ${j.backupId}${j.errorCategory ? `  ${j.errorCategory}` : ''}`);
    if (j.s3Key) console.log(`    ${j.s3Key}  until ${j.retentionUntil?.slice(0, 10) ?? '—'}`);
  }
  return 0;
}

async function cmdRetention(): Promise<number> {
  banner('Backup retention');
  const confirm = flag('confirm');
  const deps: BackupDeps = createBackupDeps({ requireDatabase: false, requireEnabled: confirm });
  const cfg = getBackupSystemConfig({ requireDatabase: false, requireEnabled: confirm });
  const now = new Date();
  console.log(`Policy: daily ${cfg.retentionDays.daily}d · weekly ${cfg.retentionDays.weekly}d · monthly ${cfg.retentionDays.monthly}d · manual ${cfg.retentionDays.manual}d`);
  console.log(`Authority: ${cfg.retentionAuthority === 'lifecycle' ? 'S3 Lifecycle rules (this command only reports)' : 'application (this command deletes with --confirm)'}`);
  console.log(`Mode: ${confirm ? 'DELETE (--confirm)' : 'DRY RUN — nothing will be deleted'}\n`);

  const [objects, verified] = await Promise.all([deps.storage.list(`${cfg.prefix}/`), deps.repo.verifiedJobs()]);
  const plan = planRetention(objects, verified, { prefix: cfg.prefix, now, retentionDays: cfg.retentionDays });

  console.log(`Objects under ${cfg.prefix}/: ${objects.length}   keep: ${plan.keep.length}   expired: ${plan.expire.length}   skipped: ${plan.skipped.length}`);
  if (plan.expire.length > 0) {
    console.log(`\n${confirm ? 'Deleting' : 'Would delete'}:`);
    for (const e of plan.expire) console.log(`  ${e.key}  (expired ${e.retentionUntil?.toISOString()}, ${fmtBytes(e.size)})`);
  }
  if (flag('verbose')) {
    console.log('\nKeeping:');
    for (const k of plan.keep) console.log(`  ${k.key}  until ${k.retentionUntil?.toISOString() ?? '—'}`);
    console.log('\nSkipped:');
    for (const s of plan.skipped) console.log(`  ${s.key}  — ${s.reason}`);
  }
  const res = await applyRetention(plan, deps.storage, { confirm, authority: cfg.retentionAuthority, prefix: cfg.prefix, now });
  if (res.dryRun) console.log('\nDry run complete — nothing deleted.');
  else {
    console.log(`\nDeleted ${res.deleted.length}; refused ${res.refused.length}.`);
    for (const r of res.refused) console.log(`  refused ${r.key}: ${r.reason}`);
  }
  return 0;
}

async function main(): Promise<number> {
  switch (command) {
    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'manual':
      return cmdRun(command);
    case 'status':
      return cmdStatus();
    case 'verify':
      return cmdVerify();
    case 'list':
      return cmdList();
    case 'retention':
      return cmdRetention();
    default:
      console.error('Usage: backup <daily|weekly|monthly|manual|status|verify|list|retention> [--force] [--confirm] [--backup-id ID] [--type T] [--limit N] [--verbose]');
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (isBackupError(err) && err.category === 'CONFIG_INVALID') {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    const secrets = [process.env.BACKUP_DB_URL, process.env.AWS_SECRET_ACCESS_KEY].filter((s): s is string => !!s);
    console.error('\nBackup command failed:', redactSecrets(err instanceof Error ? err.message : String(err), secrets));
    process.exit(err instanceof BackupError ? 1 : 1);
  });
