import { randomUUID } from 'crypto';
import { dbFor } from '../db';
import {
  businessDateStr,
  productionStockStatus,
  type ProductionStockFigures,
  type ProductionStockMovementType,
  type ProductionStockRow,
} from '../shared';
import {
  InsufficientStockError,
  type SaleBalance,
  type SaleItem,
  type StockShortfall,
} from './stock.service';

const db = dbFor('production-stock');

/**
 * Central Production Stock pool (no cron). Mirrors the derived-stock approach in
 * `stock.service.ts` but for a single, branch-agnostic pool: every movement is
 * appended to `production_stock_history`, and the day is rebuilt from it.
 *
 * ── THE POOL IS DAY-SCOPED. THERE IS NO CARRY-FORWARD. ──────────────────────
 * `production_stock.balance` is still written — it is the ledger's own running
 * total and the source of each history row's `balance_after` — but NOTHING in
 * this module reads it any more, and no figure this module returns is derived
 * from it. `balance` is Σ delta over the whole ledger up to the date, which is
 * why it is simultaneously the day's closing figure and the next day's opening.
 *
 * That is deliberate, not an oversight. The bakery bakes fresh every morning, so
 * a running total that never resets only ever misreported today: a product whose
 * pool sat at −40 showed the 50 units made this morning as −40-and-rising, the
 * counter refused to sell stock that was physically on the shelf, and the Demand
 * Summary showed a shortfall nobody could bake away. Reading the day on its own
 * puts newly prepared stock on the positive figure it actually is.
 *
 * Stock therefore enters the pool ONE way: by being prepared (or returned into
 * it) on the day it is sold from.
 *
 * The read-modify-write lives in apply_production_stock_movement (migration 15)
 * for the same reason as branch stock: PostgREST gives each call its own
 * transaction, so a ledger read and its write cannot be made atomic from here.
 *
 * Idempotency is the UNIQUE (ref_id, product_id, type) — a retry that reuses the
 * same refId is a no-op. A negative day is allowed (flagged in the UI, never
 * blocked) for everything except a counter sale, which is a decision at the till
 * rather than a record of something that already happened — see
 * commitProductionSaleTransaction.
 */

interface ProductionMovementInput {
  productId: string;
  productName: string;
  delta: number; // signed
  type: ProductionStockMovementType;
  refId: string;
  /** Defaults to the day the request arrived; see commitBranchReturn. */
  businessDate?: string;
  /**
   * Audit fields (migration 89). All optional: the RPC defaults them to NULL, so
   * a call site that has no branch or no acting user simply omits them rather
   * than inventing one.
   */
  branchId?: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
  reason?: string | null;
}

/**
 * Apply one signed movement to the pool.
 *
 * Returns the ledger's post-movement running total. That figure is bookkeeping —
 * `balance_after` on the history row — and no caller should report it or decide
 * on it; read the day back through `getProductionStockRows` instead.
 */
