import { dbFor } from '../db';
import { resolveShareSplit, type PaymentReceivedItem } from '../shared';
import { paymentsReceivedInWindow } from './cash-transfers.service';

const db = dbFor('previous-balance');

/**
 * What a branch owes for the delivery immediately preceding a given production
 * order — the figures the company copy of that order's slip prints.
 *
 * Extracted verbatim from GET /api/production-orders/:id/previous-balance so the
 * Collections export can bill exactly what the slip bills. It is deliberately
 * NOT re-derived there: the returns/discounts window below is bounded by the two
 * orders' `submitted_at` timestamps, and the comments on it record two separate
 * bugs caused by a day-based window instead. One implementation, one set of
 * windows, no drift between the slip and the spreadsheet.
 */
export interface PreviousOrderBalance {
  previous: { demandNumber: string; date: string } | null;
  /**
   * What the previous demand was ASKED for — its lines at requested quantity.
   *
   * The counterpart to `deliveredValue`, which is the same lines at approved
   * quantity. The pair is what makes a short delivery legible on the slip: the
   * branch ordered this much, that much actually went out, and the share is taken
   * from the second. Nothing bills against this figure — it is context for the
   * one that does.
   *
   * Valued on the same basis as `deliveredValue`, deliberately. Two adjacent
   * figures on a document settled in cash have to be comparable, and a difference
   * between them must mean a difference in QUANTITY rather than in how each was
   * priced. See the note on the valuation basis where they are both computed.
   */
  orderedValue: number;
  deliveredValue: number;
  companySharePct: number;
  companyShareValue: number;
  returnsValue: number;
  returnItems: { productName: string; qty: number; amount: number }[];
  discountsValue: number;
  discountItems: { demandNumber: string; amount: number }[];
  amountToCollect: number;
  /**
   * Approved cash transfers (migration 118) the branch made in the same window
   * the returns and discounts above are drawn from, completed to whole days:
   * every other deposit dated the same day as one of them is included, so
   * several handovers in one day show as that day's full sum. DISPLAYED, NOT DEDUCTED:
   * `amountToCollect` is unchanged by this figure. The transfer is its own
   * transaction, already booked as an RV- receipt when Finance approved it;
   * netting it off here as well would count the same money twice, once as
   * a receipt and once as a reduction of what is owed. The slip prints it as
   * "Payment Received" beside the existing figures, and `remainingBalance`
   * is the one derived line — what is still owed after that payment.
   */
  paymentsReceivedValue: number;
  paymentItems: PaymentReceivedItem[];
  /** `amountToCollect − paymentsReceivedValue`, never below zero. Display only. */
  remainingBalance: number;
}

