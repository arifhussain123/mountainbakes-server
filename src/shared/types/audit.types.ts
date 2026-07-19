export type AuditAction =
  | 'password_reset'
  | 'password_changed'
  | 'user_created'
  | 'user_updated'
  | 'user_activated'
  | 'user_deactivated';

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
