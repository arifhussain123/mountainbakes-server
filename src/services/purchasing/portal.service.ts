import type { BillInput, PurchaseDemandStatus, QuotationInput, SupplierPortalView } from '../../shared';
import { PURCHASE_DEMAND_STATUS_LABEL } from '../../shared';
import { alertProduction, billArgs, quotationArgs } from './demands.service';
import { api, call, clientError, db, hashToken, rs } from './common';

/**
 * The supplier's side, reached from the link in their WhatsApp message. No
 * Mountain Bakes account: the link's token IS the authorization, and it
 * authorizes exactly one demand.
 *
 * What a supplier may see is listed field by field in `view()` — never a row
 * passed through. No supplier balance, no other demand, no payment, no
 * internal note or staff name reaches this surface.
 *
 * A token is refused once revoked (a newer link was sent, the demand was
 * cancelled, rejected or received) or expired. Each request re-resolves it, so
 * a link that stops working stops working on the next tap, and an approval or
 * bill can never ride in on an old link: the database function re-checks the
 * demand's state under its lock regardless.
 */

export class PortalError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

type Row = Record<string, unknown>;

export async function resolveToken(token: string | undefined): Promise<{ tokenId: string; demandId: string; expiresAt: string }> {
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    throw new PortalError('This link is not valid. Use the link in the latest WhatsApp message from Mountain Bakes.', 401, 'invalid');
  }
  const r = await call<{ status: string; tokenId?: string; demandId?: string; expiresAt?: string; reason?: string }>('supplier_token_resolve', {
    p_hash: hashToken(token),
  });
  if (r.status === 'ok') return { tokenId: r.tokenId!, demandId: r.demandId!, expiresAt: r.expiresAt! };
  if (r.status === 'expired') throw new PortalError('This link has expired. Ask Mountain Bakes to send a new one.', 410, 'expired');
  if (r.status === 'revoked') {
    const why = r.reason === 'replaced by a newer link' ? 'A newer link was sent — use the latest WhatsApp message.' : `This demand is closed (${r.reason}).`;
    throw new PortalError(`This link no longer works. ${why}`, 410, 'revoked');
  }
  throw new PortalError('This link is not valid. Use the link in the latest WhatsApp message from Mountain Bakes.', 401, 'invalid');
}

function quotationView(q: Row | undefined) {
  if (!q) return null;
  const v = api<Record<string, unknown>>(q);
  const { enteredBy: _e, enteredByName: _en, decidedBy: _d, decidedByName: _dn, clientRequestId: _c, ...rest } = v;
  // A reason is the supplier's to read only when it was written for them: why
  // changes were asked for, or why it was turned down. Why Production accepted
  // a bill's differences is an internal note.
  const forSupplier = rest['status'] === 'changes_requested' || rest['status'] === 'rejected';
  return { ...rest, decisionReason: forSupplier ? rest['decisionReason'] : null, enteredByName: null, decidedByName: null } as never;
}

