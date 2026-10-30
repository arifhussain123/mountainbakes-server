import { dbFor } from '../db';
import {
  businessDateStr,
  EDITABLE_DOC_STATUSES,
  SYSTEM_LEDGER_HEAD_CODES,
  type CreateFinanceTransactionInput,
  type CreatePartnerExpenseInput,
  type FinanceDocStatus,
  type FinanceDocumentEvent,
  type FinanceDocumentType,
  type FinancePartner,
  type FinanceTransaction,
  type LedgerEntry,
  type LedgerSourceType,
  type PartnerExpense,
  type PartnerShareSummary,
  type UpdateFinancePartnerInput,
  type UpdateFinanceTransactionInput,
  type UpdatePartnerExpenseInput,
  type UserRole,
} from '../shared';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';
import { bindAttachments, listAttachments, listAttachmentsFor } from './attachments.service';
import { getLedgerEntry, getLedgerSummary, postEntry, requireActiveHead } from './finance-ledger.service';
import { getLedgerHeadByCode, round2 } from './finance-settings.service';
import { checkFinanceEntry, enforceRestrictions, type RestrictionGuard } from './restriction.service';

const db = dbFor('finance-documents');

/**
 * Manual income / expense documents and partner expenses.
 *
 * Both walk the same lifecycle — draft → pending_approval → approved → posted →
 * locked, or rejected — and both post to the ledger at the moment of approval.
 * The shared machinery for that lives in `approveDocument` at the bottom; the
 * per-type functions above it exist because the two carry different fields, not
 * different rules.
 *
 * WHY THE DOCUMENT AND THE LEDGER ENTRY ARE SEPARATE ROWS: the document holds
 * the decision trail (who raised it, who approved it, why it was rejected, what
 * it was edited from); the ledger entry holds the money and is immutable. Fusing
 * them would mean either a mutable ledger or an untraceable approval, and both
 * are disqualifying.
 */

const num = (v: unknown) => Number(v ?? 0);

/**
 * The single place that decides where a new document starts.
 *
 * `asDraft` is what the "Save as draft" button sends; everything else goes
 * straight into the approval queue, because the common case is an accountant
 * entering a real receipt they want signed off today.
 */
function initialStatus(asDraft: boolean): FinanceDocStatus {
  return asDraft ? 'draft' : 'pending_approval';
}

function assertEditable(doc: { status: FinanceDocStatus }, ref: string): void {
  if (!EDITABLE_DOC_STATUSES.includes(doc.status)) {
    throw Object.assign(
      new Error(
        doc.status === 'pending_approval'
          ? `${ref} is awaiting approval. Ask an approver to reject it first if it needs changing.`
          : `${ref} is ${doc.status} and can no longer be edited. Post an adjustment instead.`,
      ),
      { status: 409 },
    );
  }
}

// ---------------------------------------------------------------------------
// Manual income / expense (finance_transactions)
// ---------------------------------------------------------------------------

export type TransactionSortKey =
  | 'txnNo'
  | 'businessDate'
  | 'ledgerHeadName'
  | 'description'
  | 'branchName'
  | 'notes'
  | 'amount'
  | 'paymentMethod'
  | 'status'
  | 'submittedAt'
  | 'submittedByName'
  | 'createdByName';

const TRANSACTION_SORTABLE_COLUMNS: Record<TransactionSortKey, string> = {
  txnNo: 'txn_no',
  businessDate: 'business_date',
  ledgerHeadName: 'ledger_head_name',
  description: 'description',
  branchName: 'branch_name',
  notes: 'notes',
  amount: 'amount',
  paymentMethod: 'payment_method',
  status: 'status',
  submittedAt: 'submitted_at',
  submittedByName: 'submitted_by_name',
  createdByName: 'created_by_name',
};

export interface TransactionQuery {
  status?: FinanceDocStatus | 'pending';
  type?: 'income' | 'expense';
  branchId?: string;
  ledgerHeadId?: string;
  paymentMethod?: string;
  /** The user who last sent it for approval — the approval queue's filter. */
  submittedBy?: string;
  from?: string;
  to?: string;
  search?: string;
  minAmount?: number;
  maxAmount?: number;
  limit?: number;
  offset?: number;
  sortBy?: TransactionSortKey;
  sortDir?: 'asc' | 'desc';
}

