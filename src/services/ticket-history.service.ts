import { supabaseAdmin } from '../config/supabase';

/**
 * Append one row to a ticket's audit trail (support_ticket_history, migration 19).
 * Every ticket mutation calls this — created, reply_added, priority_changed,
 * status_changed, assigned, resolved, reopened, deleted — recording who did it and
 * the before/after value.
 *
 * Best-effort by design: a failed history write is logged but never fails the
 * mutation it accompanies (the audit trail is secondary to the action itself).
 */
export async function logTicketHistory(entry: {
  ticketId: string;
  action: string;
  oldValue?: string | null;
  newValue?: string | null;
  performedBy: string | null;
  performedByName: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('support_ticket_history').insert({
    ticket_id: entry.ticketId,
    action: entry.action,
    old_value: entry.oldValue ?? null,
    new_value: entry.newValue ?? null,
    performed_by: entry.performedBy,
    performed_by_name: entry.performedByName,
  });
  if (error) console.warn(`[tickets] history write failed (${entry.action}):`, error.message);
}
