import cron from 'node-cron';
import { runDailyClosing } from '../services/daily-closing.service';
import { dispatchClosingSummaries } from '../services/closing-notifications.service';

/**
 * Arm the automatic end-of-day closing at 2:00 AM Asia/Karachi. node-cron's
 * `timezone` option pins the fire time regardless of the server's own TZ. The
 * closing is idempotent (row lock), so an accidental double-fire is a no-op,
 * and the Auto Close toggle is checked inside the job at fire time.
 *
 * Once the day is archived, the closing summaries are generated and sent to each
 * branch / Production / Admin recipient over WhatsApp or SMS. That step:
 *   - only runs when the close actually succeeded (a skipped/failed close has no
 *     archive to summarise, and re-sending yesterday's numbers would be wrong);
 *   - is gated at fire time by the closingNotificationsEnabled setting;
 *   - never rethrows — it escalates its own failures to the Admin (notification
 *     + auto-opened Support Center ticket), so a messaging outage cannot mark a
 *     successful close as failed.
 */
export function startDailyClosingScheduler(): void {
  cron.schedule(
    '0 2 * * *',
    () => {
      runDailyClosing({ trigger: 'scheduler' })
        .then((result) => {
          if (result.status !== 'success') {
            console.log(`[daily-closing] ${result.businessDate}: ${result.status} (${result.reason ?? 'no reason'}) — skipping summaries.`);
            return;
          }
          return dispatchClosingSummaries({ businessDate: result.businessDate, trigger: 'scheduler' }).then(() => undefined);
        })
        .catch((err) => {
          console.error('[daily-closing] scheduler run threw:', err);
        });
    },
    { timezone: 'Asia/Karachi' },
  );
  console.log('[daily-closing] Scheduler armed for 02:00 Asia/Karachi (0 2 * * *).');
}
