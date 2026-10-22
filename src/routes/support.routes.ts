import { Router, type Response } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  BRANCH_ROLES,
  CASH_DEPOSITS_PER_DAY,
  cashTransferChannelsLabel,
  CASH_TRANSFER_STATUS_LABELS,
  CreateSupportTicketSchema,
  EditSupportTicketSchema,
  ResolveSupportTicketSchema,
  ChangeFiguresSchema,
  EditSaleItemsSchema,
  EditDemandItemsSchema,
  DeleteDemandSchema,
  DeleteCashDepositSchema,
  businessDateStr,
  karachiTimeStr,
  type PaymentMethod,
  type ProductionStockFigures,
  type StockFigures,
  type SupportReference,
  type SupportReferenceType,
} from '../shared';
import { notify } from '../services/push.service';
import { logFinanceAudit } from '../services/finance-audit.service';
import { listAttachments } from '../services/attachments.service';
import {
  applyStockCorrection,
  applyStockMovement,
  DayClosedError,
  getProductStockFigures,
  NegativeBalanceError,
  OverdeterminedCorrectionError,
  type StockCorrectionResult,
  type StockCorrectionTargets,
} from '../services/stock.service';
import {
  applyProductionStockCorrection,
  applyProductionStockMovement,
  CorrectionUnavailableError,
  getProductionStockFigures,
  type ProductionStockCorrectionTargets,
  type ProductionStockCorrectionResult,
} from '../services/production-stock.service';
import { getProductionBranchId } from '../utils/productionBranch';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';

const db = dbFor('support');

export const router = Router();

/**
 * Tables a resolution is allowed to write a figure edit into.
 *
 * `reference_snapshot` is frozen onto the ticket as JSONB when it is raised and
 * never revisited, so a ticket raised before migration 59 can still name
 * `production_expenses` — a table that no longer exists. Resolving it would send
 * an UPDATE to a dropped relation and 500. Gating on this set makes such a ticket
 * resolve as a manual follow-up (`applied` stays false) instead, which is what it
 * now is: there is no row left to correct.
 */
const LIVE_EDITABLE_TABLES = new Set(['expenses']);

router.use(authenticate);

// ---------------------------------------------------------------------------
// Reference lookup — resolve a typed ID (MB-/DMD-/EXP-/STK-/CT-) to its detail, scoped
// to the caller's role/branch. Throws { status } errors that map to HTTP codes.
// ---------------------------------------------------------------------------
class LookupError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const money = (v: unknown) => `Rs.${Number(v ?? 0).toLocaleString('en-PK')}`;

/**
 * The stock figures an admin may correct, labelled as the Stock page shows them.
 *
 * `adjustment` is correctable as of migration 78 and is the ALTERNATIVE to
 * `balance` — they are one degree of freedom (adjustment is the residual in
 * opening + new − sold − returned + adjustment = balance), so the RPC refuses
 * both at once.
 *
 * `opening` is correctable as of migration 79, but unlike the rest its movement is
 * dated to the PREVIOUS business day — opening IS yesterday's closing, and a
 * movement dated today cannot shift it (balance and today's net move together).
 * It is refused outright once that day has been formally closed.
 */
const STOCK_FIGURE_LABELS = {
  opening: 'Opening Stock',
  newQty: 'New Stock',
  sold: 'Sold',
  returned: 'Returned',
  adjustment: 'Adjustment',
  balance: 'Balance',
} as const;

/** The only signed correctable figure — a correction can go either way. */
const SIGNED_STOCK_FIGURES = new Set(['adjustment']);

/**
 * The pool figures an admin may correct, labelled as the Production Stock page
 * shows them.
 *
 * `balance` is the ledger's closing figure for the day — the same number the
 * Production Stock page prints — so what an admin corrects here is what the
 * production user who raised the ticket actually sees.
 */
const PRODUCTION_FIGURE_LABELS = {
  preparedToday: 'Prepared Stock',
  approvedQty: 'Branch Demand (delivered)',
  soldToday: 'Sale',
  balance: 'Balance',
} as const;

/**
 * Correction targets are keyed by the SQL RPC's names, but the figures come back
 * on a `ProductionStockFigures`, whose fields are named for the Production Stock
 * page. This is the one place the two vocabularies meet.
 */
const PRODUCTION_FIGURE_FIELD = {
  preparedToday: 'preparedToday',
  approvedQty: 'demandFulfilled',
  soldToday: 'soldToday',
  balance: 'balance',
} as const satisfies Record<keyof typeof PRODUCTION_FIGURE_LABELS, keyof ProductionStockFigures>;

/**
 * "Sold 10 → 12, Balance 40 → 38" — only the figures that actually moved. Every
 * key in STOCK_FIGURE_LABELS is correctable now, Opening and Adjustment included,
 * so all of them are worth reporting when they change.
 */
function describeStockChange(result: StockCorrectionResult): string {
  return (Object.keys(STOCK_FIGURE_LABELS) as (keyof typeof STOCK_FIGURE_LABELS)[])
    .filter((k) => result.before[k] !== result.after[k])
    .map((k) => `${STOCK_FIGURE_LABELS[k]} ${result.before[k]} → ${result.after[k]}`)
    .join(', ');
}

/** The pool's counterpart of `describeStockChange`. */
function describeProductionChange(result: ProductionStockCorrectionResult): string {
  return (Object.keys(PRODUCTION_FIGURE_LABELS) as (keyof typeof PRODUCTION_FIGURE_LABELS)[])
    .filter((k) => result.before[PRODUCTION_FIGURE_FIELD[k]] !== result.after[PRODUCTION_FIGURE_FIELD[k]])
    .map((k) =>
      `${PRODUCTION_FIGURE_LABELS[k]} ${result.before[PRODUCTION_FIGURE_FIELD[k]]} → ${result.after[PRODUCTION_FIGURE_FIELD[k]]}`)
    .join(', ');
}

function refType(refId: string): SupportReferenceType {
  const id = refId.toUpperCase();
  if (id.startsWith('MB-')) return 'sale';
  if (id.startsWith('DMD-')) return 'demand';
  if (id.startsWith('EXP-')) return 'expense';
  if (id.startsWith('STK-')) return 'stock';
  if (id.startsWith('CT-')) return 'cash_transfer';
  throw new LookupError(
    'Unknown ID. Use a sale (MB-…), demand (DMD-…), expense (EXP-…), stock (STK-…), or cash deposit (CT-…) ID.',
    400,
  );
}

/**
 * `scopeBranch` lets a super_admin resolve a STOCK reference against a specific
 * branch — the Support Center passes the ticket's branch so the admin sees (and
 * corrects) that branch's live figures rather than an all-branches total. Ignored
 * for branch managers, who are always pinned to their own branch.
 *
 * `poolScope` is its production counterpart: it resolves a STOCK reference against
 * the central pool. A production user always gets the pool from their role, but an
 * admin re-reading that same ticket would otherwise land on an all-branches total,
 * which describes something else entirely — so the Support Center asks for the pool
 * explicitly when the ticket came from Production. The two are mutually exclusive;
 * the pool wins, because a pool ticket has no branch ledger to fall back to.
 */
