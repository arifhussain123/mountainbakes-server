import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { BackupHistoryQuerySchema, RunBackupSchema, type BackupRunResponse, type BackupStatusResponse } from '../shared';
import { resolveAdminName } from '../services/audit.service';
import type { BackupDeps } from '../services/backup';

/**
 * /api/admin/backups — super_admin only. The Database Backup screen.
 *
 * Nothing here returns a credential: no connection strings, no AWS keys, and
 * the one presigned download URL lives for five minutes and is logged.
 *
 * The backup modules are imported lazily inside the handlers so the API keeps
 * booting on a host with no backup environment at all; a request then gets a
 * clean 503 with the configuration error instead of the process failing to
 * start.
 */

export const router = Router();
router.use(authenticate, requireRole('super_admin'));

async function backup() {
  return import('../services/backup');
}

/** Deps for read-only endpoints: no DB URL or BACKUP_ENABLED required. */
async function readDeps(): Promise<BackupDeps> {
  const b = await backup();
  return b.createBackupDeps({ requireDatabase: false, requireEnabled: false });
}

function configError(err: unknown): { status: number; body: { error: string; code: string } } | null {
  const e = err as { category?: string; message?: string };
  if (e?.category === 'CONFIG_INVALID') return { status: 503, body: { error: e.message ?? 'Backup system is not configured', code: 'BACKUP_NOT_CONFIGURED' } };
  return null;
}

router.get('/health', async (_req, res, next) => {
  try {
    const b = await backup();
    const deps = await readDeps();
    const [latest, latestVerified, failures] = await Promise.all([
      deps.repo.latestByType(),
      deps.repo.latestVerifiedByType(),
      deps.repo.countFailedSince(new Date(Date.now() - 7 * 86_400_000).toISOString()),
    ]);
    res.json(b.computeHealth({ latest, latestVerified, recentFailures: failures }, deps.now()));
  } catch (err) {
    const c = configError(err);
    if (c) return res.status(c.status).json(c.body);
    next(err);
  }
});

router.get('/status', async (_req, res, next) => {
  try {
    const b = await backup();
    const deps = await readDeps();
    const [latest, latestVerified, running, failures] = await Promise.all([
      deps.repo.latestByType(),
      deps.repo.latestVerifiedByType(),
      deps.repo.running(),
      deps.repo.countFailedSince(new Date(Date.now() - 7 * 86_400_000).toISOString()),
    ]);
    const body: BackupStatusResponse = {
      health: b.computeHealth({ latest, latestVerified, recentFailures: failures }, deps.now()),
      latest,
      running,
      storage: { bucket: deps.config.bucket, prefix: deps.config.prefix, region: deps.config.region },
      retention: {
        dailyDays: deps.config.retentionDays.daily,
        weeklyDays: deps.config.retentionDays.weekly,
        monthlyDays: deps.config.retentionDays.monthly,
        manualDays: deps.config.retentionDays.manual,
        authority: deps.config.retentionAuthority,
      },
      schedule: { ...b.BACKUP_SCHEDULE },
    };
    res.json(body);
  } catch (err) {
    const c = configError(err);
    if (c) return res.status(c.status).json(c.body);
    next(err);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const query = BackupHistoryQuerySchema.parse(req.query);
    const deps = await readDeps();
    const { jobs, total } = await deps.repo.history(query);
    res.json({ jobs, total, page: query.page, pageSize: query.pageSize });
  } catch (err) {
    const c = configError(err);
    if (c) return res.status(c.status).json(c.body);
    next(err);
  }
});

router.get('/restore-tests/latest', async (_req, res, next) => {
  try {
    const deps = await readDeps();
    res.json({ restoreTest: await deps.repo.latestRestoreTest() });
  } catch (err) {
    const c = configError(err);
    if (c) return res.status(c.status).json(c.body);
    next(err);
  }
});

/**
 * Start a backup. The lock is claimed synchronously (so a second click gets a
 * 409 immediately); the dump/upload then continues in this process after the
 * 202 is sent. It runs in the API process, as the scheduled runs do
 * (scheduler/database-backup.job.ts).
 */
