import { supabaseAdmin } from '../config/supabase';

/**
 * Notification helper.
 *
 * `notify()` writes a row to the `notifications` table — the in-app notification
 * feed. It is the single entry point every mutation uses to raise a notification.
 *
 * ─── Web push is currently NOT delivered ──────────────────────────────────────
 * The old implementation fanned out via Firebase Cloud Messaging, reading device
 * tokens from the `fcmTokens` Firestore collection. Firebase was removed
 * (frontend commit ae4664b) along with the FCM service worker, so there is no
 * longer any delivery channel: the `firebase-admin` messaging API is gone on this
 * side, and the browser has no worker registered to render a push on the other.
 *
 * The replacement is standard VAPID Web Push — that is what the
 * `push_subscriptions` table (endpoint / p256dh / auth, migration 07) is shaped
 * for, NOT FCM tokens. Implementing it needs a `web-push` dependency and a VAPID
 * keypair in the server env, so it is deliberately left undone rather than
 * half-built; see sendPush() below.
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
};

/**
 * TODO(push): deliver via VAPID Web Push.
 *
 * Sketch, for whoever picks this up: add `web-push`, set VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY / VAPID_SUBJECT in the server env, then select from
 * `push_subscriptions` by role and/or user_id, and sendNotification() to each
 * {endpoint, keys:{p256dh, auth}}. Delete rows on a 404/410 response — those are
 * the Web Push equivalent of the FCM invalid-token codes the old code pruned.
 *
 * Must stay fire-and-forget: a delivery failure never fails the mutation that
 * raised the notification.
 */
function sendPush(_input: NotifyInput, _notificationId: string): void {
  // Intentionally a no-op. See the module comment above.
}

/**
 * Write a notification row. Returns { id } — callers that need to reference the
 * created notification use `.id`, matching the old Firestore DocumentReference.
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
  const { data, error } = await supabaseAdmin
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
