import { businessDateStr } from '../../shared';
import type { SupplierCredit, SupplierPayment } from '../../shared';
import { notify } from '../push.service';
import { api, call, clientError, db, rs, type Actor } from './common';

/**
 * Finance's side of supplier money. Production records a payment or asks for
 * credit; nothing reaches the book until a Finance approver acts here.
 *
 *   approve payment → one PV under the chosen expense head (Raw Materials by
 *                     default), source 'vendor_payment', via the same
 *                     post_finance_ledger_entry every finance document uses
 *   reject payment  → nothing posted, reason kept
 *   reverse payment → an opposite RV entry; the PV stays, marked reversed
 *   approve credit  → the amount becomes a supplier liability (active credit)
 *
 * The person who recorded a payment cannot approve it (checked in SQL).
 */

type Row = Record<string, unknown>;

const PAYMENT_SELECT = '*, supplier:suppliers(name), demand:purchase_demands(demand_no), bill:purchase_bills(supplier_bill_no)';

function shapePayment(r: Row): SupplierPayment {
  const one = (k: string) => (Array.isArray(r[k]) ? (r[k] as Row[])[0] : r[k]) as Row | null;
  const { supplier: _s, demand: _d, bill: _b, ...rest } = r;
  return {
    ...api<SupplierPayment>(rest),
    supplierName: (one('supplier')?.['name'] as string) ?? undefined,
    demandNo: (one('demand')?.['demand_no'] as string) ?? undefined,
    supplierBillNo: (one('bill')?.['supplier_bill_no'] as string) ?? undefined,
  };
}

export async function listPayments(opts: { status?: string; supplierId?: string; search?: string; limit?: number; offset?: number }): Promise<{ payments: SupplierPayment[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = db.from('supplier_payments').select(PAYMENT_SELECT, { count: 'exact' });
  if (opts.status) q = q.eq('status', opts.status);
  if (opts.supplierId) q = q.eq('supplier_id', opts.supplierId);
  const term = opts.search?.replace(/[(),*%]/g, ' ').trim();
  if (term) q = q.or(`payment_no.ilike.%${term}%,reference_no.ilike.%${term}%,voucher_no.ilike.%${term}%`);
  const { data, error, count } = await q.order('recorded_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  return { payments: ((data ?? []) as Row[]).map(shapePayment), total: count ?? 0 };
}

export async function listCredits(opts: { status?: string; supplierId?: string; limit?: number; offset?: number }): Promise<{ credits: SupplierCredit[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = db.from('supplier_credits').select('*, supplier:suppliers(name), demand:purchase_demands(demand_no)', { count: 'exact' });
  if (opts.status) q = q.eq('status', opts.status);
  if (opts.supplierId) q = q.eq('supplier_id', opts.supplierId);
  const { data, error, count } = await q.order('requested_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  const rows = (data ?? []) as Row[];

  // Repayments per credit on this page, for the outstanding figure.
  const ids = rows.map((r) => String(r['id']));
  const repaid = new Map<string, number>();
  if (ids.length) {
    const { data: pays, error: pErr } = await db.from('supplier_payments').select('credit_id, amount').in('credit_id', ids).eq('status', 'posted');
    if (pErr) throw clientError(pErr);
    for (const p of (pays ?? []) as Row[]) repaid.set(String(p['credit_id']), (repaid.get(String(p['credit_id'])) ?? 0) + Number(p['amount']));
  }
  return {
    credits: rows.map((r) => {
      const one = (k: string) => (Array.isArray(r[k]) ? (r[k] as Row[])[0] : r[k]) as Row | null;
      const { supplier: _s, demand: _d, ...rest } = r;
      const live = ['active', 'settled'].includes(String(r['status']));
      return {
        ...api<SupplierCredit>(rest),
        supplierName: (one('supplier')?.['name'] as string) ?? undefined,
        demandNo: (one('demand')?.['demand_no'] as string) ?? undefined,
        outstanding: live ? Math.round((Number(r['approved_amount'] ?? 0) - (repaid.get(String(r['id'])) ?? 0)) * 100) / 100 : 0,
      };
    }),
    total: count ?? 0,
  };
}

async function tellProduction(title: string, message: string, relatedId: string): Promise<void> {
  try {
    await notify({ type: 'purchase_payment_reviewed', title, message, targetRole: 'production_user', relatedId });
  } catch (err) {
    console.error('[purchasing] notify production failed', (err as Error).message);
  }
}

async function onePayment(id: string): Promise<SupplierPayment> {
  const { data, error } = await db.from('supplier_payments').select(PAYMENT_SELECT).eq('id', id).single();
  if (error) throw clientError(error);
  return shapePayment(data as Row);
}

export async function approvePayment(id: string, ledgerHeadId: string | null | undefined, actor: Actor): Promise<SupplierPayment> {
  await call('supplier_payment_approve', {
    p_id: id,
    p_ledger_head_id: ledgerHeadId ?? null,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_today: businessDateStr(),
  });
  const p = await onePayment(id);
  await tellProduction('Supplier payment approved', `${p.paymentNo}: ${rs(p.amount)} to ${p.supplierName ?? 'supplier'} posted as ${p.voucherNo}`, p.demandId);
  return p;
}

export async function rejectPayment(id: string, reason: string, actor: Actor): Promise<SupplierPayment> {
  await call('supplier_payment_reject', { p_id: id, p_reason: reason, p_actor_id: actor.uid, p_actor_name: actor.name });
  const p = await onePayment(id);
  await tellProduction('Supplier payment rejected', `${p.paymentNo}: ${rs(p.amount)} — ${reason}`, p.demandId);
  return p;
}

export async function reversePayment(id: string, reason: string, actor: Actor): Promise<SupplierPayment> {
  await call('supplier_payment_reverse', { p_id: id, p_reason: reason, p_actor_id: actor.uid, p_actor_name: actor.name, p_today: businessDateStr() });
  const p = await onePayment(id);
  await tellProduction('Supplier payment reversed', `${p.paymentNo}: ${rs(p.amount)} reversed by ${p.reversalVoucherNo} — ${reason}`, p.demandId);
  return p;
}

export async function decideCredit(
  id: string,
  input: { decision: 'approve' | 'reject'; approvedAmount?: number | null; reason?: string | null },
  actor: Actor,
): Promise<SupplierCredit> {
  const row = await call<Row>('supplier_credit_decide', {
    p_id: id,
    p_decision: input.decision,
    p_approved_amount: input.approvedAmount ?? null,
    p_reason: input.reason ?? null,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  const credit = api<SupplierCredit>(row);
  await tellProduction(
    input.decision === 'approve' ? 'Supplier credit approved' : 'Supplier credit rejected',
    input.decision === 'approve' ? `${credit.creditNo}: ${rs(credit.approvedAmount)} on credit` : `${credit.creditNo}: ${input.reason ?? ''}`,
    credit.demandId,
  );
  return { ...credit, outstanding: credit.status === 'active' ? Number(credit.approvedAmount ?? 0) : 0 };
}

/** The expense heads a supplier payment may post under. */
export async function expenseHeads(): Promise<Array<{ id: string; code: string; name: string }>> {
  const { data, error } = await db.from('ledger_heads').select('id, code, name').eq('type', 'expense').eq('is_active', true).order('sort_order', { ascending: true });
  if (error) throw clientError(error);
  return (data ?? []) as Array<{ id: string; code: string; name: string }>;
}
