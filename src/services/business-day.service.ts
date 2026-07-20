import { supabaseAdmin } from '../config/supabase';

/**
 * Business-day closure state.
 *
 * This lives in its own module rather than in daily-closing.service.ts on
 * purpose: `assertBusinessDayOpen` (and therefore every branch-facing write path)
 * needs only this one read, while daily-closing.service.ts is a much larger
 * module still on Firestore. Importing that one to get this would drag the
 * unported Firestore dependency into the load graph and take the process down.
 *
 * When daily-closing.service.ts is ported it should import from here rather than
 * redefining the check — "is this day closed?" must have exactly one definition,
 * or a back-dated write could be accepted by one path and refused by the other.
 */

/**
 * True once `businessDate` has been successfully closed (locked).
 *
 * Only a 'success' closure counts. A 'running' row means a close is in flight and
 * a 'failed' one means it did not complete — in both cases the day is still open,
 * which matches the Firestore behaviour of checking `status === 'success'`.
 */
export async function isBusinessDayClosed(businessDate: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('business_day_closures')
    .select('status')
    .eq('business_date', businessDate)
    .maybeSingle();
  if (error) throw error;
  return data?.status === 'success';
}
