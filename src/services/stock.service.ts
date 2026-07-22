import { supabaseAdmin } from '../config/supabase';
import { businessDateStr, type StockMovementType, type StockRow } from '../shared';

/**
 * Derived stock tracking (no cron). We keep a running balance per
 * (branch_id, product_id) in `stock` and append every movement to `stock_history`.
 * The Stock page reconstructs Opening/New/Sold/Balance from these on read.
 *
 * ─── Where the transactions live ─────────────────────────────────────────────
 * The read-validate-write cores are Postgres functions (migration 12), called via
 * .rpc(). PostgREST gives every call its own transaction, so validate-then-write
 * split across two supabase-js calls could not hold `select ... for update`
 * between them — which is exactly the multi-cashier race the SQL-function
 * transaction exists to close.
 *
 * Idempotency is the UNIQUE (ref_id, product_id, type) on stock_history: a retry
 * that reuses the same refId is a true no-op. Negative balances remain allowed
 * (oversell is flagged in the UI, never blocked) EXCEPT on the sale and
 * branch-return paths, which reject overdrawing.
 *
 * See migration 04's header — it is the authority on both invariants.
 */

interface MovementInput {
  branchId: string;
  productId: string;
  productName: string;
  delta: number; // signed
  type: StockMovementType;
  refId: string;
}

