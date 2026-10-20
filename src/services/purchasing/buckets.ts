import type { QueryBuilder } from '../../db';
import type { PurchaseBucket, PurchaseDemandActions, PurchaseDemandStatus } from '../../shared';

/**
 * The page's work-queue tabs as filters on the purchase_demand_list view. The
 * counts come from public.purchase_summary(), which states the same rules in
 * SQL: change one, change the other.
 */

export const OPEN_EXCLUDED = ['received', 'cancelled', 'rejected'] as const;

export function applyBucket(q: QueryBuilder, bucket: PurchaseBucket): QueryBuilder {
  switch (bucket) {
    case 'pending':
      return q.not('status', 'in', `(${OPEN_EXCLUDED.join(',')})`);
    case 'urgent':
      return q.not('status', 'in', `(${OPEN_EXCLUDED.join(',')})`).eq('priority', 'urgent');
    case 'normal':
      return q.not('status', 'in', `(${OPEN_EXCLUDED.join(',')})`).eq('priority', 'normal');
    case 'awaiting_supplier':
      return q.in('status', ['awaiting_supplier', 'changes_requested']);
    case 'quotation_received':
      return q.eq('status', 'quotation_received');
    case 'awaiting_approval':
      return q.in('status', ['quotation_received', 'bill_submitted']);
    case 'approved':
      return q.in('status', ['awaiting_supplier_bill', 'bill_submitted', 'awaiting_delivery', 'partially_received', 'received']);
    case 'awaiting_bill':
      return q.eq('status', 'awaiting_supplier_bill');
    case 'awaiting_delivery':
      return q.in('status', ['awaiting_delivery', 'partially_received']);
    case 'unpaid':
      return q.not('approved_bill_id', 'is', null).neq('status', 'cancelled').in('payment_status', ['unpaid', 'partially_paid']);
    case 'completed':
      return q.eq('status', 'received').eq('payment_status', 'paid');
    case 'closed':
      return q.in('status', ['cancelled', 'rejected']);
    default:
      return q;
  }
}

const is = (s: PurchaseDemandStatus, ...set: PurchaseDemandStatus[]) => set.includes(s);

/**
 * Which buttons the demand screen may offer. The database functions enforce
 * the same states; this only spares a person a button that would be refused.
 */
export function demandActions(d: {
  status: PurchaseDemandStatus;
  revision: number;
  verifiedRevision: number | null;
  billTotal: number | null;
  paidRecorded: number;
  hasOpenCredit: boolean;
}): PurchaseDemandActions {
  const s = d.status;
  const billed = is(s, 'awaiting_delivery', 'partially_received', 'received');
  const unpaidLeft = d.billTotal !== null && d.paidRecorded < d.billTotal;
  return {
    edit: is(s, 'draft', 'verified'),
    verify: is(s, 'draft', 'verified'),
    send: s === 'verified' && d.verifiedRevision === d.revision,
    resendLink: is(s, 'awaiting_supplier', 'quotation_received', 'changes_requested', 'awaiting_supplier_bill', 'bill_submitted'),
    cancel: is(s, 'draft', 'verified', 'awaiting_supplier', 'quotation_received', 'changes_requested', 'awaiting_supplier_bill', 'bill_submitted'),
    enterQuotation: is(s, 'awaiting_supplier', 'quotation_received', 'changes_requested', 'awaiting_supplier_bill'),
    decideQuotation: s === 'quotation_received',
    enterBill: s === 'awaiting_supplier_bill',
    decideBill: s === 'bill_submitted',
    saveDelivery: is(s, 'awaiting_supplier_bill', 'bill_submitted', 'awaiting_delivery', 'partially_received', 'received'),
    receive: is(s, 'awaiting_delivery', 'partially_received'),
    recordPayment: billed && unpaidLeft,
    requestCredit: billed && unpaidLeft && !d.hasOpenCredit,
    message: !is(s, 'draft', 'verified'),
  };
}
