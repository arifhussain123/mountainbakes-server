import { dbFor } from '../db';

const db = dbFor('push');

/**
 * Notification helper.
 *
 * `notify()` writes a row to the `notifications` table — the in-app notification
 * feed. It is the single entry point every mutation uses to raise a notification,
 * and it works fully.
 *
 * ─── Web push is currently NOT delivered ──────────────────────────────────────
 * Push-to-device delivery is not implemented yet. The intended mechanism is
 * standard VAPID Web Push, backed by the `push_subscriptions` table
 * (endpoint / p256dh / auth, migration 07). Turning it on needs a `web-push`
 * dependency plus a VAPID keypair in the server env, so it is deliberately left
 * as a no-op rather than half-built; see sendPush() below.
 *
 * In-app notifications work fully — only the push-to-device leg is missing.
 */

export interface NotifyInput {
  type: string;
  title: string;
  message: string;
  targetUserId?: string | null;
  targetRole?: string | null;
  branchId?: string | null;
  relatedId?: string | null;
}

/**
 * Deep-link a notification tap to the most relevant screen. Unused until push is
 * reimplemented, but kept here so the mapping doesn't have to be rediscovered —
 * the keys match the `notification_type` enum (migration 01).
 */
export const TYPE_URL: Record<string, string> = {
  order_created: '/production-queue',
  order_ready: '/orders',
  order_cancelled: '/orders',
  low_stock: '/products',
  new_user: '/users',
  branch_added: '/branches',
  price_changed: '/products',
  // Production module
  production_demand: '/production-orders',
  production_reviewed: '/branch-new-orders',
  production_return: '/production-returns',
  // Role-blind, like the event entries below: 'branch_discount' is only ever
  // seen by Production and 'branch_discount_reviewed' only by the branch, so
  // these two happen to be unambiguous where the event ones are not.
  branch_discount: '/production-discounts',
  branch_discount_reviewed: '/branch-new-orders',
  // Cash transfers (migration 119). Same role-blindness as the discount pair
  // and equally unambiguous: 'cash_transfer' is only ever seen by Finance,
  // 'cash_transfer_reviewed' only by the branch.
  cash_transfer: '/finance-cash-transfers',
  cash_transfer_reviewed: '/branch-cash-transfers',
  purchase_quotation: '/production-whatsapp',
  purchase_bill: '/production-whatsapp',
  purchase_message: '/production-whatsapp',
  purchase_payment: '/finance-supplier-payments',
  purchase_payment_reviewed: '/production-whatsapp',
  // Special Events. NOTE this map is role-blind — the admin, branch and
  // production event screens live at three different paths, so these entries can
  // only ever be right for one role. Whoever reimplements push has to key the
  // lookup on the recipient's role before using them.
  event_created: '/special-events',
  event_reminder: '/special-events',
  event_demand_due: '/branch-events',
  event_demand_submitted: '/production-events',
  event_demand_reviewed: '/branch-events',
  event_production_updated: '/special-events',
};

/**
 * TODO(push): deliver via VAPID Web Push.
 *
 * Sketch, for whoever picks this up: add `web-push`, set VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY / VAPID_SUBJECT in the server env, then select from
 * `push_subscriptions` by role and/or user_id, and sendNotification() to each
 * {endpoint, keys:{p256dh, auth}}. Delete rows on a 404/410 response — the
 * standard Web Push way to prune dead subscriptions.
 *
 * Must stay fire-and-forget: a delivery failure never fails the mutation that
 * raised the notification.
 */
function sendPush(_input: NotifyInput, _notificationId: string): void {
  // Intentionally a no-op. See the module comment above.
}

/**
 * Write a notification row. Returns { id } — callers that need to reference the
 * created notification use `.id`.
 *
 * Deliberately throws on a failed insert rather than swallowing: callers await
 * this inside their own try/catch and surface it via next(err), and a silently
 * dropped notification is worse than a visible failure.
 */
export async function notify(input: NotifyInput): Promise<{ id: string }> {
  // The notifications_target_present check constraint requires at least one
  // target. Fail with a clear message instead of a raw 23514 from Postgres.
  if (!input.targetUserId && !input.targetRole) {
    throw new Error('notify() requires targetUserId or targetRole');
  }

  // created_at / is_read come from column defaults — do not set them here.
  const { data, error } = await db
    .from('notifications')
    .insert({
      type: input.type,
      title: input.title,
      message: input.message,
      target_user_id: input.targetUserId ?? null,
      target_role: input.targetRole ?? null,
      branch_id: input.branchId ?? null,
      related_id: input.relatedId ?? null,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to write notification: ${error.message}`);

  sendPush(input, data.id);

  return { id: data.id };
}
