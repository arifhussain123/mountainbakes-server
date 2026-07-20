import { supabaseAdmin } from '../config/supabase';
import {
  businessDateStr,
  type ProductionStockMovementType,
  type ProductionStockRow,
} from '../shared';

/**
 * Central Production Stock pool (no cron). Mirrors the derived-stock approach in
 * `stock.service.ts` but for a single, branch-agnostic pool: running balance per
 * product_id in `production_stock`, every movement appended to
 * `production_stock_history`.
 *
 * The read-modify-write lives in apply_production_stock_movement (migration 15)
 * for the same reason as branch stock: PostgREST gives each call its own
 * transaction, so a balance read and its write cannot be made atomic from here.
 *
 * Idempotency is the UNIQUE (ref_id, product_id, type) — a retry that reuses the
 * same refId is a no-op. Negative balances are allowed (flagged in the UI, never
 * blocked), matching the branch-stock philosophy.
 */

interface ProductionMovementInput {
  productId: string;
  productName: string;
  delta: number; // signed
  type: ProductionStockMovementType;
  refId: string;
}

/** Apply one signed movement to the pool. Returns the post-movement balance. */
export async function applyProductionStockMovement(input: ProductionMovementInput): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('apply_production_stock_movement', {
    p_product_id: input.productId,
    p_product_name: input.productName,
    p_delta: input.delta,
    p_type: input.type,
    p_ref_id: input.refId,
    p_business_date: businessDateStr(),
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Record "Today's Prepared Products" — each qty is positive; adds to the pool. */
export function prepareProducts(
  refId: string,
  items: { productId: string; productName: string; qty: number }[],
): Promise<number[]> {
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
): Promise<number[]> {
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
): Promise<number> {
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
  // The date filter is an indexed predicate rather than a full-collection scan.
  const [stock, history] = await Promise.all([
    supabaseAdmin.from('production_stock').select('product_id, product_name, balance'),
    supabaseAdmin
      .from('production_stock_history')
      .select('product_id, product_name, type, delta')
      .eq('business_date', date),
  ]);
  if (stock.error) throw stock.error;
  if (history.error) throw history.error;

  // Base rows from current balances.
  const rows = new Map<string, ProductionStockRow>();
  for (const d of (stock.data ?? []) as { product_id: string; product_name: string; balance: number | string }[]) {
    rows.set(d.product_id, {
      productId: d.product_id,
      productName: d.product_name,
      preparedToday: 0,
      totalStock: 0,
      approvedQty: 0,
      balance: Number(d.balance ?? 0),
      returned: 0,
    });
  }

  // Fold today's movements in.
  for (const h of (history.data ?? []) as {
    product_id: string;
    product_name: string;
    type: ProductionStockMovementType;
    delta: number | string;
  }[]) {
    let row = rows.get(h.product_id);
    if (!row) {
      // A product with movement today but no balance row yet (net zero) — still show it.
      row = {
        productId: h.product_id,
        productName: h.product_name,
        preparedToday: 0,
        totalStock: 0,
        approvedQty: 0,
        balance: 0,
        returned: 0,
      };
      rows.set(h.product_id, row);
    }
    const delta = Math.abs(Number(h.delta ?? 0));
    if (h.type === 'prepare') row.preparedToday += delta;
    else if (h.type === 'transfer_out') row.approvedQty += delta;
    else if (h.type === 'return_in') row.returned += delta;
  }

  // totalStock = what's on hand now + what already left today.
  for (const row of rows.values()) row.totalStock = row.balance + row.approvedQty;

  return [...rows.values()].sort((a, b) => a.productName.localeCompare(b.productName));
}
