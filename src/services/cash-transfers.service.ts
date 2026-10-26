import { WhereClause, dbFor, getPrisma } from '../db';
import {
  CASH_TRANSFER_METHODS,
  CASH_TRANSFER_STATUSES,
  businessDateStr,
  cashTransferChannelsLabel,
  cashTransferTotal,
  type BranchDayDeposit,
  type CashTransfer,
  type CashTransferListSummary,
  type CashTransferMethod,
  type CashTransferSortKey,
  type CashTransferStatus,
  type CreateCashTransferInput,
  type LedgerEntry,
  type PaymentReceivedItem,
  type UserRole,
} from '../shared';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';
import { resolveClientBusinessDate } from '../utils/clientBusinessDate';
import { bindAttachments, listAttachments, listAttachmentsFor } from './attachments.service';
import { getLedgerEntry } from './finance-ledger.service';
import { notify } from './push.service';
import { checkCashDeposit, enforceRestrictions } from './restriction.service';

const db = dbFor('cash-transfers');

/**
 * How far back a deposit may be dated: yesterday at most (the owner's rule,
 * 2026-10-27). Tighter than the 7-day sync window other writes use, because a
 * deposit dated days back lands in a day Finance may already have checked.
 */
export const CASH_DEPOSIT_BACKDATE_DAYS = 1;

/**
 * Cash transfers — money a branch hands to the company (migration 118).
 *
 * THE SHAPE OF THIS FILE. Two callers share it: the branch router
 * (cash-transfers.routes.ts), which may only ever see its own branch, and the
 * Finance router (finance-cash-transfers.routes.ts), which reviews across
 * branches. Both go through `listCashTransfers` / `getCashTransfer` with an
 * optional `branchId`; the ROUTER decides whether that id is pinned from the
 * JWT or chosen from the query string, and this file trusts what it is handed.
 * Every write that changes a transfer's state is a Postgres function
 * (approve_cash_transfer / reject_cash_transfer): the approval has to post the
 * RV- receipt and flip the status in one transaction, and each `db` call is its
 * own transaction, so that cannot be done from here in two steps.
 *
 * WHAT IT NEVER DOES. Nothing here touches production_orders, branch_discounts,
 * orders, expenses or stock. The transfer is one transaction; the production
 * slip reads approved rows through `paymentsReceivedInWindow` and displays the
 * sum beside its existing figures without subtracting it from anything.
 */

// ---------------------------------------------------------------------------
// Row ↔ API
// ---------------------------------------------------------------------------

/**
 * One DB row → the API's CashTransfer shape. Two fixes the discount router
 * also has to make: `business_date` → `date`, and every money column through
 * Number(), so a `numeric` that arrived as a string never leaves as one.
 */
function toApi(row: Record<string, unknown>): CashTransfer {
  const { businessDate, amount, cashAmount, easypaisaAmount, bankAmount, fuelCharges, ...rest } =
    rowToApi<Record<string, unknown>>(row);
  return {
    ...(rest as Omit<
      CashTransfer,
      'amount' | 'cashAmount' | 'easypaisaAmount' | 'bankAmount' | 'fuelCharges' | 'date' | 'attachments'
    >),
    amount: Number(amount ?? 0),
    cashAmount: Number(cashAmount ?? 0),
    easypaisaAmount: Number(easypaisaAmount ?? 0),
    bankAmount: Number(bankAmount ?? 0),
    fuelCharges: Number(fuelCharges ?? 0),
    date: String(businessDate),
    attachments: [],
  };
}

/**
 * The channel column a method filter reads (migration 121). "Paid by Easypaisa"
 * now means "carried Easypaisa money" — a mixed deposit answers to each of its
 * channels, and a pre-121 row answers to its one method through the backfill.
 */
const CHANNEL_COLUMNS: Record<CashTransferMethod, string> = {
  cash: 'cash_amount',
  easypaisa: 'easypaisa_amount',
  bank_account: 'bank_amount',
};