export async function applyProductionStockMovement(input: ProductionMovementInput): Promise<number> {
  const { data, error } = await db.rpc('apply_production_stock_movement', {
    p_product_id: input.productId,
    p_product_name: input.productName,
    p_delta: input.delta,
    p_type: input.type,
    p_ref_id: input.refId,
    p_business_date: input.businessDate ?? businessDateStr(),
    p_branch_id: input.branchId ?? null,
    p_created_by: input.createdBy ?? null,
    p_created_by_name: input.createdByName ?? null,
    p_reason: input.reason ?? null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Record "Today's Prepared Products" — each qty is positive; ADDS to the pool.
 *
 * Additive, never a replacement: a second batch on the same day appends a second
 * movement rather than overwriting the first, which is why the form shows its
 * entries as "+5 → 30". Opening stock is untouched by construction — it is a
 * different day's arithmetic.
 */
export function prepareProducts(
  refId: string,
  items: { productId: string; productName: string; qty: number }[],
  actor?: { id?: string | null; name?: string | null },
): Promise<number[]> {
  return Promise.all(
    items.map((i) =>
      applyProductionStockMovement({
        productId: i.productId,
        productName: i.productName,
        delta: Math.abs(i.qty),
        type: 'prepare',
        refId,
        createdBy: actor?.id ?? null,
        createdByName: actor?.name ?? null,
      }),
    ),
  );
}

/**
 * Move verified units OUT of the pool (recorded as a negative delta).
 *
 * Despite the name this fires at BRANCH VERIFICATION, not at approval
 * (migration 58): stock leaves when the branch counts it in. Until then the units
 * are reserved against the demand queue but still physically on the shelf, which
 * is the outstanding `branchDemand` figure — displayed beside the balance, never
 * subtracted from it.
 *
 * `branch` is carried so the ledger can say who the goods went to — a
 * DEMAND_RELEASED row with no branch is unauditable.
 */
export function transferOutOnApproval(
  orderId: string,
  items: { productId: string; productName: string; qty: number }[],
  branch?: { id?: string | null },
  actor?: { id?: string | null; name?: string | null },
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
          branchId: branch?.id ?? null,
          createdBy: actor?.id ?? null,
          createdByName: actor?.name ?? null,
        }),
      ),
  );
}

// There is deliberately NO "return into pool" here. An accepted branch return is
// Branch Return Stock (return-stock.service.ts) and moves nothing in this pool;
// the only bridge is the explicit transfer in that module (migration 139).

/**
 * Atomically validate the pool, write the order + its line items, decrement
 * `production_stock` and append `production_stock_history` — all inside ONE
 * transaction (migration 35's commit_production_sale).
 *
 * The production-counter sibling of `commitSaleTransaction`
 * (stock.service.ts): identical parameters and return shape, but the units come
 * out of the central pool instead of a branch's `stock`. `branchId` is
 * attribution only — it lands on the order row (orders.branch_id is NOT NULL, and
 * it is what puts the sale in that branch's revenue reports) and moves no branch
 * balance.
 *
 * Unlike `applyProductionStockMovement`, this one BLOCKS rather than letting the
 * pool go negative — see the migration header for why a sale is different from a
 * prepare/transfer/return. Throws `InsufficientStockError` with nothing
 * persisted, so the route can reuse the same 409 path as the branch POS sale.
 *
 * WHAT IT BLOCKS AGAINST is the DAY's balance, not the running pool total
 * (migration 88). The `available` figure in a shortfall is therefore what today's
 * movements leave on the shelf — the same number the Production Stock page and
 * the sale form show — so a 409 can no longer disagree with either.
 */
