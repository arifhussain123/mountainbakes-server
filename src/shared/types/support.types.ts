// Support tickets — the Help Desk (branches / production) → Support Center (admin)
// query queue. A ticket is always raised against ONE reference ID (a sale
// MB-######, a demand DMD-######, an expense EXP-######, a product's stock
// STK-######, or a branch's cash deposit CT-######); the reference's figures are snapshotted onto the ticket at submit
// time so the admin sees exactly what the raiser saw.

import type { PaymentMethod } from './order.types';
import type { StockFigures } from './stock.types';
import type { ProductionStockFigures } from './production-ops.types';

// 'demand' is a branch's production request (production_orders.demand_number).
// It is corrected through its own editor — PATCH /api/support/:id/demand-items,
// backed by correct_production_order (migration 77) — because a demand is a
// workflow document rather than a ledger row: its lines carry BOTH a requested
// qty and an approved qty, and whether a change to the latter owes anyone stock
// depends on whether the order was ever delivered. A rejected or cancelled
// demand stays uncorrectable; see `readOnly` below.
//
// 'system' is not raised by a human against a lookupable ID — it is opened
// automatically when an unattended job fails (e.g. the 2 AM closing summary could
// not be generated or delivered). Such a ticket has no editable reference, so its
// referenceSnapshot is null and the failure detail lives in `message`.
//
// 'cash_transfer' is a branch's cash deposit (cash_transfers.transfer_no, CT-).
// Its Cash, Easypaisa, Bank, Fuel Charges and note are corrected through
// PATCH /:id/figures, which calls amend_finance_record — the Finance Help
// Desk's function — so an approved deposit's RV- receipt for each changed
// figure is reversed and re-posted with it (migration 121). A rejected deposit
// is final and read-only.
export type SupportReferenceType = 'sale' | 'demand' | 'expense' | 'stock' | 'cash_transfer' | 'system';
export type SupportTicketStatus = 'open' | 'resolved' | 'rejected';

/** One key/value line of the auto-shown reference detail. */
export interface SupportDetailField {
  label: string;
  value: string;
}

/** A field the admin may directly correct on the underlying record. */
export interface SupportEditableField {
  key: string;
  label: string;
  kind: 'number' | 'text';
  value: string | number;
}

/**
 * One editable line of a sale (order_items row). Carried on a sale reference so
 * the Support Center can change the product, qty, unit price or discount of each
 * line and apply it live via edit_sale_items — the same four values the branch's
 * Sale view prints per line. `unitPrice` is the per-unit rate; `discount` is the
 * whole-line discount, exactly as order_items stores it.
 */
export interface SupportSaleItem {
  productId: string | null;
  productName: string;
  categoryId: string | null;
  categoryName: string | null;
  unitPrice: number;
  qty: number;
  discount: number;
}

/**
 * For sale references: the order's money row and the two rates that produce it.
 * Carried so the Support Center shows the same totals the branch sees on the
 * sale, and can preview what an edit will recompute — `taxRate` and
 * `deliveryCharges` are the components edit_sale_items keeps, so the previewed
 * grand total is derived exactly as the server will derive it.
 *
 * `subtotal` is NET of line discounts (Σ line_total), matching orders.subtotal —
 * the branch's view prints the gross by adding `discountTotal` back.
 */
export interface SupportSaleTotals {
  subtotal: number;
  discountTotal: number;
  deliveryCharges: number;
  taxRate: number;
  taxAmount: number;
  grandTotal: number;
}

/**
 * One editable line of a demand (production_order_items row). `qty` is what the
 * branch asked for; `approvedQty` is what Production granted, and it is the
 * figure that actually moves stock at verification — so it is the one a
 * correction reconciles against.
 */
export interface SupportDemandItem {
  productId: string;
  productName: string;
  qty: number;
  approvedQty: number;
}

/**
 * The resolved detail for a reference ID. Rendered auto-adjusted in both the
 * Help Desk (before submit) and the Support Center (on the ticket), and stored
 * on the ticket as `referenceSnapshot`.
 */