const SORTABLE_COLUMNS: Record<CashTransferSortKey, string> = {
  date: 'business_date',
  createdAt: 'created_at',
  approvedAt: 'approved_at',
  transferNo: 'transfer_no',
  voucherNo: 'voucher_no',
  branchName: 'branch_name',
  amount: 'amount',
  fuelCharges: 'fuel_charges',
  status: 'status',
};

export function isCashTransferSortKey(v: unknown): v is CashTransferSortKey {
  return typeof v === 'string' && v in SORTABLE_COLUMNS;
}
export function isCashTransferStatus(v: unknown): v is CashTransferStatus {
  return typeof v === 'string' && (CASH_TRANSFER_STATUSES as readonly string[]).includes(v);
}
export function isCashTransferMethod(v: unknown): v is CashTransferMethod {
  return typeof v === 'string' && (CASH_TRANSFER_METHODS as readonly string[]).includes(v);
}

/**
 * P0001 → 409 ("wrong state for this": already decided, finance day closed),
 * P0002 → 404, and the two "function does not exist" codes → 503 with the
 * migration named — the same mapping daily-sale.service.ts documents.
 */
function asClientError(error: { code?: string; message: string }): Error & { status?: number } {
  if (error.code === 'PGRST202' || error.code === '42883') {
    return Object.assign(
      new Error(
        'Cash transfers are unavailable: database migration 118 (cash_transfers) ' +
          'has not been applied. Apply the pending database migrations.',
      ),
      { status: 503 },
    );
  }
  if (error.code === 'P0002') return Object.assign(new Error('Cash transfer not found'), { status: 404 });
  if (error.code === 'P0001') return Object.assign(new Error(error.message), { status: 409 });
  return Object.assign(new Error(error.message), error.code ? { code: error.code } : {});
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What narrows the transfers — shared by the list and its summary. */
export interface CashTransferFilters {
  /** Pinned by the branch router; optional for Finance. */
  branchId?: string;
  from?: string;
  to?: string;
  status?: CashTransferStatus;
  paymentMethod?: CashTransferMethod;
  search?: string;
}

export interface CashTransferQuery extends CashTransferFilters {
  sortBy?: CashTransferSortKey;
  sortDir?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** The filter calls `filterCashTransfers` makes — met by a builder chain and by a WhereClause. */
interface CashTransferFilterable<T> {
  eq(column: string, value: unknown): T;
  gt(column: string, value: unknown): T;
  gte(column: string, value: unknown): T;
  lte(column: string, value: unknown): T;
  or(filters: string): T;
  is(column: string, value: null): T;
}

/**
 * Which transfers a set of filters means, written once. The list applies it to
 * its builder chain and the summary to a WhereClause under its aggregate, so a
 * figure above the table can never count a different set of rows from the
 * table's own total.
 */
function filterCashTransfers<T extends CashTransferFilterable<T>>(query: T, q: CashTransferFilters): T {
  // Soft-deleted through the Help Desk (migration 120) → gone from every list.
  let filtered = withoutDeleted(query);

  if (q.branchId) filtered = filtered.eq('branch_id', q.branchId);
  if (q.from) filtered = filtered.gte('business_date', q.from);
  if (q.to) filtered = filtered.lte('business_date', q.to);
  if (q.status) filtered = filtered.eq('status', q.status);
  if (q.paymentMethod) filtered = filtered.gt(CHANNEL_COLUMNS[q.paymentMethod], 0);

  // Free-text over the two numbers, the branch and the note — same convention
  // as the discount list: strip `or` filter syntax, then ilike.
  const term = q.search?.replace(/[(),*]/g, ' ').trim();
  if (term) {
    filtered = filtered.or(
      `transfer_no.ilike.%${term}%,voucher_no.ilike.%${term}%,branch_name.ilike.%${term}%,note.ilike.%${term}%`,
    );
  }
  return filtered;
}

export async function listCashTransfers(
  q: CashTransferQuery,
): Promise<{ transfers: CashTransfer[]; total: number }> {
  const sortCol = q.sortBy ? SORTABLE_COLUMNS[q.sortBy] : 'created_at';
  const ascending = q.sortDir === 'asc';

  const query = filterCashTransfers(db.from('cash_transfers').select('*', { count: 'exact' }), q)
    .order(sortCol, { ascending })
    // A stable tiebreak so paging never repeats or skips a row that shares the
    // sort value with its neighbour (every row of one day, sorted by date).
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  const transfers = ((data ?? []) as Record<string, unknown>[]).map(toApi);
  const photos = await listAttachmentsFor('cash_transfer', transfers.map((t) => t.id));
  return {
    transfers: transfers.map((t) => ({ ...t, attachments: photos.get(t.id) ?? [] })),
    total: count ?? 0,
  };
}

/**
 * The figures above Finance's board: one aggregate in Postgres over every row
 * `filterCashTransfers` matches — never the rows fetched and added up here.
 * `grouping sets` returns each status and the grand total from the same scan,
 * so the total is Postgres's own sum rather than three floats added in JS.
 */
export async function summarizeCashTransfers(q: CashTransferFilters): Promise<CashTransferListSummary> {
  type Row = {
    status: CashTransferStatus | null;
    isTotal: boolean;
    count: number;
    amount: number;
    cash: number;
    easypaisa: number;
    bank: number;
    fuel: number;
  };

  const params: unknown[] = [];
  const where = filterCashTransfers(new WhereClause('cash_transfers'), q).render('t', params);
  const rows = await getPrisma().$queryRawUnsafe<Row[]>(
    `select t.status::text                               as "status",
            (grouping(t.status) = 1)                     as "isTotal",
            count(*)::int                                as "count",
            coalesce(sum(t.amount), 0)::float8           as "amount",
            coalesce(sum(t.cash_amount), 0)::float8      as "cash",
            coalesce(sum(t.easypaisa_amount), 0)::float8 as "easypaisa",
            coalesce(sum(t.bank_amount), 0)::float8      as "bank",
            coalesce(sum(t.fuel_charges), 0)::float8     as "fuel"
       from public.cash_transfers as t${where}
      group by grouping sets ((t.status), ())`,
    ...params,
  );

  const total = rows.find((r) => r.isTotal);
  const status = (s: CashTransferStatus) => {
    const r = rows.find((row) => !row.isTotal && row.status === s);
    return { count: Number(r?.count ?? 0), amount: Number(r?.amount ?? 0) };
  };
  return {
    from: q.from ?? null,
    to: q.to ?? null,
    totals: {
      count: Number(total?.count ?? 0),
      amount: Number(total?.amount ?? 0),
      cash: Number(total?.cash ?? 0),
      easypaisa: Number(total?.easypaisa ?? 0),
      bank: Number(total?.bank ?? 0),
      fuel: Number(total?.fuel ?? 0),
    },
    pending: status('pending'),
    approved: status('approved'),
    rejected: status('rejected'),
  };
}

/**
 * One transfer, or null. When `branchId` is given the row must belong to it —
 * a branch asking for another shop's id gets "not found", not "forbidden",
 * so the response does not confirm the id exists.
 */
export async function getCashTransfer(id: string, branchId?: string | null): Promise<CashTransfer | null> {
  let query = withoutDeleted(db.from('cash_transfers').select('*').eq('id', id));
  if (branchId) query = query.eq('branch_id', branchId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const transfer = toApi(data as Record<string, unknown>);
  return { ...transfer, attachments: await listAttachments('cash_transfer', id) };
}

// ---------------------------------------------------------------------------
// Create (branch)
// ---------------------------------------------------------------------------

export async function createCashTransfer(input: {
  branchId: string;
  role: UserRole;
  actor: { uid: string; email: string };
  body: CreateCashTransferInput;
}): Promise<CashTransfer> {
  const { data: branch, error: brErr } = await db
    .from('branches')
    .select('id, name')
    .eq('id', input.branchId)
    .maybeSingle();
  if (brErr) throw brErr;
  if (!branch) throw Object.assign(new Error('Branch not found'), { status: 400 });

  // The device's business date when the mobile app sends one, today's
  // otherwise — put through the day-closure check exactly as a sale or an
  // expense is, but on a one-day window: a deposit is dated today or
  // yesterday, nothing older (the owner's rule, 2026-10-27).
  const businessDate = await resolveClientBusinessDate(input.body.businessDate, input.role, new Date(), CASH_DEPOSIT_BACKDATE_DAYS);

  // The daily limit is a Restriction Rule now (migration 136): the number comes
  // from Admin Settings, and an approved one-time exception lifts it. The
  // Idempotency-Key already collapses a double click or a retry into one row;
  // this refuses the deliberate submission past the day's allowance. A rejected
  // or deleted deposit does not count — the branch raises it again.
  const guard = await enforceRestrictions(
    await checkCashDeposit({ branchId: branch.id as string, businessDate }),
    {
      action: 'Forward deposit',
      actor: { uid: input.actor.uid, name: input.actor.email },
      branch: { id: branch.id as string, name: branch.name as string },
    },
  );

  // The Total is computed HERE, from the channels, whatever the client showed —
  // the schema has already refused a displayed total that disagreed. The
  // table's CHECK (migration 121) is the last word.
  const { cashAmount, easypaisaAmount, bankAmount, fuelCharges } = input.body;
  const amount = cashTransferTotal({ cashAmount, easypaisaAmount, bankAmount });

  const { data: created, error: insErr } = await db
    .from('cash_transfers')
    .insert({
      branch_id: branch.id,
      branch_name: branch.name,
      amount,
      cash_amount: cashAmount,
      easypaisa_amount: easypaisaAmount,
      bank_amount: bankAmount,
      fuel_charges: fuelCharges,
      note: input.body.note?.trim() || null,
      business_date: businessDate,
      status: 'pending',
      created_by: input.actor.uid,
      created_by_name: input.actor.email,
    })
    .select('*')
    .single();
  if (insErr) {
    await guard.release();
    throw insErr;
  }
  await guard.commit(created.transfer_no as string);

  // Bind the staged photo(s). The schema required one whenever the Total is
  // above 0, so a throw here means the photo vanished between upload and
  // submit (a second tab, a retry after a partial failure); the 409 tells the
  // branch to retake. A fuel-only deposit may arrive with none.
  const attachments = input.body.attachmentIds.length
    ? await bindAttachments({
        entity: 'cash_transfer',
        entityId: created.id as string,
        attachmentIds: input.body.attachmentIds,
        actor: { uid: input.actor.uid },
      })
    : [];

  const transfer = { ...toApi(created as Record<string, unknown>), attachments };

  // Finance is two roles, and a role broadcast reaches one role — so one row
  // each. branchId null: a finance user has no branch, and the notification
  // feed leaves out a role broadcast whose branch is not the reader's. Best
  // effort: the transfer is saved, and a failed notice must not turn a 201
  // into a 500 that the client would retry.
  const summary = depositSummary(transfer);
  for (const targetRole of ['finance_admin', 'finance_manager'] as const) {
    try {
      await notify({
        type: 'cash_transfer',
        title: 'Cash Transfer Submitted',
        message: `${branch.name} sent ${summary} (${transfer.transferNo}) — awaiting approval`,
        targetRole,
        branchId: null,
        relatedId: transfer.id,
      });
    } catch (err) {
      console.error('[cash-transfers] notify failed', err);
    }
  }

  return transfer;
}

/** "Rs. 80,000 (Cash + Easypaisa + Bank) + fuel Rs. 2,000" — for the notices. */
function depositSummary(t: CashTransfer): string {
  const rs = (n: number) => `Rs. ${n.toLocaleString('en-PK')}`;
  const parts: string[] = [];
  if (t.amount > 0) parts.push(`${rs(t.amount)} (${cashTransferChannelsLabel(t)})`);
  if (t.fuelCharges > 0) parts.push(`fuel charges ${rs(t.fuelCharges)}`);
  return parts.join(' + ');
}

// ---------------------------------------------------------------------------
// Review (Finance)
// ---------------------------------------------------------------------------

export interface CashTransferActor {
  uid: string;
  name: string;
}

/**
 * Approve: one RPC, one transaction — the receipt is posted and the transfer
 * marked in the same statement, so the book and the record cannot disagree.
 * Returns the transfer and the RV- entry it became.
 */
export async function approveCashTransfer(
  id: string,
  actor: CashTransferActor,
  note?: string | null,
): Promise<{ transfer: CashTransfer; ledgerEntry: LedgerEntry | null }> {
  const { data, error } = await db.rpc('approve_cash_transfer', {
    p_id: id,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_today: businessDateStr(),
    p_note: note ?? null,
  });
  if (error) throw asClientError(error);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw Object.assign(new Error('Cash transfer not found'), { status: 404 });

  const [attachments, ledgerEntry] = await Promise.all([
    listAttachments('cash_transfer', id),
    row['ledger_entry_id'] ? getLedgerEntry(String(row['ledger_entry_id'])) : Promise.resolve(null),
  ]);
  const transfer = { ...toApi(row), attachments };

  await notifyBranch(transfer, 'approved');
  return { transfer, ledgerEntry };
}

export async function rejectCashTransfer(
  id: string,
  actor: CashTransferActor,
  reason: string,
): Promise<CashTransfer> {
  const { data, error } = await db.rpc('reject_cash_transfer', {
    p_id: id,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_reason: reason,
  });
  if (error) throw asClientError(error);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw Object.assign(new Error('Cash transfer not found'), { status: 404 });

  const transfer = { ...toApi(row), attachments: await listAttachments('cash_transfer', id) };
  await notifyBranch(transfer, 'rejected');
  return transfer;
}

/** Tell the branch. Best effort: the decision is committed before this runs. */
async function notifyBranch(transfer: CashTransfer, decision: 'approved' | 'rejected'): Promise<void> {
  const amount = depositSummary(transfer);
  const message =
    decision === 'approved'
      ? `${transfer.transferNo} for ${amount} was approved — receipt ${transfer.voucherNo ?? ''}`.trim()
      : `${transfer.transferNo} for ${amount} was rejected: ${transfer.rejectionReason ?? ''}`.trim();
  try {
    await notify({
      type: 'cash_transfer_reviewed',
      title: decision === 'approved' ? 'Cash Transfer Approved' : 'Cash Transfer Rejected',
      message,
      targetRole: 'branch_manager',
      branchId: transfer.branchId,
      relatedId: transfer.id,
    });
  } catch (err) {
    console.error('[cash-transfers] notify failed', err);
  }
}

// ---------------------------------------------------------------------------
// The production slip's "Payment Received"
// ---------------------------------------------------------------------------

/**
 * Approved transfers a branch made in one billing window — after the previous
 * order was placed, up to and including this one, the SAME window
 * previous-balance.service.ts uses for returns and discounts — TOGETHER WITH
 * every other approved transfer the branch dated the same day as one of them.
 *
 * The second half is the rule a branch reads the slip by: money handed over in
 * two or three trips on one day is one day's payment, and a slip that listed
 * only the trip that happened to fall inside its window looked like the rest had
 * gone missing. So a day's deposits always travel together — if one is on the
 * slip, all of them are.
 *
 * What that costs, knowingly: on a day with two demands the same deposits print
 * on both slips. That is safe only because this figure is DISPLAYED and never
 * deducted. Anything that adds these up across slips must count each transfer
 * once, by `transferId` — the Collections export's TOTAL row does.
 *
 * 'approved' only: a pending transfer is money Finance has not yet confirmed,
 * and a rejected one never arrived.
 */
export async function paymentsReceivedInWindow(
  branchId: string,
  afterTs: string,
  untilTs: string,
): Promise<{ paymentItems: PaymentReceivedItem[]; paymentsReceivedValue: number }> {
  type Row = {
    id: string;
    transfer_no: string;
    voucher_no: string | null;
    business_date: string;
    amount: number | string;
    cash_amount: number | string;
    easypaisa_amount: number | string;
    bank_amount: number | string;
    created_at: string;
  };

  // A transfer deleted through the Help Desk left the ledger with its
  // vouchers (migration 125) and must drop out of the slip's figure too.
  const approved = () =>
    withoutDeleted(
      db
        .from('cash_transfers')
        .select('id, transfer_no, voucher_no, business_date, amount, cash_amount, easypaisa_amount, bank_amount, created_at'),
    )
      .eq('branch_id', branchId)
      .eq('status', 'approved')
      // A fuel-only deposit (Total 0) is income, not a payment against the slip.
      .gt('amount', 0);

  const { data, error } = await approved().gt('created_at', afterTs).lte('created_at', untilTs);
  if (error) throw error;
  const inWindow = (data ?? []) as Row[];

  // The rest of each of those days. Nothing in the window means nothing to
  // complete, so a slip with no payment stays a slip with no payment.
  const days = [...new Set(inWindow.map((r) => r.business_date))];
  let sameDay: Row[] = [];
  if (days.length > 0) {
    const { data: dayRows, error: dayErr } = await approved().in('business_date', days);
    if (dayErr) throw dayErr;
    sameDay = (dayRows ?? []) as Row[];
  }

  const byId = new Map<string, Row>();
  for (const r of [...inWindow, ...sameDay]) byId.set(r.id, r);
  const rows = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const paymentItems: PaymentReceivedItem[] = rows.map((r) => ({
    transferId: r.id,
    transferNo: r.transfer_no,
    voucherNo: r.voucher_no,
    date: r.business_date,
    amount: Number(r.amount ?? 0),
    cashAmount: Number(r.cash_amount ?? 0),
    easypaisaAmount: Number(r.easypaisa_amount ?? 0),
    bankAmount: Number(r.bank_amount ?? 0),
  }));

  return {
    paymentItems,
    paymentsReceivedValue: paymentItems.reduce((a, p) => a + p.amount, 0),
  };
}

/** Rows per read while paging a window of deposits — under the query layer's ceiling. */
const RECONCILIATION_PAGE = 500;

/**
 * Every live deposit dated inside a window, for Finance's Daily Closing.
 *
 * Unlike `listCashTransfers` this reads only the amounts and the two numbers a
 * reader needs to find the deposit — no photos are signed — and it pages until
 * the window is exhausted rather than returning one screen of it, because a
 * deposit left off the end would read as money not received.
 *
 * Pending and approved rows both come back and the caller tells them apart: a
 * pending deposit is reported beside the day, never counted into it. Rejected
 * deposits never arrived, deleted ones left the ledger, and a fuel-only deposit
 * (Total 0) is income rather than a handover — the same three exclusions
 * `paymentsReceivedInWindow` makes.
 */
export async function listDepositsForReconciliation(q: {
  from: string;
  to: string;
  branchId: string | null;
}): Promise<BranchDayDeposit[]> {
  const deposits: BranchDayDeposit[] = [];

  for (let offset = 0; ; offset += RECONCILIATION_PAGE) {
    let query = withoutDeleted(
      db
        .from('cash_transfers')
        .select(
          'id, transfer_no, voucher_no, status, branch_id, branch_name, business_date, amount, cash_amount, easypaisa_amount, bank_amount',
        ),
    )
      .in('status', ['pending', 'approved'])
      .gt('amount', 0)
      .gte('business_date', q.from)
      .lte('business_date', q.to)
      // `id` is the tiebreak that keeps a page boundary from repeating or
      // skipping a row among deposits submitted in the same instant.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + RECONCILIATION_PAGE - 1);
    if (q.branchId) query = query.eq('branch_id', q.branchId);

    const { data, error } = await query;
    if (error) throw asClientError(error);
    const rows = (data ?? []) as Record<string, unknown>[];

    for (const r of rows) {
      deposits.push({
        id: String(r['id']),
        transferNo: String(r['transfer_no']),
        voucherNo: (r['voucher_no'] as string | null) ?? null,
        status: r['status'] === 'approved' ? 'approved' : 'pending',
        branchId: String(r['branch_id']),
        branchName: String(r['branch_name'] ?? ''),
        businessDate: String(r['business_date']),
        amount: Number(r['amount'] ?? 0),
        cashAmount: Number(r['cash_amount'] ?? 0),
        easypaisaAmount: Number(r['easypaisa_amount'] ?? 0),
        bankAmount: Number(r['bank_amount'] ?? 0),
      });
    }

    if (rows.length < RECONCILIATION_PAGE) return deposits;
  }
}
