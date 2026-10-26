import type { UserRole } from '../shared';
import { businessDateStr, businessDaysAgoStr } from '../shared';
import { assertBusinessDayOpen } from '../middleware/assertBusinessDayOpen';

/**
 * Resolve the business date a write belongs to, honouring a date the CLIENT
 * captured when the transaction happened.
 *
 * WHY THE CLIENT GETS A SAY AT ALL. Every one of these endpoints used to stamp
 * `businessDateStr()` at the moment the request arrived, which is correct for a
 * browser at a counter and wrong for a phone: a sale rung up at 9pm with no
 * signal and delivered at 7am the next morning would be filed against a day it
 * has nothing to do with, moving money between two days' figures with nothing to
 * show it happened. The device knows when the sale was made; the server decides
 * whether that day will accept it.
 *
 * WHAT IS STILL NOT TRUSTED. The date is bounded on both sides and then put
 * through the same closure check as any other write:
 *
 *   - the future is refused outright — a phone with a wrong clock must not open
 *     a day that has not happened;
 *   - anything older than the sync window is refused, so a handset found in a
 *     drawer cannot post last month's sales into the books;
 *   - a CLOSED day is refused by `assertBusinessDayOpen`, exactly as it is for a
 *     back-dated write from the web app. Super Admin remains exempt there.
 *
 * A refusal does not lose the transaction: the mobile queue parks a rejected
 * operation with the server's reason and surfaces it in the Sync Center for a
 * person to deal with. Nothing is ever silently discarded, and nothing is
 * silently re-dated.
 */

/**
 * How far back a client-stamped date may reach: the same seven business days the
 * branch-facing lists already read back over, so a date the app can still show
 * is a date it can still sync.
 */
const MAX_BACKDATE_DAYS = 6; // inclusive of today → 7 business days

export async function resolveClientBusinessDate(
  claimed: string | undefined,
  role: UserRole,
  now: Date = new Date(),
): Promise<string> {
  const today = businessDateStr(now);

  if (!claimed || claimed === today) {
    await assertBusinessDayOpen(today, role);
    return today;
  }

  // Plain string comparison is sound for 'YYYY-MM-DD' and keeps this away from
  // Date parsing, which would drag a timezone offset into a value that has no
  // time of day. The format itself is already validated by the Zod schema.
  if (claimed > today) {
    throw Object.assign(
      new Error('This transaction is dated in the future. Check the date and time on the device.'),
      { status: 400 },
    );
  }

  const earliest = businessDaysAgoStr(MAX_BACKDATE_DAYS, now);
  if (claimed < earliest) {
    throw Object.assign(
      new Error(`This transaction is dated ${claimed}, which is older than the ${MAX_BACKDATE_DAYS + 1}-day sync window. It has to be entered by hand.`),
      { status: 400 },
    );
  }

  await assertBusinessDayOpen(claimed, role);
  return claimed;
}
