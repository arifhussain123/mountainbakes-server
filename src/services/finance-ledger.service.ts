import { dbFor } from '../db';
import {
  businessDateStr,
  businessDaysAgoStr,
  SYSTEM_LEDGER_HEAD_CODES,
  type CreateLedgerHeadInput,
  type EditLedgerEntryInput,
  type FinanceAccount,
  type FinanceDashboard,
  type FinanceDayClosing,
  type FinancePendingApproval,
  type LedgerEntry,
  type LedgerHead,
  type LedgerHeadType,
  type LedgerPage,
  type LedgerQuery,
  type LedgerSourceType,
  type LedgerSummary,
  type UpdateLedgerHeadInput,
} from '../shared';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';
import { invalidate } from '../utils/cache';
import { attachmentKey, listAttachmentsAcross } from './attachments.service';
import { getLedgerHeadByCode, round2 } from './finance-settings.service';
import type { AttachmentEntity } from '../shared';

const db = dbFor('finance-ledger');

/**
 * The ledger itself: heads, postings, queries, the day's closing, the dashboard.
 *
 * The one rule that shapes every function here: NOTHING writes `ledger_entries`
 * directly. Every posting goes through the `post_finance_ledger_entry` RPC,
 * because allocating a gapless voucher number, reading the last balance and
 * inserting the row have to be one atomic act — and each `db` call is its own
 * transaction, so that cannot be assembled from separate calls here. Same
 * reasoning as the POS sale and the stock corrections (migrations 12 and 33).
 */

const num = (v: unknown) => Number(v ?? 0);

/**
 * Which document table a voucher's `sourceId` points into, per `sourceType`.
 *
 * This is how the ledger shows the photo behind a posting: the photo belongs to
 * the SOURCE DOCUMENT, not to the (immutable) ledger row, so the row's existing
 * `(sourceType, sourceId)` pair is followed back to it.
 *
 * The four sources deliberately absent carry no photo and never will:
 *   * `opening`     — a settings figure, not a transaction anyone witnessed.
 *   * `adjustment`  — a reversal; `sourceId` is the entry being corrected, and
 *                     the evidence is whatever the ORIGINAL carried.
 *   * `company_share` / `branch_share` — both are posted by branch-income
 *                     approval and their `sourceId` is the approval row. They
 *                     are mapped anyway (below) precisely because that row CAN
 *                     carry a verifier's photo.
 */
const SOURCE_ATTACHMENT_ENTITY: Partial<Record<LedgerSourceType, AttachmentEntity>> = {
  manual: 'finance_transaction',
  salary: 'salary_payment',
  employee_advance: 'employee_advance',
  partner_expense: 'partner_expense',
  branch_income: 'finance_income_approval',
  company_share: 'finance_income_approval',
  branch_share: 'finance_income_approval',
  // Migration 118: the photo of the handover is on the cash_transfers row the
  // voucher's sourceId names — the Daily Ledger shows the branch's own picture.
  cash_transfer: 'cash_transfer',
};

/**
 * Resolve each entry's source-document photos and hang them off the entry.
 *
 * One batched lookup for the whole page across all source types — see
 * `listAttachmentsAcross` for why that matters. An entry whose source carries no
 * photo simply gets an empty array rather than being left undefined, so the
 * client never has to distinguish "not loaded" from "none".
 */
async function withSourcePhotos(entries: LedgerEntry[]): Promise<LedgerEntry[]> {
  const refs = entries.flatMap((e) => {
    const entity = e.sourceId ? SOURCE_ATTACHMENT_ENTITY[e.sourceType] : undefined;
    return entity && e.sourceId ? [{ entity, entityId: e.sourceId }] : [];
  });
  if (refs.length === 0) return entries.map((e) => ({ ...e, attachments: [] }));

  const byKey = await listAttachmentsAcross(refs);
  return entries.map((e) => {
    const entity = e.sourceId ? SOURCE_ATTACHMENT_ENTITY[e.sourceType] : undefined;
    const found = entity && e.sourceId ? byKey.get(attachmentKey(entity, e.sourceId)) : undefined;
    return { ...e, attachments: found ?? [] };
  });
}

// ---------------------------------------------------------------------------
// Ledger heads
// ---------------------------------------------------------------------------

