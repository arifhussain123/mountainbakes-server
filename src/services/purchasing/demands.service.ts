import { businessDateStr } from '../../shared';
import type {
  BillInput,
  DemandInput,
  PurchaseBucket,
  PurchaseDemand,
  PurchaseDemandDetail,
  PurchaseDemandListResponse,
  PurchaseDemandListRow,
  PurchaseDelivery,
  PurchaseReceipt,
  PurchasingSummary,
  Quotation,
  QuotationInput,
  SupplierBill,
  SupplierCredit,
  SupplierPayment,
  VerificationCheck,
  VerificationResult,
  WhatsAppMessage,
} from '../../shared';
import { notify } from '../push.service';
import { whatsappConfig } from '../whatsapp/config';
import { kickOutbox } from '../whatsapp/outbox';
import { applyBucket, demandActions } from './buckets';
import { api, call, clientError, db, issueLink, notFound, rs, type Actor } from './common';
import * as msg from './messages';

/**
 * The demand lifecycle, from Production's side. Each state change is ONE call
 * to a database function (migration 20261020000002) that locks the demand,
 * checks the state, writes the change, the history row and any WhatsApp
 * message together. This file composes the messages, issues supplier links,
 * assembles what the screens read, and tells people afterwards.
 *
 * Notifications after a commit are best effort: the change is already saved,
 * and a failed notice must not turn a success into an error a client retries.
 */

type Row = Record<string, unknown>;

// ── Reads ───────────────────────────────────────────────────────────────────

async function demandRow(id: string): Promise<Row & { items: Row[] }> {
  const { data, error } = await db.from('purchase_demands').select('*, items:purchase_demand_items(*)').eq('id', id).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw notFound('Purchase demand');
  const items = ((data['items'] as Row[]) ?? []).sort((a, b) => Number(a['line_no']) - Number(b['line_no']));
  return { ...data, items };
}

export async function getDemand(id: string): Promise<PurchaseDemand> {
  return api<PurchaseDemand>(await demandRow(id));
}

