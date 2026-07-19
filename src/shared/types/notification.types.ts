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
  | 'production_return'; // a product return was recorded/accepted

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
