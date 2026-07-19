import cron from 'node-cron';
import { runDailyClosing } from '../services/daily-closing.service';

/**
 * Arm the automatic end-of-day closing at 2:00 AM Asia/Karachi. node-cron's
 * `timezone` option pins the fire time regardless of the server's own TZ. The
 * closing is idempotent (Firestore lock), so an accidental double-fire is a no-op,
 * and the Auto Close toggle is checked inside the job at fire time.
 */
export function startDailyClosingScheduler(): void {
  cron.schedule(
    '0 2 * * *',
    () => {
      runDailyClosing({ trigger: 'scheduler' }).catch((err) => {
        console.error('[daily-closing] scheduler run threw:', err);
      });
    },
    { timezone: 'Asia/Karachi' },
  );
  console.log('[daily-closing] Scheduler armed for 02:00 Asia/Karachi (0 2 * * *).');
}
