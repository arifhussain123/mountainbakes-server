import { adminDb } from '../config/firebase';
import { businessDateStr, type StockMovementType, type StockAuditLog, type StockRow } from '../shared';

/**
 * Derived stock tracking (no cron). We keep a running balance per
 * (branchId, productId) in `stock` and append every movement to `stock_history`.
 * The Stock page reconstructs Opening/New/Sold/Balance from these on read.
 *
 * Each movement runs in its own transaction (read balance -> write balance +
 * history) so the post-movement balance is recorded accurately. Idempotency is
 * enforced with a deterministic history doc id `${refId}_${productId}_${type}`:
 * a retry that reuses the same refId is a no-op. Negative balances are allowed
 * (oversell is flagged in the UI, never blocked).
 */

interface MovementInput {
  branchId: string;
  productId: string;
  productName: string;
  delta: number; // signed
  type: StockMovementType;
  refId: string;
}

export async function applyStockMovement(input: MovementInput): Promise<void> {
  const { branchId, productId, productName, delta, type, refId } = input;
  const stockRef = adminDb.collection('stock').doc(`${branchId}_${productId}`);
  const historyRef = adminDb.collection('stock_history').doc(`${refId}_${productId}_${type}`);

  await adminDb.runTransaction(async (tx) => {
    const [stockSnap, historySnap] = await Promise.all([tx.get(stockRef), tx.get(historyRef)]);
    if (historySnap.exists) return; // already applied — idempotent no-op

    const current = stockSnap.exists ? Number(stockSnap.data()!['balance'] ?? 0) : 0;
    const balanceAfter = current + delta;
    const now = new Date().toISOString();

    tx.set(stockRef, { branchId, productId, productName, balance: balanceAfter, updatedAt: now }, { merge: true });
    tx.set(historyRef, {
      branchId,
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

/**
 * Reconstruct the per-product Opening/New/Sold/Returned/Balance rows for a branch
 * on a given business date. Opening = current balance − the day's net movements,
 * matching the derived-stock model. Shared by the Stock page and the daily-closing
 * snapshot so they can never diverge.
 */
export async function computeStockRows(branchId: string, date: string = businessDateStr()): Promise<StockRow[]> {
  const [productsSnap, stockSnap, historySnap] = await Promise.all([
    adminDb.collection('products').where('isActive', '==', true).get(),
    adminDb.collection('stock').where('branchId', '==', branchId).get(),
    adminDb.collection('stock_history').where('branchId', '==', branchId).get(),
  ]);

  const balanceByProduct = new Map<string, number>();
  for (const d of stockSnap.docs) {
    const s = d.data() as { productId: string; balance: number };
    balanceByProduct.set(s.productId, Number(s.balance ?? 0));
  }

  // Aggregate the target day's movements per product.
  const netByProduct = new Map<string, number>();
  const newByProduct = new Map<string, number>();
  const soldByProduct = new Map<string, number>();
  const returnedByProduct = new Map<string, number>();
  for (const d of historySnap.docs) {
    const h = d.data() as { productId: string; type: string; delta: number; date: string };
    if (h.date !== date) continue;
    const delta = Number(h.delta ?? 0);
    netByProduct.set(h.productId, (netByProduct.get(h.productId) ?? 0) + delta);
    if (h.type === 'production') newByProduct.set(h.productId, (newByProduct.get(h.productId) ?? 0) + delta);
    if (h.type === 'sale') soldByProduct.set(h.productId, (soldByProduct.get(h.productId) ?? 0) - delta);
    if (h.type === 'return') returnedByProduct.set(h.productId, (returnedByProduct.get(h.productId) ?? 0) - delta);
  }

  return productsSnap.docs.map((d) => {
    const p = d.data() as { name: string };
    const productId = d.id;
    const balance = balanceByProduct.get(productId) ?? 0;
    const net = netByProduct.get(productId) ?? 0;
    return {
      productId,
      productName: p.name,
      opening: balance - net, // balance at start of the business day
      newQty: newByProduct.get(productId) ?? 0,
      sold: soldByProduct.get(productId) ?? 0,
      returned: returnedByProduct.get(productId) ?? 0,
      balance,
    };
  }).sort((a, b) => a.productName.localeCompare(b.productName));
}

/** Retail sale removes stock. `qty` is positive; recorded as a negative delta. */
export function applySaleToStock(i: { branchId: string; productId: string; productName: string; qty: number; refId: string }) {
  return applyStockMovement({ ...i, delta: -Math.abs(i.qty), type: 'sale' });
}

/** Approved production adds stock. `qty` is positive; recorded as a positive delta. */
export function applyProductionToStock(i: { branchId: string; productId: string; productName: string; qty: number; refId: string }) {
  return applyStockMovement({ ...i, delta: Math.abs(i.qty), type: 'production' });
}

/**
 * Branch-initiated return: validate + decrement in ONE transaction. The balance is
 * re-read inside the transaction and the return is refused (InsufficientStockError)
 * if it exceeds the available balance — so a return can never drive a branch negative.
 * Recorded as a `return` movement with a deterministic history id for idempotency.
 */
export async function commitBranchReturn(params: {
  branchId: string;
  productId: string;
  productName: string;
  qty: number;
  refId: string;
}): Promise<{ before: number; after: number }> {
  const { branchId, productId, productName, qty, refId } = params;
  const stockRef = adminDb.collection('stock').doc(`${branchId}_${productId}`);
  const historyRef = adminDb.collection('stock_history').doc(`${refId}_${productId}_return`);

  return adminDb.runTransaction(async (tx) => {
    const [stockSnap, historySnap] = await Promise.all([tx.get(stockRef), tx.get(historyRef)]);
    const before = stockSnap.exists ? Number(stockSnap.data()!['balance'] ?? 0) : 0;
    if (historySnap.exists) return { before, after: before }; // already applied — idempotent

    if (qty > before) {
      throw new InsufficientStockError([{ productId, productName, requested: qty, available: before }]);
    }

    const after = before - qty;
    const now = new Date().toISOString();
    tx.set(stockRef, { branchId, productId, productName, balance: after, updatedAt: now }, { merge: true });
    tx.set(historyRef, {
      branchId,
      productId,
      productName,
      type: 'return' satisfies StockMovementType,
      delta: -qty,
      balanceAfter: after,
      refId,
      date: businessDateStr(),
      createdAt: now,
    });
    return { before, after };
  });
}

// ---------------------------------------------------------------------------
// Transactional POS sale (validate + create order + deduct, all-or-nothing)
// ---------------------------------------------------------------------------

export interface SaleLine {
  productId: string;
  productName: string;
  qty: number; // positive units sold on this line
}

export interface StockShortfall {
  productId: string;
  productName: string;
  requested: number;
  available: number;
}

/** Thrown by `commitSaleTransaction` when any product lacks stock. No writes happen. */
export class InsufficientStockError extends Error {
  status = 409;
  constructor(public shortfalls: StockShortfall[]) {
    super('Insufficient stock');
    this.name = 'InsufficientStockError';
  }
}

/** Post-sale balances per product, with the pre-sale value, for low-stock detection. */
export interface SaleBalance {
  productName: string;
  before: number;
  after: number;
}

/**
 * Atomically validate stock, write the order document, decrement branch balances
 * and append `stock_history` — all inside ONE Firestore transaction. This closes
 * the multi-user race: two cashiers selling the last units can't both succeed,
 * because the balance is re-read inside the transaction right before the write.
 *
 * Duplicate product lines are aggregated (one balance write + one history row per
 * product), matching the existing idempotency scheme (`${orderId}_${productId}_sale`).
 * Throws `InsufficientStockError` (leaving Firestore untouched) if validation fails.
 */
export async function commitSaleTransaction(params: {
  orderRef: FirebaseFirestore.DocumentReference;
  orderData: Record<string, unknown>;
  branchId: string;
  lines: SaleLine[];
}): Promise<Map<string, SaleBalance>> {
  const { orderRef, orderData, branchId, lines } = params;

  // Aggregate requested qty per product (duplicate lines collapse to one movement).
  const requested = new Map<string, { name: string; qty: number }>();
  for (const l of lines) {
    const e = requested.get(l.productId);
    if (e) e.qty += l.qty;
    else requested.set(l.productId, { name: l.productName, qty: l.qty });
  }

  const productIds = [...requested.keys()];
  const stockRefs = productIds.map((pid) => adminDb.collection('stock').doc(`${branchId}_${pid}`));

  return adminDb.runTransaction(async (tx) => {
    // --- ALL READS FIRST (Firestore forbids a read after a write) ---
    const stockSnaps = await Promise.all(stockRefs.map((r) => tx.get(r)));

    const before = new Map<string, number>();
    const shortfalls: StockShortfall[] = [];
    productIds.forEach((pid, i) => {
      const cur = stockSnaps[i]!.exists ? Number(stockSnaps[i]!.data()!['balance'] ?? 0) : 0;
      before.set(pid, cur);
      const req = requested.get(pid)!;
      if (req.qty > cur) {
        shortfalls.push({ productId: pid, productName: req.name, requested: req.qty, available: cur });
      }
    });
    if (shortfalls.length > 0) throw new InsufficientStockError(shortfalls);

    // --- WRITES ---
    const now = new Date().toISOString();
    const date = businessDateStr();
    tx.set(orderRef, orderData);

    const balances = new Map<string, SaleBalance>();
    productIds.forEach((pid, i) => {
      const req = requested.get(pid)!;
      const start = before.get(pid)!;
      const after = start - req.qty;
      balances.set(pid, { productName: req.name, before: start, after });

      tx.set(stockRefs[i]!, { branchId, productId: pid, productName: req.name, balance: after, updatedAt: now }, { merge: true });
      const historyRef = adminDb.collection('stock_history').doc(`${orderRef.id}_${pid}_sale`);
      tx.set(historyRef, {
        branchId,
        productId: pid,
        productName: req.name,
        type: 'sale' satisfies StockMovementType,
        delta: -req.qty,
        balanceAfter: after,
        refId: orderRef.id,
        date,
        createdAt: now,
      });
    });
    return balances;
  });
}

/** Persist a blocked-sale audit trail (one doc per offending product). Best-effort. */
export async function logBlockedSale(input: {
  branchId: string;
  branchName: string;
  userId: string;
  userName: string;
  shortfalls: StockShortfall[];
}): Promise<void> {
  const now = new Date().toISOString();
  const date = businessDateStr();
  const batch = adminDb.batch();
  for (const s of input.shortfalls) {
    const ref = adminDb.collection('stock_audit_log').doc();
    const doc: Omit<StockAuditLog, 'id'> = {
      branchId: input.branchId,
      branchName: input.branchName,
      userId: input.userId,
      userName: input.userName,
      productId: s.productId,
      productName: s.productName,
      requestedQty: s.requested,
      availableQty: s.available,
      reason: s.available <= 0 ? 'Out of Stock' : 'Insufficient Stock',
      date,
      createdAt: now,
    };
    batch.set(ref, doc);
  }
  await batch.commit();
}
