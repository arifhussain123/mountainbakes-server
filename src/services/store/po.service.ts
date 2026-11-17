import {
  STORE_PO_STATUS_LABELS,
  type StorePoInput,
  type StorePoLine,
  type StorePoStatus,
  type StorePoTransitionInput,
  type StorePurchaseOrder,
} from '../../shared';
import { businessDate, clientError, db, httpError, searchTerm, type StoreActor } from './common';

/**
 * Purchase Orders (Phase 3, behind the `purchase_orders` feature). A PO never
 * moves stock — Receiving does, against it — so the status machine and totals
 * live here rather than in a locking database function. Receiving v2 will set
 * partially_received/received and fill each line's received_qty_base.
 */

const PO_COLS =
  'id, po_no, supplier_id, order_date, expected_date, status, notes, total_amount, cancel_reason, short_close_reason, created_by_name, approved_by_name, approved_at, created_at';
const LINE_COLS =
  'id, line_no, item_id, item_name, package_name, package_qty, qty_packages, expected_price, received_qty_base, line_total';

async function activeStoreId(): Promise<string> {
  const { data, error } = await db.from('store_departments').select('id').eq('is_active', true)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw httpError(409, 'The Dry Items Store is not set up.');
  return data['id'] as string;
}

function shapePo(r: Record<string, unknown>, supplierName: string): StorePurchaseOrder {
  return {
    id: r['id'] as string,
    poNo: r['po_no'] as string,
    supplierId: r['supplier_id'] as string,
    supplierName,
    orderDate: r['order_date'] as string,
    expectedDate: (r['expected_date'] as string | null) ?? null,
    status: r['status'] as StorePoStatus,
    notes: (r['notes'] as string | null) ?? null,
    totalAmount: Number(r['total_amount'] ?? 0),
    cancelReason: (r['cancel_reason'] as string | null) ?? null,
    shortCloseReason: (r['short_close_reason'] as string | null) ?? null,
    createdByName: (r['created_by_name'] as string | null) ?? null,
    approvedByName: (r['approved_by_name'] as string | null) ?? null,
    approvedAt: (r['approved_at'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
  };
}

function shapeLine(l: Record<string, unknown>): StorePoLine {
  return {
    id: l['id'] as string,
    lineNo: Number(l['line_no']),
    itemId: l['item_id'] as string,
    itemName: l['item_name'] as string,
    packageName: l['package_name'] as string,
    packageQty: Number(l['package_qty']),
    qtyPackages: Number(l['qty_packages']),
    expectedPrice: Number(l['expected_price'] ?? 0),
    receivedQtyBase: Number(l['received_qty_base'] ?? 0),
    lineTotal: Number(l['line_total'] ?? 0),
  };
}

async function supplierNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data, error } = await db.from('suppliers').select('id, name').in('id', [...new Set(ids)]);
  if (error) throw clientError(error);
  for (const s of data ?? []) names.set(s['id'] as string, s['name'] as string);
  return names;
}