router.post('/run', validate(RunBackupSchema), async (req: AuthRequest, res, next) => {
  try {
    const b = await backup();
    const { type, force } = req.body as { type: 'daily' | 'weekly' | 'monthly' | 'manual'; force?: boolean };
    const deps = b.createBackupDeps();
    const name = await resolveAdminName(req.user!.uid, req.user!.email);
    console.log(`[backup] manual ${type} backup triggered via API by ${req.user!.email}`);

    // Pre-flight the calendar gate and the lock so the caller gets a real answer.
    const due = b.isDue(type, deps.now());
    if (!due.due && !force) {
      const body: BackupRunResponse = { backupId: b.backupIdFor(type, deps.now()), outcome: 'not_due', message: due.reason };
      return res.status(200).json(body);
    }
    const running = await deps.repo.running();
    if (running.some((r) => r.backupType === type)) {
      const body: BackupRunResponse = { backupId: running.find((r) => r.backupType === type)!.backupId, outcome: 'in_progress', message: `A ${type} backup is already running` };
      return res.status(409).json(body);
    }

    const backupId = b.backupIdFor(type, deps.now());
    const existing = await deps.repo.getByBackupId(backupId);
    if (existing && (existing.status === 'verified' || existing.status === 'success')) {
      const body: BackupRunResponse = { backupId, outcome: 'already_completed', message: `${backupId} already completed` };
      return res.status(200).json(body);
    }

    // Fire and forget — the runner records its own outcome and alerts on failure.
    b.runBackup(type, { trigger: 'api', force: !!force, triggeredBy: req.user!.uid, triggeredByName: name }, deps).catch((err) => {
      console.error('[backup] API-triggered run threw:', b.redactSecrets(err instanceof Error ? err.message : String(err), deps.config.secrets));
    });
    const body: BackupRunResponse = { backupId, outcome: 'started', message: `${type} backup started` };
    res.status(202).json(body);
  } catch (err) {
    const c = configError(err);
    if (c) return res.status(c.status).json(c.body);
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const deps = await readDeps();
    const job = (await deps.repo.getById(req.params.id)) ?? (await deps.repo.getByBackupId(req.params.id));
    if (!job) return res.status(404).json({ error: 'Backup not found' });
    res.json({ job });
  } catch (err) {
    const c = configError(err);
    if (c) return res.status(c.status).json(c.body);
    next(err);
  }
});

router.post('/:id/verify', async (req: AuthRequest, res, next) => {
  try {
    const b = await backup();
    const deps = await readDeps();
    const job = (await deps.repo.getById(req.params.id)) ?? (await deps.repo.getByBackupId(req.params.id));
    if (!job) return res.status(404).json({ error: 'Backup not found' });
    console.log(`[backup] verify ${job.backupId} requested via API by ${req.user!.email}`);
    res.json(await b.verifyBackup(job, deps));
  } catch (err) {
    const c = configError(err);
    if (c) return res.status(c.status).json(c.body);
    next(err);
  }
});

/** Short-lived presigned URL for the main archive (or ?file=auth). Logged; never stored. */
router.get('/:id/download-url', async (req: AuthRequest, res, next) => {
  try {
    const deps = await readDeps();
    const job = (await deps.repo.getById(req.params.id)) ?? (await deps.repo.getByBackupId(req.params.id));
    if (!job) return res.status(404).json({ error: 'Backup not found' });
    if (job.status !== 'verified' && job.status !== 'success') return res.status(409).json({ error: 'Only a completed backup can be downloaded' });
    const which = req.query.file === 'auth' ? 'auth' : 'main';
    const key = which === 'auth' ? job.authS3Key : job.s3Key;
    if (!key) return res.status(404).json({ error: `No ${which} archive recorded for this backup` });
    const fileName = key.split('/').pop()!;
    const expiresInSeconds = 300;
    const url = await deps.storage.presignDownload(key, expiresInSeconds, fileName);
    console.log(`[backup] download-url issued to ${req.user!.email} for ${job.backupId} (${which}), expires in ${expiresInSeconds}s`);
    res.json({ url, expiresInSeconds, fileName });
  } catch (err) {
    const c = configError(err);
    if (c) return res.status(c.status).json(c.body);
    next(err);
  }
});