// GET /api/production-orders/:id/previous-balance — what the branch owes for its
// PREVIOUS delivery, for the company copy of this order's slip.
//
// Deliberately NOT production_balances: that table is unmet demand (goods the
// branch asked for and Production could not supply), i.e. value owed TO the
// branch — the opposite direction from a receivable.
//
// Bills the IMMEDIATELY PRECEDING delivered order, not the previous business
// day's total, and that distinction is load-bearing: branches routinely take
// several deliveries in one day (four on 2026-08-09 for one branch). Billing a
// day's total would reprint the same figure on every slip that day and invite
// collecting it more than once, whereas chaining slip→previous order bills each
// delivery exactly once. The tradeoff accepted here is that a slip can bill
// goods delivered only hours earlier rather than strictly "yesterday".
//
// Computed server-side because the company share lives in finance_settings (and
// per branch on branches.company_share_pct), and production users have no access
// to the finance module at any layer — only the service-role client can read it.
// The money maths stays server-side with it.
//
// NOTE: nothing records whether a previous order was actually settled, so this
// reports the same figure on every reprint. It is a "what this order was worth"
// statement, not a live outstanding balance.
//
// Returns null when the order id does not exist (the route turns that into a 404).
export async function getPreviousOrderBalance(orderId: string): Promise<PreviousOrderBalance | null> {
  const { data: order, error: orderErr } = await db
    .from('production_orders')
    .select('id, branch_id, business_date, submitted_at')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order) return null;

  // Only a DELIVERED order can be owed for. 'pending' shipped nothing yet and
  // 'rejected' never will, so both are skipped when walking back.
  const { data: prev, error: prevErr } = await db
    .from('production_orders')
    .select('id, demand_number, business_date, submitted_at, items:production_order_items(product_id, qty, approved_qty)')
    .eq('branch_id', order.branch_id)
    .in('status', ['awaiting_verification', 'approved'])
    .lt('submitted_at', order.submitted_at)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevErr) throw prevErr;

  // The branch's own percentage where it has one, the global finance setting
  // where it does not (migration 68) — the same resolution branch-income
  // approval uses, so the slip bills at the terms the branch is actually on.
  const [{ data: fin, error: finErr }, { data: branchRow, error: branchErr }] = await Promise.all([
    db.from('finance_settings').select('company_share_pct').maybeSingle(),
    db.from('branches').select('company_share_pct').eq('id', order.branch_id).maybeSingle(),
  ]);
  if (finErr) throw finErr;
  if (branchErr) throw branchErr;
  const { companySharePct } = resolveShareSplit(
    (branchRow?.company_share_pct ?? null) as number | null,
    Number(fin?.company_share_pct ?? 75),
  );

  if (!prev) {
    return {
      previous: null, orderedValue: 0, deliveredValue: 0, companySharePct,
      companyShareValue: 0, returnsValue: 0, returnItems: [],
      discountsValue: 0, discountItems: [], amountToCollect: 0,
      paymentsReceivedValue: 0, paymentItems: [], remainingBalance: 0,
    };
  }

  const prevItems = (prev.items ?? []) as {
    product_id: string | null;
    qty: number | string | null;
    approved_qty: number | string | null;
  }[];
  const productIds = [...new Set(prevItems.map((i) => i.product_id).filter((p): p is string => !!p))];

  // Ordered and delivered, from one pass over one price map.
  //
  // ON THE VALUATION BASIS: both use the CURRENT `products.price`, which is what
  // this service has always done for `deliveredValue`. `orderedValue` follows it
  // rather than reading the line's snapshotted `unit_price`, because these two
  // print next to each other and settle in cash: valued differently, a price
  // change since the delivery would make ordered and delivered differ for a
  // reason that has nothing to do with quantity, which is the only thing their
  // difference is read as meaning.
  //
  // That the shared basis is the current price rather than the snapshot is a
  // separate question, and a live one — `unit_price` is written onto the line
  // precisely so a later price change cannot rewrite what an order was worth
  // (see the note in production-orders.routes.ts). Changing it here would move
  // `companyShareValue` and `amountToCollect`, i.e. money actually collected, so
  // it is not changed as a side effect of adding a field.
  let orderedValue = 0;
  let deliveredValue = 0;
  if (productIds.length > 0) {
    const { data: products, error: prodErr } = await db
      .from('products')
      .select('id, price')
      .in('id', productIds);
    if (prodErr) throw prodErr;
    const priceById = new Map((products ?? []).map((p) => [p.id as string, Number(p.price ?? 0)]));
    for (const i of prevItems) {
      const price = i.product_id ? (priceById.get(i.product_id) ?? 0) : 0;
      orderedValue += Number(i.qty ?? 0) * price;
      deliveredValue += Number(i.approved_qty ?? 0) * price;
    }
  }

  // Returns that came back during the period this slip bills for: after the
  // previous order was placed, up to and including this one.
  //
  // Windowed on the billing period rather than on "the previous calendar day",
  // which is what this did first and which was wrong twice over. Branches take
  // several deliveries a day, so a day-based rule (a) credited returns against
  // an order they had nothing to do with, and worse (b) re-credited the SAME
  // returns on every slip of that day — four orders, one return deducted four
  // times. Bounding by the two orders' timestamps partitions returns exactly:
  // each falls in one window, so it is deducted once and never lost.
  const { data: returns, error: retErr } = await db
    .from('production_returns')
    .select('product_id, product_name, qty')
    .eq('branch_id', order.branch_id)
    .eq('status', 'accepted')
    .gt('created_at', prev.submitted_at)
    .lte('created_at', order.submitted_at);
  if (retErr) throw retErr;

  let returnsValue = 0;
  let returnItems: { productName: string; qty: number; amount: number }[] = [];
  const returnRows = (returns ?? []) as { product_id: string; product_name: string; qty: number | string }[];
  if (returnRows.length > 0) {
    const retIds = [...new Set(returnRows.map((r) => r.product_id))];
    const { data: retProducts, error: retProdErr } = await db
      .from('products')
      .select('id, price')
      .in('id', retIds);
    if (retProdErr) throw retProdErr;
    const retPriceById = new Map((retProducts ?? []).map((p) => [p.id as string, Number(p.price ?? 0)]));
    // Itemised here rather than re-derived on the client, so the lines the slip
    // prints are by construction the ones the total was built from.
    returnItems = returnRows.map((r) => ({
      productName: r.product_name,
      qty: Number(r.qty ?? 0),
      amount: Number(r.qty ?? 0) * (retPriceById.get(r.product_id) ?? 0),
    }));
    returnsValue = returnItems.reduce((a, r) => a + r.amount, 0);
  }

  // Approved discount claims falling in the SAME billing window as the returns
  // above — after the previous order, up to and including this one.
  //
  // Windowed identically on purpose, and the reasoning the returns block sets
  // out applies unchanged: a day-based rule would re-deduct the same claim on
  // every slip of a day a branch took several deliveries. Bounding by the two
  // orders' timestamps partitions claims exactly, so each is deducted once and
  // none is lost.
  //
  // 'approved' only. A claim still pending is one Production has not agreed to,
  // and netting it off the collection would hand the branch money on a decision
  // nobody has taken; a rejected or sent-back one is not owed at all.
  //
  // No price lookup, unlike returns: a claim IS an amount. There are no units to
  // value, which is why the printed line carries money alone where Less Returns
  // carries `qty · money`.
  const { data: discounts, error: discErr } = await db
    .from('branch_discounts')
    .select('demand_number, amount')
    .eq('branch_id', order.branch_id)
    .eq('status', 'approved')
    .gt('created_at', prev.submitted_at)
    .lte('created_at', order.submitted_at);
  if (discErr) throw discErr;

  // Itemised here rather than re-derived on the client, for the reason the
  // return items are: the lines the slip prints are then by construction the
  // ones the total was built from, and cannot drift from it.
  const discountItems = ((discounts ?? []) as { demand_number: string | null; amount: number | string }[]).map(
    (d) => ({ demandNumber: d.demand_number ?? '—', amount: Number(d.amount ?? 0) }),
  );
  const discountsValue = discountItems.reduce((a, d) => a + d.amount, 0);

  // Approved cash transfers in the SAME window as the returns and discounts,
  // plus the rest of each of those days' deposits — a branch that hands money
  // over several times in a day sees the day's whole sum here. Unlike returns
  // and discounts this can therefore repeat across two slips of one day; it is
  // read-only, so nothing is deducted twice. See the note on the interface.
  const { paymentItems, paymentsReceivedValue } = await paymentsReceivedInWindow(
    order.branch_id,
    prev.submitted_at,
    order.submitted_at,
  );

  const companyShareValue = (deliveredValue * companySharePct) / 100;
  const amountToCollect = companyShareValue - returnsValue - discountsValue;

  return {
    previous: { demandNumber: prev.demand_number, date: prev.business_date },
    orderedValue,
    deliveredValue,
    companySharePct,
    companyShareValue,
    returnsValue,
    returnItems,
    discountsValue,
    discountItems,
    // Both deductions come off the company's share. A discount reduces what the
    // rider collects exactly as a return does — the only difference is that one
    // is goods coming back and the other is money agreed off.
    amountToCollect,
    paymentsReceivedValue,
    paymentItems,
    remainingBalance: Math.max(0, amountToCollect - paymentsReceivedValue),
  };
}
