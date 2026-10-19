export type AuditAction =
  | 'password_reset'
  | 'password_changed'
  | 'user_created'
  | 'user_updated'
  | 'user_activated'
  | 'user_deactivated'
  // Permanent removal (migration 124). The row is gone, so target_user_id is
  // null; name and role are kept on the log row and `details` names email + id.
  | 'user_deleted'
  // Geofencing (migration 48). These are the first entries that target something
  // other than a user, which is why they carry no target_user_id — the affected
  // subject is named in `details` instead. Worth auditing because widening a
  // branch's radius, or deleting its location outright, silently removes the
  // restriction on where that branch may sell from.
  | 'branch_location_updated'
  | 'branch_location_removed'
  // Session security (migration 98). The first entries that record an admin
  // acting ON somebody's session rather than on their account. Both target a
  // user, so `target_user_id` is populated; `details` names the device, the
  // resolved location and the admin's stated reason, because "revoked a session"
  // without which session is not an audit trail.
  //
  // There is deliberately NO 'login' or 'logout' action here. Every sign-in and
  // sign-out already writes a `login_sessions` row carrying strictly more than
  // an audit line could — IP, device, location, duration — and duplicating them
  // into audit_logs would double the busiest write in the app to say less.
  | 'session_revoked'
  | 'all_sessions_revoked'
  | 'suspicious_login'
  // Migration 99. The only READ in this list, and the only one written by an
  // action that changes nothing — which is exactly why it is here. The session
  // detail view is where an admin sees another person's activated email address,
  // IP address and resolved location; that is the most sensitive thing this app
  // shows anybody, and "who looked at whose session, and when" is a question the
  // audit trail has to be able to answer about the admins themselves.
  //
  // Written ONLY for a super admin opening SOMEBODY ELSE'S session. An admin
  // opening their own would fill the log with rows about a person reading their
  // own record, which is not a privileged act and would bury the ones that are.
  | 'session_viewed'
  // Branch returns (migration 20261020000001). Written by the branch user who
  // raised or corrected the return, targeting no user: `details` names the
  // branch, and every line's return id, product, qty and PHOTO id — the photo is
  // the evidence Production decides on, so which picture stood behind which line
  // is what this entry exists to pin down.
  | 'return_created'
  | 'return_revised';

export interface AuditLog {
  id: string;
  action: AuditAction;
  adminId: string;
  adminName: string;
  targetUserId: string | null;
  targetUserName: string | null;
  targetUserRole: string | null;
  details: string | null;
  createdAt: string;
}