async function resolveReference(
  user: AuthRequest['user'],
  rawRef: string,
  scopeBranch?: string | null,
  poolScope = false,
): Promise<SupportReference> {
  const referenceId = rawRef.trim().toUpperCase();
  const type = refType(referenceId);
  const role = user!.role;
  const branchId = user!.branchId;

  // --- SALE (orders.order_number) -----------------------------------------
  if (type === 'sale') {
    // Resolving the sentinel does double duty: it is the production role's branch
    // scope, and it is how ANY caller (an admin included) recognises a sale whose
    // units came out of the pool rather than a branch ledger. Cached, so this is
    // at most one `branches` read per TTL.
    const productionBranchId = await getProductionBranchId();

    // The whole money row, not just the grand total: the Support Center shows the
    // admin exactly what the branch sees on its own Sale view (rate, discount and
    // line amount per item; subtotal / discount / tax / grand total below), and
    // tax_rate + delivery_charges are what let it preview the recomputed total the
    // same way edit_sale_items will.
    let q = db
      .from('orders')
      .select(`
        id, order_number, customer_name, customer_phone, branch_name, branch_id,
        subtotal, discount_total, delivery_charges, tax_rate, tax_amount, grand_total,
        payment_method, status, business_date, created_at, created_by_name, notes
      `)
      .eq('order_number', referenceId)
      .limit(1);
    if (role === 'branch_manager') {
      // Fail CLOSED. Without the guard a manager whose account carries no branch
      // would scope to nothing at all and see every branch's sales.
      if (!branchId) throw new LookupError('No branch is assigned to this account.', 403);
      q = q.eq('branch_id', branchId);
    } else if (role === 'production_user') {
      // Mirrors the branch_manager scoping: production sees the counter's own
      // sales (migration 37's sentinel branch), never a shop's.
      q = q.eq('branch_id', productionBranchId);
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) throw new LookupError(`No sale found for ${referenceId}.`, 404);

    // Derived from the ROW's branch, not the caller's role, so an admin looking up
    // the same counter sale gets the same read-only verdict.
    const isProductionSale = data.branch_id === productionBranchId;

    // Line items are editable in the Support Center: the admin can change a
    // line's product, qty, unit price or discount, and it applies live via
    // edit_sale_items.
    const { data: items, error: itemsErr } = await db
      .from('order_items')
      .select('product_id, product_name, category_id, category_name, unit_price, qty, discount')
      .eq('order_id', data.id)
      .order('line_no', { ascending: true });
    if (itemsErr) throw itemsErr;

    const saleItems = (items ?? []).map((it) => ({
      productId: it.product_id,
      productName: it.product_name,
      categoryId: it.category_id,
      categoryName: it.category_name,
      unitPrice: Number(it.unit_price),
      qty: Number(it.qty),
      discount: Number(it.discount ?? 0),
    }));

    const totals = {
      subtotal: Number(data.subtotal ?? 0),
      discountTotal: Number(data.discount_total ?? 0),
      deliveryCharges: Number(data.delivery_charges ?? 0),
      taxRate: Number(data.tax_rate ?? 0),
      taxAmount: Number(data.tax_amount ?? 0),
      grandTotal: Number(data.grand_total ?? 0),
    };

    return {
      type,
      referenceId,
      entityId: data.id,
      title: `Sale ${referenceId} — ${data.customer_name ?? 'Walk-in'} · ${money(data.grand_total)}`,
      // The same rows the branch's Sale view prints, in the same order, so an
      // admin reading the ticket and the branch manager reading the sale are
      // looking at one document. Delivery and Comment appear only when the sale
      // has them — a blank row reads as a figure of zero rather than as absent.
      fields: [
        { label: 'Customer', value: data.customer_name ?? 'Walk-in' },
        { label: 'Mobile', value: data.customer_phone ?? '—' },
        { label: 'Branch', value: data.branch_name ?? '—' },
        { label: 'Date', value: String(data.business_date ?? '—') },
        { label: 'Time', value: data.created_at ? karachiTimeStr(new Date(data.created_at)) : '—' },
        { label: 'Items', value: `${saleItems.length} line${saleItems.length === 1 ? '' : 's'}` },
        { label: 'Total Qty', value: String(saleItems.reduce((s, it) => s + it.qty, 0)) },
        // Gross, as the branch's view prints it — orders.subtotal is already net
        // of the line discounts, so the discount is added back to show what the
        // items came to before it.
        { label: 'Subtotal', value: money(totals.subtotal + totals.discountTotal) },
        { label: 'Discount', value: `-${money(totals.discountTotal)}` },
        ...(totals.deliveryCharges > 0 ? [{ label: 'Delivery', value: money(totals.deliveryCharges) }] : []),
        { label: 'Government Tax', value: money(totals.taxAmount) },
        { label: 'Grand Total', value: money(totals.grandTotal) },
        { label: 'Payment', value: String(data.payment_method ?? '—') },
        { label: 'Status', value: String(data.status ?? '—') },
        { label: 'Sold By', value: data.created_by_name ?? '—' },
        ...(data.notes?.trim() ? [{ label: 'Comment', value: data.notes.trim() }] : []),
      ],
      saleTotals: totals,
      saleItems,
      // Also editable in the Support Center. Historical rows may carry a legacy
      // tender ('card' / 'online') that is no longer offered — it is shown as-is
      // and simply not one of the choices the admin can pick.
      paymentMethod: (data.payment_method ?? undefined) as PaymentMethod | undefined,
      // Order totals are recomputed from the line edits by edit_sale_items — the
      // flat editableFields path (expenses) does not apply to sales.
      editableFields: [],
      // A counter sale drew its units from `production_stock`, but edit_sale_items
      // reconciles branch `stock` keyed on orders.branch_id — and the sentinel
      // branch has no stock rows. Applying one would 409 on any increase and
      // INSERT phantom branch inventory on any decrease, leaving the pool wrong
      // either way. So it is answered, not corrected.
      ...(isProductionSale ? { readOnly: true } : {}),
    };
  }

  // --- DEMAND (production_orders.demand_number) ----------------------------
  // Corrected through PATCH /:id/demand-items, not /figures: a demand line carries
  // both a requested and an approved quantity, and only the latter moves stock —
  // and only then if the order actually delivered. correct_production_order
  // (migration 77) owns that decision; see its header for why `status` cannot make
  // it. A rejected or cancelled demand stays read-only (below).
  if (type === 'demand') {
    // An explicit column list rather than production-orders.routes.ts's `*`: this
    // snapshot is frozen into the ticket as jsonb forever, so it should not carry
    // legacy ids, print flags or audit uuids. product_id/product_name join the
    // list because the correction editor addresses lines by product.
    let q = db
      .from('production_orders')
      .select(`
        id, demand_number, branch_id, branch_name, business_date, submitted_time,
        status, was_changed, change_reason, created_by_name, approved_by_name,
        items:production_order_items(product_id, product_name, qty, approved_qty, line_no),
        packingItems:production_order_packing_items(qty, approved_qty)
      `)
      .eq('demand_number', referenceId)
      .limit(1);
    // super_admin and production_user see every branch's demand — production
    // reviews all of them, matching GET /api/production-orders, which applies no
    // branch filter for that role. A branch manager sees only its own, fail-closed.
    if (role === 'branch_manager') {
      if (!branchId) throw new LookupError('No branch is assigned to this account.', 403);
      q = q.eq('branch_id', branchId);
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) throw new LookupError(`No demand found for ${referenceId}.`, 404);

    type DemandRow = {
      product_id: string;
      product_name: string;
      qty: number | string;
      approved_qty: number | string | null;
      line_no: number | null;
    };
    type QtyRow = { qty: number | string; approved_qty: number | string | null };
    const items = (data.items ?? []) as QtyRow[];
    const packing = (data.packingItems ?? []) as QtyRow[];
    // numeric(14,3) can arrive as a string from PostgREST — coerce, as the sale
    // block does for its line items.
    const sum = (rows: QtyRow[], key: keyof QtyRow) =>
      rows.reduce((total, r) => total + Number(r[key] ?? 0), 0);
    // approved_qty stays NULL until review, so a 0 here would read as "Production
    // approved nothing" rather than "not looked at yet".
    const reviewed = items.some((i) => i.approved_qty != null);

    // Has this order already credited units to the branch? Asked of the LEDGER,
    // because `status` cannot answer it: verification sets 'verified', then
    // Production's final approval flips it back to 'approved', so a delivered
    // order and a never-delivered one look identical. Migration 77's header has
    // the live evidence. Advisory here — correct_production_order recomputes it
    // under a row lock before moving anything.
    const { count: movedCount, error: movedErr } = await db
      .from('stock_history')
      .select('id', { count: 'exact', head: true })
      .eq('ref_id', data.id)
      .eq('type', 'production');
    if (movedErr) throw movedErr;

    // Refused demands committed to nothing and moved nothing; editing their lines
    // would produce a document claiming otherwise. correct_production_order
    // refuses them too — this just keeps the editor from being offered.
    const demandReadOnly = data.status === 'rejected' || data.status === 'cancelled';

    return {
      type,
      referenceId,
      entityId: data.id,
      // No entityTable: `entityTable` + a non-empty `allowed` set is exactly what
      // drives the blind UPDATE in PATCH /:id/figures. Omitting it keeps demands
      // out of that path — they are corrected through /demand-items instead.
      title: `Demand ${referenceId} — ${data.branch_name ?? '—'} · ${data.business_date}`,
      fields: [
        { label: 'Branch', value: data.branch_name ?? '—' },
        { label: 'Date', value: String(data.business_date) },
        { label: 'Time', value: data.submitted_time ?? '—' },
        { label: 'Status', value: String(data.status) },
        { label: 'Products', value: String(items.length) },
        { label: 'Requested Qty', value: String(sum(items, 'qty')) },
        { label: 'Approved Qty', value: reviewed ? String(sum(items, 'approved_qty')) : '—' },
        { label: 'Packing Items', value: String(packing.length) },
        { label: 'Submitted By', value: data.created_by_name ?? '—' },
        { label: 'Reviewed By', value: data.approved_by_name ?? '—' },
        { label: 'Changed', value: data.was_changed ? (data.change_reason || 'Yes') : 'No' },
      ],
      // Empty on purpose: a demand has no scalar figure to patch. Its correction
      // surface is the line editor below.
      editableFields: [],
      branchId: data.branch_id ?? null,
      businessDate: String(data.business_date),
      demandItems: (data.items ?? [] as DemandRow[])
        .slice()
        .sort((a: DemandRow, b: DemandRow) => (a.line_no ?? 0) - (b.line_no ?? 0))
        .map((i: DemandRow) => ({
          productId: i.product_id,
          productName: i.product_name,
          qty: Number(i.qty ?? 0),
          approvedQty: Number(i.approved_qty ?? 0),
        })),
      demandStockMoved: (movedCount ?? 0) > 0,
      ...(demandReadOnly ? { readOnly: true } : {}),
    };
  }

  // --- EXPENSE (expenses.expense_number) -----------------------------------
  if (type === 'expense') {
    // Shop expenses only — production_expenses was dropped (migration 59), so a
    // production user has no expense of their own to raise a ticket against.
    // EXP-###### still comes from the counter both tables once shared, so a
    // number that belonged to a production expense simply no longer resolves.
    if (role !== 'production_user') {
      let q = db
        .from('expenses')
        .select('id, expense_number, description, amount, payment_method, branch_id, branch_name, business_date')
        .eq('expense_number', referenceId)
        .limit(1);
      if (role === 'branch_manager' && branchId) q = q.eq('branch_id', branchId);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      if (data) {
        return {
          type,
          referenceId,
          entityId: data.id,
          entityTable: 'expenses',
          title: `Expense ${referenceId} — ${data.description} · ${money(data.amount)}`,
          fields: [
            { label: 'Description', value: data.description },
            { label: 'Amount', value: money(data.amount) },
            { label: 'Payment', value: String(data.payment_method ?? '—') },
            { label: 'Branch', value: data.branch_name ?? '—' },
            { label: 'Date', value: String(data.business_date ?? '—') },
          ],
          editableFields: [
            { key: 'amount', label: 'Amount', kind: 'number', value: Number(data.amount) },
            { key: 'description', label: 'Description', kind: 'text', value: data.description },
          ],
        };
      }
    }
    throw new LookupError(`No expense found for ${referenceId}.`, 404);
  }

  // --- CASH DEPOSIT (cash_transfers.transfer_no) ---------------------------
  // Amount, method and note are correctable from the Support Center through
  // PATCH /:id/figures, which calls amend_finance_record — the same function the
  // Finance Help Desk uses, so an approved deposit's RV- receipt is reversed and
  // re-posted rather than left disagreeing with the row (migration 120). A
  // rejected deposit is final and never booked; it stays read-only.
  if (type === 'cash_transfer') {
    // Branch money only — the production counter never hands over a deposit.
    if (role !== 'production_user') {
      let q = withoutDeleted(
        db
          .from('cash_transfers')
          .select(`
            id, transfer_no, branch_id, branch_name, amount, payment_method, note,
            cash_amount, easypaisa_amount, bank_amount, fuel_charges,
            business_date, status, created_by_name, created_at, approved_by_name,
            rejection_reason, voucher_no
          `)
          .eq('transfer_no', referenceId),
      ).limit(1);
      if (role === 'branch_manager') {
        if (!branchId) throw new LookupError('No branch is assigned to this account.', 403);
        q = q.eq('branch_id', branchId);
      }
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      if (data) {
        const channels = {
          cashAmount: Number(data.cash_amount ?? 0),
          easypaisaAmount: Number(data.easypaisa_amount ?? 0),
          bankAmount: Number(data.bank_amount ?? 0),
          fuelCharges: Number(data.fuel_charges ?? 0),
        };
        const status =
          CASH_TRANSFER_STATUS_LABELS[data.status as keyof typeof CASH_TRANSFER_STATUS_LABELS]
          ?? String(data.status);
        return {
          type,
          referenceId,
          entityId: data.id,
          title: `Cash Deposit ${referenceId} — ${data.branch_name} · ${money(data.amount)}`,
          fields: [
            { label: 'Branch', value: data.branch_name },
            { label: 'Date', value: String(data.business_date) },
            { label: 'Time', value: data.created_at ? karachiTimeStr(new Date(data.created_at)) : '—' },
            { label: 'Cash', value: money(channels.cashAmount) },
            { label: 'Easypaisa', value: money(channels.easypaisaAmount) },
            { label: 'Bank', value: money(channels.bankAmount) },
            { label: 'Total Amount', value: money(data.amount) },
            { label: 'Fuel Charges', value: money(channels.fuelCharges) },
            { label: 'Channels', value: cashTransferChannelsLabel(channels) },
            { label: 'Status', value: status },
            ...(data.voucher_no ? [{ label: 'Voucher', value: data.voucher_no }] : []),
            { label: 'Submitted By', value: data.created_by_name ?? '—' },
            ...(data.approved_by_name ? [{ label: 'Reviewed By', value: data.approved_by_name }] : []),
            ...(data.rejection_reason ? [{ label: 'Rejection Reason', value: data.rejection_reason }] : []),
            ...(data.note?.trim() ? [{ label: 'Note', value: data.note.trim() }] : []),
          ],
          editableFields: data.status === 'rejected' ? [] : [
            // The Total is not editable: it is Cash + Easypaisa + Bank (migration 121).
            { key: 'cashAmount', label: 'Cash', kind: 'number', value: channels.cashAmount },
            { key: 'easypaisaAmount', label: 'Easypaisa', kind: 'number', value: channels.easypaisaAmount },
            { key: 'bankAmount', label: 'Bank', kind: 'number', value: channels.bankAmount },
            { key: 'fuelCharges', label: 'Fuel Charges', kind: 'number', value: channels.fuelCharges },
            { key: 'note', label: 'Note', kind: 'text', value: data.note ?? '' },
          ],
          branchId: data.branch_id,
          businessDate: String(data.business_date),
          cashTransferApproved: data.status === 'approved',
          ...(data.status === 'rejected' ? { readOnly: true } : {}),
        };
      }
    }
    throw new LookupError(`No cash deposit found for ${referenceId}.`, 404);
  }

  // --- STOCK (products.stock_code) ----------------------------------------
  const { data: product, error: prodErr } = await db
    .from('products')
    .select('id, name, sku, stock_code, price')
    .eq('stock_code', referenceId)
    .maybeSingle();
  if (prodErr) throw prodErr;
  if (!product) throw new LookupError(`No stock item found for ${referenceId}.`, 404);

  const fields: SupportReference['fields'] = [
    { label: 'Product', value: product.name },
    { label: 'SKU', value: product.sku ?? '—' },
    { label: 'Price', value: money(product.price) },
  ];
  const editableFields: SupportReference['editableFields'] = [];
  let stockFigures: StockFigures | undefined;

  // One date for the whole block. Read twice it could straddle the 2 AM Karachi
  // rollover and label a day's figures with the next day's date.
  const today = businessDateStr();

  // Production runs off the branch-agnostic pool, so neither branch path below
  // applies — a production user would otherwise fall through both and get a bare
  // Product/SKU/Price with no figures at all. Returning early rather than joining
  // the chain makes it structurally impossible for a branch-shaped `stockFigures`
  // or `branchId` to end up on a pool reference.
  //
  // CORRECTABLE since migration 50: the pool has its own correction function, so
  // these figures are absolute targets exactly as a branch's are. What it does NOT
  // have is a branch, which is why `isProductionPool` rides along — it is what
  // routes the write to the pool rather than to some shop's ledger.
  if (role === 'production_user' || poolScope) {
    // Reused rather than queried directly so the Help Desk, the Production Stock
    // page and this correction derive their figures from one definition — the
    // alternative is re-folding the movement types here and eventually disagreeing
    // with the page.
    const f = await getProductionStockFigures(product.id, today);
    // NO Opening, and no running Pool Balance either. The pool is read as the day
    // it had — prepared in, approved and sold out — because that is
    // what the Production Stock page shows, what the counter sells against, and
    // therefore the only thing a query raised from either can be about.
    fields.push(
      { label: 'Opening Stock', value: String(f.opening) },
      { label: 'Prepared Stock', value: String(f.preparedToday) },
      { label: 'Total Stock', value: String(f.totalStock) },
      { label: 'Branch Demand Stock (outstanding)', value: String(f.branchDemand) },
      { label: '  · outstanding (not yet verified)', value: String(f.branchDemand) },
      { label: '  · fulfilled (verified out)', value: String(f.demandFulfilled) },
      { label: 'Sale', value: String(f.soldToday) },
      { label: 'Transferred from Return Stock', value: String(f.returnTransferIn + f.returned) },
      { label: 'Adjustment', value: f.adjustment > 0 ? `+${f.adjustment}` : String(f.adjustment) },
      { label: 'Balance', value: String(f.balance) },
    );
    return {
      type,
      referenceId,
      entityId: product.id,
      title: `Production Stock ${referenceId} — ${product.name}`,
      fields,
      // Opening Stock, Total Stock and the reserved half of Branch Demand are
      // absent on purpose. Opening is a CLOSED day's arithmetic — correcting it
      // means correcting that day, not this one. Total Stock is opening +
      // prepared. The reserved demand lives on the order, not in this ledger, and
      // is fixed by correcting the demand.
      //
      // Balance IS correctable and is the residual: setting it books the single
      // `adjustment` movement that closes the gap between what the movement
      // figures imply and what the shelf actually holds.
      editableFields: [
        { key: 'preparedToday', label: 'Prepared Stock', kind: 'number', value: f.preparedToday },
        { key: 'approvedQty', label: 'Demand Fulfilled', kind: 'number', value: f.demandFulfilled },
        { key: 'soldToday', label: 'Sale', kind: 'number', value: f.soldToday },
        { key: 'balance', label: 'Balance', kind: 'number', value: f.balance },
      ],
      isProductionPool: true,
      // Still null, and still not a branch reference: `stockFigures` stays omitted
      // because it is the BRANCH row shape and would mislabel these numbers.
      branchId: null,
      businessDate: today,
      productionFigures: f,
    };
  }

  // Whose stock is this about? A branch manager's own branch, or — when the admin
  // re-resolves a ticket to correct it — the branch the ticket was raised from.
  // A correction needs exactly one branch's ledger to land on.
  const scopeBranchId = role === 'branch_manager' ? branchId : (scopeBranch ?? null);

  if (scopeBranchId) {
    // The whole derived row, not just the balance: the admin corrects whichever
    // figure is wrong (units never delivered, a mis-keyed sale, an unrecorded
    // return), and each one is a different compensating movement. Same definitions
    // as the branch's Stock page, so both sides read the same numbers.
    const f = await getProductStockFigures(scopeBranchId, product.id, today);
    fields.push(
      { label: 'Opening Stock', value: String(f.opening) },
      { label: 'New Stock', value: String(f.newQty) },
      { label: 'Sold', value: String(f.sold) },
      { label: 'Returned', value: String(f.returned) },
      { label: 'Adjustment', value: f.adjustment > 0 ? `+${f.adjustment}` : String(f.adjustment) },
      { label: 'Balance', value: String(f.balance) },
    );
    // Opening is deliberately absent: it is the previous day's closing, so
    // correcting it would mean rewriting a day that has already been closed.
    //
    // Adjustment and Balance are both here but are ONE degree of freedom —
    // adjustment is the residual, so setting either determines the other. The
    // dialog offers one box at a time and the RPC refuses both (migration 78).
    editableFields.push(
      { key: 'opening', label: 'Opening Stock', kind: 'number', value: f.opening },
      { key: 'newQty', label: 'New Stock', kind: 'number', value: f.newQty },
      { key: 'sold', label: 'Sold', kind: 'number', value: f.sold },
      { key: 'returned', label: 'Returned', kind: 'number', value: f.returned },
      { key: 'adjustment', label: 'Adjustment', kind: 'number', value: f.adjustment },
      { key: 'balance', label: 'Balance', kind: 'number', value: f.balance },
    );
    stockFigures = f;
  } else if (role === 'super_admin') {
    const { data: rows } = await db.from('stock').select('balance').eq('product_id', product.id);
    const total = (rows ?? []).reduce((s, r) => s + Number(r.balance ?? 0), 0);
    fields.push({ label: 'Total Balance (all branches)', value: String(total) });
    // Not editable: an all-branches total has no single ledger to correct. The
    // admin corrects stock from the branch's own ticket, which carries a branch.
  }

  return {
    type,
    referenceId,
    entityId: product.id,
    title: `Stock ${referenceId} — ${product.name}`,
    fields,
    editableFields,
    branchId: scopeBranchId,
    businessDate: today,
    stockFigures,
  };
}