export async function commitProductionSaleTransaction(params: {
  order: Record<string, unknown>;
  items: SaleItem[];
  branchId: string;
}): Promise<{ orderId: string; balances: Map<string, SaleBalance> }> {
  const { data, error } = await db.rpc('commit_production_sale', {
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

/**
 * The outstanding branch claim on the pool, per product.
 *
 * "Outstanding" means claimed but NOT yet off the shelf.
 *
 * ── WHICH STATUSES COUNT, AND WHY ────────────────────────────────────────────
 * The lifecycle is pending → awaiting_verification → verified → approved, and
 * stock leaves at VERIFY, not at review (migration 58):
 *
 *   · `pending`                — submitted, unreviewed. Claimed, still on the shelf.
 *   · `awaiting_verification`  — Production committed to sending it; the branch has
 *                                not counted it in. STILL on the shelf.
 *   · `verified`               — counted in, `transfer_out` written. Gone.
 *   · `approved`               — Production's closing sign-off AFTER verification.
 *                                Stock moved at the previous step; claims nothing.
 *   · `rejected` / `cancelled` — never will.
 *
 * So the outstanding pair is pending + awaiting_verification. Counting `approved`
 * would double-count every completed order: its units are already out of the
 * ledger via transfer_out, and adding them back as a claim would make a finished
 * demand permanently suppress the pool.
 *
 * Quantity per line: `qty` while pending (nobody has decided how much to send),
 * `approved_qty` once Production has decided. `?? qty` covers a row whose
 * approved_qty was never written.
 */
export async function getOutstandingDemand(): Promise<Map<string, number>> {
  const { data, error } = await db
    .from('production_orders')
    .select('status, items:production_order_items(product_id, qty, approved_qty)')
    .in('status', ['pending', 'awaiting_verification']);
  if (error) throw error;

  const out = new Map<string, number>();
  for (const o of (data ?? []) as unknown as {
    status: string;
    items: { product_id: string | null; qty: number | string; approved_qty: number | string | null }[];
  }[]) {
    for (const it of o.items ?? []) {
      if (!it.product_id) continue;
      // A reviewed order claims what Production agreed to send; a pending one
      // claims what the branch asked for, because nothing has been decided yet.
      const qty =
        o.status === 'pending' ? Number(it.qty ?? 0) : Number(it.approved_qty ?? it.qty ?? 0);
      if (!qty) continue;
      out.set(it.product_id, (out.get(it.product_id) ?? 0) + qty);
    }
  }
  return out;
}

/**
 * Build the Production Stock table for a Karachi business day.
 *
 * Returns the nine figures the page shows, per product, all folded out of
 * `production_stock_history` except the reserved half of `branchDemand` (see
 * `getOutstandingDemand`). `ProductionStockFigures` in @mb/shared carries the
 * arithmetic and the reasoning for why `branchDemand` has two halves.
 *
 * ── TWO LEDGER READS, NOT ONE ────────────────────────────────────────────────
 * `opening` is Σ delta strictly BEFORE the date; the day's figures are the
 * movements ON it. Those are different predicates over the same table, so this
 * cannot be one query — and `production_stock.balance` is no help for a past date,
 * because that column holds only the running total as of now and has no history.
 *
 * The opening read is an aggregate over potentially the whole ledger, so it asks
 * for a narrow (product_id, delta) projection rather than a row fetch: it is
 * summed and thrown away.
 *
 * ── WHICH PRODUCTS COME BACK ─────────────────────────────────────────────────
 * Anything that CARRIES a figure: a movement on the day, an outstanding demand, or
 * a non-zero opening. A product sitting at zero with nothing happening is absent
 * rather than a row of noughts — and every caller that keys a map off this reads a
 * missing product as 0, which is exactly what an omitted row means.
 */
export async function getProductionStockRows(date: string = businessDateStr()): Promise<ProductionStockRow[]> {
  // `products` is read for stock_code and category — the ledger stores neither,
  // and the page filters by category. Unfiltered on purpose: a product deactivated
  // today can still carry an opening balance and must not lose its row or its ID.
  const [products, prior, history, demand] = await Promise.all([
    db.from('products').select('id, name, stock_code, is_active, category_id, category_name'),
    db.from('production_stock_history').select('product_id, delta').lt('business_date', date),
    db
      .from('production_stock_history')
      .select('product_id, product_name, type, delta')
      .eq('business_date', date),
    getOutstandingDemand(),
  ]);
  if (products.error) throw products.error;
  if (prior.error) throw prior.error;
  if (history.error) throw history.error;

  const catalogue = (products.data ?? []) as {
    id: string; name: string; stock_code: string; is_active: boolean;
    category_id: string | null; category_name: string | null;
  }[];
  const metaById = new Map(catalogue.map((p) => [p.id, p]));

  const rows = new Map<string, ProductionStockRow>();
  const rowFor = (productId: string, fallbackName = 'Unknown product'): ProductionStockRow => {
    let r = rows.get(productId);
    if (!r) {
      const meta = metaById.get(productId);
      r = {
        productId,
        stockCode: meta?.stock_code ?? '—',
        productName: meta?.name ?? fallbackName,
        categoryId: meta?.category_id ?? null,
        categoryName: meta?.category_name ?? null,
        opening: 0,
        preparedToday: 0,
        totalStock: 0,
        branchDemand: 0,
        demandFulfilled: 0,
        soldToday: 0,
        returnTransferIn: 0,
        returned: 0,
        adjustment: 0,
        balance: 0,
        available: 0,
        status: 'out',
      };
      rows.set(productId, r);
    }
    return r;
  };

  // ── Opening: everything the ledger booked BEFORE this day ──────────────────
  // This is the previous business day's closing balance by construction. No
  // snapshot, no reset, no 2 AM job — which matters, because the node-cron
  // schedulers in this project are all commented out and a job-based
  // carry-forward would silently never run.
  for (const h of (prior.data ?? []) as { product_id: string; delta: number | string }[]) {
    rowFor(h.product_id).opening += Number(h.delta ?? 0);
  }

  // ── The day's own movements ────────────────────────────────────────────────
  // SIGNED, not Math.abs. The pool stores prepare/return_transfer positive and
  // transfer_out/sale negative, so negating the two outbound types reports them
  // positive for display. It matters for corrections: an admin lowering "Prepared"
  // appends a NEGATIVE 'prepare', and abs() would count that as more production.
  for (const h of (history.data ?? []) as {
    product_id: string; product_name: string; type: ProductionStockMovementType; delta: number | string;
  }[]) {
    const row = rowFor(h.product_id, h.product_name);
    const delta = Number(h.delta ?? 0);
    if (h.type === 'prepare') row.preparedToday += delta;
    else if (h.type === 'transfer_out') row.demandFulfilled -= delta;
    else if (h.type === 'return_transfer') row.returnTransferIn += delta;
    // Pre-migration-139 rows only: nothing writes 'return_in' any more.
    else if (h.type === 'return_in') row.returned += delta;
    else if (h.type === 'sale') row.soldToday -= delta;
    else if (h.type === 'adjustment') row.adjustment += delta;
  }

  // ── The outstanding branch claim ───────────────────────────────────────────
  // NOT date-scoped: an outstanding demand is outstanding NOW, whatever day it was
  // raised on. Applied only while the page is showing TODAY — on a closed day the
  // live queue describes no moment that day ever had, and a shortage chip against
  // last Tuesday would be meaningless.
  if (date === businessDateStr()) {
    for (const [productId, qty] of demand) {
      if (qty) rowFor(productId).branchDemand += qty;
    }
  }

  // ── Fold the row up ────────────────────────────────────────────────────────
  //     totalStock = opening + prepared
  //     balance    = opening + prepared + returnTransferIn + returned + adjustment
  //                  − fulfilled − sold
  //     available  = balance − branchDemand
  //
  // `adjustment` is signed, so the spec's "+ positive − negative" is one addition.
  // Every figure is counted EXACTLY once.
  //
  // BRANCH RETURN STOCK IS NOT IN THIS SUM. Accepted returns sit in their own
  // inventory; `returnTransferIn` is only what was explicitly transferred here,
  // and `returned` is the legacy automatic credit, zero since migration 139.
  //
  // OUTSTANDING DEMAND IS NOT IN THE BALANCE. A branch asking for goods does not
  // consume them — the units are still on the shelf until the branch verifies the
  // delivery, which is what `demandFulfilled` counts. That also makes `balance`
  // exactly Σ delta over the ledger, which is why tomorrow's `opening` is today's
  // balance with no further work.
  for (const row of rows.values()) {
    row.totalStock = row.opening + row.preparedToday;
    row.balance =
      row.opening + row.preparedToday + row.returnTransferIn + row.returned + row.adjustment -
      row.demandFulfilled - row.soldToday;
    row.available = row.balance - row.branchDemand;
    row.status = productionStockStatus(row.balance, row.branchDemand);
  }

  const carriesFigures = (r: ProductionStockRow): boolean =>
    r.opening !== 0 || r.preparedToday !== 0 || r.branchDemand !== 0 ||
    r.demandFulfilled !== 0 || r.soldToday !== 0 || r.returnTransferIn !== 0 ||
    r.returned !== 0 || r.adjustment !== 0;

  // Shortages first — the rows someone has to do something about — then by size.
  const URGENCY: Record<ProductionStockRow['status'], number> = { shortage: 0, out: 1, low: 2, healthy: 3 };
  return [...rows.values()]
    .filter(carriesFigures)
    .sort((a, b) =>
      URGENCY[a.status] - URGENCY[b.status] ||
      b.balance - a.balance ||
      a.productName.localeCompare(b.productName));
}

/**
 * The same nine figures for ONE product — the single-product form of
 * `getProductionStockRows`, for the Support Center's stock reference and the
 * product-detail view. Same definitions, so every screen reads one number.
 */
export async function getProductionStockFigures(
  productId: string,
  date: string = businessDateStr(),
): Promise<ProductionStockFigures> {
  const [prior, history, demand] = await Promise.all([
    db
      .from('production_stock_history')
      .select('delta')
      .eq('product_id', productId)
      .lt('business_date', date),
    db
      .from('production_stock_history')
      .select('type, delta')
      .eq('product_id', productId)
      .eq('business_date', date),
    getOutstandingDemand(),
  ]);
  if (prior.error) throw prior.error;
  if (history.error) throw history.error;

  const figures: ProductionStockFigures = {
    opening: 0,
    preparedToday: 0,
    totalStock: 0,
    branchDemand: 0,
    demandFulfilled: 0,
    soldToday: 0,
    returnTransferIn: 0,
    returned: 0,
    adjustment: 0,
    balance: 0,
    available: 0,
  };

  for (const h of (prior.data ?? []) as { delta: number | string }[]) {
    figures.opening += Number(h.delta ?? 0);
  }
  for (const h of (history.data ?? []) as { type: ProductionStockMovementType; delta: number | string }[]) {
    const delta = Number(h.delta ?? 0);
    if (h.type === 'prepare') figures.preparedToday += delta;
    else if (h.type === 'transfer_out') figures.demandFulfilled -= delta;
    else if (h.type === 'return_transfer') figures.returnTransferIn += delta;
    else if (h.type === 'return_in') figures.returned += delta;
    else if (h.type === 'sale') figures.soldToday -= delta;
    else if (h.type === 'adjustment') figures.adjustment += delta;
  }
  if (date === businessDateStr()) figures.branchDemand = demand.get(productId) ?? 0;

  // Same arithmetic as getProductionStockRows — see the comment there.
  figures.totalStock = figures.opening + figures.preparedToday;
  figures.balance =
    figures.opening + figures.preparedToday + figures.returnTransferIn + figures.returned +
    figures.adjustment - figures.demandFulfilled - figures.soldToday;
  figures.available = figures.balance - figures.branchDemand;
  return figures;
}


/**
 * What the admin may set on the pool. An omitted key is LEFT ALONE.
 *
 * `balance` is the residual, booked as one `adjustment` movement sized to close
 * the gap between what the four movement figures imply and what the shelf actually
 * holds. `opening`, `totalStock` and `branchDemand` are NOT correctable here:
 * opening is a closed day's arithmetic, totalStock is opening + prepared, and
 * branchDemand belongs to the demand queue rather than to this ledger. Correct the
 * figures they are made of.
 */
export interface ProductionStockCorrectionTargets {
  preparedToday?: number;
  /**
   * The FULFILLED figure — `demandFulfilled` on a stock row, i.e. Σ −transfer_out.
   * Named `approvedQty` because that is the key
   * `apply_production_stock_correction` (migration 50) expects in its jsonb
   * targets, and renaming it here would mean renaming it in SQL for no gain.
   */
  approvedQty?: number;
  // No `returned`: a return is Branch Return Stock, not a pool figure, and the
  // RPC's `returned` target would book a `return_in` straight into the pool.
  soldToday?: number;
  balance?: number;
}

export interface ProductionStockCorrectionResult {
  applied: boolean;
  before: ProductionStockFigures;
  after: ProductionStockFigures;
  movements: { type: ProductionStockMovementType; delta: number }[];
}

/**
 * Thrown when migration 50 has not been applied to the database yet. Migrations are
 * pushed by hand here (the server does not run them at boot), so the alternative is a
 * bare 500 from PostgREST that reads as a bug rather than as a pending deploy step.
 */
export class CorrectionUnavailableError extends Error {
  constructor() {
    super(
      'Production stock corrections are not installed on the database yet. Apply migrations 49 and 50, then try again.',
    );
    this.name = 'CorrectionUnavailableError';
  }
}

/**
 * Apply an admin correction to the central pool (migration 50) — the pool's
 * sibling of `applyStockCorrection`. Targets are ABSOLUTE: the server sizes one
 * compensating movement per figure against the live ledger, inside one
 * transaction, and the append-only history keeps every original row.
 *
 * Unlike the branch version this cannot fail on a negative result: the pool is
 * allowed to go negative (migration 15), and a product already negative has to
 * stay correctable. The resulting day figure comes back in `after` so the caller
 * can say so.
 */
export async function applyProductionStockCorrection(params: {
  productId: string;
  productName: string;
  targets: ProductionStockCorrectionTargets;
  ticketId: string;
  businessDate?: string;
}): Promise<ProductionStockCorrectionResult> {
  const { data, error } = await db.rpc('apply_production_stock_correction', {
    p_product_id: params.productId,
    p_product_name: params.productName,
    p_targets: params.targets,
    p_ticket_id: params.ticketId,
    p_business_date: params.businessDate ?? businessDateStr(),
  });
  if (error) {
    // PGRST202 is PostgREST's "no function matches this name and signature".
    if (error.code === 'PGRST202' || /apply_production_stock_correction/.test(error.message ?? '')) {
      throw new CorrectionUnavailableError();
    }
    throw error;
  }

  const result = (data ?? {}) as {
    applied?: boolean;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    movements?: { type: ProductionStockMovementType; delta: number | string }[];
  };

  // numeric(14,3) arrives as a string from PostgREST — coerce every figure.
  //
  // The RPC computes `totalStock` its own way (balance + approved + sold) and
  // knows nothing about opening or the demand queue, so the shape is rebuilt here
  // from the figures it DOES report, using the one definition in
  // `ProductionStockFigures`. `opening` comes back from the RPC's `balance` minus
  // what the day itself moved, which is what opening means.
  //
  // `branchDemand` is 0: a correction moves the LEDGER, and an outstanding claim
  // is not in it. The caller re-reads the live row afterwards for
  // a figure that includes it.
  // The RPC knows nothing about opening or the demand queue, so the shape is
  // rebuilt here from the figures it DOES report, using the one definition in
  // `ProductionStockFigures`. `balance` is the ledger's running total, which is
  // exactly what this module means by balance.
  //
  // `branchDemand` is 0: a correction moves the LEDGER, and an outstanding claim
  // is not in it. The caller re-reads the live row afterwards for a figure that
  // includes it — which is also why `available` mirrors `balance` here.
  const figures = (raw: Record<string, unknown> = {}): ProductionStockFigures => {
    const preparedToday = Number(raw['preparedToday'] ?? 0);
    const demandFulfilled = Number(raw['approvedQty'] ?? 0);
    const returned = Number(raw['returned'] ?? 0);
    const soldToday = Number(raw['soldToday'] ?? 0);
    const adjustment = Number(raw['adjustment'] ?? 0);
    const balance = Number(raw['balance'] ?? 0);
    // balance = opening + prepared + returned + adjustment − fulfilled − sold,
    // so opening is that identity rearranged.
    const opening =
      balance - preparedToday - returned - adjustment + demandFulfilled + soldToday;
    return {
      opening,
      preparedToday,
      totalStock: opening + preparedToday,
      branchDemand: 0,
      demandFulfilled,
      soldToday,
      // The RPC does not report transfers from Return Stock separately; any on
      // the day are inside `opening` as rebuilt above.
      returnTransferIn: 0,
      returned,
      adjustment,
      balance,
      available: balance,
    };
  };

  return {
    applied: Boolean(result.applied),
    before: figures(result.before),
    after: figures(result.after),
    movements: (result.movements ?? []).map((m) => ({ type: m.type, delta: Number(m.delta) })),
  };
}

/**
 * Book an authorised manual adjustment against the pool (§11).
 *
 * NOT an edit. The caller states a SIGNED quantity and a reason; the RPC appends
 * one `adjustment` movement of that size and moves the running balance by it. No
 * path here assigns a balance, which is the whole point of §38 — a wrong figure is
 * corrected by another movement, never by overwriting the first.
 *
 * The reason is checked twice, here and in SQL. The schema catches a caller that
 * forgot; the RPC catches one that bypassed the schema. An adjustment with no
 * stated cause is indistinguishable from someone typing over an inconvenient
 * number, and the audit trail exists precisely so that cannot happen.
 */
export async function recordProductionAdjustment(params: {
  productId: string;
  productName: string;
  /** SIGNED and non-zero. Positive is ADJUSTMENT_IN, negative ADJUSTMENT_OUT. */
  qty: number;
  adjustmentType: string;
  reason: string;
  remarks?: string | undefined;
  approvedBy?: string | undefined;
  actorId?: string | undefined;
  actorName?: string | undefined;
  businessDate?: string | undefined;
}): Promise<{ before: number; after: number; delta: number; duplicate: boolean }> {
  // A fresh ref per call. The idempotency key is (ref_id, product_id, type), and
  // reusing one would make a second, genuinely different adjustment a silent
  // no-op — the opposite of what an operator pressing Save twice deliberately
  // wants when the first was a different correction.
  const refId = `adj:${randomUUID()}`;

  const { data, error } = await db.rpc('apply_production_stock_adjustment', {
    p_product_id: params.productId,
    p_product_name: params.productName,
    p_delta: params.qty,
    p_reason: params.reason,
    p_ref_id: refId,
    p_business_date: params.businessDate ?? businessDateStr(),
    p_created_by: params.actorId ?? null,
    p_created_by_name: params.actorName ?? null,
    p_remarks: params.remarks ?? null,
    // Everything the popup collected that has no column of its own. Kept as
    // structured metadata rather than glued into the reason text, so the audit
    // trail can be queried by adjustment type later.
    p_metadata: {
      adjustmentType: params.adjustmentType,
      ...(params.approvedBy ? { approvedBy: params.approvedBy } : {}),
    },
  });
  if (error) {
    if (error.code === 'PGRST202' || /apply_production_stock_adjustment/.test(error.message ?? '')) {
      throw new CorrectionUnavailableError();
    }
    throw error;
  }

  const result = (data ?? {}) as { status?: string; error?: string; before?: number; after?: number; delta?: number };
  if (result.status === 'invalid') {
    throw Object.assign(new Error(result.error ?? 'Invalid adjustment'), { status: 400 });
  }
  return {
    before: Number(result.before ?? 0),
    after: Number(result.after ?? 0),
    delta: Number(result.delta ?? params.qty),
    duplicate: result.status === 'duplicate',
  };
}

/**
 * Balance / reserved / available for every product, from the ONE SQL definition
 * (migration 90) that the counter sale and the demand guard also use.
 */
export async function getProductionAvailability(): Promise<
  Map<string, { balance: number; reserved: number; available: number }>
> {
  const { data, error } = await db.rpc('production_stock_availability');
  if (error) throw error;
  const out = new Map<string, { balance: number; reserved: number; available: number }>();
  for (const r of (data ?? []) as { product_id: string; balance: number | string; reserved: number | string; available: number | string }[]) {
    out.set(r.product_id, {
      balance: Number(r.balance ?? 0),
      reserved: Number(r.reserved ?? 0),
      available: Number(r.available ?? 0),
    });
  }
  return out;
}
