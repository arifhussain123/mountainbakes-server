import cron from 'node-cron';
import { autoVerifyDailySaleRecords } from '../services/daily-sale.service';

/**
 * Arm the automatic Daily Sale Record verification at 12:30 AM Asia/Karachi.
 * Every record with a manual count (fed) that is still open or pending is
 * verified — there is no manual Verify button any more. Re-running is harmless:
 * a verified record no longer matches the sweep.
 */
export function startDailySaleVerifyScheduler(): void {
  cron.schedule(
    '30 0 * * *',
    () => {
      autoVerifyDailySaleRecords()
        .then((r) => {
          console.log(`[daily-sale-verify] ${r.businessDate}: verified ${r.verified}, failed ${r.failed}.`);
        })
        .catch((err) => {
          console.error('[daily-sale-verify] scheduler run threw:', err);
        });
    },
    { timezone: 'Asia/Karachi' },
  );
  console.log('[daily-sale-verify] Scheduler armed for 00:30 Asia/Karachi (30 0 * * *).');
}