export async function listLedgerHeads(opts: {
  type?: LedgerHeadType;
  includeInactive?: boolean;
}): Promise<LedgerHead[]> {
  let query = db
    .from('ledger_heads')
    .select('*')
    .order('type', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (opts.type) query = query.eq('type', opts.type);
  if (!opts.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw error;
  return rowToApi<LedgerHead[]>(data ?? []);
}

export async function createLedgerHead(
  input: CreateLedgerHeadInput,
  actor: { uid: string },
): Promise<LedgerHead> {
  // Uppercased here rather than in the schema so the stored code is canonical
  // however it was typed — 'exp-fuel' and 'EXP-Fuel' must not become two heads
  // that print identically on a Trial Balance.
  const code = input.code.toUpperCase();

  const { data, error } = await db
    .from('ledger_heads')
    .insert({
      code,
      name: input.name,
      type: input.type,
      description: input.description ?? null,
      group_name: input.groupName ?? null,
      sort_order: input.sortOrder,
      is_system: false,
      created_by: actor.uid,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error(`A ledger head with code ${code} already exists.`), { status: 409 });
    }
    throw error;
  }
  return rowToApi<LedgerHead>(data);
}

export async function updateLedgerHead(id: string, input: UpdateLedgerHeadInput): Promise<LedgerHead> {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row['name'] = input.name;
  if (input.description !== undefined) row['description'] = input.description;
  if (input.groupName !== undefined) row['group_name'] = input.groupName;
  if (input.sortOrder !== undefined) row['sort_order'] = input.sortOrder;
  if (input.isActive !== undefined) row['is_active'] = input.isActive;

  const { data, error } = await db
    .from('ledger_heads')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();

  // The system-head guard is a trigger (migration 52), so "cannot be
  // deactivated" arrives as a raised exception rather than a row count of zero.
  // Surfacing it as a 409 keeps it a message the user can act on instead of a 500.
  if (error) throw asClientError(error);

  // Cached by code for the automatic postings — a rename must not leave the
  // stale name being snapshotted onto new vouchers.
  invalidate('financeHead');
  return rowToApi<LedgerHead>(data);
}

/** Resolve a head by id, refusing an inactive one for new documents. */
export async function requireActiveHead(
  id: string,
  expectedType?: LedgerHeadType,
): Promise<{ id: string; name: string; type: LedgerHeadType }> {
  const { data, error } = await db
    .from('ledger_heads')
    .select('id, name, type, is_active')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Ledger head not found'), { status: 404 });
  if (!data.is_active) {
    throw Object.assign(new Error(`Ledger head "${data.name}" is inactive.`), { status: 400 });
  }
  if (expectedType && data.type !== expectedType) {
    throw Object.assign(
      new Error(`"${data.name}" is an ${data.type} head; an ${expectedType} head is required here.`),
      { status: 400 },
    );
  }
  return { id: data.id as string, name: data.name as string, type: data.type as LedgerHeadType };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export interface PostEntryInput {
  entryDate: string;
  ledgerHeadId: string;
  /** The head's own type decides the side — never take this from a client. */
  headType: LedgerHeadType;
  description: string;
  amount: number;
  account: FinanceAccount;
  sourceType: LedgerSourceType;
  sourceId?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  paymentMethod?: string | null;
  actor: { uid: string; name: string };
}

/**
 * Post one entry.
 *
 * Cash-book convention, and the only place it is decided: an INCOME head is a
 * receipt and therefore a DEBIT (the balance goes up); an EXPENSE head is a
 * payment and therefore a CREDIT. Deriving the side from the head — which the
 * server has read from the database — rather than from anything the client sent
 * is what stops a mis-set radio button booking an expense as income.
 */
export async function postEntry(input: PostEntryInput): Promise<LedgerEntry> {
  const amount = round2(input.amount);
  if (!(amount > 0)) {
    throw Object.assign(new Error('A ledger entry must move a positive amount.'), { status: 400 });
  }

  const { data, error } = await db.rpc('post_finance_ledger_entry', {
    p_entry_date: input.entryDate,
    p_ledger_head_id: input.ledgerHeadId,
    p_description: input.description,
    p_debit: input.headType === 'income' ? amount : 0,
    p_credit: input.headType === 'expense' ? amount : 0,
    p_account: input.account,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId ?? null,
    p_branch_id: input.branchId ?? null,
    p_branch_name: input.branchName ?? null,
    p_payment_method: input.paymentMethod ?? null,
    p_approved_by: input.actor.uid,
    p_approved_by_name: input.actor.name,
    p_created_by: input.actor.uid,
    p_created_by_name: input.actor.name,
    p_reverses_entry_id: null,
  });
  if (error) throw asClientError(error);

  return rowToApi<LedgerEntry>(data);
}

/**
 * Reverse — or reverse and re-post at a corrected figure — an entry already in
 * the book. The ONLY sanctioned way to change a posted number.
 *
 * The reversing entries land on the CURRENT business date, not the original's:
 * a closed day is locked precisely so the balance that was signed off stays the
 * one that was signed off.
 */
export async function adjustEntry(
  entryId: string,
  input: { reason: string; correctedAmount?: number; correctedDescription?: string },
  actor: { uid: string; name: string },
): Promise<LedgerEntry[]> {
  const { data, error } = await db.rpc('reverse_finance_ledger_entry', {
    p_entry_id: entryId,
    p_entry_date: businessDateStr(),
    p_reason: input.reason,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_corrected_amount: input.correctedAmount ?? null,
    p_corrected_description: input.correctedDescription ?? null,
  });
  if (error) throw asClientError(error);
  return rowToApi<LedgerEntry[]>(data ?? []);
}

/**
 * Edit a voucher IN PLACE (migrations 133, 135): the same row, the same PV-/RV-
 * number, no reversal and no replacement. The database does the whole thing in
 * one transaction and refuses it when `expected` no longer matches the voucher.
 */
export async function editLedgerEntry(
  entryId: string,
  input: EditLedgerEntryInput,
  actor: { uid: string; name: string },
): Promise<LedgerEntry> {
  const asText = (v: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(v ?? {}).filter(([, x]) => x !== undefined).map(([k, x]) => [k, String(x)]));

  const { data, error } = await db.rpc('edit_finance_ledger_entry', {
    p_entry_id: entryId,
    p_set: asText(input.changes),
    p_expected: asText(input.expected),
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_today: businessDateStr(),
  });
  if (error) {
    if (error.code === 'MBCON') {
      throw Object.assign(new Error(error.message), { status: 409, details: { code: 'conflict' } });
    }
    if (error.code === 'MBNFD') throw Object.assign(new Error(error.message), { status: 404 });
    throw asClientError(error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) throw Object.assign(new Error('Ledger entry not found'), { status: 404 });
  return rowToApi<LedgerEntry>(row);
}

/**
 * Delete a voucher: it is removed from the book and the balances after it are
 * recomputed. Nothing is posted to cancel it — no reversal, no new number.
 */
export async function deleteLedgerEntry(
  entryId: string,
  reason: string,
  actor: { uid: string; name: string },
): Promise<LedgerEntry | null> {
  const [removed] = await adjustEntry(entryId, { reason }, actor);
  return removed ?? null;
}

// ---------------------------------------------------------------------------
// Reading the book
// ---------------------------------------------------------------------------

/**
 * A page of the ledger, ordered by posting sequence.
 *
 * ASCENDING, always. A cash book reads top to bottom and its running balance
 * only makes sense in that direction — a "newest first" ledger shows a Balance
 * column that appears to count down, which is the single most confusing thing a
 * finance screen can do. The UI paginates to the last page for "today".
 */
export async function queryLedger(q: LedgerQuery): Promise<LedgerPage> {
  const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
  const offset = Math.max(Number(q.offset ?? 0), 0);

  let query = withoutDeleted(
    db
      .from('ledger_entries')
      .select('*')
      .order('seq', { ascending: true })
      .range(offset, offset + limit - 1),
  );

  query = applyLedgerFilters(query, q);

  const [rows, totals] = await Promise.all([
    query,
    db.rpc('finance_ledger_totals', {
      p_from: q.from ?? null,
      p_to: q.to ?? null,
      p_branch_id: q.branchId ?? null,
      p_ledger_head_id: q.ledgerHeadId ?? null,
      p_type: q.type ?? null,
      p_account: q.account ?? null,
      p_status: q.status ?? null,
      p_source_type: q.sourceType ?? null,
      p_search: q.search ?? null,
      p_min_amount: q.minAmount ?? null,
      p_max_amount: q.maxAmount ?? null,
    }),
  ]);

  if (rows.error) throw rows.error;
  if (totals.error) throw totals.error;

  const entries = await withSourcePhotos(rowToApi<LedgerEntry[]>(rows.data ?? []).map(normaliseEntry));
  // The RPC returns a one-row table, which `db.rpc` hands back as an array.
  const agg = (Array.isArray(totals.data) ? totals.data[0] : totals.data) as Record<string, unknown> | null;

  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    entries,
    total: num(agg?.['entry_count']),
    // Prefer the balance the book actually held before this page's first entry;
    // it is exact and needs no extra query. The RPC's `opening_balance` is the
    // fallback for an empty page, where there is no first entry to read it off.
    openingBalance: first ? round2(first.balance - first.debit + first.credit) : num(agg?.['opening_balance']),
    closingBalance: last ? last.balance : num(agg?.['opening_balance']),
    totalDebit: num(agg?.['total_debit']),
    totalCredit: num(agg?.['total_credit']),
  };
}

/** `2026-09-01` → `2026-08-31`. Plain calendar-date arithmetic — `dateStr` is
 *  already a resolved business date, so this needs no timezone handling. */
function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The Daily Ledger's top summary — Opening Balance, Total Received, Total
 * Expense and Balance, month-to-date as of `to`.
 *
 * Deliberately NOT `queryLedger()`'s `openingBalance`/`closingBalance`: those
 * are read off the current PAGE's first/last row, so they are only correct on
 * whichever page happens to hold the filtered range's first/last entry. This
 * calls `finance_ledger_totals` on its own, scoped to the calendar month
 * containing `to` — its `opening_balance` output (everything before month
 * start) IS the previous month's closing balance, by the same carry-forward
 * principle `finance_day_summary`/`getDayClosing` already rely on.
 *
 * ONE WRINKLE: `finance_ledger_totals`'s own `opening_balance` column is NOT
 * branch-filtered — its SQL sums `ledger_entries` company-wide before `p_from`
 * regardless of `p_branch_id` (verified against the migration). Fine when
 * `branchId` is absent, wrong when it isn't: a branch manager narrowed to
 * their branch would otherwise see every OTHER branch's opening balance mixed
 * into theirs. So when a branch is given, the opening balance is computed from
 * the same RPC's `total_debit`/`total_credit` instead (which ARE branch-
 * filtered) over everything before month start — one extra cheap RPC call,
 * still pure server-side aggregation, no row download.
 */
export async function getLedgerSummary(params: { to: string; branchId?: string | null }): Promise<LedgerSummary> {
  const to = params.to;
  const branchId = params.branchId ?? null;
  const monthStart = `${to.slice(0, 7)}-01`;

  const { data, error } = await db.rpc('finance_ledger_totals', {
    p_from: monthStart,
    p_to: to,
    p_branch_id: branchId,
  });
  if (error) throw error;

  const agg = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const totalReceived = round2(num(agg?.['total_debit']));
  const totalExpense = round2(num(agg?.['total_credit']));

  let openingBalance: number;
  if (branchId) {
    const { data: priorData, error: priorError } = await db.rpc('finance_ledger_totals', {
      p_to: dayBefore(monthStart),
      p_branch_id: branchId,
    });
    if (priorError) throw priorError;
    const priorAgg = (Array.isArray(priorData) ? priorData[0] : priorData) as Record<string, unknown> | null;
    openingBalance = round2(num(priorAgg?.['total_debit']) - num(priorAgg?.['total_credit']));
  } else {
    openingBalance = round2(num(agg?.['opening_balance']));
  }

  return {
    businessDate: to,
    monthStart,
    openingBalance,
    totalReceived,
    totalExpense,
    balance: round2(openingBalance + totalReceived - totalExpense),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function applyLedgerFilters(query: any, q: LedgerQuery): any {
  if (q.from) query = query.gte('entry_date', q.from);
  if (q.to) query = query.lte('entry_date', q.to);
  if (q.branchId) query = query.eq('branch_id', q.branchId);
  if (q.ledgerHeadId) query = query.eq('ledger_head_id', q.ledgerHeadId);
  if (q.type) query = query.eq('ledger_head_type', q.type);
  if (q.account) query = query.eq('account', q.account);
  if (q.status) query = query.eq('status', q.status);
  if (q.sourceType) query = query.eq('source_type', q.sourceType);
  if (q.voucherNo) query = query.eq('voucher_no', q.voucherNo);
  if (q.minAmount !== undefined) {
    query = query.or(`debit.gte.${q.minAmount},credit.gte.${q.minAmount}`);
  }
  if (q.maxAmount !== undefined) {
    query = query.or(`debit.lte.${q.maxAmount},credit.lte.${q.maxAmount}`);
  }
  if (q.search) {
    // `or` takes a comma-separated filter list (PostgREST's grammar, which the
    // query layer keeps); commas and parentheses inside the term would be read
    // as syntax, so they are stripped rather than escaped (there is no escape
    // for them in this grammar).
    const term = q.search.replace(/[,()*]/g, ' ').trim();
    if (term) {
      query = query.or(
        `voucher_no.ilike.%${term}%,description.ilike.%${term}%,` +
          `ledger_head_name.ilike.%${term}%,branch_name.ilike.%${term}%`,
      );
    }
  }
  return query;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Coerce every money field, so a numeric(14,2) never leaves here as a string. */
function normaliseEntry(e: LedgerEntry): LedgerEntry {
  return { ...e, debit: num(e.debit), credit: num(e.credit), balance: num(e.balance), seq: num(e.seq) };
}

export async function getLedgerEntry(id: string): Promise<LedgerEntry | null> {
  const { data, error } = await withoutDeleted(
    db.from('ledger_entries').select('*').eq('id', id),
  ).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [entry] = await withSourcePhotos([normaliseEntry(rowToApi<LedgerEntry>(data))]);
  return entry ?? null;
}

// ---------------------------------------------------------------------------
// Daily closing
// ---------------------------------------------------------------------------

/**
 * The day's figures.
 *
 * The carry-forward the brief asks for is structural, not a copied number:
 * `opening_balance` is defined as everything posted BEFORE this date, so
 * yesterday's closing IS today's opening by construction. There is no stored
 * total that can fall out of step with the entries behind it, and no nightly job
 * that has to run for tomorrow to open correctly.
 */
export async function getDayClosing(businessDate: string): Promise<FinanceDayClosing> {
  const [summary, closed] = await Promise.all([
    db.rpc('finance_day_summary', { p_business_date: businessDate }),
    db.from('finance_day_closings').select('*').eq('business_date', businessDate).maybeSingle(),
  ]);
  if (summary.error) throw summary.error;
  if (closed.error) throw closed.error;

  const s = (Array.isArray(summary.data) ? summary.data[0] : summary.data) as Record<string, unknown> | null;
  const c = closed.data as Record<string, unknown> | null;

  return {
    businessDate,
    openingBalance: num(s?.['opening_balance']),
    openingCash: num(s?.['opening_cash']),
    openingBank: num(s?.['opening_bank']),
    totalIncome: num(s?.['total_income']),
    totalExpenses: num(s?.['total_expenses']),
    netBalance: num(s?.['net_balance']),
    cashInHand: num(s?.['cash_in_hand']),
    bankBalance: num(s?.['bank_balance']),
    closingBalance: num(s?.['closing_balance']),
    entryCount: Number(s?.['entry_count'] ?? 0),
    status: c ? 'closed' : 'open',
    closedBy: (c?.['closed_by'] as string) ?? null,
    closedByName: (c?.['closed_by_name'] as string) ?? null,
    closedAt: (c?.['closed_at'] as string) ?? null,
  };
}

/**
 * Close a finance day: snapshot the figures and lock the date.
 *
 * Locking is what makes the closing balance meaningful — after this, nothing can
 * post into the day, so the number that was signed off is the number that stays.
 * A correction goes onto an open date as an adjustment, which is how it stays
 * visible.
 *
 * Refuses a future date and a day still holding un-approved money: closing over
 * a pending approval would silently push that income into the next day's
 * figures, where nobody is looking for it.
 */
export async function closeFinanceDay(
  businessDate: string,
  actor: { uid: string; name: string },
  notes?: string | null,
): Promise<FinanceDayClosing> {
  const today = businessDateStr();
  if (businessDate > today) {
    throw Object.assign(new Error('A future business date cannot be closed.'), { status: 400 });
  }

  const existing = await getDayClosing(businessDate);
  if (existing.status === 'closed') {
    throw Object.assign(new Error(`The finance day ${businessDate} is already closed.`), { status: 409 });
  }

  const pending = await countPendingForDate(businessDate);
  if (pending > 0) {
    throw Object.assign(
      new Error(
        `${pending} item${pending === 1 ? '' : 's'} for ${businessDate} ${pending === 1 ? 'is' : 'are'} ` +
          `still awaiting approval. Approve or reject them before closing — closing now would carry that ` +
          `money into a later day.`,
      ),
      { status: 409 },
    );
  }

  const { error } = await db.from('finance_day_closings').insert({
    business_date: businessDate,
    opening_balance: existing.openingBalance,
    opening_cash: existing.openingCash,
    opening_bank: existing.openingBank,
    total_income: existing.totalIncome,
    total_expenses: existing.totalExpenses,
    net_balance: existing.netBalance,
    cash_in_hand: existing.cashInHand,
    bank_balance: existing.bankBalance,
    closing_balance: existing.closingBalance,
    entry_count: existing.entryCount,
    notes: notes ?? null,
    closed_by: actor.uid,
    closed_by_name: actor.name,
  });
  // Two approvers closing the same day at once: the PK on business_date makes
  // the loser a 23505 rather than a second, differing snapshot.
  if (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error(`The finance day ${businessDate} was just closed by someone else.`), { status: 409 });
    }
    throw error;
  }

  // Mark the day's entries locked. Permitted by the immutability trigger, which
  // allows `status` to move but nothing that carries a figure.
  const { error: lockErr } = await withoutDeleted(
    db
      .from('ledger_entries')
      .update({ status: 'locked' })
      .eq('entry_date', businessDate)
      .eq('status', 'posted'),
  );
  if (lockErr) throw lockErr;

  // Documents settled on the day follow their entries into `locked`.
  for (const table of ['finance_transactions', 'salary_payments', 'partner_expenses', 'employee_advances']) {
    const { error: docErr } = await withoutDeleted(
      db
        .from(table)
        .update({ status: 'locked' })
        .eq('business_date', businessDate)
        .eq('status', 'posted'),
    );
    // A failure here leaves a posted document on a locked day — untidy but
    // harmless (the ledger is what reports read), so it is logged rather than
    // rolled back over an already-recorded closing.
    if (docErr) console.error(`[finance] could not lock ${table} for ${businessDate}:`, docErr.message);
  }

  return getDayClosing(businessDate);
}

/** Salaries carry no business_date, so they are excluded from the day check. */
async function countPendingForDate(businessDate: string): Promise<number> {
  const [txns, partners, advances, income] = await Promise.all([
    withoutDeleted(
      db
        .from('finance_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('business_date', businessDate)
        .in('status', ['draft', 'pending_approval']),
    ),
    withoutDeleted(
      db
        .from('partner_expenses')
        .select('id', { count: 'exact', head: true })
        .eq('business_date', businessDate)
        .in('status', ['draft', 'pending_approval']),
    ),
    withoutDeleted(
      db
        .from('employee_advances')
        .select('id', { count: 'exact', head: true })
        .eq('business_date', businessDate)
        .in('status', ['draft', 'pending_approval']),
    ),
    withoutDeleted(
      db
        .from('finance_income_approvals')
        .select('id', { count: 'exact', head: true })
        .eq('business_date', businessDate)
        .in('status', ['pending_verification', 'pending_approval']),
    ),
  ]);
  for (const r of [txns, partners, advances, income]) if (r.error) throw r.error;
  return (txns.count ?? 0) + (partners.count ?? 0) + (advances.count ?? 0) + (income.count ?? 0);
}

/** Closing history, most recent first. */
export async function listDayClosings(days = 30): Promise<FinanceDayClosing[]> {
  const since = businessDaysAgoStr(Math.max(1, days) - 1);
  const { data, error } = await db
    .from('finance_day_closings')
    .select('*')
    .gte('business_date', since)
    .order('business_date', { ascending: false });
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((c) => ({
    businessDate: c['business_date'] as string,
    openingBalance: num(c['opening_balance']),
    openingCash: num(c['opening_cash']),
    openingBank: num(c['opening_bank']),
    totalIncome: num(c['total_income']),
    totalExpenses: num(c['total_expenses']),
    netBalance: num(c['net_balance']),
    cashInHand: num(c['cash_in_hand']),
    bankBalance: num(c['bank_balance']),
    closingBalance: num(c['closing_balance']),
    entryCount: Number(c['entry_count'] ?? 0),
    status: 'closed' as const,
    closedBy: (c['closed_by'] as string) ?? null,
    closedByName: (c['closed_by_name'] as string) ?? null,
    closedAt: (c['closed_at'] as string) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface FinanceDashboardQuery {
  /** Defaults to today's business date — unchanged behaviour when omitted. */
  from?: string;
  /** Defaults to `from`, i.e. a single day, matching the pre-range behaviour. */
  to?: string;
  /**
   * Scope every branch-attributable figure to one branch. Cash/bank/closing
   * balance stay company-wide regardless — there is one treasury, not one per
   * branch, so `finance_day_summary` is never branch-filtered.
   */
  branchId?: string | null;
}

/**
 * Every document waiting for approval, oldest first.
 *
 * The same four queues the dashboard's "pending approval" figure counts, as
 * rows — so the number can be followed to what it is counting. Not filtered by
 * date on purpose: a document nobody approved in August is still waiting in
 * October, and a date filter is exactly how it gets lost.
 */
export async function listPendingApprovals(): Promise<FinancePendingApproval[]> {
  const pending = ['draft', 'pending_approval'];
  const [txns, partners, salaries, advances] = await Promise.all([
    withoutDeleted(db.from('finance_transactions').select('id, txn_no, txn_type, ledger_head_name, description, amount, business_date, status, created_by_name').in('status', pending)),
    withoutDeleted(db.from('partner_expenses').select('id, expense_no, partner_name, description, amount, business_date, status, requested_by_name').in('status', pending)),
    withoutDeleted(db.from('salary_payments').select('id, salary_no, employee_name, salary_month, net_salary, payment_date, status, created_by_name').in('status', pending)),
    withoutDeleted(db.from('employee_advances').select('id, advance_no, employee_name, total_amount, business_date, status, created_by_name').in('status', pending)),
  ]);
  for (const r of [txns, partners, salaries, advances]) {
    if (r.error) throw r.error;
  }

  const rows = <T,>(r: { data: unknown }) => (r.data ?? []) as T[];
  type Row = Record<string, string | number | null>;
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const day = (v: unknown) => text(v).slice(0, 10);

  const items: FinancePendingApproval[] = [
    ...rows<Row>(txns).map((r) => ({
      kind: 'transaction' as const,
      id: text(r['id']),
      refNo: text(r['txn_no']),
      date: day(r['business_date']),
      description: [text(r['ledger_head_name']), text(r['description'])].filter(Boolean).join(' — '),
      amount: round2(num(r['amount'])),
      status: text(r['status']) as FinancePendingApproval['status'],
      raisedBy: text(r['created_by_name']) || null,
    })),
    ...rows<Row>(partners).map((r) => ({
      kind: 'partner_expense' as const,
      id: text(r['id']),
      refNo: text(r['expense_no']),
      date: day(r['business_date']),
      description: [text(r['partner_name']), text(r['description'])].filter(Boolean).join(' — '),
      amount: round2(num(r['amount'])),
      status: text(r['status']) as FinancePendingApproval['status'],
      raisedBy: text(r['requested_by_name']) || null,
    })),
    ...rows<Row>(salaries).map((r) => ({
      kind: 'salary' as const,
      id: text(r['id']),
      refNo: text(r['salary_no']),
      date: day(r['payment_date']),
      description: [text(r['employee_name']), text(r['salary_month'])].filter(Boolean).join(' — '),
      amount: round2(num(r['net_salary'])),
      status: text(r['status']) as FinancePendingApproval['status'],
      raisedBy: text(r['created_by_name']) || null,
    })),
    ...rows<Row>(advances).map((r) => ({
      kind: 'advance' as const,
      id: text(r['id']),
      refNo: text(r['advance_no']),
      date: day(r['business_date']),
      description: text(r['employee_name']),
      amount: round2(num(r['total_amount'])),
      status: text(r['status']) as FinancePendingApproval['status'],
      raisedBy: text(r['created_by_name']) || null,
    })),
  ];
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.refNo.localeCompare(b.refNo));
}

/** date-string stepping, same technique `businessDateSeries` already uses below. */
function stepDateStr(dateStr: string, days: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export async function getFinanceDashboard(query: FinanceDashboardQuery = {}): Promise<FinanceDashboard> {
  const to = query.to ?? businessDateStr();
  const from = query.from ?? to;
  const branchId = query.branchId ?? null;

  // The trend card is a fixed trailing week ending on `to`, independent of the
  // selected range — same fixed-week behaviour as before this took a range.
  const trendFrom = stepDateStr(to, -6);

  let pendingIncomeQ = db
    .from('finance_income_approvals')
    .select('total_amount')
    .in('status', ['pending_verification', 'pending_approval']);
  if (branchId) pendingIncomeQ = pendingIncomeQ.eq('branch_id', branchId);

  let pendingTxnsQ = db.from('finance_transactions').select('amount').in('status', ['draft', 'pending_approval']);
  if (branchId) pendingTxnsQ = pendingTxnsQ.eq('branch_id', branchId);

  let recentQ = db.from('ledger_entries').select('*').lte('entry_date', to).order('seq', { ascending: false }).limit(10);
  if (branchId) recentQ = recentQ.eq('branch_id', branchId);

  let trendQ = db.from('ledger_entries').select('entry_date, debit, credit').gte('entry_date', trendFrom).lte('entry_date', to);
  if (branchId) trendQ = trendQ.eq('branch_id', branchId);

  const [
    day,
    shares,
    rangeTotals,
    pendingIncome,
    pendingTxns,
    pendingPartners,
    pendingSalaries,
    pendingAdvances,
    recent,
    trendRows,
  ] = await Promise.all([
    getDayClosing(to),
    shareTotals(from, to, branchId),
    db.rpc('finance_ledger_totals', { p_from: from, p_to: to, p_branch_id: branchId }),
    withoutDeleted(pendingIncomeQ),
    withoutDeleted(pendingTxnsQ),
    // partner_expenses / salary_payments / employee_advances carry no branch_id
    // (payroll and partner costs are company-level, not attributed to a branch)
    // — they are only counted into the "All Branches" view below.
    withoutDeleted(db.from('partner_expenses').select('amount').in('status', ['draft', 'pending_approval'])),
    withoutDeleted(db.from('salary_payments').select('net_salary').in('status', ['draft', 'pending_approval'])),
    withoutDeleted(db.from('employee_advances').select('total_amount').in('status', ['draft', 'pending_approval'])),
    withoutDeleted(recentQ),
    withoutDeleted(trendQ),
  ]);

  for (const r of [pendingIncome, pendingTxns, pendingPartners, pendingSalaries, pendingAdvances, recent, trendRows]) {
    if (r.error) throw r.error;
  }
  if (rangeTotals.error) throw rangeTotals.error;

  const rt = (Array.isArray(rangeTotals.data) ? rangeTotals.data[0] : rangeTotals.data) as Record<string, unknown> | null;
  const rangeIncome = round2(num(rt?.['total_debit']));
  const rangeExpenses = round2(num(rt?.['total_credit']));

  const sum = (rows: unknown, key: string) =>
    ((rows ?? []) as Record<string, unknown>[]).reduce((s, r) => s + num(r[key]), 0);

  // Every expense-side approval queue rolled into one figure — a finance user
  // wants "what is waiting on me", not four separate counts they have to add up.
  // Under a branch filter, only branch-attributable transactions count (salary,
  // partner and advance payments are company-level and have no branch_id) —
  // the "All Branches" total below is unchanged from before this took a branch.
  const pendingExpenseCount =
    (pendingTxns.data?.length ?? 0) +
    (branchId ? 0 : (pendingPartners.data?.length ?? 0) + (pendingSalaries.data?.length ?? 0) + (pendingAdvances.data?.length ?? 0));
  const pendingExpenseAmount =
    sum(pendingTxns.data, 'amount') +
    (branchId
      ? 0
      : sum(pendingPartners.data, 'amount') + sum(pendingSalaries.data, 'net_salary') + sum(pendingAdvances.data, 'total_amount'));

  const trendMap = new Map<string, { income: number; expenses: number }>();
  for (const r of (trendRows.data ?? []) as Record<string, unknown>[]) {
    const d = r['entry_date'] as string;
    const cur = trendMap.get(d) ?? { income: 0, expenses: 0 };
    cur.income += num(r['debit']);
    cur.expenses += num(r['credit']);
    trendMap.set(d, cur);
  }
  const trend = businessDateSeries(trendFrom, to).map((d) => {
    const v = trendMap.get(d) ?? { income: 0, expenses: 0 };
    return { businessDate: d, income: round2(v.income), expenses: round2(v.expenses), net: round2(v.income - v.expenses) };
  });

  return {
    businessDate: to,
    // Income/expenses across the selected range (a single day by default,
    // which is exactly what this returned before a range existed).
    todayIncome: rangeIncome,
    todayExpenses: rangeExpenses,
    // The book balance as it stands as of `to` — opening carried in, plus
    // everything posted through that date. One treasury, so never branch-scoped.
    netCashBalance: day.closingBalance,
    companyShare: shares.company,
    branchShare: shares.branch,
    pendingIncomeApprovals: pendingIncome.data?.length ?? 0,
    pendingIncomeAmount: round2(sum(pendingIncome.data, 'total_amount')),
    pendingExpenseApprovals: pendingExpenseCount,
    pendingExpenseAmount: round2(pendingExpenseAmount),
    bankBalance: day.bankBalance,
    cashInHand: day.cashInHand,
    // Fetched newest-first for the LIMIT to mean "the last ten"; reversed so the
    // card reads in the same direction as the ledger page.
    recentEntries: rowToApi<LedgerEntry[]>(recent.data ?? []).map(normaliseEntry).reverse(),
    trend,
  };
}

/** Company/branch split for a date range, read off the two system share heads. */
async function shareTotals(from: string, to: string, branchId: string | null): Promise<{ company: number; branch: number }> {
  const [company, branch] = await Promise.all([
    getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.COMPANY_SHARE),
    getLedgerHeadByCode(SYSTEM_LEDGER_HEAD_CODES.BRANCH_SHARE),
  ]);

  let query = db
    .from('ledger_entries')
    .select('ledger_head_id, debit')
    .gte('entry_date', from)
    .lte('entry_date', to)
    .in('ledger_head_id', [company.id, branch.id]);
  if (branchId) query = query.eq('branch_id', branchId);

  const { data, error } = await withoutDeleted(query);
  if (error) throw error;

  let c = 0;
  let b = 0;
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    if (r['ledger_head_id'] === company.id) c += num(r['debit']);
    else if (r['ledger_head_id'] === branch.id) b += num(r['debit']);
  }
  return { company: round2(c), branch: round2(b) };
}

/**
 * Every business date from `from` to `to` inclusive.
 *
 * Business dates are plain 'YYYY-MM-DD' strings with a 2 AM rollover already
 * baked in, so stepping them is calendar arithmetic on UTC midnight — no
 * timezone conversion, and none wanted: converting here would reintroduce the
 * offset that businessDateStr() has already accounted for.
 */
function businessDateSeries(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Turn a raised Postgres exception into something the user can act on.
 *
 * The guards in migration 52 (day closed, head inactive, already reversed,
 * entry immutable) are all `raise exception`, which comes back from `db` as
 * P0001 with the message intact. Left alone they surface as a 500 and an
 * "unexpected error" toast — which is exactly wrong for a rule the user has
 * merely bumped into.
 */
function asClientError(error: { code?: string; message: string }): Error & { status?: number } {
  if (error.code === 'P0001') {
    return Object.assign(new Error(error.message), { status: 409 });
  }
  return Object.assign(new Error(error.message), error.code ? { code: error.code } : {});
}
