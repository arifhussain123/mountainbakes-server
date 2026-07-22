export type NotificationType =
  | 'order_created'
  | 'order_ready'
  | 'order_cancelled'
  | 'low_stock'
  | 'new_user'
  | 'branch_added'
  | 'price_changed'
  // Production module
  | 'production_demand' // branch submitted a new production demand → Production
  | 'production_reviewed' // Production approved/rejected a demand → branch
  | 'production_return' // a product return was recorded/accepted
  // Support / Query tickets
  | 'ticket_created' // a user opened a support ticket → Admin
  | 'ticket_replied' // a new reply was posted → the other party
  | 'ticket_resolved' // Admin resolved a ticket → creator
  | 'ticket_reopened' // a resolved ticket was reopened → Admin
  | 'ticket_status_changed'; // Admin changed a ticket's status → creator

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  targetUserId: string | null;
  targetRole: string | null;
  branchId: string | null;
  relatedId: string | null;
  createdAt: string;
}