// GET /api/support/lookup?ref=EXP-000012 — used by the Help Desk to auto-show detail.
// &branchId= scopes a stock lookup to one branch, &pool=1 scopes it to the central
// production pool (both admin only; see resolveReference). Together they are how the
// Support Center re-reads a ticket's LIVE figures before correcting them — the
// snapshot on the ticket is from when the query was raised.
router.get('/lookup', async (req: AuthRequest, res, next) => {
  try {
    const ref = String(req.query['ref'] || '').trim();
    if (!ref) { res.status(400).json({ error: 'Reference ID is required' }); return; }
    const isAdmin = req.user!.role === 'super_admin';
    const scopeBranch = isAdmin ? (req.query['branchId'] as string | undefined) : undefined;
    const poolScope = isAdmin && String(req.query['pool'] ?? '') === '1';
    const reference = await resolveReference(req.user, ref, scopeBranch ?? null, poolScope);
    res.json({ reference });
  } catch (err) {
    if (err instanceof LookupError) { res.status(err.status).json({ error: err.message }); return; }
    next(err);
  }
});

// The columns `SupportCenterPage.tsx`'s table lets someone click to sort. An
// unrecognized `sortBy` silently falls back to `created_at desc`, matching this
// route's existing style of ignoring rather than 400ing a bad optional param.
const TICKET_SORT_COLUMNS: Record<string, string> = {
  ticketNumber: 'ticket_number',
  referenceId: 'reference_id',
  branchName: 'branch_name',
  message: 'message',
  status: 'status',
  createdAt: 'created_at',
};