export interface SupportReference {
  type: SupportReferenceType;
  referenceId: string;
  /** Human summary line, e.g. "Sale MB-000125 — Ali Raza · Rs.1,250". */
  title: string;
  fields: SupportDetailField[];
  /**
   * Directly editable fields, applied live by PATCH /api/support/:id/figures.
   * Expenses expose `amount` / `description`. A branch-scoped stock reference
   * exposes `newQty` / `sold` / `returned` / `balance` — ABSOLUTE targets, from
   * which the server sizes a compensating movement per figure. (`opening` is
   * deliberately absent: it is the previous day's closing.) Empty means "nothing
   * here can be written directly", and the correction is only recorded.
   */
  editableFields: SupportEditableField[];
  /**
   * True when the reference is INFORMATIONAL ONLY: nothing here may be written
   * back, so the Support Center offers no editor and PATCH /figures,
   * /sale-items and /demand-items all refuse it outright.
   *
   * Set for:
   *   · counter sales      — their units left `production_stock`, but
   *                          edit_sale_items reconciles branch `stock`. Applying
   *                          one would invent branch inventory (the sentinel
   *                          branch has no stock rows) and leave the pool wrong.
   *   · rejected deposits  — a rejected CT- transfer is final; nothing was
   *                          booked, and the branch records a new one.
   *   · rejected/cancelled — a demand that was refused committed to nothing and
   *     demands             moved nothing; editing its lines would produce a
   *                          document claiming otherwise. correct_production_order
   *                          refuses these independently (migration 77).
   *
   * Opt-in and absent-means-false ON PURPOSE: every snapshot written before this
   * field existed keeps its current behaviour, including legacy stock tickets that
   * carry an empty editableFields and are still corrected through StockFiguresDialog.
   */
  readOnly?: boolean;
  /**
   * True when a STOCK reference describes the central production pool rather than
   * a branch ledger. It is what routes the correction to
   * apply_production_stock_correction instead of apply_stock_correction — a
   * distinction the caller's ROLE cannot safely make, because a production account
   * may legally carry a branchId, which would otherwise send a pool correction into
   * an unrelated shop's ledger.
   *
   * Pool tickets raised BEFORE this field existed carry `readOnly: true` and no
   * flag; the Support Center recognises those by the ticket's raiser role, which is
   * equally decisive (a production user's stock lookup always resolves to the pool).
   */
  isProductionPool?: boolean;
  /**
   * For sale references: the current line items, editable in the Support Center
   * and applied live (product / qty / unit price / discount) via edit_sale_items.
   */
  saleItems?: SupportSaleItem[];
  /**
   * For sale references: the order's totals, so the Support Center can show the
   * same money row the branch sees and preview the recomputed grand total as the
   * admin edits the lines.
   */
  saleTotals?: SupportSaleTotals;
  /**
   * For sale references: the order's payment method at snapshot time. The Support
   * Center can change it alongside the line items — a wrong tender (cash booked as
   * Easypaisa, say) is the other half of "this sale is recorded wrong", and it moves
   * the day's payment-method totals without touching stock or the grand total.
   */
  paymentMethod?: PaymentMethod;
  /**
   * For demand references: the order's current product lines, editable in the
   * Support Center and applied live (add / remove / change qty and approved qty)
   * via correct_production_order.
   */
  demandItems?: SupportDemandItem[];
  /**
   * For demand references: whether this order has ALREADY credited units to the
   * branch — i.e. whether a change to `approvedQty` owes a compensating stock
   * movement on both the branch ledger and the production pool.
   *
   * Derived from stock_history, NOT from `status`. The status column cannot
   * answer this: verification sets 'verified', but Production's final approval
   * then flips it back to 'approved', so a delivered order and a never-delivered
   * one both read 'approved'. See migration 77's header.
   *
   * Advisory only — the snapshot may be hours old, so the server recomputes it
   * inside correct_production_order before moving anything. It is carried so the
   * Support Center can warn the admin that an edit will move real stock.
   */
  demandStockMoved?: boolean;
  /**
   * For cash deposit references: whether the deposit is approved, i.e. has an
   * RV- receipt in the Daily Ledger. Changing one of its figures then
   * reverses that figure's receipt and posts a fresh one, which the Support Center
   * warns about before applying.
   */
  cashTransferApproved?: boolean;
  /**
   * For cash deposit references: whether Finance rejected the deposit. It can
   * still be corrected, and the Support Center may approve it (rejected →
   * approved, which books its RV- receipts) or delete it.
   */
  cashTransferRejected?: boolean;
  /** Internal uuid of the underlying row, used when applying a figure edit. */
  entityId: string;
  /** For expenses: which table the row lives in, so the figure edit hits the right one. */
  entityTable?: string;
  /**
   * For stock references: whose ledger the figures describe. A stock correction has
   * to land on exactly one branch, and this is it — the raiser's branch, or the
   * branch an admin scoped the lookup to. Null when the reference is an
   * all-branches total, which is not correctable.
   */
  branchId?: string | null;
  /** For stock references: the business date the figures were computed for. */
  businessDate?: string;
  /**
   * For branch-scoped stock references: the branch's live derived figures, so the
   * Support Center can show the whole row and recompute the implied balance as the
   * admin edits. Absent on an all-branches (uncorrectable) stock reference.
   */
  stockFigures?: StockFigures;
  /**
   * For production-pool stock references: the pool's live derived figures. The
   * pool's counterpart of `stockFigures` — a different SHAPE, not a different
   * source, which is why it is a separate field: rendering pool numbers through the
   * branch row would mislabel Approved Qty as New Stock.
   */
  productionFigures?: ProductionStockFigures;
}

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  referenceType: SupportReferenceType;
  referenceId: string;
  referenceSnapshot: SupportReference | null;
  message: string;
  status: SupportTicketStatus;
  resolutionNote: string | null;
  branchId: string | null;
  branchName: string | null;
  raisedBy: string | null;
  raisedByName: string | null;
  raisedByRole: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