export async function view(demandId: string, expiresAt: string): Promise<SupplierPortalView> {
  const [dRes, qRes, bRes] = await Promise.all([
    db.from('purchase_demands').select('*, items:purchase_demand_items(*)').eq('id', demandId).maybeSingle(),
    db.from('purchase_quotations').select('*, items:purchase_quotation_items(*)').eq('demand_id', demandId).order('version', { ascending: false }),
    db.from('purchase_bills').select('*, items:purchase_bill_items(*)').eq('demand_id', demandId).order('submitted_at', { ascending: false }).limit(1),
  ]);
  for (const r of [dRes, qRes, bRes]) if (r.error) throw clientError(r.error);
  const d = dRes.data as Row | null;
  if (!d) throw new PortalError('This demand no longer exists.', 404, 'missing');
  const status = d['status'] as PurchaseDemandStatus;
  const quotations = (qRes.data ?? []) as Row[];
  const sortItems = (r: Row | undefined): Row | undefined =>
    r ? { ...r, items: ((r['items'] as Row[]) ?? []).sort((a, b) => Number(a['line_no']) - Number(b['line_no'])) } : undefined;
  const latest = sortItems(quotations[0]);
  const approved = sortItems(quotations.find((q) => q['id'] === d['approved_quotation_id']));
  const bill = sortItems((bRes.data ?? [])[0] as Row | undefined);

  // The reason Production gave, when it is one the supplier must act on.
  let productionNote: string | null = null;
  if (status === 'changes_requested' && latest?.['decision_reason']) productionNote = String(latest['decision_reason']);
  if (status === 'awaiting_supplier_bill' && bill?.['status'] === 'rejected' && bill['decision_reason']) {
    productionNote = `Your bill ${String(bill['supplier_bill_no'])} was returned: ${String(bill['decision_reason'])}`;
  }

  return {
    business: 'Mountain Bakes',
    demandNo: String(d['demand_no']),
    status,
    statusLabel: PURCHASE_DEMAND_STATUS_LABEL[status],
    priority: d['priority'] as 'urgent' | 'normal',
    requiredDate: String(d['required_date']),
    supplierName: String(d['supplier_name']),
    notes: (d['notes'] as string) ?? null,
    deliveryInstructions: (d['delivery_instructions'] as string) ?? null,
    items: ((d['items'] as Row[]) ?? [])
      .sort((a, b) => Number(a['line_no']) - Number(b['line_no']))
      .map((i) => ({
        id: String(i['id']),
        lineNo: Number(i['line_no']),
        itemName: String(i['item_name']),
        requestedQty: Number(i['requested_qty']),
        unit: String(i['unit']),
        note: (i['note'] as string) ?? null,
      })),
    latestQuotation: quotationView(latest),
    approvedQuotation: quotationView(approved),
    latestBill: bill ? (quotationView(bill) as never) : null,
    productionNote,
    canQuote: ['awaiting_supplier', 'quotation_received', 'changes_requested', 'awaiting_supplier_bill'].includes(status),
    canBill: status === 'awaiting_supplier_bill',
    linkExpiresAt: expiresAt,
  };
}

export async function submitQuotation(demandId: string, input: QuotationInput) {
  const before = await db.from('purchase_demands').select('supplier_name').eq('id', demandId).maybeSingle();
  const row = await call<Row>('purchase_submit_quotation', {
    p_demand_id: demandId,
    p_via: 'portal',
    ...quotationArgs(input),
    p_actor_id: null,
    p_actor_name: null,
  });
  if (!row['replayed']) {
    const supplier = String(before.data?.['supplier_name'] ?? 'The supplier');
    const withdrew = row['withdrew_approval'] ? ' (the earlier approval is withdrawn)' : '';
    await alertProduction(
      demandId,
      'quotation',
      `v${String(row['version'])}`,
      'Supplier quotation received',
      `${supplier} sent quotation v${String(row['version'])}: ${rs(row['total'] as number)}${withdrew}.`,
    );
  }
  return { version: Number(row['version']), total: Number(row['total']), replayed: !!row['replayed'] };
}

export async function submitBill(demandId: string, input: BillInput) {
  const before = await db.from('purchase_demands').select('supplier_name').eq('id', demandId).maybeSingle();
  const row = await call<Row>('purchase_submit_bill', {
    p_demand_id: demandId,
    p_via: 'portal',
    ...billArgs(input),
    p_actor_id: null,
    p_actor_name: null,
  });
  if (!row['replayed']) {
    const supplier = String(before.data?.['supplier_name'] ?? 'The supplier');
    const diff = row['differs_from_quotation'] ? ' It differs from the approved quotation.' : '';
    await alertProduction(
      demandId,
      'bill',
      String(row['id']),
      'Supplier bill received',
      `${supplier} sent bill ${String(row['supplier_bill_no'])}: ${rs(row['grand_total'] as number)}.${diff}`,
    );
  }
  return { supplierBillNo: String(row['supplier_bill_no']), grandTotal: Number(row['grand_total']), differsFromQuotation: !!row['differs_from_quotation'], replayed: !!row['replayed'] };
}
