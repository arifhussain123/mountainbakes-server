import { supabaseAdmin } from '../config/supabase';

/**
 * Compute the next candidate support-ticket number for a business day
 * ("MBQ-20260722-000001", ...) by reading the current maximum for that day and
 * adding one. The counter resets per business day.
 *
 * This is done in application code (rather than a Postgres function) so the
 * feature needs only the ticket tables — no extra DDL. It is NOT atomic on its
 * own: two concurrent creates can compute the same number, so the caller must
 * insert inside a retry loop and re-peek on a unique-violation (support_tickets
 * .ticket_no is UNIQUE, which makes the collision a hard error, never a dup).
 * At this app's ticket volume (one dyno, low rate) a collision is rare and the
 * retry resolves it.
 *
 * `businessDate` must come from the app (businessDateStr(), 02:00 Karachi
 * rollover) — never the DB's now()::date.
 */
export async function peekNextTicketNumber(businessDate: string): Promise<string> {
  const yyyymmdd = businessDate.replace(/-/g, '');
  const prefix = `MBQ-${yyyymmdd}-`;

  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .select('ticket_no')
    .like('ticket_no', `${prefix}%`)
    .order('ticket_no', { ascending: false })
    .limit(1);
  if (error) throw error;

  const last = (data?.[0]?.ticket_no as string | undefined) ?? null;
  const seq = last ? Number.parseInt(last.slice(prefix.length), 10) || 0 : 0;
  return prefix + String(seq + 1).padStart(6, '0');
}
