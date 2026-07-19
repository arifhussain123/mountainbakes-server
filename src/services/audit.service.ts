import { supabaseAdmin } from '../config/supabase';
import type { AuditAction } from '../shared';

export interface AuditInput {
  action: AuditAction;
  adminId: string;
  adminName: string;
  targetUserId?: string | null;
  targetUserName?: string | null;
  targetUserRole?: string | null;
  details?: string | null;
}

/**
 * Append a row to `audit_logs`. Never throws — an audit-write failure must not
 * break the action that triggered it (it is logged instead). supabase-js returns
 * errors rather than throwing, so the result is checked explicitly; the try/catch
 * remains for transport-level failures.
 *
 * created_at is left to the column default (now()) instead of being sent from the
 * app clock, so ordering is consistent with every other table.
 */
export async function logAudit(input: AuditInput): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('audit_logs').insert({
      action: input.action,
      admin_id: input.adminId,
      admin_name: input.adminName,
      target_user_id: input.targetUserId ?? null,
      target_user_name: input.targetUserName ?? null,
      target_user_role: input.targetUserRole ?? null,
      details: input.details ?? null,
    });
    if (error) console.error('[audit] failed to write audit log', error);
  } catch (err) {
    console.error('[audit] failed to write audit log', err);
  }
}

/** Resolve an admin's display name from their user row, falling back to email. */
export async function resolveAdminName(uid: string, email: string): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('display_name')
      .eq('id', uid)
      .maybeSingle();
    if (error) return email;
    return data?.display_name || email;
  } catch {
    return email;
  }
}
