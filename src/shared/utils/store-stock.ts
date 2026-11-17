/**
 * The single definition of an item's stock state, shared by server and web so
 * the Dashboard KPIs and the Store Stock filter can never disagree again
 * (inventory upgrade, Phase 1 · problem 1). Out-of-stock is its own state but
 * still counts as "needs reorder" — the dashboard shows it in a separate card,
 * so "Low" there means *low but not zero*, and the Stock filter is labelled to
 * match.
 *
 * This file is duplicated in mountainbakes-frontend/src/shared/utils — keep both
 * copies identical.
 */

export type StoreStockStatus = 'inactive' | 'out' | 'low' | 'ok';

export interface StoreStockInput {
  /** 'active' | 'inactive'; anything other than 'active' reads as inactive. */
  status?: string | null;
  availableQty: number;
  minStock: number;
}

/** Out and low both sit at or under the reorder level; `ok` is above it. */
export function storeStockStatus(i: StoreStockInput): StoreStockStatus {
  if ((i.status ?? 'active') !== 'active') return 'inactive';
  if (i.availableQty <= 0) return 'out';
  if (i.availableQty <= i.minStock) return 'low';
  return 'ok';
}

/** True when an active item is at or below its reorder level (low OR out). */
export function needsReorder(i: StoreStockInput): boolean {
  const s = storeStockStatus(i);
  return s === 'low' || s === 'out';
}

export const STORE_STOCK_STATUS_LABEL: Record<StoreStockStatus, string> = {
  inactive: 'Inactive',
  out: 'Out of stock',
  low: 'Low',
  ok: 'OK',
};

/**
 * The shared status-colour language (prompt §10) as semantic tone keys that the
 * web `Pill` and the mobile app both map to their own palettes:
 *   ok/received/issued            → green
 *   low/partial/pending/near      → amber
 *   out/rejected/expired/past_due → red
 *   approved/committed/on_order   → blue
 *   draft/inactive                → grey (muted)
 */
export type StoreStatusTone = 'green' | 'amber' | 'red' | 'blue' | 'muted';

export const STORE_STATUS_TONE: Record<string, StoreStatusTone> = {
  // stock
  ok: 'green',
  low: 'amber',
  out: 'red',
  inactive: 'muted',
  // expiry
  near_expiry: 'amber',
  expired: 'red',
  // demand / issue / line
  pending: 'amber',
  partial: 'amber',
  approved: 'blue',
  committed: 'blue',
  issued: 'green',
  received: 'green',
  rejected: 'red',
  cancelled: 'muted',
  // document lifecycle (POs, transfers, counts — used from later phases)
  draft: 'muted',
  sent: 'blue',
  on_order: 'blue',
  past_due: 'red',
};

export const STORE_STOCK_STATUS_TONE: Record<StoreStockStatus, StoreStatusTone> = {
  inactive: 'muted',
  out: 'red',
  low: 'amber',
  ok: 'green',
};
