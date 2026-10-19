import cron from 'node-cron';
import { RETURN_PHOTO_STAGED_TTL_HOURS } from '../shared';
import { purgeStagedAttachments } from '../services/attachments.service';

/**
 * Every hour, delete return photos that were uploaded but never attached to a
 * saved return within RETURN_PHOTO_STAGED_TTL_HOURS.
 *
 * Each product line of a return now uploads its own photo the moment it is
 * taken, so a line deleted from the form, a retake, or a return that was never
 * saved each leave one behind. The clients discard their own where they can
 * (DELETE /api/attachments/:id); this is the backstop for the rest.
 *
 * Safe to run on several instances at once: the delete is guarded on
 * `entity_id is null` in the statement itself, so a photo bound a moment ago is
 * never touched, and two sweeps racing simply split the rows between them.
 * RETURN_PHOTO_SWEEP=off disarms it.
 */
export function startReturnPhotoSweepScheduler(): void {
  if (process.env['RETURN_PHOTO_SWEEP'] === 'off') {
    console.log('[return-photo-sweep] Disabled (RETURN_PHOTO_SWEEP=off).');
    return;
  }
  cron.schedule('17 * * * *', () => {
    purgeStagedAttachments({ entity: 'branch_return', olderThanHours: RETURN_PHOTO_STAGED_TTL_HOURS })
      .then((removed) => {
        if (removed > 0) console.log(`[return-photo-sweep] Deleted ${removed} unused return photo(s).`);
      })
      .catch((err) => {
        console.error('[return-photo-sweep] run threw:', err);
      });
  });
  console.log(`[return-photo-sweep] Armed hourly; unused return photos are kept ${RETURN_PHOTO_STAGED_TTL_HOURS} h.`);
}
