import cron from 'node-cron';
import { dispatchDueEventNotifications } from '../services/event-notifications.service';
import {
  refreshEventEstimates,
  refreshEventStatuses,
  rollForwardRecurringEvents,
} from '../services/special-events.service';

/**
 * Two Special Events jobs, both pinned to Asia/Karachi by node-cron's `timezone`
 * option regardless of the server's own TZ.
 *
 * ─── 09:00 — send the day's due reminders ────────────────────────────────────
 * Deliberately NOT 2 AM. These reminders are read by branch managers and
 * production staff, so they should land in working hours; and 2 AM is already
 * contended by the daily closing and price activation. The dispatch is idempotent
 * (claim-based), so an accidental double-fire is a no-op, and the
 * eventNotificationsEnabled toggle is checked inside the job at fire time.
 *
 * ─── 02:30 — maintenance ─────────────────────────────────────────────────────
 * After the business-day rollover and before anyone is looking: refresh the
 * Hijri estimates for unconfirmed events, advance upcoming → active → completed,
 * and create next year's occurrences for recurring series. Ordered so that a
 * freshly rolled-forward event already has its estimate when the reminder
 * schedule is next built.
 *
 * Like the other two schedulers, the idempotency here assumes a SINGLE server * (one replica). The claim is safe against concurrent claimers, but the stale-claim
 * sweep is not written for a fleet.
 */
export function startEventNotificationScheduler(): void {
  cron.schedule(
    '0 9 * * *',
    () => {
      dispatchDueEventNotifications({ trigger: 'scheduler' })
        .then((result) => {
          if (result.skipped) {
            console.log(`[event-notify] ${result.onDate}: skipped — ${result.skipped}`);
          }
        })
        .catch((err) => {
          console.error('[event-notify] scheduler run threw:', err);
        });
    },
    { timezone: 'Asia/Karachi' },
  );

  cron.schedule(
    '30 2 * * *',
    () => {
      refreshEventEstimates()
        .then(() => refreshEventStatuses())
        .then(() => rollForwardRecurringEvents())
        .then(() => undefined)
        .catch((err) => {
          console.error('[special-events] maintenance run threw:', err);
        });
    },
    { timezone: 'Asia/Karachi' },
  );

  console.log(
    '[event-notify] Scheduler armed: reminders 09:00, maintenance 02:30 Asia/Karachi.',
  );
}