export async function listTransactions(
  q: TransactionQuery,
): Promise<{ transactions: FinanceTransaction[]; total: number }> {
  const limit = Math.min(Math.max(Number(q.limit ?? 200), 1), 500);
  const offset = Math.max(Number(q.offset ?? 0), 0);

  // An unknown key (a column the screen sorts but the API does not) falls back
  // to the default rather than ordering by nothing.
  const sortCol = (q.sortBy && TRANSACTION_SORTABLE_COLUMNS[q.sortBy]) || 'business_date';
  const ascending = q.sortDir === 'asc';

  let query = withoutDeleted(
    db
      .from('finance_transactions')
      .select('*', { count: 'exact' })
      .order(sortCol, { ascending })
      .range(offset, offset + limit - 1),
  );
  if (sortCol !== 'created_at') query = query.order('created_at', { ascending });

  if (q.status === 'pending') query = query.in('status', ['draft', 'pending_approval']);
  else if (q.status) query = query.eq('status', q.status);
  if (q.type) query = query.eq('txn_type', q.type);
  if (q.branchId) query = query.eq('branch_id', q.branchId);
  if (q.ledgerHeadId) query = query.eq('ledger_head_id', q.ledgerHeadId);
  if (q.paymentMethod) query = query.eq('payment_method', q.paymentMethod);
  if (q.submittedBy) query = query.eq('submitted_by', q.submittedBy);
  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);
  if (q.minAmount !== undefined) query = query.gte('amount', q.minAmount);
  if (q.maxAmount !== undefined) query = query.lte('amount', q.maxAmount);
  if (q.search) {
    const term = q.search.replace(/[,()*]/g, ' ').trim();
    if (term) {
      query = query.or(
        `txn_no.ilike.%${term}%,description.ilike.%${term}%,ledger_head_name.ilike.%${term}%,reference_no.ilike.%${term}%`,
      );
    }
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = rowToApi<FinanceTransaction[]>(data ?? []).map((t) => ({ ...t, amount: num(t.amount) }));
  // One query and one signing call for the whole page, not one per row; the
  // same for the RV-/PV- of the posted rows.
  const ledgerIds = rows.map((t) => t.ledgerEntryId).filter((id): id is string => !!id);
  const [photos, vouchers] = await Promise.all([
    listAttachmentsFor(
      'finance_transaction',
      rows.map((t) => t.id),
    ),
    ledgerIds.length
      ? db.from('ledger_entries').select('id, voucher_no').in('id', ledgerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (vouchers.error) throw vouchers.error;
  const voucherOf = new Map(
    ((vouchers.data ?? []) as Record<string, unknown>[]).map((v) => [v['id'] as string, v['voucher_no'] as string]),
  );
  return {
    transactions: rows.map((t) => ({
      ...t,
      attachments: photos.get(t.id) ?? [],
      voucherNo: t.ledgerEntryId ? (voucherOf.get(t.ledgerEntryId) ?? null) : null,
    })),
    total: count ?? 0,
  };
}

/**
 * Branch income posts income-type ledger entries automatically (company
 * share / branch share — see finance-income.service.ts). A manual entry
 * booked against the same head, for the same amount, on the same date is
 * almost always someone re-keying money that already reached the book, not
 * a second real transaction that happens to coincide. Rather than silently
 * accepting the double-count, this throws a 409 with the matching entry
 * attached; the client shows it as a warning and can resubmit with
 * `confirmDuplicate: true` for the rare case it really is a coincidence.
 */
async function assertNotDuplicateIncome(
  ledgerHeadId: string,
  amount: number,
  businessDate: string,
): Promise<void> {
  // A DELETED voucher must not block the re-entry that replaces it: the whole
  // point of deleting a wrong income posting is to enter the right one, and
  // matching against the deleted row would reject it as a duplicate of itself.
  const { data: existing, error } = await withoutDeleted(
    db
      .from('ledger_entries')
      .select('voucher_no, entry_date, debit, ledger_head_name')
      .eq('ledger_head_id', ledgerHeadId)
      .eq('entry_date', businessDate)
      .eq('debit', round2(amount))
      .in('source_type', ['branch_income', 'company_share', 'branch_share'])
      .in('status', ['posted', 'locked'])
      .limit(1),
  ).maybeSingle();
  if (error) throw error;
  if (!existing) return;

  throw Object.assign(
    new Error(
      `This matches ${existing.voucher_no} — ${existing.ledger_head_name}, already posted from Branch ` +
        `Income for ${existing.entry_date} at the same amount. If this is a genuinely separate ` +
        `transaction that happens to coincide, confirm to create it anyway.`,
    ),
    {
      status: 409,
      details: {
        code: 'duplicate_income',
        existing: {
          voucherNo: existing.voucher_no as string,
          entryDate: existing.entry_date as string,
          amount: num(existing.debit),
          ledgerHeadName: existing.ledger_head_name as string,
        },
      },
    },
  );
}

/**
 * Restriction Rules (migration 136) for a finance entry: the ledger back-entry
 * period and Company Share keyed as income. Bound to the user, the head, the
 * date and the amount, so an approval covers exactly the entry it was asked
 * for. A Super Admin is the approver of these rules, not their subject.
 */
async function guardFinanceEntry(
  entry: { ledgerHeadId: string; businessDate: string; amount: number; branch: { id: string; name: string } | null },
  actor: { uid: string; name: string; role?: UserRole },
): Promise<RestrictionGuard | null> {
  if (actor.role === 'super_admin') return null;
  return enforceRestrictions(
    await checkFinanceEntry({
      userId: actor.uid,
      ledgerHeadId: entry.ledgerHeadId,
      businessDate: entry.businessDate,
      amount: round2(entry.amount),
    }),
    { action: 'Ledger entry', actor, branch: entry.branch },
  );
}

/**
 * An entry may cite only an AI Expense Capture run its own creator made: the
 * link is the audit trail of where the figures came from, so it must not be
 * pointed at someone else's run.
 */
async function assertOwnCapture(captureId: string, actor: { uid: string }): Promise<void> {
  const { data, error } = await db
    .from('finance_ai_captures')
    .select('id')
    .eq('id', captureId)
    .eq('created_by', actor.uid)
    .eq('status', 'ok')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('That AI capture run was not found.'), { status: 400 });
}

export async function createTransaction(
  input: CreateFinanceTransactionInput,
  actor: { uid: string; name: string; role?: UserRole },
): Promise<FinanceTransaction> {
  // The head is read from the database and ITS type decides whether this is
  // income or expense. Nothing the client sent gets a vote — see the schema note.
  const head = await requireActiveHead(input.ledgerHeadId);
  const branch = await resolveBranch(input.branchId);
  const businessDate = input.businessDate ?? businessDateStr();
  if (input.aiCaptureId) await assertOwnCapture(input.aiCaptureId, actor);

  if (head.type === 'income' && !input.confirmDuplicate) {
    await assertNotDuplicateIncome(head.id, input.amount, businessDate);
  }

  // Last, so an approval is only spent on an entry that has passed every other
  // check and is about to be written.
  const guard = await guardFinanceEntry({ ledgerHeadId: head.id, businessDate, amount: input.amount, branch }, actor);
  const status = initialStatus(input.asDraft);

  const { data, error } = await db
    .from('finance_transactions')
    .insert({
      txn_type: head.type,
      ledger_head_id: head.id,
      ledger_head_name: head.name,
      branch_id: branch?.id ?? null,
      branch_name: branch?.name ?? null,
      description: input.description,
      amount: round2(input.amount),
      payment_method: input.paymentMethod,
      account: input.account,
      business_date: businessDate,
      status,
      reference_no: input.referenceNo?.trim() || null,
      notes: input.notes?.trim() || null,
      // Only when set, so a database without the column still takes hand-keyed entries.
      ...(input.aiCaptureId ? { ai_capture_id: input.aiCaptureId } : {}),
      created_by: actor.uid,
      created_by_name: actor.name,
      ...(status === 'pending_approval' ? submittedStamp(actor) : {}),
    })
    .select('*')
    .single();
  if (error) {
    await guard?.release();
    throw error;
  }

  const txn = rowToApi<FinanceTransaction>(data);
  await guard?.commit(txn.txnNo);
  // Binding happens after the insert because the staged photos need this row's
  // id. A failure here throws, leaving an entry with no photo — recoverable
  // (it is a draft or pending, both editable) and far preferable to the
  // alternative of swallowing the error and silently accepting an
  // unsubstantiated voucher.
  const attachments = await bindAttachments({
    entity: 'finance_transaction',
    entityId: txn.id,
    attachmentIds: input.attachmentIds,
    actor,
  });
  return { ...txn, attachments };
}

export async function updateTransaction(
  id: string,
  input: UpdateFinanceTransactionInput,
  actor?: { uid: string; name: string; role?: UserRole },
): Promise<FinanceTransaction> {
  const current = await getTransaction(id);
  if (!current) throw Object.assign(new Error('Entry not found'), { status: 404 });
  assertEditable(current, current.txnNo);

  // An edit that changes the date, the head or the amount is a new decision
  // under the restriction rules. Otherwise "save it for today, then edit the
  // date" would walk around the back-entry period, and an approval given for
  // one amount could be stretched to cover another. An edit that leaves all
  // three alone (a description, a reference) is not re-examined.
  const nextAmount = input.amount !== undefined ? round2(input.amount) : Number(current.amount);
  const changed =
    (input.businessDate !== undefined && input.businessDate !== current.businessDate) ||
    (input.ledgerHeadId !== undefined && input.ledgerHeadId !== current.ledgerHeadId) ||
    nextAmount !== Number(current.amount);
  const guard =
    actor && changed
      ? await guardFinanceEntry(
          {
            ledgerHeadId: input.ledgerHeadId ?? current.ledgerHeadId,
            businessDate: input.businessDate ?? current.businessDate,
            amount: nextAmount,
            branch: current.branchId ? { id: current.branchId, name: current.branchName ?? '' } : null,
          },
          actor,
        )
      : null;

  const row: Record<string, unknown> = {};
  if (input.ledgerHeadId !== undefined) {
    const head = await requireActiveHead(input.ledgerHeadId);
    row['ledger_head_id'] = head.id;
    row['ledger_head_name'] = head.name;
    row['txn_type'] = head.type;
  }
  if (input.branchId !== undefined) {
    const branch = await resolveBranch(input.branchId);
    row['branch_id'] = branch?.id ?? null;
    row['branch_name'] = branch?.name ?? null;
  }
  if (input.description !== undefined) row['description'] = input.description;
  if (input.amount !== undefined) row['amount'] = round2(input.amount);
  if (input.paymentMethod !== undefined) row['payment_method'] = input.paymentMethod;
  if (input.account !== undefined) row['account'] = input.account;
  if (input.businessDate !== undefined) row['business_date'] = input.businessDate;
  // A cleared box is "none", not an empty string — so an untouched blank field
  // is no change at all in the entry's history.
  if (input.referenceNo !== undefined) row['reference_no'] = input.referenceNo?.trim() || null;
  if (input.notes !== undefined) row['notes'] = input.notes?.trim() || null;
  if (actor) {
    row['updated_by'] = actor.uid;
    row['updated_by_name'] = actor.name;
  }

  // "Save and resubmit": the correction and the submission are one statement,
  // so the approver can never be shown the entry before its correction. A plain
  // save leaves a rejected entry rejected, remarks and all, until the author
  // chooses to send it back.
  if (input.resubmit) {
    if (!actor) throw Object.assign(new Error('Submitting needs a signed-in user.'), { status: 401 });
    Object.assign(row, { status: 'pending_approval', rejection_reason: null }, submittedStamp(actor));
  }

  const { data, error } = await withoutDeleted(
    db.from('finance_transactions').update(row).eq('id', id).in('status', EDITABLE_DOC_STATUSES),
  )
    .select('*')
    .single();
  if (error) {
    await guard?.release();
    throw error;
  }
  await guard?.commit(current.txnNo);
  return rowToApi<FinanceTransaction>(data);
}

export async function getTransaction(id: string): Promise<FinanceTransaction | null> {
  const { data, error } = await withoutDeleted(
    db.from('finance_transactions').select('*').eq('id', id),
  ).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const ledgerEntryId = (data as Record<string, unknown>)['ledger_entry_id'] as string | null;
  const [attachments, voucher] = await Promise.all([
    listAttachments('finance_transaction', id),
    ledgerEntryId
      ? db.from('ledger_entries').select('voucher_no').eq('id', ledgerEntryId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (voucher.error) throw voucher.error;
  return {
    ...rowToApi<FinanceTransaction>(data),
    amount: num((data as Record<string, unknown>)['amount']),
    attachments,
    voucherNo: (voucher.data?.['voucher_no'] as string | undefined) ?? null,
  };
}

/** Who sent an entry for approval, and when — on every submission and resubmission. */
function submittedStamp(actor: { uid: string; name: string }) {
  return {
    submitted_by: actor.uid,
    submitted_by_name: actor.name,
    submitted_at: new Date().toISOString(),
  };
}

/**
 * Move a draft, or a corrected rejected entry, into the approval queue.
 *
 * The entry is checked again first — its head may have been closed since it was
 * keyed — so the approver is not handed something that can only fail to post.
 * A resubmission is the same row: the trigger raises its revision and the
 * history keeps the rejection it answers.
 */
export async function submitTransaction(
  id: string,
  actor: { uid: string; name: string },
): Promise<FinanceTransaction> {
  const current = await getTransaction(id);
  if (!current) throw Object.assign(new Error('Entry not found'), { status: 404 });
  if (!EDITABLE_DOC_STATUSES.includes(current.status)) {
    throw Object.assign(
      new Error(
        current.status === 'pending_approval'
          ? `${current.txnNo} is already awaiting approval.`
          : `${current.txnNo} is ${current.status}; only a draft or rejected entry can be submitted.`,
      ),
      { status: 409 },
    );
  }
  await requireActiveHead(current.ledgerHeadId);

  const { data, error } = await withoutDeleted(
    db
      .from('finance_transactions')
      .update({ status: 'pending_approval', rejection_reason: null, ...submittedStamp(actor) })
      .eq('id', id)
      .in('status', EDITABLE_DOC_STATUSES),
  )
    .select('*')
    .maybeSingle();
  if (error) throw error;
  // Lost a race with another tab or user: say what it is now.
  if (!data) throw Object.assign(new Error(`${current.txnNo} was just submitted by someone else.`), { status: 409 });
  return rowToApi<FinanceTransaction>(data);
}

/**
 * Approve and post, as ONE database transaction (approve_finance_transaction):
 * the voucher number, the ledger row and the entry's `posted` status are
 * committed together or not at all. Two approvers at once: the row lock makes
 * the second wait, find it posted, and get a 409. A refused posting (closed
 * day, inactive head) leaves the entry pending with no voucher spent.
 */
export async function approveTransaction(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<{ document: FinanceTransaction; entry: LedgerEntry }> {
  const { data, error } = await db.rpc('approve_finance_transaction', {
    p_id: id,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_note: notes ?? null,
  });
  if (error) {
    if (error.code === 'P0002') throw Object.assign(new Error('Entry not found'), { status: 404 });
    if (error.code === 'P0001') throw Object.assign(new Error(error.message), { status: 409 });
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw Object.assign(new Error('Entry not found'), { status: 404 });

  const [document, entry] = await Promise.all([
    getTransaction(id),
    getLedgerEntry(String(row['ledger_entry_id'])),
  ]);
  return { document: document!, entry: entry! };
}

/**
 * Send an entry back to its author. The rejecter goes in rejected_*, not
 * approved_*, and the remarks stay in the history after the entry is corrected.
 */
export async function rejectTransaction(
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<FinanceTransaction> {
  const remarks = reason.trim();
  if (remarks.length < 3) throw Object.assign(new Error('A reason is required to reject an entry.'), { status: 400 });

  const { data, error } = await withoutDeleted(
    db
      .from('finance_transactions')
      .update({
        status: 'rejected',
        rejection_reason: remarks,
        rejected_by: actor.uid,
        rejected_by_name: actor.name,
        rejected_at: new Date().toISOString(),
      })
      .eq('id', id)
      .in('status', ['draft', 'pending_approval']),
  )
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const current = await getTransaction(id);
    if (!current) throw Object.assign(new Error('Entry not found'), { status: 404 });
    throw Object.assign(
      new Error(
        `${current.txnNo} is ${current.status}. Only a pending entry can be rejected; a posted one needs a reversal instead.`,
      ),
      { status: 409 },
    );
  }
  return (await getTransaction(id))!;
}

/** The entry's workflow history, oldest first. */
export async function getDocumentHistory(
  documentType: FinanceDocumentType,
  documentId: string,
): Promise<FinanceDocumentEvent[]> {
  const { data, error } = await db
    .from('finance_document_events')
    .select('*')
    .eq('document_type', documentType)
    .eq('document_id', documentId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return rowToApi<FinanceDocumentEvent[]>(data ?? []).map((e) => ({ ...e, changes: e.changes ?? {} }));
}

/**
 * Everyone who has sent an entry for approval — the approval queue's
 * "Submitted by" choices. Distinct by user; the newest name wins.
 */
export async function listSubmitters(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await withoutDeleted(
    db
      .from('finance_transactions')
      .select('submitted_by, submitted_by_name')
      .not('submitted_by', 'is', null)
      .order('submitted_at', { ascending: false })
      .limit(1000),
  );
  if (error) throw error;
  const seen = new Map<string, string>();
  for (const r of data ?? []) {
    const id = String(r['submitted_by']);
    if (!seen.has(id)) seen.set(id, String(r['submitted_by_name'] ?? 'Unknown'));
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------------

export async function listFinancePartners(includeInactive = false): Promise<FinancePartner[]> {
  let query = db.from('finance_partners').select('*').order('name', { ascending: true });
  if (!includeInactive) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw error;
  return rowToApi<FinancePartner[]>(data ?? []).map((p) => ({ ...p, sharePct: num(p.sharePct) }));
}

async function requireActivePartner(id: string): Promise<FinancePartner> {
  const { data, error } = await db.from('finance_partners').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Partner not found'), { status: 404 });
  const partner = { ...rowToApi<FinancePartner>(data), sharePct: num((data as Record<string, unknown>)['share_pct']) };
  if (!partner.isActive) throw Object.assign(new Error(`${partner.name} is not an active partner.`), { status: 400 });
  return partner;
}

/** Profile edit only — name and sharePct are fixed at seed time. */
export async function updateFinancePartner(id: string, input: UpdateFinancePartnerInput): Promise<FinancePartner> {
  const row: Record<string, unknown> = {};
  if (input.fatherName !== undefined) row['father_name'] = input.fatherName;
  if (input.dateOfBirth !== undefined) row['date_of_birth'] = input.dateOfBirth;
  if (input.joinedOn !== undefined) row['joined_on'] = input.joinedOn;
  if (input.partnerType !== undefined) row['partner_type'] = input.partnerType;
  if (input.address !== undefined) row['address'] = input.address;
  if (input.contactNumber !== undefined) row['contact_number'] = input.contactNumber;
  if (input.emergencyNumber !== undefined) row['emergency_number'] = input.emergencyNumber;

  const { data, error } = await db
    .from('finance_partners')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return { ...rowToApi<FinancePartner>(data), sharePct: num((data as Record<string, unknown>)['share_pct']) };
}

// ---------------------------------------------------------------------------
// Partner advances / draws (partner_expenses)
// ---------------------------------------------------------------------------

export type PartnerExpenseSortKey = 'expenseNo' | 'partnerName' | 'businessDate' | 'amount' | 'paymentMethod' | 'status';

const PARTNER_EXPENSE_SORTABLE_COLUMNS: Record<PartnerExpenseSortKey, string> = {
  expenseNo: 'expense_no',
  partnerName: 'partner_name',
  businessDate: 'business_date',
  amount: 'amount',
  paymentMethod: 'payment_method',
  status: 'status',
};

export interface PartnerExpenseQuery {
  status?: FinanceDocStatus | 'pending';
  partnerId?: string;
  partnerName?: string;
  txnKind?: 'advance' | 'draw';
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: PartnerExpenseSortKey;
  sortDir?: 'asc' | 'desc';
}

export async function listPartnerExpenses(
  q: PartnerExpenseQuery,
): Promise<{ expenses: PartnerExpense[]; total: number }> {
  const limit = Math.min(Math.max(Number(q.limit ?? 200), 1), 500);
  const offset = Math.max(Number(q.offset ?? 0), 0);

  const sortCol = q.sortBy ? PARTNER_EXPENSE_SORTABLE_COLUMNS[q.sortBy] : 'business_date';
  const ascending = q.sortDir === 'asc';

  let query = withoutDeleted(
    db
      .from('partner_expenses')
      .select('*', { count: 'exact' })
      .order(sortCol, { ascending })
      .range(offset, offset + limit - 1),
  );
  if (sortCol !== 'created_at') query = query.order('created_at', { ascending });

  if (q.status === 'pending') query = query.in('status', ['draft', 'pending_approval']);
  else if (q.status) query = query.eq('status', q.status);
  if (q.partnerId) query = query.eq('partner_id', q.partnerId);
  if (q.partnerName) query = query.eq('partner_name', q.partnerName);
  if (q.txnKind) query = query.eq('txn_kind', q.txnKind);
  if (q.from) query = query.gte('business_date', q.from);
  if (q.to) query = query.lte('business_date', q.to);
  if (q.search) {
    const term = q.search.replace(/[,()*]/g, ' ').trim();
    if (term) {
      query = query.or(
        `expense_no.ilike.%${term}%,partner_name.ilike.%${term}%,description.ilike.%${term}%,ledger_head_name.ilike.%${term}%`,
      );
    }
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = rowToApi<PartnerExpense[]>(data ?? []).map((p) => ({ ...p, amount: num(p.amount) }));
  const photos = await listAttachmentsFor(
    'partner_expense',
    rows.map((p) => p.id),
  );
  return {
    expenses: rows.map((p) => ({ ...p, attachments: photos.get(p.id) ?? [] })),
    total: count ?? 0,
  };
}

const TXN_KIND_LABEL: Record<'advance' | 'draw', string> = { advance: 'Advance to', draw: 'Draw by' };

export async function createPartnerExpense(
  input: CreatePartnerExpenseInput,
  actor: { uid: string; name: string },
): Promise<PartnerExpense> {
  const partner = await requireActivePartner(input.partnerId);
  // Always EXP-PARTNER, resolved here rather than taken from the client — the
  // form only asks for a partner, an amount and a reason, not a ledger head.
  const head = await getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.PARTNER_WITHDRAWAL);

  const { data, error } = await db
    .from('partner_expenses')
    .insert({
      partner_id: partner.id,
      partner_name: partner.name,
      txn_kind: input.txnKind,
      ledger_head_id: head.id,
      ledger_head_name: head.name,
      description: `${TXN_KIND_LABEL[input.txnKind]} ${partner.name}`,
      amount: round2(input.amount),
      payment_method: input.paymentMethod,
      account: input.account,
      business_date: input.businessDate ?? businessDateStr(),
      status: initialStatus(input.asDraft),
      requested_by: actor.uid,
      requested_by_name: actor.name,
      notes: input.notes ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;

  const expense = rowToApi<PartnerExpense>(data);
  const attachments = await bindAttachments({
    entity: 'partner_expense',
    entityId: expense.id,
    attachmentIds: input.attachmentIds,
    actor,
  });
  return { ...expense, attachments };
}

export async function updatePartnerExpense(
  id: string,
  input: UpdatePartnerExpenseInput,
): Promise<PartnerExpense> {
  const current = await getPartnerExpense(id);
  if (!current) throw Object.assign(new Error('Partner expense not found'), { status: 404 });
  assertEditable(current, current.expenseNo);

  const row: Record<string, unknown> = {};
  if (input.amount !== undefined) row['amount'] = round2(input.amount);
  if (input.paymentMethod !== undefined) row['payment_method'] = input.paymentMethod;
  if (input.account !== undefined) row['account'] = input.account;
  if (input.businessDate !== undefined) row['business_date'] = input.businessDate;
  if (input.notes !== undefined) row['notes'] = input.notes;
  if (current.status === 'rejected') {
    row['status'] = 'pending_approval';
    row['rejection_reason'] = null;
  }

  const { data, error } = await withoutDeleted(
    db.from('partner_expenses').update(row).eq('id', id).in('status', EDITABLE_DOC_STATUSES),
  )
    .select('*')
    .single();
  if (error) throw error;
  return rowToApi<PartnerExpense>(data);
}

export async function getPartnerExpense(id: string): Promise<PartnerExpense | null> {
  const { data, error } = await withoutDeleted(
    db.from('partner_expenses').select('*').eq('id', id),
  ).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ...rowToApi<PartnerExpense>(data),
    amount: num((data as Record<string, unknown>)['amount']),
    attachments: await listAttachments('partner_expense', id),
  };
}

export async function submitPartnerExpense(id: string): Promise<PartnerExpense> {
  const { data, error } = await withoutDeleted(
    db
      .from('partner_expenses')
      .update({ status: 'pending_approval', rejection_reason: null })
      .eq('id', id)
      .in('status', ['draft', 'rejected']),
  )
    .select('*')
    .single();
  if (error) throw Object.assign(new Error('Only a draft or rejected expense can be submitted.'), { status: 409 });
  return rowToApi<PartnerExpense>(data);
}

export async function approvePartnerExpense(
  id: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<{ document: PartnerExpense; entry: LedgerEntry }> {
  const doc = await getPartnerExpense(id);
  if (!doc) throw Object.assign(new Error('Partner expense not found'), { status: 404 });

  const entry = await approveDocument({
    table: 'partner_expenses',
    id,
    ref: doc.expenseNo,
    status: doc.status,
    actor,
    notes,
    posting: {
      entryDate: doc.businessDate,
      ledgerHeadId: doc.ledgerHeadId,
      headType: 'expense',
      description: `${doc.description} (${doc.expenseNo})`,
      amount: doc.amount,
      account: doc.account,
      paymentMethod: doc.paymentMethod,
      branchId: null,
      branchName: null,
      sourceType: 'partner_expense',
    },
  });

  return { document: (await getPartnerExpense(id))!, entry };
}

export async function rejectPartnerExpense(
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<PartnerExpense> {
  await rejectDocument('partner_expenses', id, reason, actor);
  return (await getPartnerExpense(id))!;
}

// ---------------------------------------------------------------------------
// Partner Share Detail — computed, not stored
// ---------------------------------------------------------------------------

/**
 * The ledger Balance the four partners split, each partner's cut of it,
 * their advances, draws and remaining balance — plus total company share and
 * the grand total (company share − expenses) for reference.
 *
 * THE SHARE BASE IS THE DAILY LEDGER'S BALANCE, not the grand total: the same
 * `getLedgerSummary()` figure the Daily Ledger's "Balance" card shows (opening
 * balance + received − expense, company-wide), as of `to` or today. It is a
 * running book balance, so `from` does not move it — `from` only narrows the
 * period totals and the advances/draws below.
 *
 * The period totals come straight off `ledger_entries` rather than the source
 * documents — a posted entry is the one thing every finance figure on this
 * page has to agree with, and reading it directly means a reversal or an
 * adjustment is reflected automatically instead of needing this report to
 * know about every document type that can post one.
 */
export async function getPartnerShareSummary(from?: string, to?: string): Promise<PartnerShareSummary> {
  let ledgerQuery = withoutDeleted(
    db
      .from('ledger_entries')
      .select('ledger_head_type, source_type, debit, credit')
      .in('status', ['posted', 'locked']),
  );
  if (from) ledgerQuery = ledgerQuery.gte('entry_date', from);
  if (to) ledgerQuery = ledgerQuery.lte('entry_date', to);

  const { data: entries, error: ledgerErr } = await ledgerQuery;
  if (ledgerErr) throw ledgerErr;

  let totalExpense = 0;
  let totalCompanyShare = 0;
  for (const row of entries ?? []) {
    if (row['ledger_head_type'] === 'expense' && row['source_type'] !== 'partner_expense') {
      totalExpense += num(row['credit']);
    }
    if (row['source_type'] === 'company_share') totalCompanyShare += num(row['debit']);
  }

  const grandTotal = round2(totalCompanyShare - totalExpense);

  const { balance: ledgerBalance } = await getLedgerSummary({ to: to ?? businessDateStr() });

  const partners = await listFinancePartners();

  let txnQuery = withoutDeleted(
    db
      .from('partner_expenses')
      .select('partner_id, txn_kind, amount')
      .in('status', ['posted', 'locked'])
      .not('partner_id', 'is', null),
  );
  if (from) txnQuery = txnQuery.gte('business_date', from);
  if (to) txnQuery = txnQuery.lte('business_date', to);

  const { data: txns, error: txnErr } = await txnQuery;
  if (txnErr) throw txnErr;

  const totalsByPartner = new Map<string, { advance: number; draw: number }>();
  for (const row of txns ?? []) {
    const partnerId = row['partner_id'] as string;
    const bucket = totalsByPartner.get(partnerId) ?? { advance: 0, draw: 0 };
    const amount = num(row['amount']);
    if (row['txn_kind'] === 'advance') bucket.advance += amount;
    else bucket.draw += amount;
    totalsByPartner.set(partnerId, bucket);
  }

  return {
    from: from ?? null,
    to: to ?? null,
    totalExpense: round2(totalExpense),
    totalCompanyShare: round2(totalCompanyShare),
    grandTotal,
    ledgerBalance,
    partners: partners.map((p) => {
      const bucket = totalsByPartner.get(p.id) ?? { advance: 0, draw: 0 };
      const sharePctAmount = round2((ledgerBalance * p.sharePct) / 100);
      return {
        id: p.id,
        name: p.name,
        sharePct: p.sharePct,
        sharePctAmount,
        advancePaid: round2(bucket.advance),
        drawPaid: round2(bucket.draw),
        balance: round2(sharePctAmount - bucket.advance - bucket.draw),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared approval machinery
// ---------------------------------------------------------------------------

export interface ApproveDocumentInput {
  table:
    | 'finance_transactions'
    | 'partner_expenses'
    | 'salary_payments'
    | 'employee_advances'
    | 'branch_share_payments';
  id: string;
  ref: string;
  status: FinanceDocStatus;
  actor: { uid: string; name: string };
  notes?: string | null;
  posting: {
    entryDate: string;
    ledgerHeadId: string;
    headType: 'income' | 'expense';
    description: string;
    amount: number;
    account: 'cash' | 'bank';
    paymentMethod: string;
    branchId: string | null;
    branchName: string | null;
    sourceType: LedgerSourceType;
  };
}

/**
 * Approve a document and post it.
 *
 * ORDER MATTERS, and the order here is the safe one: claim the approval FIRST
 * (a conditional update that only succeeds from a pending state), then post.
 *
 * Two approvers clicking at the same moment is the case this protects against.
 * With the claim first, exactly one of them wins the update and posts; the loser
 * gets a 409. Posting first would let both reach the ledger and book the expense
 * twice, and the ledger is append-only — the second one could then only be
 * removed by a reversal, which is a conversation nobody wants to have.
 *
 * If the posting itself then fails, the document is left `approved` but not
 * `posted`, with no ledger entry. That state is deliberately visible (the UI
 * shows it as approved-not-posted) rather than silently rolled back: the
 * approval was a real human decision and should not evaporate because the
 * ledger refused the date.
 */
async function approveDocument(input: ApproveDocumentInput): Promise<LedgerEntry> {
  if (input.status === 'draft') {
    throw Object.assign(new Error(`${input.ref} is a draft. Submit it for approval first.`), { status: 409 });
  }
  if (input.status !== 'pending_approval') {
    throw Object.assign(
      new Error(`${input.ref} is ${input.status} and cannot be approved again.`),
      { status: 409 },
    );
  }

  const { data: claimed, error: claimErr } = await withoutDeleted(
    db
      .from(input.table)
      .update({
        status: 'approved',
        approved_by: input.actor.uid,
        approved_by_name: input.actor.name,
        approved_at: new Date().toISOString(),
        ...(input.notes ? { notes: input.notes } : {}),
      })
      .eq('id', input.id)
      .eq('status', 'pending_approval'),
  )
    .select('id')
    .maybeSingle();
  if (claimErr) {
    // MBRSG: the salary_payments trigger refused the claim because the employee
    // resigned before this month. A decision about the document, not a fault.
    if (claimErr.code === 'MBRSG') throw Object.assign(new Error(claimErr.message), { status: 409 });
    throw claimErr;
  }
  if (!claimed) {
    throw Object.assign(new Error(`${input.ref} was just approved by someone else.`), { status: 409 });
  }

  const entry = await postEntry({ ...input.posting, sourceId: input.id, actor: input.actor });

  const { error: postedErr } = await withoutDeleted(
    db
      .from(input.table)
      .update({ status: 'posted', ledger_entry_id: entry.id })
      .eq('id', input.id),
  );
  if (postedErr) throw postedErr;

  return entry;
}

async function rejectDocument(
  table: ApproveDocumentInput['table'],
  id: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<void> {
  const { data, error } = await withoutDeleted(
    db
      .from(table)
      .update({
        status: 'rejected',
        rejection_reason: reason,
        approved_by: actor.uid,
        approved_by_name: actor.name,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .in('status', ['draft', 'pending_approval']),
  )
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw Object.assign(
      new Error('Only a draft or pending document can be rejected. A posted entry needs a reversal instead.'),
      { status: 409 },
    );
  }
}

async function resolveBranch(branchId?: string | null): Promise<{ id: string; name: string } | null> {
  if (!branchId) return null;
  const { data, error } = await db.from('branches').select('id, name').eq('id', branchId).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Branch not found'), { status: 400 });
  return { id: data.id as string, name: data.name as string };
}

export { approveDocument, rejectDocument };
