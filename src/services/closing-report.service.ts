import { supabaseAdmin } from '../config/supabase';
import {
  businessDayBounds,
  type BranchClosingReport,
  type ProductionClosingReport,
  type CompanyClosingReport,
  type PaymentMethod,
} from '../shared';
import { computeStockRows } from './stock.service';

/**
 * Build the end-of-day closing reports.
 *
 * Why these are computed here rather than read off `business_day_closures`: that
 * archive aggregates sales and expenses across ALL branches (only its stock
 * snapshot is per-branch), but the whole point of this feature is that a branch
 * receives ONLY its own figures. So the per-branch numbers are recomputed here
 * with the same source queries and date semantics the closing archive uses —
 * orders by created_at with INCLUSIVE business-day bounds (migration 03),
 * expenses and production by business_date.
 */

const num = (v: unknown) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 'YYYY-MM-DD' → 'DD-MM-YYYY' for the human-facing message. */
export function formatBusinessDate(businessDate: string): string {
  const [y, m, d] = businessDate.split('-');
  return `${d}-${m}-${y}`;
}

/** Rs. 85,450 — grouping matches the rest of the app (en-PK). */
export function money(n: number, symbol = 'Rs.'): string {
  return `${symbol} ${round2(n).toLocaleString('en-PK')}`;
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------
export async function buildBranchReport(
  branch: { id: string; name: string },
  businessDate: string,
): Promise<BranchClosingReport> {
  const { fromISO, toISO } = businessDayBounds(businessDate);

  const [orders, expenses, demandOrders, stockRows] = await Promise.all([
    supabaseAdmin
      .from('orders')
      .select('status, grand_total, discount_total, tax_amount, payment_method')
      .eq('branch_id', branch.id)
      .gte('created_at', fromISO)
      .lte('created_at', toISO),
    supabaseAdmin
      .from('expenses')
      .select('amount, payment_method, description')
      .eq('branch_id', branch.id)
      .eq('business_date', businessDate),
    supabaseAdmin
      .from('production_orders')
      .select('status, items:production_order_items(product_name, qty)')
      .eq('branch_id', branch.id)
      .eq('business_date', businessDate),
    computeStockRows(branch.id, businessDate),
  ]);
  for (const r of [orders, expenses, demandOrders]) {
    if (r.error) throw r.error;
  }

  // ── Sales + payment split (cancelled orders never count) ──
  const payments = { cash: 0, easypaisa: 0, foodpanda: 0, bank: 0, other: 0, total: 0 };
  const sales = { total: 0, transactions: 0, average: 0, discount: 0, tax: 0, net: 0 };

  for (const o of (orders.data ?? []) as {
    status: string; grand_total: number; discount_total: number; tax_amount: number; payment_method: PaymentMethod;
  }[]) {
    if (o.status === 'cancelled') continue;
    const total = num(o.grand_total);
    sales.transactions += 1;
    sales.total += total;
    sales.discount += num(o.discount_total);
    sales.tax += num(o.tax_amount);

    switch (o.payment_method) {
      case 'cash': payments.cash += total; break;
      case 'easypaisa': payments.easypaisa += total; break;
      case 'foodpanda': payments.foodpanda += total; break;
      case 'bank_account': payments.bank += total; break;
      // Forward-compatible: a payment method added later still shows up.
      default: payments.other += total; break;
    }
  }
  payments.total = payments.cash + payments.easypaisa + payments.foodpanda + payments.bank + payments.other;
  sales.net = sales.total - sales.discount - sales.tax;
  sales.average = sales.transactions > 0 ? sales.total / sales.transactions : 0;

  // ── Expenses ──
  const expenseRows = (expenses.data ?? []) as { amount: number; payment_method: string; description?: string }[];
  const byCategory: Record<string, number> = {};
  let expTotal = 0, expCash = 0, expEasypaisa = 0;
  for (const e of expenseRows) {
    const amt = num(e.amount);
    expTotal += amt;
    const cat = e.description || 'Uncategorised';
    byCategory[cat] = (byCategory[cat] || 0) + amt;
    if (e.payment_method === 'cash') expCash += amt;
    else if (e.payment_method === 'easypaisa') expEasypaisa += amt;
  }

  // ── Next-day demand: what this branch asked Production for on this date ──
  const demandMap: Record<string, number> = {};
  let demandTotal = 0;
  for (const o of (demandOrders.data ?? []) as { status: string; items: { product_name: string; qty: number }[] }[]) {
    for (const it of o.items ?? []) {
      const qty = num(it.qty);
      demandMap[it.product_name] = (demandMap[it.product_name] || 0) + qty;
      demandTotal += qty;
    }
  }
  const demandItems = Object.entries(demandMap)
    .map(([productName, qty]) => ({ productName, qty: round2(qty) }))
    .sort((a, b) => b.qty - a.qty);

  // ── Stock (unit counts summed across products) ──
  const stock = { opening: 0, received: 0, sold: 0, returned: 0, closing: 0 };
  for (const r of stockRows) {
    stock.opening += num(r.opening);
    stock.received += num(r.newQty);
    stock.sold += num(r.sold);
    stock.returned += num(r.returned);
    stock.closing += num(r.balance);
  }

  return {
    scope: 'branch',
    businessDate,
    branchId: branch.id,
    branchName: branch.name,
    sales: {
      total: round2(sales.total), transactions: sales.transactions, average: round2(sales.average),
      discount: round2(sales.discount), tax: round2(sales.tax), net: round2(sales.net),
    },
    payments: {
      cash: round2(payments.cash), easypaisa: round2(payments.easypaisa), foodpanda: round2(payments.foodpanda),
      bank: round2(payments.bank), other: round2(payments.other), total: round2(payments.total),
    },
    stock: {
      opening: round2(stock.opening), received: round2(stock.received), sold: round2(stock.sold),
      returned: round2(stock.returned), closing: round2(stock.closing),
    },
    expenses: { total: round2(expTotal), byCategory, cash: round2(expCash), easypaisa: round2(expEasypaisa) },
    demand: { items: demandItems, totalQty: round2(demandTotal) },
    overall: {
      income: round2(payments.total),
      expenses: round2(expTotal),
      netCollection: round2(payments.total - expTotal),
    },
  };
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------
export async function buildProductionReport(businessDate: string): Promise<ProductionClosingReport> {
  const [movements, pool, demandOrders, prodExpenses] = await Promise.all([
    supabaseAdmin
      .from('production_stock_history')
      .select('type, delta')
      .eq('business_date', businessDate),
    supabaseAdmin.from('production_stock').select('balance'),
    supabaseAdmin
      .from('production_orders')
      .select('status, items:production_order_items(qty, approved_qty)')
      .eq('business_date', businessDate),
    supabaseAdmin
      .from('production_expenses')
      .select('amount, category')
      .eq('business_date', businessDate),
  ]);
  for (const r of [movements, pool, demandOrders, prodExpenses]) {
    if (r.error) throw r.error;
  }

  // The central pool's ledger: prepare (+), transfer_out (-), return_in (+).
  let prepared = 0, delivered = 0, returned = 0;
  for (const m of (movements.data ?? []) as { type: string; delta: number }[]) {
    const d = num(m.delta);
    if (m.type === 'prepare') prepared += d;
    else if (m.type === 'transfer_out') delivered += Math.abs(d);
    else if (m.type === 'return_in') returned += d;
  }
  const remaining = ((pool.data ?? []) as { balance: number }[]).reduce((s, p) => s + num(p.balance), 0);

  let demandTotal = 0, demandApproved = 0, ordersClosed = 0, ordersPending = 0;
  for (const o of (demandOrders.data ?? []) as { status: string; items: { qty: number; approved_qty: number | null }[] }[]) {
    if (o.status === 'approved') ordersClosed += 1;
    if (o.status === 'pending') ordersPending += 1;
    for (const it of o.items ?? []) {
      demandTotal += num(it.qty);
      demandApproved += num(it.approved_qty);
    }
  }

  const byCategory: Record<string, number> = {};
  let expTotal = 0;
  for (const e of (prodExpenses.data ?? []) as { amount: number; category?: string }[]) {
    const amt = num(e.amount);
    expTotal += amt;
    const cat = e.category || 'Uncategorised';
    byCategory[cat] = (byCategory[cat] || 0) + amt;
  }

  return {
    scope: 'production',
    businessDate,
    production: {
      prepared: round2(prepared), delivered: round2(delivered),
      returned: round2(returned), remaining: round2(remaining),
    },
    demand: {
      total: round2(demandTotal),
      approved: round2(demandApproved),
      pending: round2(Math.max(0, demandTotal - demandApproved)),
    },
    expenses: { total: round2(expTotal), byCategory },
    orders: { closed: ordersClosed, pending: ordersPending },
  };
}

// ---------------------------------------------------------------------------
// Company (Admin rollup)
// ---------------------------------------------------------------------------
export function buildCompanyReport(
  businessDate: string,
  branchReports: BranchClosingReport[],
  production: ProductionClosingReport,
): CompanyClosingReport {
  const totalSales = branchReports.reduce((s, b) => s + b.sales.total, 0);
  const branchExpenses = branchReports.reduce((s, b) => s + b.expenses.total, 0);
  const totalExpenses = branchExpenses + production.expenses.total;

  return {
    scope: 'company',
    businessDate,
    totalSales: round2(totalSales),
    totalExpenses: round2(totalExpenses),
    totalProduction: round2(production.production.prepared),
    totalClosingStock: round2(branchReports.reduce((s, b) => s + b.stock.closing, 0) + production.production.remaining),
    totalPendingOrders: production.orders.pending,
    totalTomorrowDemand: round2(branchReports.reduce((s, b) => s + b.demand.totalQty, 0)),
    companyProfit: round2(totalSales - totalExpenses),
    branches: branchReports
      .map((b) => ({
        branchId: b.branchId,
        branchName: b.branchName,
        sales: b.sales.total,
        expenses: b.expenses.total,
        net: b.overall.netCollection,
      }))
      .sort((a, b) => b.sales - a.sales),
  };
}

/** Generate every report for a business date, in one pass. */
export async function generateClosingReports(businessDate: string): Promise<{
  branches: BranchClosingReport[];
  production: ProductionClosingReport;
  company: CompanyClosingReport;
}> {
  const { data: branchRows, error } = await supabaseAdmin
    .from('branches')
    .select('id, name')
    .eq('is_active', true)
    .order('name', { ascending: true });
  if (error) throw error;

  const branches = await Promise.all(
    ((branchRows ?? []) as { id: string; name: string }[]).map((b) => buildBranchReport(b, businessDate)),
  );
  const production = await buildProductionReport(businessDate);
  const company = buildCompanyReport(businessDate, branches, production);
  return { branches, production, company };
}

// ---------------------------------------------------------------------------
// WhatsApp / SMS message bodies
// ---------------------------------------------------------------------------

/** Blank-line separated "Label\nValue" blocks — reads well in a chat bubble. */
function block(...lines: (string | null)[]): string {
  return lines.filter((l): l is string => l !== null).join('\n');
}

export function formatBranchMessage(r: BranchClosingReport, companyName = 'Mountain Bakes', symbol = 'Rs.'): string {
  return block(
    companyName,
    '',
    `Branch: ${r.branchName}`,
    `Date: ${formatBusinessDate(r.businessDate)}`,
    '',
    'Sales', money(r.sales.total, symbol),
    '',
    'Cash', money(r.payments.cash, symbol),
    '',
    'Easypaisa', money(r.payments.easypaisa, symbol),
    '',
    'Foodpanda', money(r.payments.foodpanda, symbol),
    '',
    'Bank', money(r.payments.bank, symbol),
    '',
    'Expenses', money(r.expenses.total, symbol),
    '',
    'Closing Stock', `${r.stock.closing} Items`,
    '',
    'Tomorrow Demand', `${r.demand.totalQty} Items`,
    '',
    'Net Collection', money(r.overall.netCollection, symbol),
    '',
    'Thank you.',
  );
}

export function formatProductionMessage(r: ProductionClosingReport, companyName = 'Mountain Bakes', symbol = 'Rs.'): string {
  return block(
    companyName,
    '',
    'Production Summary',
    '',
    'Prepared', `${r.production.prepared} Items`,
    '',
    'Delivered', `${r.production.delivered} Items`,
    '',
    'Returned', `${r.production.returned} Items`,
    '',
    'Closing Stock', `${r.production.remaining} Items`,
    '',
    'Pending Demand', `${r.demand.pending} Items`,
    '',
    'Production Expense', money(r.expenses.total, symbol),
    '',
    'Business Date', formatBusinessDate(r.businessDate),
  );
}

export function formatCompanyMessage(r: CompanyClosingReport, companyName = 'Mountain Bakes', symbol = 'Rs.'): string {
  const perBranch = r.branches.map((b) => `${b.branchName}: ${money(b.sales, symbol)}`).join('\n');
  return block(
    companyName,
    '',
    'Daily Company Summary',
    `Date: ${formatBusinessDate(r.businessDate)}`,
    '',
    'Total Sales', money(r.totalSales, symbol),
    '',
    'Total Expenses', money(r.totalExpenses, symbol),
    '',
    'Company Profit', money(r.companyProfit, symbol),
    '',
    'Prepared (Production)', `${r.totalProduction} Items`,
    '',
    'Closing Stock', `${r.totalClosingStock} Items`,
    '',
    'Tomorrow Demand', `${r.totalTomorrowDemand} Items`,
    '',
    'Branches',
    perBranch || '—',
  );
}
