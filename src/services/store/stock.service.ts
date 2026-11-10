import type {
  StoreAdjustInput,
  StoreAdjustment,
  StoreBatch,
  StoreLedger,
  StorePage,
  StoreReceipt,
  StoreReceiptInput,
  StoreStockRow,
} from '../../shared';
import { api, call, clientError, db, httpError, searchTerm, type StoreActor } from './common';

/**
 * Stock in and out of the Store, other than issuing to Production: receiving
 * (one batch per line, at the Price Control price), adjustments, and the read
 * models over the movement ledger.
 */

const page = (limit?: number, offset?: number) => {
  const l = Math.min(Math.max(limit ?? 50, 1), 200);
  const o = Math.max(offset ?? 0, 0);
  return { l, o };
};

// ── Receiving ───────────────────────────────────────────────────────────────

export async function receive(input: StoreReceiptInput, actor: StoreActor): Promise<StoreReceipt> {
  const { data, error } = await db.rpc('store_receive_stock', {
    p_actor_id: actor.uid, p_actor_name: actor.name, p_actor_role: actor.role, p_input: input,
  });
  if (error) {
    // The same supplier, date and items are already on a receipt: the client
    // shows it and may resend with confirmDuplicate.
    const m = /^DUPLICATE_RECEIPT:(\S+)/.exec(error.message ?? '');
    if (m) {
      throw httpError(409, `This looks like ${m[1]}, already saved for the same supplier, date and items.`, { code: 'duplicate_receipt', duplicateOf: m[1] });
    }
    throw clientError(error);
  }
  return api<StoreReceipt>(data);
}

export async function listReceipts(opts: { from?: string; to?: string; search?: string; limit?: number; offset?: number }): Promise<StorePage<StoreReceipt>> {
  const { l, o } = page(opts.limit, opts.offset);
  let q = db.from('store_receipts').select('*, lines:store_batches(*, item:store_items(item_no, item_code, name, base_unit))', { count: 'exact' });
  if (opts.from) q = q.gte('receipt_date', opts.from);
  if (opts.to) q = q.lte('receipt_date', opts.to);
  const term = searchTerm(opts.search);
  if (term) q = q.or(`receipt_no.ilike.%${term}%,supplier_name.ilike.%${term}%,invoice_no.ilike.%${term}%`);
  const { data, error, count } = await q.order('receipt_date', { ascending: false }).order('created_at', { ascending: false }).range(o, o + l - 1);
  if (error) throw clientError(error);
  return { rows: api<Array<Record<string, unknown>>>(data ?? []).map(flattenReceipt), total: count ?? 0 };
}

export async function getReceipt(id: string): Promise<StoreReceipt> {
  const { data, error } = await db.from('store_receipts')
    .select('*, lines:store_batches(*, item:store_items(item_no, item_code, name, base_unit))').eq('id', id).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw httpError(404, 'Receipt not found');
  return flattenReceipt(api<Record<string, unknown>>(data));
}

function flattenReceipt(r: Record<string, unknown>): StoreReceipt {
  const lines = ((r['lines'] as Array<Record<string, unknown>>) ?? [])
    .map((b) => {
      const item = b['item'] as { itemNo: string; itemCode: string; name: string; baseUnit: string } | null;
      const { item: _i, ...rest } = b;
      void _i;
      return { ...(rest as unknown as StoreBatch), itemNo: item?.itemNo, itemCode: item?.itemCode, itemName: item?.name, baseUnit: item?.baseUnit };
    })
    .sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0));
  return { ...(r as unknown as StoreReceipt), lines };
}

/** Suppliers for the receiving form (the same list WhatsApp Purchasing keeps). */
export async function listSuppliers(): Promise<Array<{ id: string; name: string; supplierCode: string }>> {
  const { data, error } = await db.from('suppliers').select('id, name, supplier_code')
    .is('deleted_at', null).eq('is_active', true).order('name').range(0, 499);
  if (error) throw clientError(error);
  return api(data ?? []);
}

// ── Adjustments ─────────────────────────────────────────────────────────────

export async function adjust(input: StoreAdjustInput, actor: StoreActor): Promise<StoreAdjustment> {
  return api<StoreAdjustment>(await call('store_adjust_stock', {
    p_actor_id: actor.uid, p_actor_name: actor.name, p_actor_role: actor.role, p_input: input,
  }));
}

export async function listAdjustments(opts: { from?: string; to?: string; itemId?: string; limit?: number; offset?: number }): Promise<StorePage<StoreAdjustment>> {
  const { l, o } = page(opts.limit, opts.offset);
  let q = db.from('store_adjustments').select('*, item:store_items(item_no, name, base_unit)', { count: 'exact' });
  if (opts.from) q = q.gte('business_date', opts.from);
  if (opts.to) q = q.lte('business_date', opts.to);
  if (opts.itemId) q = q.eq('item_id', opts.itemId);
  const { data, error, count } = await q.order('business_date', { ascending: false }).order('created_at', { ascending: false }).range(o, o + l - 1);
  if (error) throw clientError(error);
  return {
    rows: api<Array<Record<string, unknown>>>(data ?? []).map((a) => {
      const item = a['item'] as { itemNo: string; name: string; baseUnit: string } | null;
      const { item: _i, ...rest } = a;
      void _i;
      return { ...(rest as unknown as StoreAdjustment), itemNo: item?.itemNo, itemName: item?.name, baseUnit: item?.baseUnit };
    }),
    total: count ?? 0,
  };
}

// ── Read models ─────────────────────────────────────────────────────────────

export async function stockSummary(from: string, to: string): Promise<StoreStockRow[]> {
  return api<StoreStockRow[]>(await call('store_stock_summary', { p_from: from, p_to: to }));
}

export async function itemLedger(itemId: string, from: string, to: string): Promise<StoreLedger> {
  return api<StoreLedger>(await call('store_item_ledger', { p_item: itemId, p_from: from, p_to: to }));
}

/** An item's batches, newest first; `open` keeps only those with stock left. */
export async function listBatches(itemId: string, open = false): Promise<StoreBatch[]> {
  let q = db.from('store_batches').select('*, receipt:store_receipts(receipt_no)').eq('item_id', itemId);
  if (open) q = q.gt('remaining_qty', 0);
  const { data, error } = await q.order('received_at', { ascending: false }).order('created_at', { ascending: false }).range(0, 999);
  if (error) throw clientError(error);
  return api<Array<Record<string, unknown>>>(data ?? []).map((b) => {
    const r = b['receipt'] as { receiptNo: string } | null;
    const { receipt: _r, ...rest } = b;
    void _r;
    return { ...(rest as unknown as StoreBatch), receiptNo: r?.receiptNo ?? null };
  });
}
