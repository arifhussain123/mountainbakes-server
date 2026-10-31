import { dbFor } from '../db';
import type {
  CreateLoanClientInput,
  CreateLoanEntryInput,
  LoanClient,
  LoanClientBalance,
  LoanClientDetail,
  LoanClientWithBalance,
  LoanEntry,
  LoanLedgerPage,
  LoanLedgerQueryInput,
  UpdateLoanClientInput,
} from '../shared';
import { rowToApi } from '../utils/case';
import { bindAttachments, listAttachmentsFor } from './attachments.service';

const db = dbFor('finance-loans');

/**
 * Refundable & Receivable Loans — the client-wise loan register.
 *
 * ─── Separate from the General Ledger ────────────────────────────────────────
 * Nothing in this module calls post_finance_ledger_entry or touches
 * ledger_entries. A loan is not income, a payment against it is not an expense,
 * and the cash book, profit and every existing finance report stay exactly as
 * they were. The accounting workbook reads the balances from here and shows
 * them as a memorandum under Liabilities (finance-accounting.service.ts).
 *
 * ─── The rules live in Postgres ──────────────────────────────────────────────
 * Migration 20261031000001: post_finance_loan_entry decides the side from the
 * entry type, checks the client and the head, and numbers the voucher (LN-) in
 * one statement; finance_loan_ledger computes opening, totals and the running
 * balance when read. This module names fields and maps errors.
 */

/** Actor every write is attributed to. Resolved from the JWT by the router. */
export interface LoanActor {
  uid: string;
  name: string;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function clientError(message: string, status: number, details?: unknown): Error & { status: number } {
  return Object.assign(new Error(message), { status }, details ? { details } : {});
}

/** P0001 → 409 (a refused rule), P0002 → 404, a missing function → 503 naming the migration. */
function asClientError(error: { code?: string; message: string }): Error {
  if (error.code === 'PGRST202' || error.code === '42883') {
    return Object.assign(
      new Error(
        'Refundable & Receivable Loans are unavailable: database migration ' +
          '20261031000001_finance_loans has not been applied.',
      ),
      { status: 503, expose: true },
    );
  }
  if (error.code === 'P0001') return clientError(error.message, 409);
  if (error.code === 'P0002') return clientError(error.message, 404);
  if (error.code === '22023') return clientError(error.message, 400);
  return Object.assign(new Error(error.message), error.code ? { code: error.code } : {});
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function toClient(row: Record<string, unknown>): LoanClient {
  const c = rowToApi<LoanClient>(row);
  return { ...c, isActive: Boolean(row['is_active']) };
}

function toBalance(row: Record<string, unknown>): LoanClientBalance {
  return {
    clientId: String(row['clientId']),
    clientCode: String(row['clientCode']),
    clientName: String(row['clientName']),
    companyName: (row['companyName'] as string | null) ?? null,
    isActive: Boolean(row['isActive']),
    totalRefundable: num(row['totalRefundable']),
    totalReceivable: num(row['totalReceivable']),
    totalDebit: num(row['totalDebit']),
    totalCredit: num(row['totalCredit']),
    balance: num(row['balance']),
    entryCount: num(row['entryCount']),
  };
}

/** Posted totals per client up to `to` (all time when omitted), optionally for one branch's entries. */
export async function getClientBalances(to?: string | null, branchId?: string | null): Promise<LoanClientBalance[]> {
  const { data, error } = await db.rpc('finance_loan_client_balances', {
    p_to: to ?? null,
    p_branch_id: branchId ?? null,
  });
  if (error) throw asClientError(error);
  return ((data ?? []) as Record<string, unknown>[]).map(toBalance);
}

/** Every client row, paged until a page comes back empty — a short page is the read cap, not the end. */
async function readAllClients(): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (;;) {
    const { data, error } = await db
      .from('finance_loan_clients')
      .select('*')
      .order('client_code', { ascending: true })
      .range(out.length, out.length + PAGE - 1);
    if (error) throw asClientError(error);
    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) break;
    out.push(...rows);
  }
  return out;
}