/** Apply one signed movement. Returns the post-movement balance. */
export async function applyStockMovement(input: MovementInput): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('apply_stock_movement', {
    p_branch_id: input.branchId,
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

/**
 * Reconstruct the per-product Opening/New/Sold/Returned/Balance rows for a branch
 * on a given business date. Opening = current balance − the day's net movements,
 * matching the derived-stock model. Shared by the Stock page and the daily-closing
 * snapshot so they can never diverge.
 */
export async function computeStockRows(branchId: string, date: string = businessDateStr()): Promise<StockRow[]> {
  // The date filter is a real indexed predicate now
  // (stock_history_branch_date_idx), rather than fetching a branch's entire
  // history and filtering in memory.
  const [products, stock, history] = await Promise.all([
    supabaseAdmin.from('products').select('id, name, stock_code').eq('is_active', true),
    supabaseAdmin.from('stock').select('product_id, balance').eq('branch_id', branchId),
    supabaseAdmin
      .from('stock_history')
      .select('product_id, type, delta')
      .eq('branch_id', branchId)
      .eq('business_date', date),
  ]);
  if (products.error) throw products.error;
  if (stock.error) throw stock.error;
  if (history.error) throw history.error;

  const balanceByProduct = new Map<string, number>();
  for (const s of (stock.data ?? []) as { product_id: string; balance: number | string }[]) {
    balanceByProduct.set(s.product_id, Number(s.balance ?? 0));
  }

  const net = new Map<string, number>();
  const newQty = new Map<string, number>();
  const sold = new Map<string, number>();
  const returned = new Map<string, number>();
  for (const h of (history.data ?? []) as { product_id: string; type: string; delta: number | string }[]) {
    const delta = Number(h.delta ?? 0);
    net.set(h.product_id, (net.get(h.product_id) ?? 0) + delta);
    if (h.type === 'production') newQty.set(h.product_id, (newQty.get(h.product_id) ?? 0) + delta);
    // Sold and returned are stored as negative deltas; report them positive.
    if (h.type === 'sale') sold.set(h.product_id, (sold.get(h.product_id) ?? 0) - delta);
    if (h.type === 'return') returned.set(h.product_id, (returned.get(h.product_id) ?? 0) - delta);
  }

  return ((products.data ?? []) as { id: string; name: string; stock_code: string }[])
    .map((p) => {
      const balance = balanceByProduct.get(p.id) ?? 0;
      return {
        productId: p.id,
        productName: p.name,
        stockCode: p.stock_code,
        opening: balance - (net.get(p.id) ?? 0), // balance at start of the business day
        newQty: newQty.get(p.id) ?? 0,
        sold: sold.get(p.id) ?? 0,
        returned: returned.get(p.id) ?? 0,
        balance,
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

/** Retail sale removes stock. `qty` is positive; recorded as a negative delta. */
export function applySaleToStock(i: { branchId: string; productId: string; productName: string; qty: number; refId: string }) {
  return applyStockMovement({ ...i, delta: -Math.abs(i.qty), type: 'sale' });
}

/** Approved production adds stock. `qty` is positive; recorded as a positive delta. */
export function applyProductionToStock(i: { branchId: string; productId: string; productName: string; qty: number; refId: string }) {
  return applyStockMovement({ ...i, delta: Math.abs(i.qty), type: 'production' });
}

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

/** Thrown by the validated paths when a product lacks stock. No writes happen. */
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
 * Branch-initiated return: validate + decrement in ONE transaction. The balance is
 * re-read under a row lock and the return is refused (InsufficientStockError) if it
 * exceeds the available balance — so a return can never drive a branch negative.
 */
export async function commitBranchReturn(params: {
  branchId: string;
  productId: string;
  productName: string;
  qty: number;
  refId: string;
}): Promise<{ before: number; after: number }> {
  const { data, error } = await supabaseAdmin.rpc('commit_branch_return', {
    p_branch_id: params.branchId,
    p_product_id: params.productId,
    p_product_name: params.productName,
    p_qty: params.qty,
    p_ref_id: params.refId,
    p_business_date: businessDateStr(),
  });
  if (error) throw error;

  const result = data as
    | { status: 'ok'; before: number; after: number }
    | { status: 'insufficient'; requested: number; available: number };

  if (result.status === 'insufficient') {
    throw new InsufficientStockError([
      {
        productId: params.productId,
        productName: params.productName,
        requested: Number(result.requested),
        available: Number(result.available),
      },
    ]);
  }

  return { before: Number(result.before), after: Number(result.after) };
}

/** An order line as persisted to order_items. */
export interface SaleItem {
  productId: string;
  productName: string;
  categoryId?: string | null;
  categoryName?: string | null;
  unitPrice: number;
  qty: number;
  discount?: number;
  lineTotal: number;
}

/**
 * Atomically validate stock, write the order + its line items, decrement branch
 * balances and append `stock_history` — all inside ONE transaction (migration 12's
 * commit_sale). This closes the multi-user race: two cashiers selling the last
 * units can't both succeed, because every stock row is locked (in product_id
 * order, to avoid deadlock between overlapping orders) before validation.
 *
 * Duplicate product lines are kept verbatim in order_items but aggregated for
 * stock — one balance write and one ledger row per product.
 *
 * Throws `InsufficientStockError` with nothing persisted if validation fails.
 *
 * NOTE: the caller does not supply the id — Postgres generates the order id, so
 * it is returned instead.
 */
export async function commitSaleTransaction(params: {
  order: Record<string, unknown>;
  items: SaleItem[];
  branchId: string;
}): Promise<{ orderId: string; balances: Map<string, SaleBalance> }> {
  const { data, error } = await supabaseAdmin.rpc('commit_sale', {
    p_order: params.order,
    p_items: params.items,
    p_branch_id: params.branchId,
    p_business_date: businessDateStr(),
  });
  if (error) throw error;

  const result = data as
    | { status: 'ok'; orderId: string; balances: Record<string, { productName: string; before: number; after: number }> }
    | { status: 'insufficient'; shortfalls: StockShortfall[] };

  if (result.status === 'insufficient') {
    throw new InsufficientStockError(
      result.shortfalls.map((s) => ({
        productId: s.productId,
        productName: s.productName,
        requested: Number(s.requested),
        available: Number(s.available),
      })),
    );
  }

  const balances = new Map<string, SaleBalance>();
  for (const [productId, b] of Object.entries(result.balances ?? {})) {
    balances.set(productId, {
      productName: b.productName,
      before: Number(b.before),
      after: Number(b.after),
    });
  }
  return { orderId: result.orderId, balances };
}

/** Persist a blocked-sale audit trail (one row per offending product). Best-effort. */
export async function logBlockedSale(input: {
  branchId: string;
  branchName: string;
  userId: string;
  userName: string;
  shortfalls: StockShortfall[];
}): Promise<void> {
  if (input.shortfalls.length === 0) return;

  // Written outside the failed sale's transaction on purpose (migration 04): the
  // sale rolls back, this must not.
  const { error } = await supabaseAdmin.from('stock_audit_log').insert(
    input.shortfalls.map((s) => ({
      branch_id: input.branchId,
      branch_name: input.branchName,
      user_id: input.userId,
      user_name: input.userName,
      product_id: s.productId,
      product_name: s.productName,
      requested_qty: s.requested,
      available_qty: s.available,
      reason: s.available <= 0 ? 'Out of Stock' : 'Insufficient Stock',
      business_date: businessDateStr(),
    })),
  );
  if (error) throw error;
}
