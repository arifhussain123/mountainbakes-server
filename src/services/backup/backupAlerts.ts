import { dbFor } from '../../db';
import type { BackupType } from '../../shared';
import { notify } from '../push.service';
import { getMessageProvider, getRetryPolicy, sendWithRetry } from '../messaging';

const db = dbFor('backup');

/**
 * A failed backup must not vanish into a log nobody reads. Every
 * failure:
 *   1. is one console line in the Railway deploy log (plus exit code 1 from the CLI),
 *   2. is a FAILED backup_jobs row the status screen and health endpoint show,
 *   3. opens a Support Center ticket + in-app notification for every super
 *      admin — the same escalation path the 2 AM closing job uses,
 *   4. optionally (BACKUP_ALERT_MESSAGING=true) texts the admin recipients in
 *      notification_recipients over the configured SMS/WhatsApp provider.
 *
 * The message carries the type, times, category and a redacted reason — never
 * a connection string, key or raw pg_dump stderr.
 */

export interface FailureAlert {
  backupId: string;
  backupType: BackupType;
  startedAt: Date;
  failedAt: Date;
  category: string;
  /** Already redacted by the caller. */
  safeMessage: string;
  attempts: number;
  environment: string;
}

export interface AlertOptions {
  messaging: boolean;
  log?: (line: string) => void;
}

interface RecipientRow {
  recipient_name: string | null;
  mobile_number: string;
  channel: 'whatsapp' | 'sms' | 'both';
}

/** Never throws — the run's own result must still be reported. */
export async function alertBackupFailure(alert: FailureAlert, opts: AlertOptions): Promise<void> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const title = `Database backup FAILED — ${alert.backupType} (${alert.backupId})`;
  const body = [
    `Backup type: ${alert.backupType}`,
    `Backup ID: ${alert.backupId}`,
    `Environment: ${alert.environment}`,
    `Started: ${alert.startedAt.toISOString()}`,
    `Failed: ${alert.failedAt.toISOString()}`,
    `Attempts: ${alert.attempts}`,
    `Error category: ${alert.category}`,
    '',
    alert.safeMessage.slice(0, 2000),
    '',
    'Check the Database Backup screen and the Railway deploy log, then re-run `pnpm backup:<type> -- --force` once the cause is fixed.',
  ].join('\n');

  try {
    const { data: ticket, error } = await db
      .from('support_tickets')
      .insert({
        reference_type: 'system',
        reference_id: `BACKUP-${alert.backupType.toUpperCase()}-${alert.backupId.replace(/^backup-[a-z]+-/, '')}`,
        reference_snapshot: null,
        message: `${title}\n\n${body}`,
        status: 'open',
        raised_by: null,
        raised_by_name: 'System',
        raised_by_role: 'system',
      })
      .select('id, ticket_number')
      .single();
    if (error) throw error;

    await notify({
      type: 'support_query',
      title: `Database backup failed — ${ticket.ticket_number}`,
      message: `${alert.backupType} backup ${alert.backupId} failed: ${alert.category}`,
      targetRole: 'super_admin',
      branchId: null,
      relatedId: ticket.id,
    });
  } catch (err) {
    log(`[backup] escalation (ticket + notification) failed: ${err instanceof Error ? err.message : err}`);
  }

  if (!opts.messaging) return;
  try {
    const { data, error } = await db
      .from('notification_recipients')
      .select('recipient_name, mobile_number, channel')
      .eq('active', true)
      .eq('department', 'admin');
    if (error) throw error;
    const provider = getMessageProvider();
    const policy = getRetryPolicy();
    const text = `Mountain Bakes: ${alert.backupType} database backup ${alert.backupId} FAILED (${alert.category}) at ${alert.failedAt.toISOString()}. See Admin → Database Backup.`;
    for (const r of (data ?? []) as RecipientRow[]) {
      const channels: ('whatsapp' | 'sms')[] = r.channel === 'both' ? ['whatsapp', 'sms'] : [r.channel];
      for (const channel of channels) {
        const res = await sendWithRetry(() => provider.send({ to: r.mobile_number, body: text, channel }), policy.maxAttempts, policy.baseDelayMs);
        if (!res.ok) log(`[backup] alert ${channel} to ${r.recipient_name ?? r.mobile_number} failed: ${res.error}`);
      }
    }
  } catch (err) {
    log(`[backup] alert messaging failed: ${err instanceof Error ? err.message : err}`);
  }
}
