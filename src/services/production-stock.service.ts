import { adminDb } from '../config/firebase';
import {
  businessDateStr,
  type ProductionStockMovementType,
  type ProductionStockRow,
} from '../shared';

/**
 * Central Production Stock pool (no cron). Mirrors the derived-stock approach in
 * `stock.service.ts` but for a single, branch-agnostic pool: running balance per
 * productId in `production_stock`, every movement appended to
 * `production_stock_history`.
 *
 * Each movement is its own transaction (read balance -> write balance + history).
 * Idempotency uses a deterministic history id `${refId}_${productId}_${type}`, so
 * a retry that reuses the same refId is a no-op. Negative balances are allowed
 * (flagged in the UI, never blocked) — matching the branch-stock philosophy.
 */

interface ProductionMovementInput {
  productId: string;
  productName: string;
  delta: number; // signed
  type: ProductionStockMovementType;
  refId: string;
}

export async function applyProductionStockMovement(input: ProductionMovementInput): Promise<void> {
  const { productId, productName, delta, type, refId } = input;
  const stockRef = adminDb.collection('production_stock').doc(productId);
  const historyRef = adminDb.collection('production_stock_history').doc(`${refId}_${productId}_${type}`);

  await adminDb.runTransaction(async (tx) => {
    const [stockSnap, historySnap] = await Promise.all([tx.get(stockRef), tx.get(historyRef)]);
    if (historySnap.exists) return; // already applied — idempotent no-op

    const current = stockSnap.exists ? Number(stockSnap.data()!['balance'] ?? 0) : 0;
    const balanceAfter = current + delta;
    const now = new Date().toISOString();

    tx.set(stockRef, { productId, productName, balance: balanceAfter, updatedAt: now }, { merge: true });
    tx.set(historyRef, {
      productId,
      productName,
      type,
      delta,
      balanceAfter,
      refId,
      date: businessDateStr(),
      createdAt: now,
    });
  });
}

/** Record "Today's Prepared Products" — each qty is positive; adds to the pool. */
export function prepareProducts(
  refId: string,
  items: { productId: string; productName: string; qty: number }[],
): Promise<void[]> {
  return Promise.all(
    items.map((i) =>
      applyProductionStockMovement({
        productId: i.productId,
        productName: i.productName,
        delta: Math.abs(i.qty),
        type: 'prepare',
        refId,
      }),
    ),
  );
}

/** On demand approval, move approved units OUT of the pool (recorded as a negative delta). */
export function transferOutOnApproval(
  orderId: string,
  items: { productId: string; productName: string; qty: number }[],
): Promise<void[]> {
  return Promise.all(
    items
      .filter((i) => i.qty > 0)
      .map((i) =>
        applyProductionStockMovement({
          productId: i.productId,
          productName: i.productName,
          delta: -Math.abs(i.qty),
          type: 'transfer_out',
          refId: orderId,
        }),
      ),
  );
}

/** On an accepted return, add units BACK into the pool. */
export function returnIntoPool(
  returnId: string,
  item: { productId: string; productName: string; qty: number },
): Promise<void> {
  return applyProductionStockMovement({
    productId: item.productId,
    productName: item.productName,
    delta: Math.abs(item.qty),
    type: 'return_in',
    refId: returnId,
  });
}

/**
 * Build the Production Stock table for a Karachi day: current pool balance per
 * product plus today's prepared / transferred-out / returned totals.
 * `totalStock` is the gross available for the day (balance + what was moved out).
 */
export async function getProductionStockRows(date: string = businessDateStr()): Promise<ProductionStockRow[]> {
  const [stockSnap, historySnap] = await Promise.all([
    adminDb.collection('production_stock').get(),
    adminDb.collection('production_stock_history').where('date', '==', date).get(),
  ]);

  // Base rows from current balances.
  const rows = new Map<string, ProductionStockRow>();
  for (const doc of stockSnap.docs) {
    const d = doc.data() as { productId: string; productName: string; balance: number };
    rows.set(d.productId, {
      productId: d.productId,
      productName: d.productName,
      preparedToday: 0,
      totalStock: 0,
      approvedQty: 0,
      balance: Number(d.balance ?? 0),
      returned: 0,
    });
  }

  // Fold today's movements in.
  for (const doc of historySnap.docs) {
    const h = doc.data() as { productId: string; productName: string; type: ProductionStockMovementType; delta: number };
    let row = rows.get(h.productId);
    if (!row) {
      // A product with movement today but no balance doc yet (net zero) — still show it.
      row = { productId: h.productId, productName: h.productName, preparedToday: 0, totalStock: 0, approvedQty: 0, balance: 0, returned: 0 };
      rows.set(h.productId, row);
    }
    if (h.type === 'prepare') row.preparedToday += Math.abs(h.delta);
    else if (h.type === 'transfer_out') row.approvedQty += Math.abs(h.delta);
    else if (h.type === 'return_in') row.returned += Math.abs(h.delta);
  }

  // totalStock = what's on hand now + what already left today.
  for (const row of rows.values()) row.totalStock = row.balance + row.approvedQty;

  return [...rows.values()].sort((a, b) => a.productName.localeCompare(b.productName));
}
