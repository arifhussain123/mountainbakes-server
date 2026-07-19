import { adminDb } from '../config/firebase';

export async function generateOrderNumber(): Promise<string> {
  const counterRef = adminDb.collection('counters').doc('orders');

  return adminDb.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const current: number = doc.exists ? (doc.data()!['count'] as number) : 124;
    const next = current + 1;
    tx.set(counterRef, { count: next });
    return `MB-${String(next).padStart(6, '0')}`;
  });
}