// GET /api/support — admin sees the whole queue; a raiser sees only their own tickets.
//
// Archived tickets are hidden by default so the Archive button still clears the
// queue, which is what it was being used for. `?includeArchived=1` brings them
// back (admin only — a raiser has no archive view), which is how anyone answers
// "what was the query behind this correction?" after the fact.
//
// Paginated + searched server-side (`page`/`pageSize`/`search`), mirroring
// `GET /api/finance-tickets` (finance-tickets.routes.ts) — this used to be a flat
// `.limit(500)` with no page concept, so a branch/production account with a long
// history downloaded and rendered every one of its own tickets on every visit.
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const isAdmin = req.user!.role === 'super_admin';
    const includeArchived = isAdmin && ['1', 'true'].includes(String(req.query['includeArchived'] ?? ''));

    const rawPage = Number(req.query['page']);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const rawPageSize = Number(req.query['pageSize']);
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(200, Math.floor(rawPageSize)) : 20;

    const sortByRaw = String(req.query['sortBy'] ?? '');
    const sortCol = TICKET_SORT_COLUMNS[sortByRaw] ?? 'created_at';
    const ascending = req.query['sortDir'] === 'asc';

    let query = db
      .from('support_tickets')
      .select('*', { count: 'exact' })
      .order(sortCol, { ascending });
    if (!includeArchived) query = query.is('archived_at', null);
    // Branch scoping (unconditional for a non-admin raiser) and the status
    // filter are independent — status only narrows an already-correctly-scoped
    // query, for either caller, so a raiser can ask for their own open queue
    // separately from their own history the same way the admin queue does.
    if (!isAdmin) query = query.eq('raised_by', req.user!.uid);
    if (req.query['status']) query = query.eq('status', String(req.query['status']));
    // The Help Desk's "Resolved & rejected" history is everything but the open
    // queue — one filter rather than asking twice and merging client-side.
    if (req.query['excludeStatus']) query = query.neq('status', String(req.query['excludeStatus']));
    // §5's Source filter (SupportCenterPage.tsx) — WHERE a query came from.
    // Branch/production both raise into this same table, so "source" is really
    // a role filter: `raised_by_role` in BRANCH_ROLES vs exactly production_user.
    const source = req.query['source'] as string | undefined;
    if (source === 'branch') query = query.in('raised_by_role', BRANCH_ROLES);
    else if (source === 'production') query = query.eq('raised_by_role', 'production_user');

    // Free text across the handles someone actually remembers — same escaping
    // as the Finance Help Desk's search (finance-tickets.routes.ts).
    const search = String(req.query['search'] ?? '').trim();
    if (search) {
      const term = search.replace(/[(),*]/g, ' ').trim();
      if (term) {
        query = query.or(
          [
            `ticket_number.ilike.*${term}*`,
            `message.ilike.*${term}*`,
            `raised_by_name.ilike.*${term}*`,
            `branch_name.ilike.*${term}*`,
          ].join(','),
        );
      }
    }

    // §19/§13 — one page, not the table. `count: 'exact'` above is what makes the
    // pager honest about how many pages there are.
    const fromRow = (page - 1) * pageSize;
    query = query.range(fromRow, fromRow + pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ tickets: rowToApi(data ?? []), total: count ?? 0, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// GET /api/support/stats — open-ticket counts by source, for the Source filter's
// badges (SupportCenterPage.tsx). Two `head: true` counts rather than a full
// row fetch: the badges need a number, not the rows, and they must reflect the
// WHOLE open queue regardless of which page the table is currently showing.
router.get('/stats', requireRole('super_admin'), async (_req, res, next) => {
  try {
    const [branchRes, productionRes] = await Promise.all([
      db
        .from('support_tickets')
        .select('*', { count: 'exact', head: true })
        .is('archived_at', null)
        .eq('status', 'open')
        .in('raised_by_role', BRANCH_ROLES),
      db
        .from('support_tickets')
        .select('*', { count: 'exact', head: true })
        .is('archived_at', null)
        .eq('status', 'open')
        .eq('raised_by_role', 'production_user'),
    ]);
    if (branchRes.error) throw branchRes.error;
    if (productionRes.error) throw productionRes.error;
    res.json({ branchOpen: branchRes.count ?? 0, productionOpen: productionRes.count ?? 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/support — raise a query (branches + production). Snapshots the reference.
router.post('/', requireRole('branch_manager', 'production_user'), validate(CreateSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { referenceId, message } = req.body;
    let reference: SupportReference;
    try {
      reference = await resolveReference(req.user, referenceId);
    } catch (err) {
      if (err instanceof LookupError) { res.status(err.status).json({ error: err.message }); return; }
      throw err;
    }

    const { data, error } = await db
      .from('support_tickets')
      .insert({
        reference_type: reference.type,
        reference_id: reference.referenceId,
        reference_snapshot: reference,
        message,
        branch_id: req.user!.branchId,
        branch_name: req.user!.branchName,
        raised_by: req.user!.uid,
        raised_by_name: req.user!.email,
        raised_by_role: req.user!.role,
      })
      .select('*')
      .single();
    if (error) throw error;

    // In-app notification to admins — best-effort, never fails the mutation.
    try {
      await notify({
        type: 'support_query',
        title: `New support query ${data.ticket_number}`,
        message: `${req.user!.branchName || req.user!.email} raised a query on ${reference.referenceId}`,
        targetRole: 'super_admin',
        branchId: req.user!.branchId,
        relatedId: data.id,
      });
    } catch { /* notification failure must not fail ticket creation */ }

    res.status(201).json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// Helper: load a ticket or 404.
async function getTicket(id: string) {
  const { data, error } = await db.from('support_tickets').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Archived tickets are readable (that is the whole point of keeping them) but
 * never writable — un-archive first. Returns true when the caller has already
 * been answered and the handler must stop.
 */
function refusedAsArchived(ticket: { archived_at?: string | null } | null, res: Response): boolean {
  if (!ticket?.archived_at) return false;
  res.status(409).json({ error: 'This query is archived. Restore it before making changes.' });
  return true;
}

// PATCH /api/support/:id — admin edits the ticket text (Edit button)
router.patch('/:id', requireRole('super_admin'), validate(EditSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const patch: Record<string, unknown> = {};
    if (req.body.message !== undefined) patch['message'] = req.body.message;
    if (req.body.resolutionNote !== undefined) patch['resolution_note'] = req.body.resolutionNote;
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

    const { data, error } = await db
      .from('support_tickets')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Ticket not found' }); return; }
    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/support/:id/resolve — admin resolves or rejects (Reject button + Resolve)
router.patch('/:id/resolve', requireRole('super_admin'), validate(ResolveSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status, resolutionNote } = req.body;
    const { data, error } = await db
      .from('support_tickets')
      .update({
        status,
        resolution_note: resolutionNote || null,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Ticket not found' }); return; }

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} ${status}`,
          message: resolutionNote || `Your query on ${data.reference_id} was ${status}.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

/** What amend_finance_record reports for one corrected field of a cash deposit. */
interface CashDepositAmendment {
  field: DepositField;
  originalValue: string | null;
  newValue: string | null;
  ledger?: {
    ledgerAmended?: boolean;
    reversalVoucherNo?: string | null;
    correctedVoucherNo?: string | null;
    /** A date correction moves the receipts in place (migration 132) — these are the ones that moved. */
    redatedVoucherNos?: string | null;
  };
}

/** The correctable figures of a deposit (migration 121). The Total follows from the first three. */
const DEPOSIT_MONEY_FIELDS = ['cashAmount', 'easypaisaAmount', 'bankAmount', 'fuelCharges'] as const;
type DepositField = (typeof DEPOSIT_MONEY_FIELDS)[number] | 'note' | 'businessDate';

const DEPOSIT_FIELD_LABELS: Record<DepositField, string> = {
  cashAmount: 'Cash',
  easypaisaAmount: 'Easypaisa',
  bankAmount: 'Bank',
  fuelCharges: 'Fuel Charges',
  note: 'Note',
  businessDate: 'Date',
};

const DEPOSIT_COLUMNS = {
  cashAmount: 'cash_amount',
  easypaisaAmount: 'easypaisa_amount',
  bankAmount: 'bank_amount',
  fuelCharges: 'fuel_charges',
} as const;

function depositValueLabel(field: DepositField, value: string | null): string {
  if (value == null || value === '') return '—';
  return field === 'note' || field === 'businessDate' ? value : money(value);
}

/** "Cash Rs.1,000 → Rs.1,200 (PV-000041 reversed, posted RV-000231)". */
function describeDepositChange(changes: CashDepositAmendment[]): string {
  return changes
    .map((c) => {
      const line =
        `${DEPOSIT_FIELD_LABELS[c.field]} ${depositValueLabel(c.field, c.originalValue)}` +
        ` → ${depositValueLabel(c.field, c.newValue)}`;
      if (c.ledger?.redatedVoucherNos) return `${line} (${c.ledger.redatedVoucherNos} moved to the new date)`;
      if (!c.ledger?.ledgerAmended) return line;
      const moved = [
        c.ledger.reversalVoucherNo ? `${c.ledger.reversalVoucherNo} reversed` : '',
        c.ledger.correctedVoucherNo ? `posted ${c.ledger.correctedVoucherNo}` : '',
      ].filter(Boolean);
      return moved.length ? `${line} (${moved.join(', ')})` : line;
    })
    .join(', ');
}

/**
 * Apply an admin's cash deposit correction, one field at a time, through
 * amend_finance_record — the Finance Help Desk's own function, so both desks
 * mean the same thing by "corrected". The figures are Cash, Easypaisa, Bank and
 * Fuel Charges; the Total is recomputed in SQL from the first three. An
 * approved deposit whose figure changes has every RV- it produced reversed and
 * fresh ones posted, dated today (the original day is usually closed).
 *
 * Compared against the LIVE row, not the snapshot: a field that already holds
 * the requested value is skipped, so a repeat submit posts nothing. Every value
 * is validated before the first write, because each field is its own
 * transaction and a refusal half-way would leave the deposit half-corrected —
 * which is also why increases are applied before decreases: moving 10,000 from
 * Cash to Bank never passes through an all-zero deposit the database refuses.
 */
async function amendCashDeposit(
  req: AuthRequest,
  ticket: Record<string, any>,
  snapshot: SupportReference,
  edits: Record<string, string | number>,
  note: string,
): Promise<{ changes: CashDepositAmendment[] } | { status: number; error: string }> {
  const { data: live, error: liveErr } = await withoutDeleted(
    db
      .from('cash_transfers')
      .select('id, transfer_no, status, amount, note, cash_amount, easypaisa_amount, bank_amount, fuel_charges, business_date')
      .eq('id', snapshot.entityId),
  ).maybeSingle();
  if (liveErr) throw liveErr;
  if (!live) {
    return { status: 409, error: `${ticket.reference_id} has been deleted, so there is nothing left to correct.` };
  }
  if (live.status === 'rejected') {
    return {
      status: 409,
      error: `${live.transfer_no} was rejected and is final — nothing was booked for it. The branch records a new deposit instead.`,
    };
  }
  if ('amount' in edits || 'paymentMethod' in edits) {
    return {
      status: 400,
      error: 'Correct a cash deposit by its Cash, Easypaisa, Bank and Fuel Charges figures — the Total follows from them.',
    };
  }

  const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
  const after: Record<(typeof DEPOSIT_MONEY_FIELDS)[number], number> = {
    cashAmount: cents(live.cash_amount),
    easypaisaAmount: cents(live.easypaisa_amount),
    bankAmount: cents(live.bank_amount),
    fuelCharges: cents(live.fuel_charges),
  };

  const pending: { field: DepositField; value: string; delta: number }[] = [];
  for (const field of DEPOSIT_MONEY_FIELDS) {
    if (!(field in edits)) continue;
    const value = String(edits[field] ?? '').trim();
    const n = Number(value);
    if (!value || !Number.isFinite(n) || n < 0) {
      return { status: 400, error: `${DEPOSIT_FIELD_LABELS[field]} must be a number, 0 or more.` };
    }
    const was = cents(live[DEPOSIT_COLUMNS[field]]);
    if (cents(n) === was) continue;
    after[field] = cents(n);
    pending.push({ field, value, delta: cents(n) - was });
  }
  if ('note' in edits) {
    const value = String(edits['note'] ?? '').trim();
    if (value !== (live.note ?? '').trim()) pending.push({ field: 'note', value, delta: 0 });
  }
  // The date goes LAST (the most negative delta): an approved deposit's receipts
  // move to the corrected day, and the ones a figure change re-posted move with them.
  if ('businessDate' in edits) {
    const value = String(edits['businessDate'] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
      return { status: 400, error: 'Date must be a valid date.' };
    }
    if (value > businessDateStr()) {
      return { status: 400, error: 'The date of a cash deposit cannot be in the future.' };
    }
    if (value !== String(live.business_date)) {
      pending.push({ field: 'businessDate', value, delta: Number.NEGATIVE_INFINITY });
    }
  }

  const totalAfter = after.cashAmount + after.easypaisaAmount + after.bankAmount;
  if (totalAfter + after.fuelCharges <= 0) {
    return { status: 400, error: 'Every amount would be 0. Delete the deposit instead of zeroing it.' };
  }
  // The photo rule the branch popup follows: money beyond fuel needs evidence.
  if (totalAfter > 0 && cents(live.amount) === 0) {
    const photos = await listAttachments('cash_transfer', live.id);
    if (photos.length === 0) {
      return {
        status: 409,
        error: `${live.transfer_no} has no payment photo, so it can only carry Fuel Charges. The branch records a new deposit with the photo.`,
      };
    }
  }
  pending.sort((a, b) => b.delta - a.delta);

  const reason = [`Support query ${ticket.ticket_number}`, note?.trim()].filter(Boolean).join(' — ');
  const changes: CashDepositAmendment[] = [];
  for (const { field, value } of pending) {
    const { data, error } =
      field === 'businessDate'
        ? await db.rpc('amend_cash_transfer_date', {
            p_transfer_id: live.id,
            p_new_date: value,
            p_reason: reason,
            p_actor_id: req.user!.uid,
            p_actor_name: req.user!.email,
            p_today: businessDateStr(),
            p_max_per_day: CASH_DEPOSITS_PER_DAY,
          })
        : await db.rpc('amend_finance_record', {
            p_reference_type: 'cash_transfer',
            p_reference_id: live.id,
            p_field: field,
            p_new_value: value,
            p_reason: reason,
            p_actor_id: req.user!.uid,
            p_actor_name: req.user!.email,
            p_entry_date: businessDateStr(),
          });
    if (error) {
      // A plpgsql RAISE (P0001) is a sentence written for a person — pass it on.
      if (error.code === 'P0001') {
        const done = changes.length ? ` Already applied: ${describeDepositChange(changes)}.` : '';
        return { status: 409, error: `${error.message}${done}` };
      }
      throw error;
    }
    const result = data as CashDepositAmendment;
    changes.push({ ...result, field });

    await logFinanceAudit(req, {
      entity: 'cash_transfer',
      entityId: live.id,
      entityRef: live.transfer_no,
      action: 'updated',
      previousValues: { [field]: result.originalValue },
      newValues: {
        [field]: result.newValue,
        supportTicketNo: ticket.ticket_number,
        reason,
        ...(result.ledger?.ledgerAmended
          ? { reversalVoucherNo: result.ledger.reversalVoucherNo, correctedVoucherNo: result.ledger.correctedVoucherNo }
          : {}),
      },
    });
  }
  return { changes };
}

// PATCH /api/support/:id/figures — admin "Change" button. Applies a live edit to an
// expense's amount/description, or a correction to a branch's stock figures (New /
// Sold / Returned / Balance, as absolute targets). Anything with no correctable
// figure is recorded on the ticket for manual follow-up. Either way the ticket is
// marked resolved.
//
// A figure the caller omits is LEFT ALONE — that is what makes it safe for the
// Support Center to send only what the admin touched, so a sale rung up while the
// dialog was open is not reverted by a stale target.
router.patch('/:id/figures', requireRole('super_admin'), validate(ChangeFiguresSchema), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (refusedAsArchived(ticket, res)) return;

    const snapshot = (ticket.reference_snapshot ?? null) as SupportReference | null;

    // Is this stock query about the central POOL rather than a branch ledger?
    //
    // Two ways to tell, and both are needed. New snapshots carry the flag. Tickets
    // raised BEFORE the pool became correctable (migration 50) carry `readOnly: true`
    // and no flag at all — for those the raiser's role is equally decisive, because
    // a production user's stock lookup has only ever resolved to the pool.
    //
    // This is also the guard that keeps a pool correction off a shop's ledger: a
    // production account may legally carry a branchId (the user schema makes it
    // merely nullable) which POST /api/support stamps onto the ticket, so the branch
    // path below must never be reachable for a pool ticket.
    const isPoolStock =
      snapshot?.type === 'stock' &&
      (snapshot.isProductionPool === true || ticket.raised_by_role === 'production_user');

    // Read-only references have nothing to write back — demands and Production
    // counter sales. A legacy pool ticket is exempt: its snapshot says read-only
    // only because the pool had no correction function when it was raised, and it
    // is re-read live before anything is written.
    //
    // A cash deposit is exempt too: tickets raised before deposits became
    // correctable froze `readOnly: true` for every CT-, and whether one can be
    // corrected is a question about the LIVE row — amend_finance_record refuses
    // a rejected or deleted deposit with its own message.
    const isCashDeposit = snapshot?.type === 'cash_transfer';
    if (snapshot?.readOnly && !isPoolStock && !isCashDeposit) {
      res.status(400).json({
        error: 'This reference is informational only and cannot be corrected here. Reply to the query and resolve it instead.',
      });
      return;
    }

    const { edits, note } = req.body as { edits: Record<string, string | number>; note: string };
    const allowed = new Set((snapshot?.editableFields ?? []).map((f) => f.key));

    let applied = false;
    // Set when a stock path ran, so the note and the response report the REAL
    // before/after rather than echoing back what the admin typed.
    let stockResult: (StockCorrectionResult & { productName: string }) | null = null;
    let poolResult: (ProductionStockCorrectionResult & { productName: string }) | null = null;
    let depositResult: CashDepositAmendment[] | null = null;

    // The pool first — a pool ticket is `type === 'stock'` too, and the branch path
    // below would otherwise claim it.
    if (isPoolStock) {
      // Absolute targets, as on the branch. `totalStock` is not among them: it is
      // opening + prepared, with no movement of its own to book against. Nor is
      // `returned`: a return is Branch Return Stock, not a pool figure, and the
      // RPC's `returned` target would book it straight into the pool.

      const targets: ProductionStockCorrectionTargets = {};
      for (const key of ['preparedToday', 'approvedQty', 'soldToday', 'balance'] as const) {
        const raw = edits[key];
        if (raw === undefined || raw === '') continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          res.status(400).json({ error: `${PRODUCTION_FIGURE_LABELS[key]} must be a number.` });
          return;
        }
        // The three movement figures are counts and cannot be negative. Balance
        // can: the pool is allowed to run negative (migration 15) and does, so
        // refusing one would make an already-negative product impossible to
        // correct.
        if (key !== 'balance' && value < 0) {
          res.status(400).json({ error: `${PRODUCTION_FIGURE_LABELS[key]} must be a number of 0 or more.` });
          return;
        }
        targets[key] = value;
      }
      if (Object.keys(targets).length === 0) {
        res.status(400).json({ error: 'Enter at least one stock figure to correct.' });
        return;
      }

      // Re-read the name rather than trusting the snapshot's — the history keeps a
      // name snapshot, and it should read as the name at correction time.
      const { data: product, error: prodErr } = await db
        .from('products')
        .select('name')
        .eq('id', snapshot!.entityId)
        .maybeSingle();
      if (prodErr) throw prodErr;
      if (!product) { res.status(404).json({ error: 'The linked product no longer exists' }); return; }

      try {
        const result = await applyProductionStockCorrection({
          productId: snapshot!.entityId,
          productName: product.name as string,
          targets,
          ticketId: ticket.id as string,
        });
        poolResult = { ...result, productName: product.name as string };
        applied = result.applied;
      } catch (err) {
        // The one failure that is a deploy step rather than a bug — say so, and
        // leave the ticket open so it can simply be retried afterwards.
        if (err instanceof CorrectionUnavailableError) {
          res.status(503).json({ error: err.message });
          return;
        }
        throw err;
      }
    } else if (snapshot?.type === 'stock') {
      // The branch comes from the TICKET. The figures describe one branch's
      // ledger — the raiser's — and that is the only one this correction may move.
      const branchId = ticket.branch_id as string | null;
      if (!branchId) {
        res.status(400).json({ error: 'This query has no branch, so there is no branch stock to correct.' });
        return;
      }

      // Absolute targets, not deltas: the admin enters the figures as they should
      // read. `opening` is honoured too (migration 79), but it is the one figure
      // whose movement lands on the PREVIOUS business day, because that is the day
      // it describes — the RPC refuses it if that day has been closed.
      const targets: StockCorrectionTargets = {};
      for (const key of ['opening', 'newQty', 'sold', 'returned', 'adjustment', 'balance'] as const) {
        const raw = edits[key];
        if (raw === undefined || raw === '') continue;
        const value = Number(raw);
        // Adjustment is signed — a correction can take stock away as well as add
        // it, and 0 is how one is cleared. The rest are counts and cannot be < 0.
        const signed = SIGNED_STOCK_FIGURES.has(key);
        if (!Number.isFinite(value) || (!signed && value < 0)) {
          res.status(400).json({
            error: signed
              ? `${STOCK_FIGURE_LABELS[key]} must be a number.`
              : `${STOCK_FIGURE_LABELS[key]} must be a number of 0 or more.`,
          });
          return;
        }
        targets[key] = value;
      }
      // Caught here as well as in the RPC so the admin gets the message without a
      // round trip that writes nothing.
      if (targets.balance !== undefined && targets.adjustment !== undefined) {
        res.status(400).json({ error: 'Set either Balance or Adjustment, not both — each one determines the other.' });
        return;
      }
      if (Object.keys(targets).length === 0) {
        res.status(400).json({ error: 'Enter at least one stock figure to correct.' });
        return;
      }

      // Re-read the name rather than trusting the snapshot's — stock_history keeps
      // a name snapshot, and it should read as the name at correction time.
      const { data: product, error: prodErr } = await db
        .from('products')
        .select('name')
        .eq('id', snapshot.entityId)
        .maybeSingle();
      if (prodErr) throw prodErr;
      if (!product) { res.status(404).json({ error: 'The linked product no longer exists' }); return; }

      try {
        const result = await applyStockCorrection({
          branchId,
          productId: snapshot.entityId,
          productName: product.name as string,
          targets,
          ticketId: ticket.id as string,
        });
        stockResult = { ...result, productName: product.name as string };
        applied = result.applied;
      } catch (err) {
        if (err instanceof OverdeterminedCorrectionError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err instanceof DayClosedError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof NegativeBalanceError) {
          res.status(409).json({ error: `${err.message} A branch balance cannot go below zero.` });
          return;
        }
        throw err;
      }
    } else if (isCashDeposit && snapshot) {
      const outcome = await amendCashDeposit(req, ticket, snapshot, edits, note);
      if ('error' in outcome) { res.status(outcome.status).json({ error: outcome.error }); return; }
      depositResult = outcome.changes;
      applied = depositResult.length > 0;
    } else if (snapshot?.entityTable && LIVE_EDITABLE_TABLES.has(snapshot.entityTable) && allowed.size > 0) {
      // Live mutation — only expense columns are ever in `allowed` here.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(edits)) {
        if (!allowed.has(k)) continue;
        patch[k] = k === 'amount' ? Number(v) : v;
      }
      if (Object.keys(patch).length > 0) {
        const { error } = await db.from(snapshot.entityTable).update(patch).eq('id', snapshot.entityId);
        if (error) throw error;
        applied = true;
      }
    }

    // Compose an audit-friendly resolution note describing what changed. The stock
    // path words its own: `applied` is false there when the figures already matched,
    // which is a no-op rather than a pending manual follow-up.
    const changeLines = Object.entries(edits)
      .filter(([k]) => allowed.size === 0 || allowed.has(k))
      .map(([k, v]) => `${k} → ${v}`);
    const summary = depositResult
      ? depositResult.length > 0
        ? `Cash deposit ${ticket.reference_id} corrected: ${describeDepositChange(depositResult)}`
        : `Cash deposit ${ticket.reference_id} already matched — nothing to correct`
      : stockResult
      ? stockResult.applied
        ? `Branch stock corrected for ${stockResult.productName}: ${describeStockChange(stockResult)}`
        : `Branch stock for ${stockResult.productName} already matched — nothing to correct`
      : poolResult
        ? poolResult.applied
          ? `Production stock corrected for ${poolResult.productName}: ${describeProductionChange(poolResult)}`
          : `Production stock for ${poolResult.productName} already matched — nothing to correct`
        : `${applied ? 'Figures updated' : 'Correction recorded (manual follow-up)'}: ${changeLines.join(', ')}`;
    const resolutionNote = [note, summary].filter(Boolean).join(' — ');

    const { data, error } = await db
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} resolved`,
          message: resolutionNote || `Your query on ${data.reference_id} was resolved.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    // `stock` stays the BRANCH result so existing clients are untouched; a pool
    // correction reports under its own key with its own (different) figure shape.
    res.json({ ticket: rowToApi(data), applied, stock: stockResult, productionStock: poolResult, cashDeposit: depositResult });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/support/:id/sale-items — admin "Change" for a SALE query. Applies a
// live edit to the order's line items (product / qty / unit price, add / remove),
// recomputing order totals and reconciling stock atomically via edit_sale_items,
// optionally re-tenders the sale (paymentMethod), then resolves the ticket.
// Overdrawing a branch balance is rejected (409).
router.patch('/:id/sale-items', requireRole('super_admin'), validate(EditSaleItemsSchema), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (refusedAsArchived(ticket, res)) return;
    if (ticket.reference_type !== 'sale') { res.status(400).json({ error: 'Only sale queries support line-item edits' }); return; }

    const snapshot = (ticket.reference_snapshot ?? null) as SupportReference | null;

    // A Production counter sale. edit_sale_items reconciles branch `stock` keyed on
    // orders.branch_id, and the sentinel branch these are booked to has no stock
    // rows — so a qty increase would 409 with a bogus "not enough stock" and a
    // decrease would INSERT phantom branch inventory, while the pool the units
    // actually came from stayed untouched.
    if (snapshot?.readOnly) {
      res.status(400).json({
        error: 'This sale was rung up at the Production counter, so its items cannot be corrected here. Reply to the query and resolve it instead.',
      });
      return;
    }

    const orderId = snapshot?.entityId;
    if (!orderId) { res.status(400).json({ error: 'This ticket has no linked sale to edit' }); return; }

    const { items, paymentMethod, note } = req.body as {
      items: unknown[];
      paymentMethod?: PaymentMethod;
      note: string;
    };

    const { data: result, error } = await db.rpc('edit_sale_items', {
      p_order_id: orderId,
      p_items: items,
      p_business_date: businessDateStr(),
    });
    if (error) throw error;

    const outcome = (result ?? {}) as { status?: string; shortfalls?: unknown; grandTotal?: number };
    if (outcome.status === 'not_found') { res.status(404).json({ error: 'The linked sale no longer exists' }); return; }
    if (outcome.status === 'insufficient') {
      const shortfalls = (outcome.shortfalls ?? []) as Array<{ productName: string; requested: number; available: number }>;
      const detail = shortfalls.map((s) => `${s.productName} (need ${s.requested}, have ${s.available})`).join('; ');
      res.status(409).json({ error: `Not enough stock: ${detail}`, shortfalls: outcome.shortfalls });
      return;
    }

    // Payment method rides alongside the line edit but is deliberately NOT part of
    // edit_sale_items: it touches no stock, no line total and no grand total, so it
    // needs none of that function's locking. `.neq` makes the write self-checking —
    // rows come back only when the tender actually moved, so the resolution note
    // can't claim a change that did not happen (the snapshot may be stale).
    //
    // Ordered after the RPC on purpose: the item edit is the part that can fail
    // (insufficient stock → 409), and it must fail before anything else is written.
    // If this update itself errors the ticket stays open and the admin retries —
    // re-running edit_sale_items with the same lines is a no-op (delta 0 moves no
    // stock and the recomputed totals are identical).
    let paymentChanged = false;
    if (paymentMethod) {
      const { data: repaid, error: payErr } = await db
        .from('orders')
        .update({ payment_method: paymentMethod })
        .eq('id', orderId)
        .neq('payment_method', paymentMethod)
        .select('id');
      if (payErr) throw payErr;
      paymentChanged = (repaid ?? []).length > 0;
    }

    // Record what changed and resolve the ticket in one update.
    const resolutionNote = [
      note,
      `Sale items updated (new total ${money(outcome.grandTotal)})`,
      paymentChanged ? `Payment method → ${paymentMethod}` : '',
    ].filter(Boolean).join(' — ');
    const { data, error: updErr } = await db
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (updErr) throw updErr;

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} resolved`,
          message: resolutionNote || `Your query on ${data.reference_id} was resolved.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data), applied: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/support/:id/demand-items — admin "Change" for a DEMAND query.
// Rewrites the demand's product lines (add / remove / change requested and
// approved qty) via correct_production_order, reconciles stock if the order
// already delivered, then resolves the ticket.
router.patch('/:id/demand-items', requireRole('super_admin'), validate(EditDemandItemsSchema), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (refusedAsArchived(ticket, res)) return;
    if (ticket.reference_type !== 'demand') {
      res.status(400).json({ error: 'Only demand queries support line edits here' });
      return;
    }

    const snapshot = (ticket.reference_snapshot ?? null) as SupportReference | null;
    if (snapshot?.readOnly) {
      res.status(400).json({ error: 'This demand was rejected or cancelled, so its lines cannot be corrected. Reply to the query and resolve it instead.' });
      return;
    }

    // Already-resolved tickets are refused, and that is what makes the retry story
    // below sound. The compensating movements are keyed on THIS TICKET's id, so
    // they are idempotent on (ref_id, product_id, type):
    //
    //   · a run that dies halfway leaves the ticket 'open' (the resolve is the last
    //     write), so retrying re-applies the same ref, completes the products that
    //     never moved and no-ops the ones that did.
    //   · a run that succeeds flips it to 'resolved', and a SECOND correction from
    //     the same ticket would compute fresh deltas but reuse that ref — every
    //     movement would silently no-op and the admin would see figures that did
    //     not change. Refusing here is what stops that.
    //
    // Correcting the same demand twice is legitimate; it just needs its own query,
    // which gives it its own ref.
    if (ticket.status === 'resolved') {
      res.status(409).json({ error: 'This query has already been corrected. Raise a new query to correct this demand again.' });
      return;
    }

    const orderId = snapshot?.entityId;
    if (!orderId) { res.status(400).json({ error: 'This ticket has no linked demand to edit' }); return; }

    const { items, reason, note } = req.body as {
      items: { productId: string; productName: string; qty: number; approvedQty: number }[];
      reason: string;
      note: string;
    };

    // Guard the caller's own input before the RPC: two lines for the same product
    // would make "the final state" ambiguous, and the function would apply
    // whichever the update happened to see last.
    const ids = items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) {
      res.status(400).json({ error: 'The same product appears more than once. Combine those lines into one.' });
      return;
    }

    const { data: result, error } = await db.rpc('correct_production_order', {
      p_order_id: orderId,
      p_lines: items,
      p_reason: reason || '',
      p_actor_name: req.user!.email ?? '',
    });
    if (error) throw error;

    const outcome = (result ?? {}) as {
      status?: string;
      orderStatus?: string;
      branchId?: string;
      branchName?: string | null;
      stockMoved?: boolean;
      deltas?: { productId: string; productName: string; delta: number | string }[];
    };
    if (outcome.status === 'not_found') { res.status(404).json({ error: 'The linked demand no longer exists' }); return; }
    if (outcome.status === 'empty') { res.status(400).json({ error: 'A demand must keep at least one product' }); return; }
    if (outcome.status === 'not_correctable') {
      res.status(400).json({ error: `This demand is ${outcome.orderStatus} — it committed to nothing and moved no stock, so there is nothing to correct.` });
      return;
    }

    // ── Reconcile, but only if this order actually delivered ─────────────────
    // The RPC returns deltas ONLY when the ledger shows units were credited for
    // this order; otherwise the line edit is the whole correction, because
    // verification has not run yet and will move whatever approved_qty now says.
    //
    // The ref_id must differ from the order id — both ledgers are idempotent on
    // (ref_id, product_id, type) and the original delivery is keyed on the bare
    // order id, so reusing it would silently no-op every correction. It must also
    // be STABLE across a retry, which is why it is the ticket's id and not a fresh
    // uuid: see the already-resolved guard above for the full argument.
    const deltas = (outcome.deltas ?? [])
      .map((d) => ({ ...d, delta: Number(d.delta) }))
      .filter((d) => d.delta !== 0);

    if (deltas.length && outcome.branchId) {
      const refId = `${orderId}:fix:${ticket.id}`;
      for (const d of deltas) {
        // Branch gains what the pool loses. 'adjustment' on both sides: this is an
        // admin correction, not a fresh production run or a return.
        await applyStockMovement({
          branchId: outcome.branchId,
          productId: d.productId,
          productName: d.productName,
          delta: d.delta,
          type: 'adjustment',
          refId,
        });
        await applyProductionStockMovement({
          productId: d.productId,
          productName: d.productName,
          delta: -d.delta,
          type: 'adjustment',
          refId,
        });
      }
    }

    const moved = deltas.map((d) => `${d.productName} ${d.delta > 0 ? '+' : ''}${d.delta}`).join(' · ');
    const resolutionNote = [
      note,
      `Demand lines updated (${items.length} product${items.length === 1 ? '' : 's'})`,
      deltas.length ? `stock reconciled — ${moved}` : 'no stock movement (this demand had not delivered)',
    ].filter(Boolean).join(' — ');

    const { data, error: updErr } = await db
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (updErr) throw updErr;

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} resolved`,
          message: resolutionNote || `Your query on ${data.reference_id} was resolved.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data), applied: true, stockMoved: deltas.length > 0, deltas });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/support/:id/demand — destroy the demand this query was raised
 * against, reversing whatever it delivered.
 *
 * The escalation from PATCH /:id/demand-items above. That editor answers "these
 * quantities are wrong"; this answers "this demand was verified and it should
 * never have been", which no set of corrected lines can express — the editor
 * refuses an empty line list, and a line left at zero still leaves a document
 * asserting a delivery that did not happen.
 *
 * Unlike the line editor this does NOT refuse a rejected or cancelled demand.
 * That gate exists there because editing such a demand's lines would produce a
 * document claiming a commitment that was never made; deleting one makes no
 * claim at all, and those demands moved no stock, so the reversal simply comes
 * back empty.
 *
 * Everything destructive happens inside delete_production_order (migration 82),
 * in one transaction: reverse both ledgers, snapshot to audit_logs, drop the
 * row. The reversal is NOT applied here the way the correction route applies
 * its deltas — see that migration's header for why a delete cannot use the
 * retryable split.
 */
router.delete('/:id/demand', requireRole('super_admin'), validate(DeleteDemandSchema), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (refusedAsArchived(ticket, res)) return;
    if (ticket.reference_type !== 'demand') {
      res.status(400).json({ error: 'Only demand queries can delete a demand' });
      return;
    }

    const snapshot = (ticket.reference_snapshot ?? null) as SupportReference | null;
    const orderId = snapshot?.entityId;
    if (!orderId) { res.status(400).json({ error: 'This ticket has no linked demand to delete' }); return; }

    const { reason, confirmDemandNumber, note } = req.body as {
      reason: string;
      confirmDemandNumber: string;
      note: string;
    };

    // Re-checked here rather than trusted to the client: this is the only
    // irreversible action in the Support Center, and the confirmation is
    // worthless if the thing being confirmed is whatever the browser chose to
    // send. Compared against the ticket's own reference, which is the number the
    // admin is looking at.
    if (confirmDemandNumber.trim().toUpperCase() !== String(ticket.reference_id ?? '').trim().toUpperCase()) {
      res.status(400).json({ error: `Type ${ticket.reference_id} exactly to confirm the deletion.` });
      return;
    }

    // Distinct from the correction's ':fix:' family so it can never collide with
    // the original delivery or with an earlier correction — both ledgers are
    // idempotent on (ref_id, product_id, type), and a reused ref would silently
    // no-op the whole reversal. Keyed on the ticket so the audit row, the
    // ledger entries and the query that authorised them all agree.
    const refId = `${orderId}:del:${ticket.id}`;

    // A discount claim holds its demand with ON DELETE RESTRICT (migration 93) —
    // deliberately, the claim is evidence about the delivery. Left to the RPC the
    // refusal surfaced as a bare foreign-key error, masked in production as
    // "Internal server error". Say why, and what to do about it.
    const { data: discounts, error: discErr } = await db
      .from('branch_discounts')
      .select('status')
      .eq('production_order_id', orderId);
    if (discErr) throw discErr;
    if (discounts && discounts.length > 0) {
      const open = discounts.filter((d) => d.status === 'pending' || d.status === 'returned').length;
      const decided = discounts.length - open;
      const parts = [
        open ? `${open} open` : '',
        decided ? `${decided} approved/rejected` : '',
      ].filter(Boolean).join(' and ');
      res.status(409).json({
        error: `${ticket.reference_id} cannot be deleted: it has ${parts} discount claim${discounts.length === 1 ? '' : 's'} against it. `
          + (decided
            ? 'A decided discount keeps its demand on the record.'
            : 'The branch must withdraw the discount first.'),
      });
      return;
    }

    const { data: result, error } = await db.rpc('delete_production_order', {
      p_order_id: orderId,
      p_reason: reason,
      p_ref_id: refId,
      p_actor_id: req.user!.uid,
      p_actor_name: req.user!.email ?? '',
    });
    // Anything else still pointing at the demand (or a discount raised between the
    // check above and the delete). The transaction rolled back, so nothing moved.
    if (error && (error as { code?: string }).code === '23503') {
      res.status(409).json({ error: `${ticket.reference_id} cannot be deleted: other records still refer to it. Nothing was changed.` });
      return;
    }
    if (error) throw error;

    const outcome = (result ?? {}) as {
      status?: string;
      demandNumber?: string;
      branchName?: string | null;
      orderStatus?: string;
      stockMoved?: boolean;
      branchReversals?: { productId: string; productName: string; delta: number | string }[];
      poolReversals?: { productId: string; productName: string; delta: number | string }[];
    };

    // Already gone — a double submit, or a demand deleted from another tab. Not
    // an error worth a 500, but the admin must not be told it just happened.
    if (outcome.status === 'not_found') {
      res.status(404).json({ error: 'That demand no longer exists — it may already have been deleted.' });
      return;
    }

    const branchRev = (outcome.branchReversals ?? []).map((d) => ({ ...d, delta: Number(d.delta) }));
    const reversed = branchRev.map((d) => `${d.productName} ${d.delta > 0 ? '+' : ''}${d.delta}`).join(' · ');
    const resolutionNote = [
      note,
      `Demand ${outcome.demandNumber ?? ticket.reference_id} DELETED — ${reason}`,
      branchRev.length ? `stock reversed — ${reversed}` : 'no stock to reverse (this demand had not delivered)',
    ].filter(Boolean).join(' — ');

    const { data, error: updErr } = await db
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (updErr) throw updErr;

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Demand ${outcome.demandNumber ?? ticket.reference_id} deleted`,
          message: resolutionNote,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({
      ticket: rowToApi(data),
      deleted: true,
      demandNumber: outcome.demandNumber ?? null,
      stockMoved: outcome.stockMoved === true,
      branchReversals: branchRev,
      poolReversals: (outcome.poolReversals ?? []).map((d) => ({ ...d, delta: Number(d.delta) })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/support/:id/cash-deposit — delete the cash deposit this query was
 * raised against (the Support Center's "Delete record" / "Delete data").
 *
 * Goes through soft_delete_finance_record, the Finance Help Desk's own delete,
 * so both desks mean the same thing by it. Since migration 125 that removes the
 * deposit AND every ledger entry it produced in one transaction, recomputes the
 * running balance, and posts nothing in their place — no reversal, no credit.
 * Any status may be deleted: a pending or rejected deposit simply has no
 * ledger entries to remove.
 *
 * A second delete (double submit, another tab) finds the deposit already gone
 * and answers 409 without touching the ledger or the query.
 */
router.delete('/:id/cash-deposit', requireRole('super_admin'), validate(DeleteCashDepositSchema), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (refusedAsArchived(ticket, res)) return;
    if (ticket.reference_type !== 'cash_transfer') {
      res.status(400).json({ error: 'Only cash deposit queries can delete a cash deposit' });
      return;
    }

    const snapshot = (ticket.reference_snapshot ?? null) as SupportReference | null;
    const transferId = snapshot?.entityId;
    if (!transferId) { res.status(400).json({ error: 'This ticket has no linked cash deposit to delete' }); return; }

    const { reason, confirmTransferNo, note } = req.body as { reason: string; confirmTransferNo: string; note: string };

    // Re-checked here, as for a demand: the confirmation is worthless if the
    // thing confirmed is whatever the browser chose to send.
    if (confirmTransferNo.trim().toUpperCase() !== String(ticket.reference_id ?? '').trim().toUpperCase()) {
      res.status(400).json({ error: `Type ${ticket.reference_id} exactly to confirm the deletion.` });
      return;
    }

    const { data: removed, error } = await db.rpc('soft_delete_finance_record', {
      p_reference_type: 'cash_transfer',
      p_reference_id: transferId,
      p_reason: [`Support query ${ticket.ticket_number}`, reason].join(' — '),
      p_actor_id: req.user!.uid,
      p_actor_name: req.user!.email,
      // deleted_query_id names a Finance Help Desk query; a support ticket is
      // not one, so it goes by number only.
      p_query_id: null,
      p_query_no: ticket.ticket_number,
    });
    if (error) throw error;

    const outcome = (removed ?? {}) as {
      deleted?: boolean;
      referenceNo?: string;
      ledgerRemoved?: string | null;
      balancesRewritten?: number;
      closingBalance?: number | null;
      reason?: string;
    };
    if (!outcome.deleted) {
      res.status(409).json({ error: `${ticket.reference_id} is already deleted — there is nothing left to remove.` });
      return;
    }
    const transferNo = outcome.referenceNo ?? String(ticket.reference_id ?? '');

    await logFinanceAudit(req, {
      entity: 'cash_transfer',
      entityId: transferId,
      entityRef: transferNo,
      action: 'deleted',
      newValues: {
        softDeleted: true,
        deletedVia: 'support_center',
        supportTicketNo: ticket.ticket_number,
        reason,
        ...(outcome.ledgerRemoved ? { ledgerEntriesRemoved: outcome.ledgerRemoved } : {}),
        ...(outcome.balancesRewritten
          ? { balancesRewritten: outcome.balancesRewritten, closingBalance: outcome.closingBalance ?? null }
          : {}),
      },
    });

    const resolutionNote = [
      note,
      `Cash deposit ${transferNo} DELETED — ${reason}`,
      outcome.ledgerRemoved
        ? `ledger entries removed: ${outcome.ledgerRemoved}`
        : 'nothing was booked in the ledger for it',
    ].filter(Boolean).join(' — ');

    const { data, error: updErr } = await db
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (updErr) throw updErr;

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Cash deposit ${transferNo} deleted`,
          message: resolutionNote,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({
      ticket: rowToApi(data),
      deleted: true,
      transferNo,
      ledgerRemoved: outcome.ledgerRemoved ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/support/:id — admin clears a query off the queue (Archive button).
//
// ARCHIVES, it does not delete (migration 76). The verb stays DELETE so the
// existing client keeps working, but the row survives: a resolved query is the
// only record of what was asked and how it was answered, and it is the audit
// anchor for anything applied from it — apply_stock_correction stamps
// '<ticket_id>:stock:<uuid>' into stock_history.ref_id, which dangles the moment
// the ticket disappears. Hard-deleting is why support_tickets was empty despite
// 35 corrections having been applied on 2026-08-16 alone.
//
// Archiving an already-archived ticket is a no-op rather than an error: the
// `.is('archived_at', null)` predicate simply matches nothing, and a second click
// should not 500.
router.delete('/:id', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { data, error } = await db
      .from('support_tickets')
      .update({
        archived_at: new Date().toISOString(),
        archived_by: req.user!.uid,
        archived_by_name: req.user!.email,
      })
      .eq('id', req.params.id)
      .is('archived_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      const { data: exists, error: exErr } = await db
        .from('support_tickets').select('id').eq('id', req.params.id).maybeSingle();
      if (exErr) throw exErr;
      if (!exists) { res.status(404).json({ error: 'Ticket not found' }); return; }
    }

    res.json({ success: true, archived: true });
  } catch (err) {
    next(err);
  }
});