export async function listPurchaseOrders(opts: { status?: StorePoStatus; search?: string; limit?: number; offset?: number } = {}): Promise<{ rows: StorePurchaseOrder[]; total: number }> {
  let q = db.from('store_purchase_orders').select(PO_COLS, { count: 'exact' });
  if (opts.status) q = q.eq('status', opts.status);
  const term = searchTerm(opts.search);
  if (term) q = q.ilike('po_no', `%${term}%`);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { data, error, count } = await q.order('order_date', { ascending: false }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  const pos = data ?? [];
  const names = await supplierNames(pos.map((p) => p['supplier_id'] as string));
  return { rows: pos.map((p) => shapePo(p, names.get(p['supplier_id'] as string) ?? '')), total: count ?? 0 };
}

export async function getPurchaseOrder(id: string): Promise<StorePurchaseOrder> {
  const { data, error } = await db.from('store_purchase_orders').select(PO_COLS).eq('id', id).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw httpError(404, 'Purchase order not found');
  const names = await supplierNames([data['supplier_id'] as string]);
  const { data: lines, error: lErr } = await db.from('store_purchase_order_lines').select(LINE_COLS).eq('po_id', id).order('line_no');
  if (lErr) throw clientError(lErr);
  const po = shapePo(data, names.get(data['supplier_id'] as string) ?? '');
  po.lines = (lines ?? []).map(shapeLine);
  return po;
}

export async function createPurchaseOrder(input: StorePoInput, actor: StoreActor): Promise<StorePurchaseOrder> {
  const storeId = await activeStoreId();

  const { data: supplier, error: sErr } = await db.from('suppliers').select('id').eq('id', input.supplierId).is('deleted_at', null).maybeSingle();
  if (sErr) throw clientError(sErr);
  if (!supplier) throw httpError(404, 'Supplier not found');

  const { data: items, error: iErr } = await db.from('store_items').select('id, name').in('id', [...new Set(input.lines.map((l) => l.itemId))]);
  if (iErr) throw clientError(iErr);
  const itemNames = new Map((items ?? []).map((i) => [i['id'] as string, i['name'] as string]));
  for (const l of input.lines) if (!itemNames.has(l.itemId)) throw httpError(404, 'An item on the order no longer exists.');

  const today = await businessDate();
  const { data: header, error: hErr } = await db.from('store_purchase_orders').insert({
    store_id: storeId,
    supplier_id: input.supplierId,
    order_date: input.orderDate ?? today,
    expected_date: input.expectedDate ?? null,
    notes: input.notes ?? null,
    created_by: actor.uid,
    created_by_name: actor.name,
  }).select('id').single();
  if (hErr) throw clientError(hErr);
  const poId = header['id'] as string;

  let total = 0;
  const lineRows = input.lines.map((l, idx) => {
    const price = l.expectedPrice ?? 0;
    const lineTotal = Math.round(l.qtyPackages * price * 100) / 100;
    total += lineTotal;
    return {
      po_id: poId, line_no: idx + 1, item_id: l.itemId, item_name: itemNames.get(l.itemId),
      package_name: l.packageName.trim(), package_qty: l.packageQty, qty_packages: l.qtyPackages,
      expected_price: price, line_total: lineTotal,
    };
  });
  const { error: lErr } = await db.from('store_purchase_order_lines').insert(lineRows);
  if (lErr) {
    await db.from('store_purchase_orders').delete().eq('id', poId); // never leave an orphan header
    throw clientError(lErr);
  }
  await db.from('store_purchase_orders').update({ total_amount: Math.round(total * 100) / 100 }).eq('id', poId);
  return getPurchaseOrder(poId);
}

/** The allowed status transitions. Receiving owns partially_received/received. */
const TRANSITIONS: Record<string, { from: StorePoStatus[]; to: StorePoStatus; needsReason?: boolean }> = {
  submit: { from: ['draft'], to: 'pending_approval' },
  approve: { from: ['pending_approval'], to: 'approved' },
  send: { from: ['approved'], to: 'sent' },
  cancel: { from: ['draft', 'pending_approval', 'approved', 'sent', 'partially_received'], to: 'cancelled', needsReason: true },
  short_close: { from: ['sent', 'partially_received'], to: 'closed', needsReason: true },
};

export async function transitionPurchaseOrder(id: string, input: StorePoTransitionInput, actor: StoreActor): Promise<StorePurchaseOrder> {
  const { data: po, error } = await db.from('store_purchase_orders').select('id, status').eq('id', id).maybeSingle();
  if (error) throw clientError(error);
  if (!po) throw httpError(404, 'Purchase order not found');
  const status = po['status'] as StorePoStatus;
  const reason = (input.reason ?? '').trim();

  const t = TRANSITIONS[input.action];
  if (!t) throw httpError(400, 'Unknown action');
  if (!t.from.includes(status)) throw httpError(409, `A ${STORE_PO_STATUS_LABELS[status]} purchase order can't be ${input.action.replace('_', '-')}ed.`);
  if (t.needsReason && !reason) throw httpError(400, 'A reason is required.');

  const update: Record<string, unknown> = { status: t.to };
  if (input.action === 'approve') {
    update['approved_by'] = actor.uid;
    update['approved_by_name'] = actor.name;
    update['approved_at'] = new Date().toISOString();
  }
  if (input.action === 'cancel') update['cancel_reason'] = reason;
  if (input.action === 'short_close') update['short_close_reason'] = reason;

  const { error: uErr } = await db.from('store_purchase_orders').update(update).eq('id', id);
  if (uErr) throw clientError(uErr);
  return getPurchaseOrder(id);
}
