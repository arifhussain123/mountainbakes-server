import type { UserRole } from '../shared';
import { isBusinessDayClosed } from '../services/daily-closing.service';

/**
 * Throw a 403 if `businessDate` has already been closed (locked), unless the actor
 * is a Super Admin. Branch-facing writes normally target the currently-open day, so
 * this mainly guards back-dated writes and the narrow 2 AM close race.
 */
export async function assertBusinessDayOpen(businessDate: string, role: UserRole): Promise<void> {
  if (role === 'super_admin') return;
  if (await isBusinessDayClosed(businessDate)) {
    throw Object.assign(
      new Error('This business day has been closed. Please contact Admin.'),
      { status: 403 },
    );
  }
}