export async function listLoanClients(): Promise<LoanClientWithBalance[]> {
  const [rows, balances] = await Promise.all([readAllClients(), getClientBalances()]);

  // In the balances' order (name, then code) — the order the dropdowns and
  // the Detail of Clients table read in.
  const order = new Map(balances.map((b, i) => [b.clientId, i]));
  rows.sort((a, b) => (order.get(String(a['id'])) ?? 0) - (order.get(String(b['id'])) ?? 0));

  const byId = new Map(balances.map((b) => [b.clientId, b]));
  return rows.map((row) => {
    const client = toClient(row);
    const b = byId.get(client.id);
    return {
      ...client,
      totalRefundable: b?.totalRefundable ?? 0,
      totalReceivable: b?.totalReceivable ?? 0,
      totalDebit: b?.totalDebit ?? 0,
      totalCredit: b?.totalCredit ?? 0,
      balance: b?.balance ?? 0,
      entryCount: b?.entryCount ?? 0,
    };
  });
}

async function readClient(id: string): Promise<LoanClient> {
  const { data, error } = await db.from('finance_loan_clients').select('*').eq('id', id).maybeSingle();
  if (error) throw asClientError(error);
  if (!data) throw clientError('Client not found', 404);
  return toClient(data as Record<string, unknown>);
}

export async function getLoanClientDetail(id: string): Promise<LoanClientDetail> {
  const client = await readClient(id);
  const balance = (await getClientBalances()).find((b) => b.clientId === id) ?? {
    clientId: id,
    clientCode: client.clientCode,
    clientName: client.clientName,
    companyName: client.companyName,
    isActive: client.isActive,
    totalRefundable: 0,
    totalReceivable: 0,
    totalDebit: 0,
    totalCredit: 0,
    balance: 0,
    entryCount: 0,
  };
  return { client, balance };
}

/** Escape LIKE wildcards so a name is matched literally. */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Refuse a second client with the same name or mobile number unless the user
 * confirms — two "Ali Traders" in one dropdown is how a payment lands on the
 * wrong account. A confirmed duplicate is allowed: two people can share a name.
 */
async function assertNotDuplicateClient(
  input: { clientName?: string | null; mobileNumber?: string | null },
  exceptId: string | null,
): Promise<void> {
  const matches: Record<string, unknown>[] = [];
  if (input.clientName) {
    let q = db.from('finance_loan_clients').select('id, client_code, client_name, mobile_number')
      .ilike('client_name', likeLiteral(input.clientName.trim()))
      .limit(1);
    if (exceptId) q = q.neq('id', exceptId);
    const { data, error } = await q;
    if (error) throw asClientError(error);
    matches.push(...((data ?? []) as Record<string, unknown>[]));
  }
  if (!matches.length && input.mobileNumber) {
    let q = db.from('finance_loan_clients').select('id, client_code, client_name, mobile_number')
      .eq('mobile_number', input.mobileNumber)
      .limit(1);
    if (exceptId) q = q.neq('id', exceptId);
    const { data, error } = await q;
    if (error) throw asClientError(error);
    matches.push(...((data ?? []) as Record<string, unknown>[]));
  }
  const existing = matches[0];
  if (!existing) return;

  throw clientError(
    `${existing['client_code']} — ${existing['client_name']} already exists with the same ` +
      `${String(existing['client_name']).toLowerCase() === input.clientName?.trim().toLowerCase() ? 'name' : 'mobile number'}. ` +
      `Confirm to save this as a separate client anyway.`,
    409,
    {
      code: 'duplicate_client',
      existing: {
        id: existing['id'],
        clientCode: existing['client_code'],
        clientName: existing['client_name'],
        mobileNumber: existing['mobile_number'] ?? null,
      },
    },
  );
}

export async function createLoanClient(input: CreateLoanClientInput, actor: LoanActor): Promise<LoanClient> {
  if (!input.confirmDuplicate) await assertNotDuplicateClient(input, null);

  const { data, error } = await db
    .from('finance_loan_clients')
    .insert({
      company_name: input.companyName ?? null,
      client_name: input.clientName.trim(),
      mobile_number: input.mobileNumber ?? null,
      whatsapp_number: input.whatsappNumber ?? null,
      address: input.address ?? null,
      note: input.note ?? null,
      created_by: actor.uid,
      created_by_name: actor.name,
      updated_by: actor.uid,
      updated_by_name: actor.name,
    })
    .select('*')
    .single();
  if (error) throw asClientError(error);
  return toClient(data as Record<string, unknown>);
}