export interface DemandListQuery {
  bucket?: PurchaseBucket;
  status?: string;
  priority?: string;
  supplierId?: string;
  from?: string;
  to?: string;
  search?: string;
  sortBy?: 'created_at' | 'required_date' | 'demand_no' | 'supplier_name' | 'updated_at';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export async function listDemands(q: DemandListQuery): Promise<PurchaseDemandListResponse> {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  let query = db.from('purchase_demand_list').select('*', { count: 'exact' });
  if (q.bucket) query = applyBucket(query, q.bucket);
  if (q.status) query = query.eq('status', q.status);
  if (q.priority) query = query.eq('priority', q.priority);
  if (q.supplierId) query = query.eq('supplier_id', q.supplierId);
  if (q.from) query = query.gte('created_at', `${q.from}T00:00:00+05:00`);
  if (q.to) query = query.lte('created_at', `${q.to}T23:59:59.999+05:00`);
  const term = q.search?.replace(/[(),*%]/g, ' ').trim();
  if (term) query = query.or(`demand_no.ilike.%${term}%,supplier_name.ilike.%${term}%,notes.ilike.%${term}%`);
  const sortBy = q.sortBy ?? 'created_at';
  const { data, error, count } = await query
    .order(sortBy, { ascending: q.sortDir === 'asc' })
    .order('demand_no', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  return { demands: api<PurchaseDemandListRow[]>(data ?? []), total: count ?? 0 };
}

export async function getSummary(): Promise<PurchasingSummary> {
  return call<PurchasingSummary>('purchase_summary', {});
}

async function rowsWithItems(table: string, itemsTable: string, demandId: string, order: string): Promise<Row[]> {
  const { data, error } = await db.from(table).select(`*, items:${itemsTable}(*)`).eq('demand_id', demandId).order(order, { ascending: true });
  if (error) throw clientError(error);
  return (data ?? []).map((r: Row) => ({
    ...r,
    items: ((r['items'] as Row[]) ?? []).sort((a, b) => Number(a['line_no'] ?? 0) - Number(b['line_no'] ?? 0)),
  }));
}

export async function listDemandMessages(demandId: string): Promise<WhatsAppMessage[]> {
  const { data, error } = await db
    .from('whatsapp_messages')
    .select('*, conversation:whatsapp_conversations(wa_id), outbox:whatsapp_outbox(attempts, next_attempt_at, status)')
    .eq('demand_id', demandId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw clientError(error);
  return (data ?? []).map((r: Row) => shapeMessage(r));
}

export function shapeMessage(r: Row): WhatsAppMessage {
  const conv = (Array.isArray(r['conversation']) ? r['conversation'][0] : r['conversation']) as Row | null;
  const outbox = (Array.isArray(r['outbox']) ? r['outbox'][0] : r['outbox']) as Row | null;
  const demand = (Array.isArray(r['demand']) ? r['demand'][0] : r['demand']) as Row | null;
  const supplier = (Array.isArray(r['supplier']) ? r['supplier'][0] : r['supplier']) as Row | null;
  const { conversation: _c, outbox: _o, demand: _d, supplier: _s, ...rest } = r;
  const queued = outbox && (outbox['status'] === 'pending' || outbox['status'] === 'processing');
  return {
    ...api<WhatsAppMessage>(rest),
    waId: String(conv?.['wa_id'] ?? ''),
    demandNo: (demand?.['demand_no'] as string) ?? null,
    supplierName: (supplier?.['name'] as string) ?? null,
    attempts: outbox ? Number(outbox['attempts']) : null,
    nextAttemptAt: queued ? String(outbox!['next_attempt_at']) : null,
  };
}

export async function getDemandDetail(id: string): Promise<PurchaseDemandDetail> {
  const demand = await demandRow(id);
  const [supplierRes, quotations, bills, deliveryRes, receipts, paymentsRes, creditsRes, eventsRes, messages, tokenRes] = await Promise.all([
    db.from('suppliers').select('*').eq('id', String(demand['supplier_id'])).maybeSingle(),
    rowsWithItems('purchase_quotations', 'purchase_quotation_items', id, 'version'),
    rowsWithItems('purchase_bills', 'purchase_bill_items', id, 'submitted_at'),
    db.from('purchase_deliveries').select('*').eq('demand_id', id).maybeSingle(),
    db.from('purchase_receipts').select('*, items:purchase_receipt_items(*)').eq('demand_id', id).order('received_at', { ascending: true }),
    db.from('supplier_payments').select('*').eq('demand_id', id).order('recorded_at', { ascending: true }),
    db.from('supplier_credits').select('*').eq('demand_id', id).order('requested_at', { ascending: true }),
    db.from('purchase_demand_events').select('*').eq('demand_id', id).order('created_at', { ascending: true }).limit(1000),
    listDemandMessages(id),
    db.from('supplier_access_tokens').select('expires_at').eq('demand_id', id).is('revoked_at', null).order('created_at', { ascending: false }).limit(1),
  ]);
  for (const r of [supplierRes, deliveryRes, receipts, paymentsRes, creditsRes, eventsRes, tokenRes]) if (r.error) throw clientError(r.error);

  const payments = api<SupplierPayment[]>(paymentsRes.data ?? []);
  const posted = payments.filter((p) => p.status === 'posted').reduce((s, p) => s + Number(p.amount), 0);
  const pending = payments.filter((p) => p.status === 'pending_approval').reduce((s, p) => s + Number(p.amount), 0);
  const credits = (creditsRes.data ?? []).map((c: Row) => {
    const repaid = payments.filter((p) => p.creditId === c['id'] && p.status === 'posted').reduce((s, p) => s + Number(p.amount), 0);
    const approved = c['approved_amount'] == null ? 0 : Number(c['approved_amount']);
    return { ...api<SupplierCredit>(c), outstanding: ['active', 'settled'].includes(String(c['status'])) ? round2(approved - repaid) : 0 };
  });

  const billsApi = api<SupplierBill[]>(bills);
  const approvedBill = billsApi.find((b) => b.id === demand['approved_bill_id']) ?? null;
  const receiptsApi = api<PurchaseReceipt[]>(receipts.data ?? []);
  const receiptProgress = (approvedBill?.items ?? []).map((bi) => {
    const lines = receiptsApi.flatMap((r) => r.items).filter((ri) => ri.billItemId === bi.id);
    const received = round3(lines.reduce((s, l) => s + Number(l.receivedQty), 0));
    const damaged = round3(lines.reduce((s, l) => s + Number(l.damagedQty), 0));
    return { billItemId: bi.id, itemName: bi.itemName, unit: bi.unit, billed: Number(bi.qty), received, damaged, outstanding: round3(Math.max(0, Number(bi.qty) - received)) };
  });

  const base = api<PurchaseDemand>(demand);
  const billTotal = approvedBill ? Number(approvedBill.grandTotal) : null;
  return {
    ...base,
    supplier: supplierRes.data ? api(supplierRes.data) : null,
    quotations: api<Quotation[]>(quotations),
    bills: billsApi,
    delivery: deliveryRes.data ? api<PurchaseDelivery>(deliveryRes.data) : null,
    receipts: receiptsApi,
    payments,
    credits,
    events: api(eventsRes.data ?? []),
    messages,
    receiptProgress,
    totals: {
      billTotal,
      paidPosted: round2(posted),
      paidPending: round2(pending),
      outstanding: billTotal === null ? null : round2(billTotal - posted),
      creditOutstanding: round2(credits.reduce((s, c) => s + c.outstanding, 0)),
    },
    actions: demandActions({
      status: base.status,
      revision: base.revision,
      verifiedRevision: base.verifiedRevision,
      billTotal,
      paidRecorded: posted + pending,
      hasOpenCredit: credits.some((c) => c.status === 'pending_approval' || c.status === 'active'),
    }),
    linkExpiresAt: (tokenRes.data?.[0]?.['expires_at'] as string) ?? null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ── Draft, verify, send ─────────────────────────────────────────────────────

function demandJson(input: DemandInput) {
  return {
    supplierId: input.supplierId,
    priority: input.priority,
    requiredDate: input.requiredDate,
    notes: input.notes ?? null,
    deliveryInstructions: input.deliveryInstructions ?? null,
    paymentPreference: input.paymentPreference,
    creditReference: input.paymentPreference === 'credit' ? input.creditReference ?? null : null,
    creditAmountRequested: input.paymentPreference === 'credit' ? input.creditAmountRequested ?? null : null,
    creditTerms: input.paymentPreference === 'credit' ? input.creditTerms ?? null : null,
    creditDueDate: input.paymentPreference === 'credit' ? input.creditDueDate ?? null : null,
    creditNotes: input.paymentPreference === 'credit' ? input.creditNotes ?? null : null,
    clientRequestId: input.clientRequestId ?? null,
  };
}

function itemsJson(input: DemandInput) {
  return input.items.map((i) => ({
    itemId: i.itemId ?? null,
    itemName: i.itemName,
    itemCode: i.itemCode ?? null,
    requestedQty: i.requestedQty,
    unit: i.unit,
    note: i.note ?? null,
  }));
}

export async function createDemand(input: DemandInput, actor: Actor): Promise<PurchaseDemand & { replayed: boolean }> {
  const row = await call<Row>('purchase_create_demand', {
    p_demand: demandJson(input),
    p_items: itemsJson(input),
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_today: businessDateStr(),
  });
  return api(row);
}

export async function updateDemand(id: string, input: DemandInput & { revision: number }, actor: Actor): Promise<PurchaseDemand> {
  const row = await call<Row>('purchase_update_demand', {
    p_id: id,
    p_revision: input.revision,
    p_demand: demandJson(input),
    p_items: itemsJson(input),
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  return api(row);
}

/**
 * The checks behind Verify. Errors block sending; warnings are shown and do
 * not. Only a demand whose every error check passes is marked verified — and
 * only the revision that was checked: an edit afterwards un-verifies it.
 */
export async function verifyDemand(id: string, revision: number, actor: Actor): Promise<VerificationResult> {
  const d = await getDemand(id);
  const checks: VerificationCheck[] = [];
  const add = (key: string, label: string, ok: boolean, message?: string, severity: 'error' | 'warning' = 'error') =>
    checks.push({ key, label, ok, message: ok ? undefined : message, severity });

  add('state', 'Demand can be verified', d.status === 'draft' || d.status === 'verified', `It is ${d.status.replace(/_/g, ' ')}.`);
  add('revision', 'Nothing changed since it was opened', d.revision === revision, 'Someone edited it. Reload and verify again.');

  const today = businessDateStr();
  add('requiredDate', 'Required date is today or later', !!d.requiredDate && d.requiredDate >= today, 'Choose a required date from today on.');
  add('priority', 'Priority is set', d.priority === 'urgent' || d.priority === 'normal', 'Choose Urgent or Normal.');

  const { data: s, error } = await db.from('suppliers').select('*').eq('id', d.supplierId).maybeSingle();
  if (error) throw clientError(error);
  add('supplier', 'Supplier is registered and active', !!s && !s['deleted_at'] && !!s['is_active'], 'The supplier was removed or deactivated.');
  add('optIn', 'Supplier agreed to WhatsApp messages', !!s?.['whatsapp_opt_in_at'], 'Record the supplier\'s consent on their profile first.');
  const e164 = /^\+[1-9]\d{7,14}$/.test(d.supplierWhatsapp);
  add('number', 'WhatsApp number is in international format', e164, `${d.supplierWhatsapp} is not a valid number.`);
  add('numberCurrent', 'Number matches the supplier profile', !s || s['whatsapp_number'] === d.supplierWhatsapp,
    `The supplier's number is now ${String(s?.['whatsapp_number'])}. Edit and save the demand to use it.`);

  add('items', 'At least one item', d.items.length > 0, 'Add an item.');
  const badQty = d.items.filter((i) => !(Number(i.requestedQty) > 0));
  add('quantities', 'Every quantity is above zero', badQty.length === 0, `Check ${badQty.map((i) => i.itemName).join(', ')}.`);
  const seen = new Map<string, number>();
  for (const i of d.items) seen.set(`${i.itemName.trim().toLowerCase()}|${i.unit}`, (seen.get(`${i.itemName.trim().toLowerCase()}|${i.unit}`) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k.split('|')[0]);
  add('duplicates', 'No item is listed twice', dupes.length === 0, `Listed more than once: ${dupes.join(', ')}.`);

  if (d.paymentPreference === 'credit') {
    add('credit', 'Credit amount requested', Number(d.creditAmountRequested ?? 0) > 0, 'Enter the credit amount.');
    add('creditDue', 'Credit due date is not in the past', !d.creditDueDate || d.creditDueDate >= today, 'The credit due date has passed.', 'warning');
  }

  // A second demand for the same supplier in the last day may be a double submission.
  const { data: recent } = await db
    .from('purchase_demands')
    .select('demand_no')
    .eq('supplier_id', d.supplierId)
    .neq('id', d.id)
    .not('status', 'in', '(cancelled,rejected)')
    .gte('created_at', new Date(Date.now() - 86_400_000).toISOString())
    .limit(3);
  add('duplicateDemand', 'No other demand to this supplier in the last 24 hours', !recent?.length,
    `Also sent recently: ${(recent ?? []).map((r: Row) => r['demand_no']).join(', ')}. Make sure this is not a duplicate.`, 'warning');

  const cfg = whatsappConfig();
  if (cfg.provider === 'mock') {
    add('provider', 'WhatsApp is connected', false, 'WhatsApp is in mock mode: the message will be recorded but NOT delivered.', 'warning');
  } else {
    add('provider', 'WhatsApp is configured', cfg.missing.length === 0, `Not configured: ${cfg.missing.join(', ')}.`);
  }

  const ok = checks.every((c) => c.ok || c.severity === 'warning');
  if (ok) {
    const row = await call<Row>('purchase_mark_verified', { p_id: id, p_revision: revision, p_actor_id: actor.uid, p_actor_name: actor.name });
    return { ok, checks, demand: api(row) };
  }
  return { ok, checks, demand: d };
}

export async function sendDemand(id: string, revision: number, actor: Actor): Promise<PurchaseDemand & { messageId: string }> {
  const d = await demandRow(id);
  const cfg = whatsappConfig();
  if (cfg.provider === 'meta' && cfg.missing.length > 0) {
    throw Object.assign(new Error(`WhatsApp is not configured: ${cfg.missing.join(', ')}.`), { status: 503 });
  }
  const link = issueLink();
  const message = msg.demandSentMessage(d as never, link);
  const row = await call<Row>('purchase_send_demand', {
    p_id: id,
    p_revision: revision,
    p_token_hash: link.hash,
    p_token_expires: link.expiresAt,
    p_message: message,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  kickOutbox();
  return api(row);
}

export async function resendLink(id: string, actor: Actor): Promise<PurchaseDemand> {
  const d = await demandRow(id);
  const link = issueLink();
  const row = await call<Row>('purchase_resend_link', {
    p_id: id,
    p_token_hash: link.hash,
    p_token_expires: link.expiresAt,
    p_message: msg.linkResentMessage(d as never, link),
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  kickOutbox();
  return api(row);
}

export async function cancelDemand(id: string, reason: string, actor: Actor): Promise<PurchaseDemand> {
  const d = await demandRow(id);
  const row = await call<Row>('purchase_cancel_demand', {
    p_id: id,
    p_reason: reason,
    p_message: msg.cancelledMessage(d as never, reason),
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  kickOutbox();
  return api(row);
}

export async function addNote(id: string, note: string, actor: Actor): Promise<void> {
  await demandRow(id);
  const { error } = await db.from('purchase_demand_events').insert({
    demand_id: id,
    event: 'note',
    actor_type: 'staff',
    actor_id: actor.uid,
    actor_name: actor.name,
    reason: note.trim(),
  });
  if (error) throw clientError(error);
}

// ── Quotation ───────────────────────────────────────────────────────────────

export function quotationArgs(input: QuotationInput) {
  return {
    p_quotation: {
      deliveryCharge: input.deliveryCharge ?? 0,
      estimatedDeliveryDate: input.estimatedDeliveryDate ?? null,
      deliveryNotes: input.deliveryNotes ?? null,
      notes: input.notes ?? null,
      clientRequestId: input.clientRequestId ?? null,
    },
    p_items: input.items.map((l) => ({
      demandItemId: l.demandItemId ?? null,
      substituteForDemandItemId: l.substituteForDemandItemId ?? null,
      itemName: l.itemName,
      unit: l.unit ?? null,
      availableQty: l.availableQty,
      unitRate: l.unitRate,
      availability: l.availability,
      note: l.note ?? null,
    })),
  };
}

/**
 * Tell Production a supplier responded: an in-app notice to every Production
 * user, and a WhatsApp to the staff phones in WHATSAPP_PRODUCTION_ALERT_TO.
 */
export async function alertProduction(demandId: string, kind: 'quotation' | 'bill', uniq: string, title: string, body: string): Promise<void> {
  try {
    await notify({ type: kind === 'quotation' ? 'purchase_quotation' : 'purchase_bill', title, message: body, targetRole: 'production_user', relatedId: demandId });
    const d = await demandRow(demandId);
    for (const m of msg.productionAlerts(d as never, kind, uniq, `${body} Review it in the Mountain Bakes app.`)) {
      await call('whatsapp_enqueue', { p_message: m, p_actor_id: null, p_actor_name: 'system' });
    }
    kickOutbox();
  } catch (err) {
    console.error('[purchasing] production alert failed', (err as Error).message);
  }
}

/** Production keys in a quotation the supplier sent as an ordinary message. */
export async function enterQuotation(demandId: string, input: QuotationInput, actor: Actor): Promise<Quotation> {
  const row = await call<Row>('purchase_submit_quotation', {
    p_demand_id: demandId,
    p_via: 'staff',
    ...quotationArgs(input),
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  return api(row);
}

export async function decideQuotation(
  demandId: string,
  quotationId: string,
  input: { version: number; decision: 'approve' | 'request_changes' | 'reject'; reason?: string | null },
  actor: Actor,
): Promise<PurchaseDemand> {
  const d = await demandRow(demandId);
  const { data: q, error } = await db.from('purchase_quotations').select('id, version, total').eq('id', quotationId).eq('demand_id', demandId).maybeSingle();
  if (error) throw clientError(error);
  if (!q) throw notFound('Quotation');
  const reason = input.reason?.trim() ?? '';
  const link = input.decision === 'reject' ? null : issueLink();
  const message =
    input.decision === 'approve'
      ? msg.quotationApprovedMessage(d as never, input.version, Number(q['total']), link!)
      : input.decision === 'request_changes'
        ? msg.changesRequestedMessage(d as never, input.version, reason, link!)
        : msg.quotationRejectedMessage(d as never, input.version, reason);
  const row = await call<Row>('purchase_decide_quotation', {
    p_demand_id: demandId,
    p_quotation_id: quotationId,
    p_version: input.version,
    p_decision: input.decision,
    p_reason: reason || null,
    p_token_hash: link?.hash ?? null,
    p_token_expires: link?.expiresAt ?? null,
    p_message: message,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  kickOutbox();
  return api(row);
}

// ── Bill ────────────────────────────────────────────────────────────────────

export function billArgs(input: BillInput) {
  return {
    p_bill: {
      supplierBillNo: input.supplierBillNo,
      invoiceDate: input.invoiceDate,
      deliveryDate: input.deliveryDate ?? null,
      deliveryCharge: input.deliveryCharge ?? 0,
      discount: input.discount ?? 0,
      otherCharges: input.otherCharges ?? 0,
      otherChargesNote: input.otherChargesNote ?? null,
      supplierPaymentMethod: input.supplierPaymentMethod ?? null,
      supplierStatedPaid: input.supplierStatedPaid ?? 0,
      notes: input.notes ?? null,
      clientRequestId: input.clientRequestId ?? null,
    },
    p_items: input.items.map((l) => ({ quotationItemId: l.quotationItemId, qty: l.qty, unitRate: l.unitRate })),
  };
}

export async function enterBill(demandId: string, input: BillInput, actor: Actor): Promise<SupplierBill> {
  const row = await call<Row>('purchase_submit_bill', {
    p_demand_id: demandId,
    p_via: 'staff',
    ...billArgs(input),
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  return api(row);
}

export async function decideBill(
  demandId: string,
  billId: string,
  input: { decision: 'approve' | 'reject'; acceptDifferences?: boolean; reason?: string | null },
  actor: Actor,
): Promise<PurchaseDemand> {
  const d = await demandRow(demandId);
  const { data: b, error } = await db.from('purchase_bills').select('id, supplier_bill_no, grand_total').eq('id', billId).eq('demand_id', demandId).maybeSingle();
  if (error) throw clientError(error);
  if (!b) throw notFound('Bill');
  const reason = input.reason?.trim() ?? '';
  const link = input.decision === 'reject' ? issueLink() : null;
  const message =
    input.decision === 'approve'
      ? msg.billApprovedMessage(d as never, String(b['supplier_bill_no']), Number(b['grand_total']), billId)
      : msg.billRejectedMessage(d as never, String(b['supplier_bill_no']), reason, billId, link!);
  const row = await call<Row>('purchase_decide_bill', {
    p_demand_id: demandId,
    p_bill_id: billId,
    p_decision: input.decision,
    p_reason: reason || null,
    p_accept_differences: input.acceptDifferences ?? false,
    p_token_hash: link?.hash ?? null,
    p_token_expires: link?.expiresAt ?? null,
    p_message: message,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  kickOutbox();
  return api(row);
}

// ── Delivery, receipt ───────────────────────────────────────────────────────

export async function saveDelivery(demandId: string, input: Record<string, unknown>, actor: Actor): Promise<PurchaseDelivery> {
  const row = await call<Row>('purchase_save_delivery', { p_demand_id: demandId, p_delivery: input, p_actor_id: actor.uid, p_actor_name: actor.name });
  return api(row);
}

export async function recordReceipt(
  demandId: string,
  input: { items: Array<Record<string, unknown>>; final: boolean; notes?: string | null; businessDate?: string; clientRequestId?: string },
  actor: Actor,
): Promise<PurchaseReceipt & { status: string; shortages: unknown[]; replayed: boolean }> {
  const today = businessDateStr();
  const businessDate = input.businessDate ?? today;
  if (businessDate > today) throw Object.assign(new Error('Goods cannot be received on a future date.'), { status: 400 });
  const row = await call<Row>('purchase_record_receipt', {
    p_demand_id: demandId,
    p_receipt: { notes: input.notes ?? null, clientRequestId: input.clientRequestId ?? null },
    p_items: input.items,
    p_final: input.final,
    p_business_date: businessDate,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  return api(row);
}

// ── Payments and credit (Production's side) ─────────────────────────────────

async function notifyFinance(title: string, message: string, relatedId: string): Promise<void> {
  for (const targetRole of ['finance_admin', 'finance_manager'] as const) {
    try {
      await notify({ type: 'purchase_payment', title, message, targetRole, relatedId });
    } catch (err) {
      console.error('[purchasing] notify finance failed', (err as Error).message);
    }
  }
}

export async function recordPayment(demandId: string, input: Record<string, unknown>, actor: Actor): Promise<SupplierPayment & { replayed: boolean }> {
  const row = await call<Row>('purchase_record_payment', { p_demand_id: demandId, p_payment: input, p_actor_id: actor.uid, p_actor_name: actor.name });
  const payment = api<SupplierPayment & { replayed: boolean }>(row);
  if (!payment.replayed) {
    const d = await getDemand(demandId);
    await notifyFinance('Supplier payment to approve', `${payment.paymentNo}: ${rs(payment.amount)} ${payment.method} to ${d.supplierName} (${d.demandNo})`, payment.id);
  }
  return payment;
}

export async function requestCredit(demandId: string, input: Record<string, unknown>, actor: Actor): Promise<SupplierCredit> {
  const row = await call<Row>('purchase_request_credit', { p_demand_id: demandId, p_credit: input, p_actor_id: actor.uid, p_actor_name: actor.name });
  const credit = api<SupplierCredit>(row);
  const d = await getDemand(demandId);
  await notifyFinance('Supplier credit to approve', `${credit.creditNo}: ${rs(credit.requestedAmount)} on credit with ${d.supplierName} (${d.demandNo})`, credit.id);
  return { ...credit, outstanding: 0 };
}
