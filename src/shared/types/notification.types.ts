/**
 * Must stay in lockstep with the Postgres `notification_type` enum — that enum is
 * the authority, and `notifications.type` is `not null` against it, so a value
 * missing there fails the insert with a raw 22P02. The enum is declared in
 * migration 01 and extended by 14 (`password_reset`), 25 (the two `support_*`),
 * 42 (the six `event_*`), 72 (`production_demand_cancelled`) and 92 (the two
 * `branch_discount*`) and 119 (the two `cash_transfer*`).
 *
 * Note `notify()` takes `type: string`, not this union (services/push.service.ts) —
 * nothing mechanically enforces the match, so add values in BOTH places.
 */
export type NotificationType =
  | 'order_created'
  | 'order_ready'
  | 'order_cancelled'
  | 'low_stock'
  | 'new_user'
  | 'branch_added'
  | 'price_changed'
  | 'password_reset' // migration 14 — admin reset a user's password → that user
  // Production module
  | 'production_demand' // branch submitted a new production demand → Production
  | 'production_reviewed' // Production approved/rejected a demand → branch
  | 'production_return' // a product return was raised, or reviewed by production
  | 'production_order_verified' // branch verified physical receipt of a demand → Production
  | 'production_demand_cancelled' // branch deleted a still-pending demand → Production (migration 72)
  // Branch discount claims (migration 92) — money asked for against a demand.
  // Two values where returns make do with one, because the two directions have
  // different audiences: a claim raised goes to Production, a claim decided goes
  // back to the branch.
  | 'branch_discount' // a branch raised a discount claim → Production
  | 'branch_discount_reviewed' // Production approved/rejected/sent it back → branch
  // Cash transfers (migration 119) — money a branch handed to the company.
  | 'cash_transfer' // a branch recorded a handover → Finance
  | 'cash_transfer_reviewed' // Finance approved/rejected it → branch
  // WhatsApp Purchasing (migration 20261020000002).
  | 'purchase_quotation' // a supplier sent a quotation → Production
  | 'purchase_bill' // a supplier sent a bill → Production
  | 'purchase_message' // a supplier wrote on WhatsApp (matched or not) → Production
  | 'purchase_payment' // Production recorded a supplier payment or credit → Finance
  | 'purchase_payment_reviewed' // Finance approved/rejected/reversed it → Production
  // Help Desk → Support Center queries (migration 25)
  | 'support_query' // a branch/production user raised a query → Admin
  | 'support_resolved' // Admin resolved/rejected or corrected the figures → raiser
  // Finance Help Desk queries (migration 60) — a separate queue from the two above.
  //
  // The TARGET of the first one changed in migration 94: a query now goes
  // straight to the ADMIN, never to a Finance Admin first (§3 of the Help Desk
  // brief). The value is unchanged because the notifications already delivered
  // under it mean the same thing — "somebody raised a finance query" — and
  // renaming an enum value would orphan every row carrying the old one.
  | 'finance_query' // a Finance user raised a query → Admin
  | 'finance_query_resolved' // Admin resolved/rejected/closed it → raiser
  | 'finance_query_updated' // Admin moved it along (under review, needs info) → raiser
  | 'finance_query_message' // either side added to the conversation → the other side
  | 'finance_query_amended' // Admin changed or deleted the record behind it → raiser
  // Special Events (migration 42)
  | 'event_created' // a new event was published → branches + Production
  | 'event_reminder' // a scheduled countdown reminder fired → branch or Production
  | 'event_demand_due' // the branch demand deadline is tomorrow → branch
  | 'event_demand_submitted' // a branch submitted its advance demand → Production
  | 'event_demand_reviewed' // Production/Admin approved or rejected a demand → branch
  | 'event_production_updated' // a preparation stage moved → Admin
  // Session security (migration 97/98)
  | 'security_alert'; // a sign-in tripped the suspicion detector → Admin

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
