import { adminDb, admin } from '../config/firebase';

/**
 * Firebase Cloud Messaging + notification helper.
 *
 * `notify()` writes the Firestore notification document (unchanged in-app
 * behaviour) AND fans out a web-push message to every device token registered
 * for the target role / user. Push is fire-and-forget: a messaging failure
 * never breaks the originating request.
 *
 * Messages are DATA-ONLY on purpose — the web service worker
 * (public/firebase-messaging-sw.js) renders the notification, which avoids the
 * duplicate-notification problem you get when a `notification` payload is also
 * present.
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

// Deep-link a notification tap to the most relevant screen.
const TYPE_URL: Record<string, string> = {
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

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

async function tokensFor(input: NotifyInput): Promise<string[]> {
  const col = adminDb.collection('fcmTokens');
  const queries: Promise<FirebaseFirestore.QuerySnapshot>[] = [];
  if (input.targetRole) queries.push(col.where('role', '==', input.targetRole).get());
  if (input.targetUserId) queries.push(col.where('uid', '==', input.targetUserId).get());
  if (queries.length === 0) return [];

  const snaps = await Promise.all(queries);
  const tokens = new Set<string>();
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const t = (doc.data() as { token?: string }).token || doc.id;
      if (t) tokens.add(t);
    }
  }
  return [...tokens];
}

async function sendPush(input: NotifyInput, notificationId: string): Promise<void> {
  const tokens = await tokensFor(input);
  if (tokens.length === 0) return;

  const data: Record<string, string> = {
    title: input.title,
    body: input.message,
    url: TYPE_URL[input.type] || '/',
    type: input.type,
    notificationId,
  };
  if (input.relatedId) data.relatedId = input.relatedId;

  // sendEachForMulticast handles up to 500 tokens per call.
  const batches: string[][] = [];
  for (let i = 0; i < tokens.length; i += 500) batches.push(tokens.slice(i, i + 500));

  for (const batch of batches) {
    const res = await admin.messaging().sendEachForMulticast({ tokens: batch, data });
    // Prune tokens that are no longer valid so the collection stays clean.
    await Promise.all(
      res.responses.map((r, i) => {
        if (r.success) return null;
        const code = r.error?.code;
        if (code && INVALID_TOKEN_CODES.has(code)) {
          return adminDb.collection('fcmTokens').doc(batch[i]!).delete().catch(() => undefined);
        }
        return null;
      }),
    );
  }
}

/**
 * Write a notification document and push it to registered devices.
 * Returns the created document reference (same as the old raw `.add()`).
 */
export async function notify(input: NotifyInput) {
  const now = new Date().toISOString();
  const ref = await adminDb.collection('notifications').add({
    type: input.type,
    title: input.title,
    message: input.message,
    isRead: false,
    targetUserId: input.targetUserId ?? null,
    targetRole: input.targetRole ?? null,
    branchId: input.branchId ?? null,
    relatedId: input.relatedId ?? null,
    createdAt: now,
  });

  // Fire-and-forget: never let a push error fail the mutation.
  void sendPush(input, ref.id).catch((err) =>
    console.error('[push] failed to send notification', err),
  );

  return ref;
}