/**
 * Edit a client's details. Entries reference the client by id, so an edited
 * name shows on every past entry — the history stays attached, not copied.
 */
export async function updateLoanClient(
  id: string,
  input: UpdateLoanClientInput,
  actor: LoanActor,
): Promise<{ before: LoanClient; after: LoanClient }> {
  const before = await readClient(id);
  if (!input.confirmDuplicate) {
    await assertNotDuplicateClient(
      {
        clientName: input.clientName !== undefined && input.clientName !== before.clientName ? input.clientName : null,
        mobileNumber: input.mobileNumber !== undefined && input.mobileNumber !== before.mobileNumber ? input.mobileNumber : null,
      },
      id,
    );
  }

  const patch: Record<string, unknown> = { updated_by: actor.uid, updated_by_name: actor.name };
  if (input.companyName !== undefined) patch['company_name'] = input.companyName ?? null;
  if (input.clientName !== undefined) patch['client_name'] = input.clientName.trim();
  if (input.mobileNumber !== undefined) patch['mobile_number'] = input.mobileNumber ?? null;
  if (input.whatsappNumber !== undefined) patch['whatsapp_number'] = input.whatsappNumber ?? null;
  if (input.address !== undefined) patch['address'] = input.address ?? null;
  if (input.note !== undefined) patch['note'] = input.note ?? null;

  const { data, error } = await db.from('finance_loan_clients').update(patch).eq('id', id).select('*').single();
  if (error) throw asClientError(error);
  return { before, after: toClient(data as Record<string, unknown>) };
}

