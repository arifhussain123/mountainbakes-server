import cron from 'node-cron';
import { activateDuePrices } from '../services/price.service';

/**
 * Arm future-dated price activation at 2:00 AM Asia/Karachi — the business-day
 * rollover — so a price scheduled with effectiveDate == today becomes the live
 * `products.price` on the correct business day. Idempotent (Firestore lock), so a
 * double-fire is a no-op. A startup catch-up (see index.ts) recovers a missed run.
 */
export function startPriceActivationScheduler(): void {
  cron.schedule(
    '0 2 * * *',
    () => {
      activateDuePrices({ trigger: 'scheduler' }).catch((err) => {
        console.error('[price-activation] scheduler run threw:', err);
      });
    },
    { timezone: 'Asia/Karachi' },
  );
  console.log('[price-activation] Scheduler armed for 02:00 Asia/Karachi (0 2 * * *).');
}
