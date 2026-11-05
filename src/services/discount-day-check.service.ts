import { dbFor } from '../db';
import type { BranchDiscountStatus, DiscountDayCheck, DiscountDayProduct } from '../shared';

const db = dbFor('discount-day-check');

/** Every db read is capped at 1000 rows, so each list here is paged to the end. */
const PAGE = 1000;

/** `in (...)` lists are chunked so a busy day does not build one enormous URL/statement. */
const ID_CHUNK = 200;

const round2 = (n: number) => Math.round(n * 100) / 100;

async function readAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * The till's discounts for one branch on one business day, per product, set
 * against the discount claims that branch raised for the same day.
 *
 * Actual = order_items.discount on the day's non-cancelled POS sales. Staff sales
 * are kept in: they take no money but can carry a discount, and computeClosingTotals
 * counts their discounts the same way.
 *
 * Claimed = every claim for the day that is not rejected — pending, sent back and
 * approved all still ask for the money.
 */
export async function getDiscountDayCheck({ branchId, date }: { branchId: string; date: string }): Promise<DiscountDayCheck> {
  const [orders, claimRows] = await Promise.all([
    readAllPages<{ id: string }>((from, to) =>
      db
        .from('orders')
        .select('id')
        .eq('branch_id', branchId)
        .eq('business_date', date)
        .neq('status', 'cancelled')
        .gt('discount_total', 0)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    readAllPages<{ id: string; demand_number: string | null; amount: number | string; status: BranchDiscountStatus }>(
      (from, to) =>
        db
          .from('branch_discounts')
          .select('id, demand_number, amount, status')
          .eq('branch_id', branchId)
          .eq('business_date', date)
          .neq('status', 'rejected')
          .order('created_at', { ascending: true })
          .range(from, to),
    ),
  ]);

  const byProduct = new Map<string, DiscountDayProduct>();
  const orderIds = orders.map((o) => o.id);
  for (let i = 0; i < orderIds.length; i += ID_CHUNK) {
    const chunk = orderIds.slice(i, i + ID_CHUNK);
    const items = await readAllPages<{
      product_id: string | null;
      product_name: string;
      qty: number | string;
      discount: number | string;
    }>((from, to) =>
      db
        .from('order_items')
        .select('product_id, product_name, qty, discount')
        .in('order_id', chunk)
        .gt('discount', 0)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const it of items) {
      // A deleted product has no id; its snapshotted name keeps its lines together.
      const key = it.product_id ?? `name:${it.product_name}`;
      const row = byProduct.get(key) ?? { productId: it.product_id, productName: it.product_name, qty: 0, discount: 0 };
      row.qty += Number(it.qty) || 0;
      row.discount += Number(it.discount) || 0;
      byProduct.set(key, row);
    }
  }

  const products = [...byProduct.values()]
    .map((p) => ({ ...p, qty: Math.round(p.qty * 1000) / 1000, discount: round2(p.discount) }))
    .sort((a, b) => b.discount - a.discount || a.productName.localeCompare(b.productName));

  const claims = claimRows.map((c) => ({
    id: c.id,
    demandNumber: c.demand_number,
    amount: Number(c.amount),
    status: c.status,
  }));

  const actualTotal = round2(products.reduce((s, p) => s + p.discount, 0));
  const claimedTotal = round2(claims.reduce((s, c) => s + c.amount, 0));
  const difference = round2(claimedTotal - actualTotal);

  return { branchId, date, products, actualTotal, claimedTotal, difference, matches: difference === 0, claims };
}
