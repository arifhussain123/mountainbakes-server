import { adminDb } from '../config/firebase';
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
 * Append an entry to the `auditLogs` collection. Never throws — an audit-write
 * failure must not break the action that triggered it (it is logged instead).
 */
export async function logAudit(input: AuditInput): Promise<void> {
  try {
    await adminDb.collection('auditLogs').add({
      action: input.action,
      adminId: input.adminId,
      adminName: input.adminName,
      targetUserId: input.targetUserId ?? null,
      targetUserName: input.targetUserName ?? null,
      targetUserRole: input.targetUserRole ?? null,
      details: input.details ?? null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] failed to write audit log', err);
  }
}

/** Resolve an admin's display name from their user doc, falling back to email. */
export async function resolveAdminName(uid: string, email: string): Promise<string> {
  try {
    const doc = await adminDb.collection('users').doc(uid).get();
    return (doc.data() as { displayName?: string } | undefined)?.displayName || email;
  } catch {
    return email;
  }
}