/** Activate or deactivate. Clients are never deleted: their entries must keep pointing somewhere. */
export async function setLoanClientActive(id: string, isActive: boolean, actor: LoanActor): Promise<LoanClient> {
  await readClient(id);
  const { data, error } = await db
    .from('finance_loan_clients')
    .update({ is_active: isActive, updated_by: actor.uid, updated_by_name: actor.name })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw asClientError(error);
  return toClient(data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

function toEntry(raw: Record<string, unknown>): LoanEntry {
  return {
    id: String(raw['id']),
    voucherNo: String(raw['voucherNo']),
    seq: num(raw['seq']),
    clientId: String(raw['clientId']),
    clientCode: String(raw['clientCode']),
    clientName: String(raw['clientName']),
    companyName: (raw['companyName'] as string | null) ?? null,
    entryType: raw['entryType'] as LoanEntry['entryType'],
    ledgerHeadId: String(raw['ledgerHeadId']),
    ledgerHeadName: String(raw['ledgerHeadName']),
    branchId: (raw['branchId'] as string | null) ?? null,
    branchName: (raw['branchName'] as string | null) ?? null,
    businessDate: String(raw['businessDate']),
    amount: num(raw['amount']),
    debit: num(raw['debit']),
    credit: num(raw['credit']),
    balance: num(raw['balance']),
    paymentMethod: (raw['paymentMethod'] as string | null) ?? null,
    description: String(raw['description']),
    note: (raw['note'] as string | null) ?? null,
    status: raw['status'] as LoanEntry['status'],
    cancelReason: (raw['cancelReason'] as string | null) ?? null,
    cancelledByName: (raw['cancelledByName'] as string | null) ?? null,
    cancelledAt: (raw['cancelledAt'] as string | null) ?? null,
    createdByName: (raw['createdByName'] as string | null) ?? null,
    createdAt: String(raw['createdAt']),
  };
}

export type LoanLedgerQuery = Omit<LoanLedgerQueryInput, 'limit' | 'offset'> & { limit: number; offset: number };

/** One page of the register, with the filtered set's opening, totals and closing balance. */
export async function getLoanLedger(q: LoanLedgerQuery, opts: { photos?: boolean } = {}): Promise<LoanLedgerPage> {
  if (q.from > q.to) throw clientError('From must not be after To', 400);
  const { data, error } = await db.rpc('finance_loan_ledger', {
    p_from: q.from,
    p_to: q.to,
    p_client_id: q.clientId ?? null,
    p_branch_id: q.branchId ?? null,
    p_entry_type: q.entryType ?? null,
    p_ledger_head_id: q.ledgerHeadId ?? null,
    p_payment_method: q.paymentMethod ?? null,
    p_status: q.status ?? null,
    p_search: q.search?.trim() || null,
    p_limit: q.limit,
    p_offset: q.offset,
  });
  if (error) throw asClientError(error);

  const out = (data ?? {}) as Record<string, unknown>;
  const entries = ((out['rows'] ?? []) as Record<string, unknown>[]).map(toEntry);

  if (opts.photos !== false && entries.length) {
    const photos = await listAttachmentsFor('finance_loan_entry', entries.map((e) => e.id));
    for (const e of entries) e.attachments = photos.get(e.id) ?? [];
  }

  return {
    from: q.from,
    to: q.to,
    openingBalance: num(out['openingBalance']),
    totalDebit: num(out['totalDebit']),
    totalCredit: num(out['totalCredit']),
    closingBalance: num(out['closingBalance']),
    total: num(out['count']),
    limit: q.limit,
    offset: q.offset,
    entries,
  };
}

/** Every row of a window, paged until a page comes back empty (the read cap is not the end of the data). */
export async function getLoanLedgerAll(q: Omit<LoanLedgerQuery, 'limit' | 'offset'>): Promise<LoanLedgerPage> {
  const PAGE = 500;
  const first = await getLoanLedger({ ...q, limit: PAGE, offset: 0 }, { photos: false });
  const entries = [...first.entries];
  while (entries.length < first.total) {
    const next = await getLoanLedger({ ...q, limit: PAGE, offset: entries.length }, { photos: false });
    if (next.entries.length === 0) break;
    entries.push(...next.entries);
  }
  return { ...first, limit: entries.length, entries };
}

/**
 * One entry, with its photo. Its running balance is read from the whole
 * register's ledger for that day, so it is the same figure the Loan Ledger shows.
 */
export async function getLoanEntry(id: string): Promise<LoanEntry> {
  const { data, error } = await db.from('finance_loan_entries').select('business_date').eq('id', id).maybeSingle();
  if (error) throw asClientError(error);
  if (!data) throw clientError('Loan entry not found', 404);
  const day = String((data as Record<string, unknown>)['business_date']);
  const page = await getLoanLedgerAll({ from: day, to: day });
  const entry = page.entries.find((e) => e.id === id);
  if (!entry) throw clientError('Loan entry not found', 404);
  entry.attachments = (await listAttachmentsFor('finance_loan_entry', [id])).get(id) ?? [];
  return entry;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export async function postLoanEntry(input: CreateLoanEntryInput, actor: LoanActor): Promise<LoanEntry> {
  const { data, error } = await db.rpc('post_finance_loan_entry', {
    p_request_id: input.requestId,
    p_client_id: input.clientId,
    p_entry_type: input.entryType,
    p_ledger_head_id: input.ledgerHeadId,
    // Only a Receivable Loan carries a branch; a payment method only a Paid Payment.
    p_branch_id: input.entryType === 'receivable_loan' ? input.branchId ?? null : null,
    p_business_date: input.businessDate,
    p_amount: input.amount,
    p_payment_method: input.entryType === 'paid_payment' ? input.paymentMethod ?? null : null,
    p_description: input.description,
    p_note: input.note ?? null,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  if (error) throw asClientError(error);

  const id = String((data as Record<string, unknown>)['id']);
  // After the entry exists. A replayed request re-binds nothing: the photos
  // were bound the first time, and bindAttachments ignores an empty list.
  if (input.attachmentIds.length) {
    const already = (await listAttachmentsFor('finance_loan_entry', [id])).get(id) ?? [];
    if (!already.length) {
      await bindAttachments({ entity: 'finance_loan_entry', entityId: id, attachmentIds: input.attachmentIds, actor });
    }
  }
  return getLoanEntry(id);
}

export async function cancelLoanEntry(id: string, reason: string, actor: LoanActor): Promise<LoanEntry> {
  const { error } = await db.rpc('cancel_finance_loan_entry', {
    p_id: id,
    p_reason: reason,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  if (error) throw asClientError(error);
  return getLoanEntry(id);
}
