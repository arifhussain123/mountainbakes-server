import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import {
  requireFinance,
  requireFinanceHelpDeskAdmin,
  requireFinanceHelpDeskParticipant,
} from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  AmendFinanceRecordSchema,
  AmendFinanceTicketSchema,
  AssignFinanceTicketSchema,
  CorrectFinanceRecordSchema,
  CreateFinanceTicketSchema,
  DeleteFinanceRecordSchema,
  EditFinanceDraftSchema,
  EditFinanceTicketSchema,
  FINANCE_AMENDABLE_FIELDS,
  FINANCE_QUERY_PRIORITY_LABELS,
  FINANCE_QUERY_TYPE_LABELS,
  FINANCE_TICKET_FEED_FIELD_LABELS,
  FINANCE_TICKET_PREFIX_MAP,
  FINANCE_TICKET_PREFIXES,
  FINANCE_TICKET_REFERENCES,
  FINANCE_TICKET_REOPENABLE_STATUSES,
  FINANCE_TICKET_STATUS_LABELS,
  FINANCE_TICKET_TRANSITIONS,
  FINANCE_RESOLUTION_TYPE_LABELS,
  businessDateStr,
  FinanceTicketMessageSchema,
  FinanceTicketQuerySchema,
  FinanceTicketResponseSchema,
  FinanceTicketStatusSchema,
  RecreateFinanceTicketSchema,
  ReopenFinanceTicketSchema,
  RestoreFinanceTicketSchema,
  financeAmendableValue,
  financeHelpDeskCan,
  isFinanceRecordAmendable,
  isFinanceTicketTerminal,
  type FinanceAmendmentAction,
  type FinanceAuditEntity,
  type FinanceQueryPriority,
  type FinanceQueryType,
  type FinanceResolutionType,
  type CorrectFinanceRecordInput,
  type CreateFinanceTicketInput,
  type FinanceTicketFeedInput,
  type FinanceTicketReferenceLookup,
  type FinanceTicketReferenceType,
  type FinanceTicketResolution,
  type FinanceTicketStatus,
  type FinanceTicketVersionAction,
  type FinanceTicketVersionChange,
} from '../shared';
import { notify } from '../services/push.service';
import {
  financeTicketAuditTrail,
  logFinanceAudit,
  requestFingerprint,
} from '../services/finance-audit.service';
import { bindAttachments, listAttachments, listAttachmentsFor } from '../services/attachments.service';
import { rowToApi } from '../utils/case';
import { withoutDeleted } from '../utils/softDelete';

const db = dbFor('finance-tickets');

/**
 * /api/finance/tickets — the Finance Help Desk.
 *
 *     Finance User  →  Finance Help Desk  →  ADMIN
 *
 * A Finance user REPORTS, VIEWS and DISCUSSES. An Admin — and only an Admin —
 * responds, moves the query along, and changes, amends, overwrites or deletes
 * the finance record behind it. That is the brief's §21, and the split runs
 * through every route below: the reporting half sits behind `requireFinance`,
 * the acting half behind `requireFinanceHelpDeskAdmin`.
 *
 * Migration 94 reversed migration 60 here, and the reversal is the thing most
 * likely to surprise: the queue used to belong to `finance_admin`, and no longer
 * does. See requireFinanceHelpDeskAdmin's own header for why, and for why the
 * `allowSuperAdminWrite` toggle is deliberately not consulted.
 *
 * Four things are deliberate and worth not "tidying" later:
 *
 *   1. The snapshot is the WHOLE source row, not a hand-picked subset. Picking
 *      columns means guessing which ones matter to whoever reads the query in
 *      three months, and silently losing a column when the source table grows.
 *   2. A reference is OPTIONAL. "Calculation Issue" and "Other" name no single
 *      record, and forcing a raiser to invent one sends the admin to the wrong
 *      row.
 *   3. Nothing is destroyed. Delete is `soft_delete_finance_record` — a stamp —
 *      and the query itself is stamped too. Migration 60's real delete is gone.
 *   4. Every write that touches the BOOKS goes through one handler
 *      (`applyRecordChange`) so the amendment record, the audit row and the
 *      notification cannot be written for one verb and forgotten for another.
 */

export const router = Router();

router.use(authenticate);

/** A raiser sees their own queue; the admin and the auditor see all of it. */
function seesWholeQueue(role: string): boolean {
  return financeHelpDeskCan(role, 'respond') || role === 'finance_auditor';
}

/** Which side of the desk this caller speaks from, for the conversation thread. */
function sideOf(role: string): 'finance' | 'admin' {
  return financeHelpDeskCan(role, 'respond') ? 'admin' : 'finance';
}

class LookupError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The legal status moves live in FINANCE_TICKET_TRANSITIONS on the shared
 * types — one table, read by this route to refuse a move and by the detail
 * screen to offer one. Reopen (§12), submit (§2) and amend (§6) are not in it
 * on purpose: each has to do something a bare status change does not, and each
 * has its own route below.
 */
const FINANCE_TICKET_REOPENABLE: readonly FinanceTicketStatus[] = FINANCE_TICKET_REOPENABLE_STATUSES;

/**
 * The row as this caller may see it.
 *
 * `internal_note` is the admin's working note (§6) and is stripped for everyone
 * else HERE, at the boundary, rather than by the UI declining to render it — a
 * note the raiser must not read is not protected by a component, because the row
 * still crosses the wire either way.
 */
function ticketForCaller<T extends Record<string, unknown>>(row: T, isAdmin: boolean) {
  if (isAdmin) return rowToApi(row);
  const { internal_note: _internalNote, ...visible } = row;
  return rowToApi(visible);
}

/**
 * Resolve `RV-000001` to the row it names.
 *
 * The prefix decides the table, so the raiser types one reference and never has
 * to say what kind of record it is. An unknown prefix is a 400 (the caller sent
 * something malformed); a well-formed reference that matches nothing is a 404
 * (they sent something reasonable that does not exist) — the two are different
 * problems for the person typing, and collapsing them makes the Help Desk say
 * "invalid" to a voucher number that is merely from another branch's book.
 *
 * A soft-deleted record still resolves, and says so. Refusing it would make the
 * one query most worth raising — "where did this voucher go?" — the one query
 * that cannot be raised.
 */
async function resolveReference(refRaw: string): Promise<FinanceTicketReferenceLookup> {
  const referenceNo = refRaw.trim().toUpperCase();
  const prefix = referenceNo.split('-')[0] ?? '';
  const referenceType = FINANCE_TICKET_PREFIX_MAP[prefix] as FinanceTicketReferenceType | undefined;

  if (!referenceType) {
    const known = FINANCE_TICKET_PREFIXES.join(', ');
    throw new LookupError(`Unknown reference type "${prefix}". Expected one of: ${known}.`, 400);
  }

  const { table, refColumn, label } = FINANCE_TICKET_REFERENCES[referenceType];
  const { data, error } = await db
    .from(table)
    .select('*')
    .eq(refColumn, referenceNo)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new LookupError(`No ${label.toLowerCase()} found for ${referenceNo}.`, 404);

  return {
    referenceType,
    referenceId: data.id as string,
    referenceNo,
    label,
    snapshot: rowToApi(data) as Record<string, unknown>,
  };
}

/** The live row behind a query, deleted or not — the admin's working copy. */
async function liveReference(
  referenceType: FinanceTicketReferenceType | null,
  referenceId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!referenceType || !referenceId) return null;
  const { table } = FINANCE_TICKET_REFERENCES[referenceType];
  const { data, error } = await db.from(table).select('*').eq('id', referenceId).maybeSingle();
  if (error) throw error;
  return data ? (rowToApi(data) as Record<string, unknown>) : null;
}

async function getTicket(id: string) {
  const { data, error } = await db
    .from('finance_tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Why a referenced record cannot be changed from the Finance Help Desk.
 *
 * Only ever true of a SALE today (migration 96): it resolves, it snapshots, and
 * it is corrected in the Support Center — through `edit_sale_items`, which
 * rewrites the lines, recomputes the order's totals and reconciles branch
 * stock. The message says where to go, because "nothing on this record can be
 * changed" on its own reads as "and nowhere else either".
 */
function informationalReferenceMessage(
  referenceType: FinanceTicketReferenceType,
  referenceNo: unknown,
): string {
  const ref = typeof referenceNo === 'string' && referenceNo ? referenceNo : 'That record';
  if (referenceType === 'order') {
    return (
      `${ref} is a sale, and a sale is corrected in the Support Center — where the line items, ` +
      'the totals and the branch stock are reconciled together. It is shown here so the query ' +
      'carries the figures; change it there, and answer this query with what was done.'
    );
  }
  return `Nothing on ${ref} can be changed directly from the Help Desk.`;
}

/**
 * May this caller read this query at all?
 *
 * A DRAFT is the raiser's alone (§2): it has not been sent, so even an Admin
 * has no business reading it. The queue applies the same rule in SQL.
 */
function canSee(req: AuthRequest, ticket: Record<string, unknown>): boolean {
  if (ticket['raised_by'] === req.user!.uid) return true;
  if (ticket['status'] === 'draft') return false;
  return seesWholeQueue(req.user!.role);
}

// ---------------------------------------------------------------------------
// The query as a fed record (migration 106) — feed fields, diffs and versions
// ---------------------------------------------------------------------------

/**
 * API field → finance_tickets column, for everything the feed form can set.
 *
 * `referenceNo` and `branchId` are deliberately absent: both RESOLVE to more
 * than one column (a reference to type/id/no/snapshot, a branch to id+name) and
 * are handled by `applyFeed` explicitly rather than copied across.
 */
const FEED_COLUMNS: Record<string, string> = {
  subject: 'subject',
  queryType: 'query_type',
  priority: 'priority',
  description: 'message',
  message: 'message',
  amount: 'amount',
  businessDate: 'business_date',
  remarks: 'remarks',
  voucherRef: 'voucher_ref',
  transactionRef: 'transaction_ref',
  expenseRef: 'expense_ref',
  incomeRef: 'income_ref',
};

/** Column → the label the history prints. Built from the shared feed labels. */
const COLUMN_LABELS: Record<string, string> = {
  subject: FINANCE_TICKET_FEED_FIELD_LABELS.subject,
  query_type: FINANCE_TICKET_FEED_FIELD_LABELS.queryType,
  priority: FINANCE_TICKET_FEED_FIELD_LABELS.priority,
  message: FINANCE_TICKET_FEED_FIELD_LABELS.message,
  amount: FINANCE_TICKET_FEED_FIELD_LABELS.amount,
  branch_name: FINANCE_TICKET_FEED_FIELD_LABELS.branchName,
  business_date: FINANCE_TICKET_FEED_FIELD_LABELS.businessDate,
  remarks: FINANCE_TICKET_FEED_FIELD_LABELS.remarks,
  reference_no: FINANCE_TICKET_FEED_FIELD_LABELS.referenceNo,
  voucher_ref: FINANCE_TICKET_FEED_FIELD_LABELS.voucherRef,
  transaction_ref: FINANCE_TICKET_FEED_FIELD_LABELS.transactionRef,
  expense_ref: FINANCE_TICKET_FEED_FIELD_LABELS.expenseRef,
  income_ref: FINANCE_TICKET_FEED_FIELD_LABELS.incomeRef,
  status: 'Status',
  admin_response: 'Admin response',
  resolution_note: 'Resolution',
  resolution_type: 'Resolution type',
  resolution_amount: 'Resolution amount',
  internal_note: 'Internal note',
  assigned_to_name: 'Assigned admin',
  resolved_by_name: 'Resolved by',
  delete_reason: 'Deletion reason',
  restore_reason: 'Restore reason',
  reopen_reason: 'Reopen reason',
};

/** Columns the history DIFFS between versions. Stamps and ids are not changes. */
const VERSIONED_COLUMNS = Object.keys(COLUMN_LABELS);

/** The wire spelling of a stored value, as the history prints it. */
function versionValue(column: string, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return JSON.stringify(raw);
  const value = String(raw);
  if (column === 'status') return FINANCE_TICKET_STATUS_LABELS[value as FinanceTicketStatus] ?? value;
  if (column === 'query_type') return FINANCE_QUERY_TYPE_LABELS[value as FinanceQueryType] ?? value;
  if (column === 'priority') return FINANCE_QUERY_PRIORITY_LABELS[value as FinanceQueryPriority] ?? value;
  if (column === 'resolution_type') {
    return FINANCE_RESOLUTION_TYPE_LABELS[value as FinanceResolutionType] ?? value;
  }
  if (column === 'amount' || column === 'resolution_amount') {
    const n = Number(value);
    return Number.isFinite(n)
      ? n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : value;
  }
  return value;
}

/** snake_case column → camelCase API field, for the version's change list. */
function apiField(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** The field-level diff between two rows, over the versioned columns only. */
function diffRows(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FinanceTicketVersionChange[] {
  const changes: FinanceTicketVersionChange[] = [];
  for (const column of VERSIONED_COLUMNS) {
    const from = versionValue(column, before[column]);
    const to = versionValue(column, after[column]);
    if (from === to) continue;
    changes.push({ field: apiField(column), label: COLUMN_LABELS[column] ?? column, old: from, new: to });
  }
  return changes;
}

/**
 * Write the next version of a query (§7).
 *
 * Bumps `finance_tickets.version` and inserts the finance_ticket_versions row
 * in that order, so a version number is never handed out twice: the UPDATE is
 * guarded on the version it read, and a concurrent writer that loses the race
 * gets a 409 from the caller rather than a duplicate-key error from the
 * database. The snapshot is the row AFTER the change, whole.
 *
 * Returns the row as re-read with its new version, which is what the caller
 * should send back — a response carrying the pre-bump version would make the
 * next edit's guard fail for no reason the user can see.
 */
async function recordVersion(
  req: AuthRequest,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  action: FinanceTicketVersionAction,
  reason: string | null,
  extraChanges: FinanceTicketVersionChange[] = [],
): Promise<Record<string, unknown>> {
  const currentVersion = Number(after['version'] ?? before['version'] ?? 1);
  const nextVersion = currentVersion + 1;

  const { data: bumped, error: bumpErr } = await db
    .from('finance_tickets')
    .update({ version: nextVersion })
    .eq('id', after['id'] as string)
    .eq('version', currentVersion)
    .select('*')
    .maybeSingle();
  if (bumpErr) throw bumpErr;
  if (!bumped) {
    throw Object.assign(
      new Error('Someone else changed this query while you were working on it. Reload and try again.'),
      { status: 409 },
    );
  }

  const changes = [...diffRows(before, bumped), ...extraChanges];

  const { error } = await db.from('finance_ticket_versions').insert({
    ticket_id: bumped['id'],
    query_no: bumped['query_no'],
    version: nextVersion,
    action,
    changed_by: req.user!.uid,
    changed_by_name: req.user!.email,
    changed_by_role: req.user!.role,
    reason,
    changes,
    snapshot: bumped,
  });
  if (error) throw error;

  return bumped;
}

/** Version 1 — written once, when the row is created (or recreated). */
async function recordFirstVersion(
  req: AuthRequest,
  row: Record<string, unknown>,
  action: 'created' | 'recreated',
  reason: string | null,
): Promise<void> {
  const { error } = await db.from('finance_ticket_versions').insert({
    ticket_id: row['id'],
    query_no: row['query_no'],
    version: Number(row['version'] ?? 1),
    action,
    changed_by: req.user!.uid,
    changed_by_name: req.user!.email,
    changed_by_role: req.user!.role,
    reason,
    changes: [],
    snapshot: row,
  });
  if (error) throw error;
}

/** A branch by id, for the name cache. 404s in words rather than a bare FK error. */
async function resolveBranch(branchId: string | null | undefined): Promise<{ id: string; name: string } | null> {
  if (!branchId) return null;
  const { data, error } = await db.from('branches').select('id, name').eq('id', branchId).maybeSingle();
  if (error) throw error;
  if (!data) throw new LookupError('That branch does not exist.', 404);
  return { id: data.id as string, name: data.name as string };
}

/**
 * Turn a feed payload into the columns it sets. Only keys PRESENT on the
 * payload are written — `undefined` means "leave it", `null` means "clear it" —
 * so a form that sends its whole state and a PATCH that sends one field both
 * do what they say.
 *
 * A reference that is GIVEN must resolve (a typo'd voucher number silently
 * accepted is a query the admin cannot action); a reference set to null clears
 * all four reference columns together, since a snapshot of nothing is noise.
 */
async function feedToPatch(body: FinanceTicketFeedInput & { message?: string }): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(FEED_COLUMNS)) {
    const value = (body as Record<string, unknown>)[field];
    if (value !== undefined) patch[column] = value;
  }

  if (body.branchId !== undefined) {
    const branch = await resolveBranch(body.branchId);
    patch['branch_id'] = branch?.id ?? null;
    patch['branch_name'] = branch?.name ?? null;
  }

  if (body.referenceNo !== undefined) {
    if (body.referenceNo) {
      const reference = await resolveReference(body.referenceNo);
      patch['reference_type'] = reference.referenceType;
      patch['reference_id'] = reference.referenceId;
      patch['reference_no'] = reference.referenceNo;
      patch['reference_snapshot'] = reference.snapshot;
    } else {
      patch['reference_type'] = null;
      patch['reference_id'] = null;
      patch['reference_no'] = null;
      patch['reference_snapshot'] = null;
    }
  }

  return patch;
}

/** The category a query about each kind of record falls under. */
const REFERENCE_QUERY_TYPE: Record<FinanceTicketReferenceType, FinanceQueryType> = {
  ledger_entry: 'ledger',
  income_approval: 'income',
  finance_transaction: 'company_transaction',
  salary_payment: 'salary',
  employee_advance: 'salary',
  partner_expense: 'partner_advance',
  branch_share_payment: 'branch_share',
  order: 'income',
  cash_transfer: 'payment',
};

/** Which free-text handle a reference of each kind also fills. */
const REFERENCE_HANDLE_COLUMN: Partial<Record<FinanceTicketReferenceType, string>> = {
  ledger_entry: 'voucher_ref',
  income_approval: 'income_ref',
  finance_transaction: 'transaction_ref',
};

// A ledger voucher carries its figure on one side — debit or credit — and zero on the other.
const SNAPSHOT_AMOUNT_KEYS = ['amount', 'totalAmount', 'grandTotal', 'netSalary', 'grossSalary', 'debit', 'credit'];
const SNAPSHOT_DATE_KEYS = ['businessDate', 'entryDate', 'paymentDate', 'transferDate', 'date'];

/**
 * Fill what a reference-first query did not say from the record it names.
 *
 * The New Query popup sends a reference and a description and nothing else, so
 * the type, subject, amount, branch and date are read HERE from the row the
 * reference resolved to — never from the client, which has only ever seen a
 * copy of it. A column the caller did set is left alone, which is what keeps
 * the admin's full form (recreate) saying exactly what it was told.
 */
async function deriveFromReference(patch: Record<string, unknown>): Promise<void> {
  const referenceType = patch['reference_type'] as FinanceTicketReferenceType | null | undefined;
  const snapshot = patch['reference_snapshot'] as Record<string, unknown> | null | undefined;
  if (!referenceType || !snapshot) return;
  const referenceNo = String(patch['reference_no']);
  const label = FINANCE_TICKET_REFERENCES[referenceType].label;

  if (patch['query_type'] === undefined) {
    const txnType = snapshot['txnType'];
    patch['query_type'] =
      referenceType === 'finance_transaction' && (txnType === 'income' || txnType === 'expense')
        ? txnType
        : REFERENCE_QUERY_TYPE[referenceType];
  }
  if (patch['subject'] === undefined) patch['subject'] = `${label} ${referenceNo}`;

  if (patch['amount'] === undefined) {
    for (const key of SNAPSHOT_AMOUNT_KEYS) {
      const n = Number(snapshot[key]);
      if (snapshot[key] !== null && snapshot[key] !== undefined && snapshot[key] !== '' && Number.isFinite(n) && (key === 'debit' ? n > 0 : n >= 0)) {
        patch['amount'] = n;
        break;
      }
    }
  }
  if (patch['business_date'] === undefined) {
    for (const key of SNAPSHOT_DATE_KEYS) {
      const v = snapshot[key];
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        patch['business_date'] = v.slice(0, 10);
        break;
      }
    }
  }
  if (patch['branch_id'] === undefined && typeof snapshot['branchId'] === 'string' && snapshot['branchId']) {
    const { data, error } = await db
      .from('branches')
      .select('id, name')
      .eq('id', snapshot['branchId'])
      .maybeSingle();
    if (error) throw error;
    if (data) {
      patch['branch_id'] = data.id;
      patch['branch_name'] = data.name;
    }
  }

  const handle = REFERENCE_HANDLE_COLUMN[referenceType];
  if (handle && patch[handle] === undefined) patch[handle] = referenceNo;
}

/** Only the columns whose value actually differs from the row — an honest diff. */
function onlyChanged(patch: Record<string, unknown>, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(patch)) {
    const current = row[column];
    const same =
      current === value ||
      (current === null && value === null) ||
      (typeof current === 'number' && typeof value === 'number' && current === value) ||
      (typeof current === 'object' && typeof value === 'object' && JSON.stringify(current) === JSON.stringify(value)) ||
      // numeric columns come back as numbers; the form may send the same figure as a string
      (typeof current === 'number' && typeof value === 'string' && Number(value) === current) ||
      (typeof current === 'string' && typeof value === 'number' && Number(current) === value);
    if (!same) out[column] = value;
  }
  return out;
}

/** The camelCase previous values for the audit row, over the columns a patch touched. */
function previousOf(patch: Record<string, unknown>, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(patch).map((k) => [k, row[k] ?? null]));
}

/** The version rows as this caller may read them. */
function versionForCaller(row: Record<string, unknown>, isAdmin: boolean): Record<string, unknown> {
  const snapshot = { ...((row['snapshot'] as Record<string, unknown> | null) ?? {}) };
  let changes = ((row['changes'] as FinanceTicketVersionChange[] | null) ?? []);
  if (!isAdmin) {
    delete snapshot['internal_note'];
    changes = changes.filter((c) => c.field !== 'internalNote');
  }
  return {
    ...rowToApi({ ...row, snapshot: undefined, changes: undefined }),
    changes,
    snapshot: rowToApi(snapshot),
  };
}

/** §12's notification payload — Query ID, subject, status, who, when. */
function queryNotice(row: Record<string, unknown>, by: string, extra?: string): string {
  const lines = [
    `Query ID: ${String(row['query_no'])}`,
    `Subject: ${String(row['subject'])}`,
    `Status: ${FINANCE_TICKET_STATUS_LABELS[row['status'] as FinanceTicketStatus] ?? String(row['status'])}`,
    `Updated by: ${by}`,
    `Date/time: ${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' })}`,
  ];
  if (extra?.trim()) lines.push('', extra.trim());
  return lines.join('\n');
}

/** Tell the raiser (never the actor themself). Best-effort, like every notify here. */
async function notifyRaiser(
  req: AuthRequest,
  row: Record<string, unknown>,
  type: 'finance_query_updated' | 'finance_query_resolved' | 'finance_query_amended',
  title: string,
  extra?: string,
): Promise<void> {
  const raisedBy = row['raised_by'] as string | null;
  if (!raisedBy || raisedBy === req.user!.uid) return;
  try {
    await notify({
      type,
      title,
      message: queryNotice(row, req.user!.email, extra),
      targetUserId: raisedBy,
      relatedId: row['id'] as string,
    });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Lookup — preview the record before raising the query (§13)
// ---------------------------------------------------------------------------

router.get('/lookup', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const ref = String(req.query['ref'] ?? '').trim();
    if (!ref) {
      res.status(400).json({ error: 'Reference number is required' });
      return;
    }
    res.json({ reference: await resolveReference(ref) });
  } catch (err) {
    if (err instanceof LookupError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The queue (§4, §18, §19)
// ---------------------------------------------------------------------------

router.get('/stats', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    // Scoped from the JWT, never from the query string — a raiser counts their
    // own queries, everyone who sees the whole queue counts all of it.
    const raisedBy = seesWholeQueue(req.user!.role) ? null : req.user!.uid;
    const { data, error } = await db.rpc('finance_ticket_stats', { p_raised_by: raisedBy });
    if (error) throw error;
    res.json({ stats: data ?? {} });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const isAdmin = financeHelpDeskCan(req.user!.role, 'respond');
    // The filter vocabulary is validated here rather than by `validate()`, which
    // reads the body: a bad status or a page of 0 is a 400 in words, not a
    // PostgREST error about a column.
    const parsed = FinanceTicketQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    const q = parsed.data;

    const FINANCE_TICKET_SORTABLE_COLUMNS: Record<NonNullable<typeof q.sortBy>, string> = {
      queryNo: 'query_no',
      raisedByName: 'raised_by_name',
      subject: 'subject',
      amount: 'amount',
      priority: 'priority',
      status: 'status',
      createdAt: 'created_at',
    };
    const sortCol = q.sortBy ? FINANCE_TICKET_SORTABLE_COLUMNS[q.sortBy] : 'created_at';
    const ascending = q.sortDir === 'asc';

    let query = db
      .from('finance_tickets')
      .select('*', { count: 'exact' })
      .order(sortCol, { ascending });

    // A stamped query is an ADMIN view and off by default even for them: the
    // queue is a list of work, and deleted rows are not work. `deletedOnly` is
    // the Deleted Queries screen (§8).
    if (isAdmin && q.deletedOnly) query = query.not('deleted_at', 'is', null);
    else if (!(isAdmin && q.includeDeleted)) query = withoutDeleted(query);

    // Scoping is decided by ROLE, never by a query parameter — a raiser cannot
    // widen their own view by asking for it, and every filter below only
    // narrows what this line already allowed. Another person's DRAFT is not on
    // anyone's desk yet, so the whole-queue view excludes it.
    if (!seesWholeQueue(req.user!.role)) query = query.eq('raised_by', req.user!.uid);
    else if (q.mine) query = query.eq('raised_by', req.user!.uid);
    else query = query.or(`status.neq.draft,raised_by.eq.${req.user!.uid}`);

    if (q.status !== 'all') query = query.eq('status', q.status);
    if (q.queryType !== 'all') query = query.eq('query_type', q.queryType);
    if (q.priority !== 'all') query = query.eq('priority', q.priority);
    if (q.raisedBy) query = query.eq('raised_by', q.raisedBy);
    if (q.branchId) query = query.eq('branch_id', q.branchId);
    if (q.queryNo) query = query.eq('query_no', q.queryNo.trim().toUpperCase());
    if (q.amountMin !== undefined) query = query.gte('amount', q.amountMin);
    if (q.amountMax !== undefined) query = query.lte('amount', q.amountMax);

    const referenceNo = String(q.referenceNo ?? '').trim().toUpperCase();
    if (referenceNo) query = query.eq('reference_no', referenceNo);

    if (q.from) query = query.gte('created_at', `${q.from}T00:00:00.000Z`);
    if (q.to) query = query.lte('created_at', `${q.to}T23:59:59.999Z`);

    // Free text across the handles a person actually remembers. PostgREST
    // `or` takes a comma-separated filter list; the term is escaped for the
    // commas and parentheses that would otherwise break out of it.
    const search = String(q.search ?? '').trim();
    if (search) {
      const term = search.replace(/[(),*]/g, ' ').trim();
      if (term) {
        query = query.or(
          [
            `query_no.ilike.*${term}*`,
            `ticket_no.ilike.*${term}*`,
            `reference_no.ilike.*${term}*`,
            `voucher_ref.ilike.*${term}*`,
            `transaction_ref.ilike.*${term}*`,
            `expense_ref.ilike.*${term}*`,
            `income_ref.ilike.*${term}*`,
            `subject.ilike.*${term}*`,
            `raised_by_name.ilike.*${term}*`,
            `branch_name.ilike.*${term}*`,
          ].join(','),
        );
      }
    }

    // §19 — one page, not the table. `count: 'exact'` above is what makes the
    // pager honest about how many pages there are.
    const fromRow = (q.page - 1) * q.pageSize;
    query = query.range(fromRow, fromRow + q.pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({
      tickets: (data ?? []).map((row) => ticketForCaller(row, isAdmin)),
      total: count ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// One query, in full — the View popup (§5)
// ---------------------------------------------------------------------------

/**
 * §7's View History — every version of the query, newest first. Lazy: read when
 * somebody opens the history, not with the query.
 */
router.get('/:id/history', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id as string);
    if (!ticket) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (!canSee(req, ticket)) {
      res.status(403).json({ error: 'Forbidden: that query was raised by someone else.' });
      return;
    }
    const isAdmin = financeHelpDeskCan(req.user!.role, 'respond');
    const { data, error } = await db
      .from('finance_ticket_versions')
      .select('*')
      .eq('ticket_id', ticket.id)
      .order('version', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ versions: (data ?? []).map((v) => versionForCaller(v, isAdmin)) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id as string);
    if (!ticket) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (!canSee(req, ticket)) {
      res.status(403).json({ error: 'Forbidden: that query was raised by someone else.' });
      return;
    }

    const isAdmin = financeHelpDeskCan(req.user!.role, 'respond');

    const [
      { data: messages, error: msgErr },
      { data: amendments, error: amdErr },
      ticketPhotos,
      auditTrail,
    ] = await Promise.all([
      db
        .from('finance_ticket_messages')
        .select('*')
        .eq('ticket_id', ticket.id)
        .order('created_at', { ascending: true }),
      db
        .from('finance_amendments')
        .select('*')
        .eq('ticket_id', ticket.id)
        .order('created_at', { ascending: false }),
      listAttachments('finance_ticket', ticket.id),
      // §14's Audit History. Built from the trail rather than from the two
      // lists above: those say what the query LOOKS LIKE now, and the history
      // has to say what it went through — including the edits that left no
      // trace on the current row.
      financeTicketAuditTrail(ticket.id as string, isAdmin),
    ]);
    if (msgErr) throw msgErr;
    if (amdErr) throw amdErr;

    // One query for every message's photos rather than one per message.
    const photosByMessage = await listAttachmentsFor(
      'finance_ticket_message',
      (messages ?? []).map((m) => m.id as string),
    );

    res.json({
      ticket: {
        ...ticketForCaller(ticket, isAdmin),
        attachments: ticketPhotos,
        messages: (messages ?? []).map((m) => ({
          ...rowToApi(m),
          attachments: photosByMessage.get(m.id as string) ?? [],
        })),
        // The correction history is what an admin acted on and what an auditor
        // checks. A raiser sees it too: §7 gives them the Admin response, and a
        // response of "corrected to Rs.45,000" is not readable without it.
        amendments: rowToApi(amendments ?? []),
        // §14. Every change this query has been through, oldest first, already
        // redacted for the caller — see financeTicketAuditTrail.
        auditTrail,
        // The record as it stands NOW, beside the snapshot of how it stood when
        // the query was raised. Admin-only: it is the working copy the Amend
        // dialog reads its current values from, and a raiser has no use for it.
        liveRecord: isAdmin
          ? await liveReference(
              ticket.reference_type as FinanceTicketReferenceType | null,
              ticket.reference_id as string | null,
            )
          : undefined,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Raise (§2, §3) — `create` covers Accountant, Finance Manager and Finance
// Admin, and excludes the Read Only Auditor, without this route naming roles.
// ---------------------------------------------------------------------------

router.post('/', requireFinance('create'), validate(CreateFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as CreateFinanceTicketInput;
    const { attachmentIds, draft } = body;

    let patch: Record<string, unknown>;
    try {
      patch = await feedToPatch(body);
      await deriveFromReference(patch);
    } catch (err) {
      if (err instanceof LookupError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }

    // A Finance user's own branch is the default when the form names none —
    // the query is about their book, and the Admin filters by branch.
    if (patch['branch_id'] === undefined && req.user!.branchId) {
      patch['branch_id'] = req.user!.branchId;
      patch['branch_name'] = req.user!.branchName;
    }

    const now = new Date().toISOString();
    const { data, error } = await db
      .from('finance_tickets')
      .insert({
        ...patch,
        status: draft ? 'draft' : 'open',
        submitted_at: draft ? null : now,
        raised_by: req.user!.uid,
        raised_by_name: req.user!.email,
        raised_by_role: req.user!.role,
      })
      .select('*')
      .single();
    if (error) throw error;

    if (attachmentIds?.length) {
      await bindAttachments({
        entity: 'finance_ticket',
        entityId: data.id,
        attachmentIds,
        actor: { uid: req.user!.uid },
      });
    }

    await recordFirstVersion(req, data, 'created', null);

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: data.id,
      entityRef: data.query_no,
      action: 'created',
      newValues: {
        queryType: data.query_type,
        priority: data.priority,
        referenceNo: data.reference_no,
        subject: data.subject,
        amount: data.amount,
        branchName: data.branch_name,
        businessDate: data.business_date,
        status: data.status,
      },
    });

    // §16. Straight to ADMIN — never to another Finance user, which is the whole
    // point of §3. A draft goes nowhere until it is submitted. Best-effort: a
    // notification that fails must not lose the query.
    if (!draft) {
      try {
        await notify({
          type: 'finance_query',
          title: `New Finance Query ${data.query_no}`,
          message: queryNotice(data, req.user!.email, `Priority: ${String(data.priority).toUpperCase()}`),
          targetRole: 'super_admin',
          relatedId: data.id,
        });
      } catch { /* notification failure must not fail query creation */ }
    }

    res.status(201).json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Drafts (§2) — the raiser's own, until submitted
// ---------------------------------------------------------------------------

/** The raiser edits their own draft. No reason needed: nobody else has read it. */
router.patch('/:id/draft', requireFinance('create'), validate(EditFinanceDraftSchema), async (req: AuthRequest, res, next) => {
  try {
    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (before['raised_by'] !== req.user!.uid) {
      res.status(403).json({ error: 'Forbidden: that draft belongs to someone else.' });
      return;
    }
    if (before['status'] !== 'draft') {
      res.status(409).json({
        error: `Query ${before['query_no']} has been submitted. Only an Admin can change it now — add a message instead.`,
      });
      return;
    }

    let patch: Record<string, unknown>;
    try {
      patch = onlyChanged(await feedToPatch(req.body), before);
    } catch (err) {
      if (err instanceof LookupError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }

    let row = before;
    if (Object.keys(patch).length) {
      const { data, error } = await db
        .from('finance_tickets')
        .update(patch)
        .eq('id', before.id)
        .eq('status', 'draft')
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(409).json({ error: 'That draft changed while you were editing it.' });
        return;
      }
      row = await recordVersion(req, before, data, 'edited', null);
    }

    if (req.body.attachmentIds?.length) {
      await bindAttachments({
        entity: 'finance_ticket',
        entityId: row.id as string,
        attachmentIds: req.body.attachmentIds,
        actor: { uid: req.user!.uid },
      });
    }

    res.json({ ticket: rowToApi(row) });
  } catch (err) {
    next(err);
  }
});

/**
 * Submit a draft — DRAFT → PENDING. This is the moment the Admin is told.
 * The status route does not offer this move; a submission stamps
 * `submitted_at` and notifies, and a bare status change would do neither.
 */
router.post('/:id/submit', requireFinance('create'), async (req: AuthRequest, res, next) => {
  try {
    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (before['raised_by'] !== req.user!.uid) {
      res.status(403).json({ error: 'Forbidden: that draft belongs to someone else.' });
      return;
    }
    if (before['status'] !== 'draft') {
      res.status(409).json({ error: `Query ${before['query_no']} has already been submitted.` });
      return;
    }
    if (String(before['subject'] ?? '').trim().length < 3 || String(before['message'] ?? '').trim().length < 3) {
      res.status(400).json({ error: 'Give the query a subject and a description before submitting it.' });
      return;
    }

    const { data, error } = await db
      .from('finance_tickets')
      .update({ status: 'open', submitted_at: new Date().toISOString() })
      .eq('id', before.id)
      .eq('status', 'draft')
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(409).json({ error: 'That draft changed while you were submitting it.' });
      return;
    }

    const row = await recordVersion(req, before, data, 'submitted', null);

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: row.id as string,
      entityRef: row.query_no as string,
      action: 'submitted',
      previousValues: { status: 'draft' },
      newValues: { status: 'open' },
    });

    try {
      await notify({
        type: 'finance_query',
        title: `New Finance Query ${row.query_no}`,
        message: queryNotice(row, req.user!.email, `Priority: ${String(row.priority).toUpperCase()}`),
        targetRole: 'super_admin',
        relatedId: row.id as string,
      });
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Conversation (§17) — BOTH sides, which is why it is not admin-gated.
// ---------------------------------------------------------------------------

router.post(
  '/:id/messages',
  // NOT requireFinance('create') — that gate grants a super admin nothing but
  // `view` unless `allowSuperAdminWrite` is on, and it ships off, so an Admin
  // could read a query and not answer it. See the middleware's own header.
  requireFinanceHelpDeskParticipant(),
  validate(FinanceTicketMessageSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const ticket = await getTicket(req.params.id as string);
      if (!ticket) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      if (!canSee(req, ticket)) {
        res.status(403).json({ error: 'Forbidden: that query was raised by someone else.' });
        return;
      }
      if (ticket['deleted_at']) {
        res.status(409).json({ error: `Query ${ticket['query_no']} has been deleted.` });
        return;
      }
      if (ticket['status'] === 'draft') {
        res.status(409).json({ error: `Query ${ticket['query_no']} is a draft. Submit it first.` });
        return;
      }
      if (ticket['status'] === 'closed') {
        res.status(409).json({
          error: `Query ${ticket['query_no']} is closed. Raise a new query for anything further.`,
        });
        return;
      }

      const side = sideOf(req.user!.role);

      const { data, error } = await db
        .from('finance_ticket_messages')
        .insert({
          ticket_id: ticket.id,
          author_id: req.user!.uid,
          author_name: req.user!.email,
          author_role: req.user!.role,
          author_side: side,
          body: req.body.body,
        })
        .select('*')
        .single();
      if (error) throw error;

      if (req.body.attachmentIds?.length) {
        await bindAttachments({
          entity: 'finance_ticket_message',
          entityId: data.id,
          attachmentIds: req.body.attachmentIds,
          actor: { uid: req.user!.uid },
        });
      }

      // §7's "Mark information as received": the raiser answering a
      // WAITING_FOR_FINANCE query is the act itself, not a separate button to
      // remember to press. The status goes back to the admin's court.
      if (side === 'finance' && ticket['status'] === 'waiting_for_finance') {
        const { data: moved, error: moveErr } = await db
          .from('finance_tickets')
          .update({ status: 'under_review', information_received_at: new Date().toISOString() })
          .eq('id', ticket.id)
          .eq('status', 'waiting_for_finance')
          .select('*')
          .maybeSingle();
        if (moveErr) throw moveErr;
        // The status moved, so it is a version — but a version that cannot be
        // written must not lose the message that was already posted.
        if (moved) {
          try {
            await recordVersion(req, ticket, moved, 'status_changed', 'Information received from Finance');
          } catch (err) {
            console.error('[finance-tickets] could not version the information-received move', err);
          }
        }
      }

      try {
        if (side === 'finance') {
          await notify({
            type: 'finance_query_message',
            title: `Reply on ${ticket['query_no']}`,
            message: `${req.user!.email}: ${String(req.body.body).slice(0, 140)}`,
            targetRole: 'super_admin',
            relatedId: ticket.id as string,
          });
        } else if (ticket['raised_by']) {
          await notify({
            type: 'finance_query_message',
            title: `Admin replied on ${ticket['query_no']}`,
            message: String(req.body.body).slice(0, 140),
            targetUserId: ticket['raised_by'] as string,
            relatedId: ticket.id as string,
          });
        }
      } catch { /* best-effort */ }

      res.status(201).json({ message: rowToApi(data) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Administer — ADMIN ONLY, from here down (§6, §14, §21)
// ---------------------------------------------------------------------------

router.patch('/:id', requireFinanceHelpDeskAdmin(), validate(EditFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    // A deleted query is a record, not a working row. Editing one would produce
    // an audit entry describing a change to something the desk considers gone.
    if (before['deleted_at']) {
      res.status(409).json({ error: `Query ${before['query_no']} has been deleted. Restore it first.` });
      return;
    }
    if (before['status'] === 'draft') {
      res.status(409).json({ error: `Query ${before['query_no']} is still a draft with its raiser.` });
      return;
    }

    let patch: Record<string, unknown>;
    try {
      patch = await feedToPatch(req.body);
    } catch (err) {
      if (err instanceof LookupError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (req.body.resolutionNote !== undefined) patch['resolution_note'] = req.body.resolutionNote;
    if (req.body.internalNote !== undefined) patch['internal_note'] = req.body.internalNote;
    patch = onlyChanged(patch, before);

    if (!Object.keys(patch).length) {
      res.json({ ticket: rowToApi(before), unchanged: true });
      return;
    }

    // §8: a change the RAISER will see needs a stated reason, and the reason is
    // what the audit row is worth reading for. An edit that only touches the
    // admin's own internal note changes nothing the raiser sees, so it does not.
    const touchesRaiserVisible = Object.keys(patch).some((k) => k !== 'internal_note');
    const reason = String(req.body.reason ?? '').trim();
    if (touchesRaiserVisible && !reason) {
      res.status(400).json({
        error:
          `Editing ${before['query_no']} needs a reason. It is kept with the previous values in ` +
          'the version history, and it is how the next reader knows why the query changed.',
      });
      return;
    }

    const { data, error } = await db
      .from('finance_tickets')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    // §7: every modification is a version. The diff is computed from the rows,
    // so the version says exactly what moved and nothing that did not.
    const row = await recordVersion(req, before, data, 'edited', reason || null);

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: row.id as string,
      entityRef: row.query_no as string,
      action: 'updated',
      previousValues: previousOf(patch, before),
      newValues: { ...patch, version: row.version, ...(reason ? { reason } : {}) },
    });

    // The raiser is told their query was changed under them. Silently editing
    // someone's report and leaving them to notice is exactly the "data loss"
    // §19 is about, even when every previous value is safe in the history.
    if (touchesRaiserVisible) {
      await notifyRaiser(req, row, 'finance_query_updated', `Query ${row.query_no} — updated by Admin`, `Reason: ${reason}`);
    }

    res.json({ ticket: rowToApi(row) });
  } catch (err) {
    next(err);
  }
});

/**
 * §6 — Amend the query. Same feed as Edit, but:
 *   · the reason is required whether or not a raiser-visible field moved,
 *   · the status becomes AMENDED (from any live status), and
 *   · a version is written even when only the note changed, because an
 *     amendment is an act on the record and the record should say so.
 * The record behind the query is untouched (§17); that is POST /:id/amend.
 */
router.post('/:id/amend-query', requireFinanceHelpDeskAdmin(), validate(AmendFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (before['deleted_at']) {
      res.status(409).json({ error: `Query ${before['query_no']} has been deleted. Restore it first.` });
      return;
    }
    const from = before['status'] as FinanceTicketStatus;
    if (from === 'draft') {
      res.status(409).json({ error: `Query ${before['query_no']} is still a draft with its raiser.` });
      return;
    }
    if (isFinanceTicketTerminal(from)) {
      res.status(409).json({
        error:
          `Query ${before['query_no']} is ${FINANCE_TICKET_STATUS_LABELS[from]}. Reopen it to amend it — ` +
          'the resolution it was given is kept in the history either way.',
      });
      return;
    }

    let patch: Record<string, unknown>;
    try {
      patch = await feedToPatch(req.body);
    } catch (err) {
      if (err instanceof LookupError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (req.body.internalNote !== undefined) patch['internal_note'] = req.body.internalNote;
    patch = onlyChanged(patch, before);

    const reason = String(req.body.reason).trim();
    const now = new Date().toISOString();

    const { data, error } = await db
      .from('finance_tickets')
      .update({
        ...patch,
        status: 'amended',
        amend_count: Number(before['amend_count'] ?? 0) + 1,
        amended_at: now,
        amended_by: req.user!.uid,
        amended_by_name: req.user!.email,
      })
      .eq('id', before.id)
      .eq('status', from)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(409).json({ error: 'Someone else moved this query while you were working on it.' });
      return;
    }

    const row = await recordVersion(req, before, data, 'amended', reason);

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: row.id as string,
      entityRef: row.query_no as string,
      action: 'amended',
      previousValues: { ...previousOf(patch, before), status: from },
      newValues: { ...patch, status: 'amended', version: row.version, reason },
    });

    await notifyRaiser(req, row, 'finance_query_amended', `Query ${row.query_no} — Amended by Admin`, `Reason: ${reason}`);

    res.json({ ticket: rowToApi(row) });
  } catch (err) {
    next(err);
  }
});

/**
 * §11 — the Admin Response block, written without moving the status. Resolving
 * still goes through PATCH /:id/status (it needs the resolution type); this is
 * for answering, stating a corrected figure, or noting something while the
 * query stays live.
 */
router.post('/:id/response', requireFinanceHelpDeskAdmin(), validate(FinanceTicketResponseSchema), async (req: AuthRequest, res, next) => {
  try {
    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (before['deleted_at']) {
      res.status(409).json({ error: `Query ${before['query_no']} has been deleted. Restore it first.` });
      return;
    }
    if (before['status'] === 'draft') {
      res.status(409).json({ error: `Query ${before['query_no']} is still a draft with its raiser.` });
      return;
    }

    const b = req.body as {
      adminResponse?: string; resolutionNote?: string; resolutionAmount?: number | null;
      remarks?: string; internalNote?: string;
    };
    let patch: Record<string, unknown> = {};
    if (b.adminResponse !== undefined) patch['admin_response'] = b.adminResponse || null;
    if (b.resolutionNote !== undefined) patch['resolution_note'] = b.resolutionNote || null;
    if (b.resolutionAmount !== undefined) patch['resolution_amount'] = b.resolutionAmount;
    if (b.remarks !== undefined) patch['remarks'] = b.remarks || null;
    if (b.internalNote !== undefined) patch['internal_note'] = b.internalNote || null;
    patch = onlyChanged(patch, before);

    if (!Object.keys(patch).length) {
      res.json({ ticket: rowToApi(before), unchanged: true });
      return;
    }
    if ('admin_response' in patch) {
      patch['responded_by'] = req.user!.uid;
      patch['responded_by_name'] = req.user!.email;
      patch['responded_at'] = new Date().toISOString();
    }

    const { data, error } = await db
      .from('finance_tickets')
      .update(patch)
      .eq('id', before.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }

    const row = await recordVersion(req, before, data, 'responded', null);

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: row.id as string,
      entityRef: row.query_no as string,
      action: 'updated',
      previousValues: previousOf(patch, before),
      newValues: { ...patch, version: row.version },
    });

    // The raiser reads the response, the resolution and the figure — not the
    // internal note, which never leaves the admin side.
    const raiserVisible = Object.keys(patch).some((k) => k !== 'internal_note');
    if (raiserVisible) {
      await notifyRaiser(
        req,
        row,
        'finance_query_updated',
        `Query ${row.query_no} — Admin response`,
        typeof b.adminResponse === 'string' ? b.adminResponse : undefined,
      );
    }

    res.json({ ticket: rowToApi(row) });
  } catch (err) {
    next(err);
  }
});

/** §8 — bring a deleted query back. The delete stamp is kept in the history. */
router.post('/:id/restore', requireFinanceHelpDeskAdmin(), validate(RestoreFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const before = await getTicket(req.params.id as string);
    if (!before) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (!before['deleted_at']) {
      res.status(409).json({ error: `Query ${before['query_no']} is not deleted.` });
      return;
    }
    const reason = String(req.body.reason).trim();

    const { data, error } = await db
      .from('finance_tickets')
      .update({
        deleted_at: null,
        deleted_by: null,
        deleted_by_name: null,
        delete_reason: null,
        restored_at: new Date().toISOString(),
        restored_by: req.user!.uid,
        restored_by_name: req.user!.email,
        restore_reason: reason,
      })
      .eq('id', before.id)
      .not('deleted_at', 'is', null)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(409).json({ error: 'Someone else restored this query already.' });
      return;
    }

    const row = await recordVersion(req, before, data, 'restored', reason, [
      { field: 'deleted', label: 'Deleted', old: 'Yes', new: null },
    ]);

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: row.id as string,
      entityRef: row.query_no as string,
      action: 'restored',
      previousValues: { softDeleted: true, deleteReason: before['delete_reason'] },
      newValues: { softDeleted: false, reason, version: row.version },
    });

    await notifyRaiser(req, row, 'finance_query_updated', `Query ${row.query_no} — Restored`, `Reason: ${reason}`);

    res.json({ ticket: rowToApi(row) });
  } catch (err) {
    next(err);
  }
});

/**
 * §9 — Recreate. A NEW query under a NEW Query ID, copied from this one with
 * the overrides in the body applied on top, each row pointing at the other.
 * The old query is left exactly as it is (its status, its resolution, its
 * history) — recreating is not deleting, and the Admin may still delete or
 * close the old one afterwards if that is what they mean.
 *
 * The raiser of the new query is the ORIGINAL raiser, not the admin: it is
 * their report, corrected, and they must be able to see and discuss it.
 */
router.post('/:id/recreate', requireFinanceHelpDeskAdmin(), validate(RecreateFinanceTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const source = await getTicket(req.params.id as string);
    if (!source) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (source['status'] === 'draft') {
      res.status(409).json({ error: `Query ${source['query_no']} is still a draft with its raiser.` });
      return;
    }
    if (source['recreated_as_id']) {
      res.status(409).json({
        error: `Query ${source['query_no']} has already been recreated as ${source['recreated_as_query_no']}.`,
      });
      return;
    }

    let overrides: Record<string, unknown>;
    try {
      overrides = await feedToPatch(req.body);
    } catch (err) {
      if (err instanceof LookupError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    const reason = String(req.body.reason).trim();
    const now = new Date().toISOString();

    const { data: created, error: insErr } = await db
      .from('finance_tickets')
      .insert({
        // Copied: what the query SAYS.
        query_type: source['query_type'],
        priority: source['priority'],
        reference_type: source['reference_type'],
        reference_id: source['reference_id'],
        reference_no: source['reference_no'],
        reference_snapshot: source['reference_snapshot'],
        voucher_ref: source['voucher_ref'],
        transaction_ref: source['transaction_ref'],
        expense_ref: source['expense_ref'],
        income_ref: source['income_ref'],
        subject: source['subject'],
        message: source['message'],
        amount: source['amount'],
        branch_id: source['branch_id'],
        branch_name: source['branch_name'],
        business_date: source['business_date'],
        remarks: source['remarks'],
        raised_by: source['raised_by'],
        raised_by_name: source['raised_by_name'],
        raised_by_role: source['raised_by_role'],
        // Then the Admin's corrections.
        ...overrides,
        // Not copied: the status, the answer, the assignment, the history.
        // A recreated query starts its own life on the desk.
        status: 'open',
        submitted_at: now,
        recreated_from_id: source['id'],
        recreated_from_query_no: source['query_no'],
        internal_note: source['internal_note'],
      })
      .select('*')
      .single();
    if (insErr) throw insErr;

    // The old query points forward. Its own version says it was recreated.
    const { data: updatedSource, error: srcErr } = await db
      .from('finance_tickets')
      .update({ recreated_as_id: created.id, recreated_as_query_no: created.query_no })
      .eq('id', source.id)
      .select('*')
      .maybeSingle();
    if (srcErr) throw srcErr;

    if (req.body.copyAttachments !== false) {
      const photos = await listAttachments('finance_ticket', source.id as string);
      if (photos.length) {
        try {
          await bindAttachments({
            entity: 'finance_ticket',
            entityId: created.id,
            attachmentIds: photos.map((a) => a.id),
            actor: { uid: req.user!.uid },
          });
        } catch { /* an attachment that cannot be re-bound must not lose the query */ }
      }
    }

    await recordFirstVersion(req, created, 'recreated', `Recreated from ${source['query_no']}: ${reason}`);
    if (updatedSource) {
      await recordVersion(req, source, updatedSource, 'recreated', reason, [
        { field: 'recreatedAsQueryNo', label: 'Recreated as', old: null, new: String(created.query_no) },
      ]);
    }

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: created.id,
      entityRef: created.query_no,
      action: 'recreated',
      newValues: { recreatedFromQueryNo: source['query_no'], reason, ...overrides },
    });
    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: source.id as string,
      entityRef: source['query_no'] as string,
      action: 'recreated',
      newValues: { recreatedAsQueryNo: created.query_no, reason },
    });

    await notifyRaiser(
      req,
      created,
      'finance_query_updated',
      `Query ${source['query_no']} recreated as ${created.query_no}`,
      `Reason: ${reason}`,
    );

    res.status(201).json({ ticket: rowToApi(created), source: updatedSource ? rowToApi(updatedSource) : null });
  } catch (err) {
    next(err);
  }
});

/** §14's Assign / take. Null unassigns, which is what the "Unassigned" card counts. */
router.patch(
  '/:id/assign',
  requireFinanceHelpDeskAdmin(),
  validate(AssignFinanceTicketSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const assignedTo: string | null = req.body.assignedTo;

      const before = await getTicket(req.params.id as string);
      if (!before) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      if (before['deleted_at'] || before['status'] === 'draft') {
        res.status(409).json({ error: `Query ${before['query_no']} is not on the desk.` });
        return;
      }

      let assignedName: string | null = null;
      if (assignedTo) {
        const { data: user, error: userErr } = await db
          .from('users')
          .select('id, name, email, role')
          .eq('id', assignedTo)
          .maybeSingle();
        if (userErr) throw userErr;
        if (!user) {
          res.status(404).json({ error: 'That user does not exist.' });
          return;
        }
        // A query can only be assigned to somebody who is allowed to act on it —
        // assigning it to a Finance user would produce a queue entry nobody can
        // clear, and §3 says the query does not go to a Finance user at all.
        if (!financeHelpDeskCan(user.role as string, 'respond')) {
          res.status(400).json({
            error: `${user.name ?? user.email} is not an Admin and cannot action a Help Desk query.`,
          });
          return;
        }
        assignedName = (user.name as string) || (user.email as string);
      }

      const { data, error } = await db
        .from('finance_tickets')
        .update({
          assigned_to: assignedTo,
          assigned_to_name: assignedName,
          assigned_at: assignedTo ? new Date().toISOString() : null,
        })
        .eq('id', req.params.id)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }

      const row = await recordVersion(req, before, data, 'assigned', null);

      await logFinanceAudit(req, {
        entity: 'finance_ticket',
        entityId: row.id as string,
        entityRef: row.query_no as string,
        action: 'updated',
        newValues: { assignedTo, assignedToName: assignedName },
      });

      res.json({ ticket: rowToApi(row) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * §8's workflow, as one route.
 *
 *     OPEN → UNDER REVIEW → (investigate, correct if required) → RESOLVED
 *
 * The move is checked against FINANCE_TICKET_TRANSITIONS rather than accepted as
 * sent: a query that jumps from `open` straight to `closed` skips the record
 * that anybody looked at it, and the workflow's value is that the queue can be
 * read at a glance.
 */
router.patch(
  '/:id/status',
  requireFinanceHelpDeskAdmin(),
  validate(FinanceTicketStatusSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { status, adminResponse, resolutionNote, resolutionType, resolutionAmount } = req.body as {
        status: FinanceTicketStatus;
        adminResponse?: string;
        resolutionNote?: string;
        resolutionType?: FinanceResolutionType;
        resolutionAmount?: number | null;
      };

      const before = await getTicket(req.params.id as string);
      if (!before) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      if (before['deleted_at']) {
        res.status(409).json({ error: `Query ${before['query_no']} has been deleted.` });
        return;
      }

      const from = before['status'] as FinanceTicketStatus;
      if (from === status) {
        res.status(409).json({ error: `Query ${before['query_no']} is already ${FINANCE_TICKET_STATUS_LABELS[status]}.` });
        return;
      }
      if (!FINANCE_TICKET_TRANSITIONS[from].includes(status)) {
        const allowed = FINANCE_TICKET_TRANSITIONS[from].map((s) => FINANCE_TICKET_STATUS_LABELS[s]);
        res.status(409).json({
          error: allowed.length
            ? `A ${FINANCE_TICKET_STATUS_LABELS[from]} query can only move to: ${allowed.join(', ')}.`
            : `Query ${before['query_no']} is ${FINANCE_TICKET_STATUS_LABELS[from]} and cannot change again. ` +
              'Raise a new query for anything further.',
        });
        return;
      }

      // §8: ending a query says why it ended. Enforced here rather than in the
      // schema because the requirement depends on the TARGET status, which the
      // schema can see, and on the note already on the row, which it cannot.
      const note = resolutionNote ?? (before['resolution_note'] as string | null) ?? '';
      if (isFinanceTicketTerminal(status) && status !== 'closed' && !note.trim() && !adminResponse?.trim()) {
        res.status(400).json({
          error:
            `Resolving or rejecting ${before['query_no']} needs a note saying what was done, ` +
            'or why this is not an error. It is what the raiser sees.',
        });
        return;
      }

      // §11's Resolution Type. Required when a query is RESOLVED or REJECTED,
      // optional on `closed` — closing is filing a query that was already
      // answered, and demanding the type again would ask the admin to restate a
      // decision the resolution already recorded.
      if (isFinanceTicketTerminal(status) && status !== 'closed' && !resolutionType
          && !before['resolution_type']) {
        res.status(400).json({
          error:
            `Say what kind of resolution this is — Fixed, Information Provided, Rejected, ` +
            `Duplicate or Other. It is what ${before['query_no']} is counted as in reports.`,
        });
        return;
      }

      const patch: Record<string, unknown> = { status };
      if (resolutionType !== undefined) patch['resolution_type'] = resolutionType;
      if (resolutionAmount !== undefined) patch['resolution_amount'] = resolutionAmount;
      if (adminResponse !== undefined) {
        patch['admin_response'] = adminResponse;
        patch['responded_by'] = req.user!.uid;
        patch['responded_by_name'] = req.user!.email;
        patch['responded_at'] = new Date().toISOString();
      }
      if (resolutionNote !== undefined) patch['resolution_note'] = resolutionNote;
      if (isFinanceTicketTerminal(status)) {
        patch['resolved_by'] = req.user!.uid;
        patch['resolved_by_name'] = req.user!.email;
        patch['resolved_at'] = new Date().toISOString();
      }

      const { data, error } = await db
        .from('finance_tickets')
        .update(patch)
        .eq('id', req.params.id)
        // Optimistic guard: two admins resolving the same query at once must not
        // both succeed and overwrite each other's closing record.
        .eq('status', from)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(409).json({ error: 'Someone else moved this query while you were working on it.' });
        return;
      }

      const row = await recordVersion(
        req,
        before,
        data,
        isFinanceTicketTerminal(status) ? 'resolved' : 'status_changed',
        null,
      );

      await logFinanceAudit(req, {
        entity: 'finance_ticket',
        entityId: row.id as string,
        entityRef: row.query_no as string,
        action: status === 'rejected' ? 'rejected' : status === 'resolved' ? 'resolved' : 'updated',
        previousValues: { status: from },
        newValues: { status, adminResponse, resolutionNote, resolutionType, resolutionAmount, version: row.version },
      });

      // Sent to the raiser even when the Admin is answering their own query —
      // there is no "self" on a status change the queue reads.
      try {
        if (row.raised_by) {
          await notify({
            type: isFinanceTicketTerminal(status) ? 'finance_query_resolved' : 'finance_query_updated',
            title: `Query ${row.query_no} — ${FINANCE_TICKET_STATUS_LABELS[status]}`,
            message: queryNotice(row, req.user!.email, adminResponse || resolutionNote || undefined),
            targetUserId: row.raised_by as string,
            relatedId: row.id as string,
          });
        }
      } catch { /* best-effort */ }

      res.json({ ticket: rowToApi(row) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * §12 — a resolution is disputed, and the query goes live again.
 *
 *     RESOLVED  →  REOPENED  →  UNDER_REVIEW
 *
 * ONE ROUTE, TWO OUTCOMES, decided from the JWT and not from the payload:
 *
 *   · An Admin REOPENS the query. The resolution being overturned is archived
 *     onto `resolution_history` in the same UPDATE that clears it, so there is
 *     no instant at which the query has neither the old answer nor a record of
 *     it, and no way for a failure between two writes to lose one.
 *   · The Finance RAISER records a REQUEST to reopen. §12 says either side may
 *     ask "depending on permissions", and a Finance user's permission is to ask:
 *     the request is posted as a message on the thread — where it is
 *     append-only and the admin's reply sits beside it — and the admin is
 *     notified. The status does not move, which is the whole difference.
 *
 * Anyone else who reaches here is a Finance user looking at somebody else's
 * query, and `canSee` has already turned them away.
 *
 * WHY NOT PATCH /:id/status WITH status='reopened'. Because reopening is the one
 * transition that must UNDO a previous write rather than follow it, and the undo
 * has a precondition — archive first — that no other transition has. Expressed
 * as a row in FINANCE_TICKET_TRANSITIONS it would be a branch every other
 * transition skips, and the archive step would be one `if` away from being
 * forgotten by the next person who adds a status.
 */
router.post(
  '/:id/reopen',
  requireFinanceHelpDeskParticipant(),
  validate(ReopenFinanceTicketSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const reason = String(req.body.reason).trim();

      const before = await getTicket(req.params.id as string);
      if (!before) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      if (!canSee(req, before)) {
        res.status(403).json({ error: 'Forbidden: that query was raised by someone else.' });
        return;
      }
      if (before['deleted_at']) {
        res.status(409).json({ error: `Query ${before['query_no']} has been deleted.` });
        return;
      }

      const from = before['status'] as FinanceTicketStatus;
      if (!FINANCE_TICKET_REOPENABLE.includes(from)) {
        res.status(409).json({
          error:
            `Query ${before['query_no']} is ${FINANCE_TICKET_STATUS_LABELS[from]} and is already ` +
            'open. Only a resolved, rejected or closed query can be reopened.',
        });
        return;
      }

      const isAdmin = financeHelpDeskCan(req.user!.role, 'respond');

      // ---- The raiser's side: a request, not a reopening ----
      if (!isAdmin) {
        const { data: message, error: msgErr } = await db
          .from('finance_ticket_messages')
          .insert({
            ticket_id: before['id'],
            author_id: req.user!.uid,
            author_name: req.user!.email,
            author_role: req.user!.role,
            author_side: 'finance',
            body: `Requested to reopen this query.\n\nReason: ${reason}`,
          })
          .select('*')
          .single();
        if (msgErr) throw msgErr;

        await logFinanceAudit(req, {
          entity: 'finance_ticket',
          entityId: before['id'] as string,
          entityRef: before['query_no'] as string,
          action: 'reopen_requested',
          previousValues: { status: from },
          newValues: { reason },
        });

        try {
          await notify({
            type: 'finance_query',
            title: `Reopen requested — ${before['query_no']}`,
            message: `${req.user!.email} disputes the resolution.\n\nReason: ${reason}`,
            targetRole: 'super_admin',
            relatedId: before['id'] as string,
          });
        } catch { /* best-effort */ }

        // 202, not 200: the request was accepted and nothing has changed yet.
        // A 200 with an unchanged ticket would read to the client as "reopened"
        // and to the raiser as a status that refused to update.
        res.status(202).json({
          requested: true,
          ticket: ticketForCaller(before, false),
          message: rowToApi(message),
        });
        return;
      }

      // ---- The admin's side: the reopening itself ----
      //
      // The answer being overturned is preserved verbatim, including its
      // resolution type and who gave it, and stamped with who overturned it and
      // why. Reopening three times leaves three of these, oldest first.
      const archived: FinanceTicketResolution = {
        status: from,
        resolutionType: (before['resolution_type'] as FinanceResolutionType | null) ?? null,
        resolutionNote: (before['resolution_note'] as string | null) ?? null,
        adminResponse: (before['admin_response'] as string | null) ?? null,
        resolvedBy: (before['resolved_by'] as string | null) ?? null,
        resolvedByName: (before['resolved_by_name'] as string | null) ?? null,
        resolvedAt: (before['resolved_at'] as string | null) ?? null,
        reopenedAt: new Date().toISOString(),
        reopenedByName: req.user!.email,
        reopenReason: reason,
      };
      const history = [
        ...((before['resolution_history'] as FinanceTicketResolution[] | null) ?? []),
        archived,
      ];

      const { data, error } = await db
        .from('finance_tickets')
        .update({
          status: 'reopened',
          resolution_history: history,
          reopen_count: history.length,
          reopened_at: archived.reopenedAt,
          reopened_by: req.user!.uid,
          reopened_by_name: req.user!.email,
          reopen_reason: reason,
          // Cleared because `finance_tickets_resolution_check` forbids a live
          // query from carrying a resolver — and because the query genuinely no
          // longer has a current answer. Both are safe to clear only because
          // `history` above already holds them, in this same statement.
          resolved_by: null,
          resolved_by_name: null,
          resolved_at: null,
          resolution_note: null,
          resolution_type: null,
        })
        .eq('id', req.params.id)
        // Same optimistic guard as the status route: two admins reopening at
        // once must not both archive, or the history grows a duplicate entry
        // for a resolution that was only overturned once.
        .eq('status', from)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(409).json({ error: 'Someone else moved this query while you were working on it.' });
        return;
      }

      const row = await recordVersion(req, before, data, 'reopened', reason);

      await logFinanceAudit(req, {
        entity: 'finance_ticket',
        entityId: row.id as string,
        entityRef: row.query_no as string,
        action: 'reopened',
        previousValues: {
          status: from,
          resolutionType: archived.resolutionType,
          resolutionNote: archived.resolutionNote,
          resolvedByName: archived.resolvedByName,
          resolvedAt: archived.resolvedAt,
        },
        newValues: { status: 'reopened', reason, reopenCount: history.length },
      });

      await notifyRaiser(req, row, 'finance_query_updated', `Query ${row.query_no} — Reopened`, `Reason: ${reason}`);

      res.json({ ticket: rowToApi(row) });
    } catch (err) {
      next(err);
    }
  },
);
// ---------------------------------------------------------------------------
// Changing the BOOKS (§9, §11, §12) — the reason this module has a Help Desk
// ---------------------------------------------------------------------------

/**
 * Write the amendment record for a change that has already happened.
 *
 * Called AFTER the database has done the work, never before, and from the
 * database's own report of what it did rather than from the request that asked
 * for it. The difference matters: `amend_finance_record` recomputes derived
 * columns and re-posts vouchers, so "what the admin typed" and "what changed"
 * are not the same thing, and the second is the one an auditor needs.
 *
 * `finance_amendments` is append-only and its `ticket_id` is ON DELETE RESTRICT,
 * so this row is the thing that makes §21 true — every correction to the books
 * is permanently tied to the query that justified it.
 */
async function recordAmendment(
  req: AuthRequest,
  ticket: Record<string, unknown>,
  action: FinanceAmendmentAction,
  applied: {
    referenceType: string;
    referenceNo: string;
    field: string;
    originalValue: string | null;
    newValue: string | null;
    difference: number | null;
  },
  reason: string,
): Promise<void> {
  const { ipAddress } = requestFingerprint(req);
  const { error } = await db.from('finance_amendments').insert({
    ticket_id: ticket['id'],
    query_no: ticket['query_no'],
    reference_type: applied.referenceType,
    reference_id: ticket['reference_id'],
    reference_no: applied.referenceNo,
    action,
    field: applied.field,
    original_value: applied.originalValue,
    new_value: applied.newValue,
    difference: applied.difference,
    reason,
    admin_id: req.user!.uid,
    admin_name: req.user!.email,
    ip_address: ipAddress,
  });
  // Unlike the audit trail, this one THROWS. The trail is forensic context and
  // must never roll back a change that already moved money; this row is the
  // justification the brief requires the change to carry, and a correction that
  // silently loses it is exactly what §21 exists to prevent. It is written
  // immediately after the change, so the window in which one can exist without
  // the other is a single statement wide.
  if (error) throw error;
}

/**
 * §14's Edit / Amend / Overwrite, as one route.
 *
 * The three verbs differ in what the UI demands before calling — an overwrite of
 * an approved record needs §11's confirmation, which `AmendFinanceRecordSchema`
 * requires to reach the server rather than being a dialog the API cannot see —
 * and in what gets recorded. They do NOT differ in what happens to the row,
 * which is why they share `amend_finance_record()`: three code paths would drift
 * into three subtly different definitions of "corrected".
 *
 * What a Finance user cannot do here is the whole point, and it is enforced by
 * `requireFinanceHelpDeskAdmin()` on the line below, not by the button being
 * hidden.
 */
router.post(
  '/:id/amend',
  requireFinanceHelpDeskAdmin(),
  validate(AmendFinanceRecordSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { action, field, newValue, reason } = req.body as {
        action: FinanceAmendmentAction;
        field: string;
        newValue: string;
        reason: string;
      };

      const ticket = await getTicket(req.params.id as string);
      if (!ticket) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      const referenceType = ticket['reference_type'] as FinanceTicketReferenceType | null;
      if (!referenceType || !ticket['reference_id']) {
        res.status(409).json({
          error:
            `Query ${ticket['query_no']} names no finance record, so there is nothing to change. ` +
            'Answer it with a response, or ask the raiser for the reference.',
        });
        return;
      }

      // The field whitelist, checked here as well as in the function. The
      // function is the boundary; this is the message — it names the fields that
      // WOULD work, which a generic 400 out of Postgres cannot.
      const allowed = FINANCE_AMENDABLE_FIELDS[referenceType] ?? [];
      const spec = allowed.find((f) => f.key === field);
      if (!spec) {
        res.status(400).json({
          error: allowed.length
            ? `"${field}" cannot be changed on this record. Try: ${allowed.map((f) => f.key).join(', ')}.`
            : informationalReferenceMessage(referenceType, ticket['reference_no']),
        });
        return;
      }

      const { data: applied, error } = await db.rpc('amend_finance_record', {
        p_reference_type: referenceType,
        p_reference_id: ticket['reference_id'],
        p_field: field,
        p_new_value: newValue,
        p_reason: reason,
        p_actor_id: req.user!.uid,
        p_actor_name: req.user!.email,
        // The reversal and its correction are posted to TODAY, not to the
        // original entry's date: post_finance_ledger_entry refuses a closed day,
        // and the day a wrong voucher was posted is usually closed by the time
        // anybody notices it was wrong.
        p_entry_date: businessDateStr(),
      });
      if (error) throw asAmendError(error);

      const result = applied as {
        referenceType: string;
        referenceNo: string;
        field: string;
        originalValue: string | null;
        newValue: string | null;
        difference: number | null;
        ledger?: { ledgerAmended?: boolean; reversalVoucherNo?: string; correctedVoucherNo?: string };
      };

      await recordAmendment(req, ticket, action, result, reason);

      await logFinanceAudit(req, {
        // Every FinanceTicketReferenceType is also a FinanceAuditEntity, so the
        // trail names the record's own kind rather than flattening it.
        entity: referenceType as FinanceAuditEntity,
        entityId: ticket['reference_id'] as string,
        entityRef: result.referenceNo,
        action: action === 'overwrite' ? 'adjusted' : 'updated',
        previousValues: { [result.field]: result.originalValue },
        newValues: {
          [result.field]: result.newValue,
          queryNo: ticket['query_no'],
          reason,
          ...(result.ledger?.ledgerAmended
            ? {
                reversalVoucherNo: result.ledger.reversalVoucherNo,
                correctedVoucherNo: result.ledger.correctedVoucherNo,
              }
            : {}),
        },
      });

      try {
        if (ticket['raised_by']) {
          await notify({
            type: 'finance_query_amended',
            title: `${result.referenceNo} corrected`,
            message:
              `${spec.label}: ${result.originalValue ?? '—'} → ${result.newValue ?? '—'}` +
              `\nQuery ID: ${ticket['query_no']}`,
            targetUserId: ticket['raised_by'] as string,
            relatedId: ticket['id'] as string,
          });
        }
      } catch { /* best-effort */ }

      res.json({
        applied: result,
        record: await liveReference(referenceType, ticket['reference_id'] as string),
      });
    } catch (err) {
      next(err);
    }
  },
);

/** "Rs.2,500" — the Finance UI's own spelling, for notifications and responses. */
const rupees = (v: unknown) => `Rs.${Number(v ?? 0).toLocaleString('en-PK')}`;

/** Money in paisa, so 2500 and "2500.00" compare equal without float drift. */
const paisa = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/** What correct_finance_record_for_query reports for each field it changed. */
interface CorrectedField {
  referenceType: string;
  referenceNo: string;
  field: string;
  label: string;
  originalValue: string | null;
  newValue: string | null;
  /** As a person reads it — a category or branch by name (migration 130). Absent on the older types. */
  originalText?: string | null;
  newText?: string | null;
  difference: number | null;
  ledger?: { ledgerAmended?: boolean; reversalVoucherNo?: string; correctedVoucherNo?: string };
}

/** "Amount Rs.2,500 → Rs.3,000, Description Fuel → Fuel charges". */
function describeCorrection(applied: CorrectedField[], moneyFields: Set<string>): string {
  return applied
    .map((a) => {
      const show = (v: string | null) => (v === null || v === '' ? '—' : moneyFields.has(a.field) ? rupees(v) : `"${v}"`);
      return `${a.label} ${show(a.originalText ?? a.originalValue)} → ${show(a.newText ?? a.newValue)}`;
    })
    .join(', ');
}

/**
 * A category or a branch by NAME, for the response the raiser reads. The
 * correction itself carries ids; a sentence with a uuid in it is not an answer.
 */
async function correctionDisplayNames(
  edits: { kind: string; value: string; expected: string }[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = (kind: string) =>
    [...new Set(edits.filter((e) => e.kind === kind).flatMap((e) => [e.value, e.expected]).filter(Boolean))];
  const heads = ids('head');
  if (heads.length) {
    const { data, error } = await db.from('ledger_heads').select('id, name').in('id', heads);
    if (error) throw error;
    for (const h of data ?? []) names.set(h.id as string, h.name as string);
  }
  const branches = ids('branch');
  if (branches.length) {
    const { data, error } = await db.from('branches').select('id, name').in('id', branches);
    if (error) throw error;
    for (const b of data ?? []) names.set(b.id as string, b.name as string);
  }
  return names;
}

/**
 * "Correct record" — the Finance Query's direct correction (migration 129).
 *
 * Several fields of the linked record at once, and optionally the query's
 * resolution, applied by ONE database function in ONE transaction: every field
 * goes through `amend_finance_record` (the same function /amend uses, so the
 * whitelist, reversal-and-repost and derived totals are unchanged), then the
 * amendment rows, the resolve and the version row are written beside them. A
 * refusal at any step leaves the record, the books and the query as they were.
 *
 * Optimistic concurrency at two levels: `expectedVersion` for the query (every
 * write to a query bumps it) and each edit's `expected` for the record, checked
 * here for a fast answer and again in SQL against the value actually replaced.
 */
router.post(
  '/:id/correct-record',
  requireFinanceHelpDeskAdmin(),
  validate(CorrectFinanceRecordSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as CorrectFinanceRecordInput;

      const ticket = await getTicket(req.params.id as string);
      if (!ticket) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      if (ticket['deleted_at']) {
        res.status(409).json({ error: `Query ${ticket['query_no']} has been deleted. Restore it before correcting its record.` });
        return;
      }
      const referenceType = ticket['reference_type'] as FinanceTicketReferenceType | null;
      if (!referenceType || !ticket['reference_id']) {
        res.status(409).json({
          error:
            `Query ${ticket['query_no']} names no finance record, so there is nothing to correct. ` +
            'Set its Reference ID first, or answer it with a response.',
        });
        return;
      }
      if (!isFinanceRecordAmendable(referenceType)) {
        res.status(409).json({ error: informationalReferenceMessage(referenceType, ticket['reference_no']) });
        return;
      }
      if (Number(ticket['version']) !== body.expectedVersion) {
        res.status(409).json({
          error: `Query ${ticket['query_no']} was changed by another user while you were working on it. Reload it and try again.`,
          details: { code: 'conflict' },
        });
        return;
      }

      const live = await liveReference(referenceType, ticket['reference_id'] as string);
      if (!live || live['deletedAt']) {
        res.status(409).json({ error: `${ticket['reference_no'] ?? 'That record'} has been deleted, so there is nothing left to correct.` });
        return;
      }

      const allowed = FINANCE_AMENDABLE_FIELDS[referenceType] ?? [];
      const moneyFields = new Set(allowed.filter((f) => f.kind === 'money').map((f) => f.key));
      const edits: { field: string; value: string; expected: string; label: string; money: boolean; delta: number; kind: string }[] = [];
      for (const edit of body.edits) {
        const spec = allowed.find((f) => f.key === edit.field);
        if (!spec) {
          res.status(400).json({
            error: `"${edit.field}" cannot be changed on this record. It accepts: ${allowed.map((f) => f.label).join(', ')}.`,
          });
          return;
        }
        const money = spec.kind === 'money';
        if (money && !/^\d{1,12}(\.\d{1,2})?$/.test(edit.value)) {
          res.status(400).json({ error: `${spec.label} must be an amount of 0 or more, with at most 2 decimals.` });
          return;
        }
        if (money && edit.expected && !Number.isFinite(Number(edit.expected))) {
          res.status(400).json({ error: `The current ${spec.label} sent with the correction is not a number.` });
          return;
        }
        if (spec.kind === 'select' && !(spec.options ?? []).some((o) => o.value === edit.value)) {
          res.status(400).json({ error: `Choose one of the listed values for ${spec.label}.` });
          return;
        }
        if (spec.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(edit.value)) {
          res.status(400).json({ error: `${spec.label} must be a date.` });
          return;
        }
        // A branch may be cleared (company-wide); a category may not.
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if ((spec.kind === 'head' || (spec.kind === 'branch' && edit.value !== '')) && !UUID.test(edit.value)) {
          res.status(400).json({ error: `Choose a ${spec.label.toLowerCase()} from the list.` });
          return;
        }

        const current = financeAmendableValue(referenceType, live, edit.field);
        const expected = edit.expected ?? '';
        const same = (a: string, b: string) => (money ? paisa(a) === paisa(b) : a.trim() === b.trim());
        if (!same(current, expected)) {
          res.status(409).json({
            error: 'This record was changed by another user. Please reload the latest version before applying your correction.',
            details: { code: 'conflict' },
          });
          return;
        }
        if (same(current, edit.value)) continue;
        edits.push({
          field: edit.field,
          value: edit.value,
          expected,
          label: spec.label,
          money,
          delta: money ? paisa(edit.value) - paisa(current) : 0,
          kind: spec.kind,
        });
      }
      if (!edits.length) {
        res.status(400).json({ error: 'No changes detected.' });
        return;
      }

      // An approved record is OVERWRITTEN, and §11 wants that acknowledged in a
      // way the server can see — the same rule AmendFinanceRecordSchema applies.
      const approved = ['approved', 'posted', 'locked'].includes(String(live['status'] ?? ''));
      if (approved && body.confirmOverwrite !== true) {
        res.status(400).json({
          error: 'This is an approved financial record. Confirm the overwrite — it is recorded in the audit trail.',
        });
        return;
      }

      // Increases before decreases: moving 10,000 from Cash to Bank on a deposit
      // must never pass through an all-zero row, which the database refuses.
      edits.sort((a, b) => b.delta - a.delta);

      const note = body.note?.trim() ?? '';
      const reason = [`Finance query ${ticket['query_no']}`, note].filter(Boolean).join(' — ');
      const names = await correctionDisplayNames(edits);
      const named = (e: { kind: string }, v: string) =>
        e.kind === 'branch' && v === '' ? 'Company-wide' : names.get(v) ?? v;
      const preview = describeCorrection(
        edits.map((e) => ({
          referenceType,
          referenceNo: String(ticket['reference_no'] ?? ''),
          field: e.field,
          label: e.label,
          originalValue: e.expected,
          newValue: e.value,
          originalText: named(e, e.expected),
          newText: named(e, e.value),
          difference: null,
        })),
        moneyFields,
      );
      const adminResponse = body.resolve
        ? body.adminResponse?.trim() ||
          `Corrected ${ticket['reference_no']}: ${preview}.${note ? ` ${note}` : ''}`
        : undefined;
      const statusFrom = ticket['status'] as FinanceTicketStatus;

      const { data, error } = await db.rpc('correct_finance_record_for_query', {
        p_ticket_id: ticket['id'],
        p_expected_version: body.expectedVersion,
        p_edits: edits.map(({ field, value, expected, label, money }) => ({ field, value, expected, label, money })),
        p_reason: reason,
        p_action: approved ? 'overwrite' : 'amend',
        p_resolve: body.resolve,
        p_admin_response: adminResponse ?? null,
        p_labels: {
          statusFrom: FINANCE_TICKET_STATUS_LABELS[statusFrom] ?? statusFrom,
          statusTo: FINANCE_TICKET_STATUS_LABELS.resolved,
          resolutionType: FINANCE_RESOLUTION_TYPE_LABELS.fixed,
        },
        p_actor_id: req.user!.uid,
        p_actor_name: req.user!.email,
        p_actor_role: req.user!.role,
        p_ip_address: requestFingerprint(req).ipAddress,
        // Reversal and correction are dated TODAY, as on /amend: the day the
        // wrong voucher was posted is usually closed by now.
        p_entry_date: businessDateStr(),
      });
      if (error) {
        if (error.code === 'MBCON') {
          res.status(409).json({ error: error.message, details: { code: 'conflict' } });
          return;
        }
        if (error.code === 'MBNFD') {
          res.status(404).json({ error: error.message });
          return;
        }
        throw asAmendError(error);
      }

      const result = data as { applied: CorrectedField[]; statusFrom: FinanceTicketStatus; ticket: Record<string, unknown> };
      const summary = describeCorrection(result.applied, moneyFields);

      for (const a of result.applied) {
        await logFinanceAudit(req, {
          entity: referenceType as FinanceAuditEntity,
          entityId: ticket['reference_id'] as string,
          entityRef: a.referenceNo,
          action: approved ? 'adjusted' : 'updated',
          previousValues: { [a.field]: a.originalText ?? a.originalValue },
          newValues: {
            [a.field]: a.newText ?? a.newValue,
            event: 'FINANCE_RECORD_CORRECTED',
            queryNo: ticket['query_no'],
            reason,
            ...(a.ledger?.ledgerAmended
              ? { reversalVoucherNo: a.ledger.reversalVoucherNo, correctedVoucherNo: a.ledger.correctedVoucherNo }
              : {}),
          },
        });
      }
      if (body.resolve) {
        await logFinanceAudit(req, {
          entity: 'finance_ticket',
          entityId: ticket['id'] as string,
          entityRef: ticket['query_no'] as string,
          action: 'resolved',
          previousValues: { status: result.statusFrom },
          newValues: {
            status: 'resolved',
            resolutionType: 'fixed',
            adminResponse,
            reason,
            version: result.ticket['version'],
          },
        });
      }

      await notifyRaiser(
        req,
        result.ticket,
        body.resolve ? 'finance_query_resolved' : 'finance_query_amended',
        body.resolve
          ? `Query ${ticket['query_no']} — Resolved`
          : `${ticket['reference_no']} corrected`,
        `${ticket['reference_no']}: ${summary}`,
      );

      res.json({
        applied: result.applied,
        summary,
        ticket: rowToApi(result.ticket),
        record: await liveReference(referenceType, ticket['reference_id'] as string),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * §10's delete — soft, always.
 *
 * The record is stamped and stays readable to an Admin; the query stays too, and
 * carries the same stamp. Migration 60's real delete, which destroyed both the
 * query text and the voucher and left only the fact in the trail, is gone: a
 * query is now the justification for the corrections made under it (§21), and a
 * justification the actor can destroy is not one.
 *
 * The order is deliberate:
 *
 *   1. stamp the RECORD   — the step that recomputes the ledger and can fail
 *   2. write the amendment — only once the record actually went
 *   3. stamp the QUERY     — last, so a failure at (1) leaves both in place and
 *                            the operation is safe to retry
 */
router.delete(
  '/:id/record',
  requireFinanceHelpDeskAdmin(),
  validate(DeleteFinanceRecordSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { reason } = req.body as { reason: string };

      const ticket = await getTicket(req.params.id as string);
      if (!ticket) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }
      const referenceType = ticket['reference_type'] as FinanceTicketReferenceType | null;
      if (!referenceType || !ticket['reference_id']) {
        res.status(409).json({ error: `Query ${ticket['query_no']} names no finance record to delete.` });
        return;
      }
      // Checked HERE rather than left to the function. `soft_delete_finance_record`
      // does refuse an informational reference — but by raising `unknown finance
      // reference type`, which reaches the admin as a 500 and reads like a bug
      // rather than like the answer, which is "that record is not deleted from
      // this desk".
      if (!isFinanceRecordAmendable(referenceType)) {
        res.status(409).json({ error: informationalReferenceMessage(referenceType, ticket['reference_no']) });
        return;
      }

      const { data: removed, error } = await db.rpc('soft_delete_finance_record', {
        p_reference_type: referenceType,
        p_reference_id: ticket['reference_id'],
        p_reason: reason,
        p_actor_id: req.user!.uid,
        p_actor_name: req.user!.email,
        p_query_id: ticket['id'],
        p_query_no: ticket['query_no'],
      });
      if (error) throw error;

      const source = (removed ?? {}) as {
        deleted?: boolean;
        referenceNo?: string;
        balancesRewritten?: number;
        closingBalance?: number | null;
        /** Cash deposit only (migration 125): the RV- vouchers removed with it. */
        ledgerRemoved?: string | null;
        /** Vouchers on a closed day, reversed today instead of removed: "RV-000239 → PV-000756". */
        ledgerReversed?: string | null;
        reason?: string;
      };
      if (!source.deleted) {
        res.status(409).json({
          error: `${ticket['reference_no'] ?? 'That record'} could not be deleted — ${source.reason ?? 'it is no longer there'}.`,
        });
        return;
      }

      await recordAmendment(
        req,
        ticket,
        'delete',
        {
          referenceType,
          referenceNo: source.referenceNo ?? String(ticket['reference_no'] ?? ''),
          field: 'record',
          originalValue: 'present',
          newValue: 'deleted',
          difference: null,
        },
        reason,
      );

      await logFinanceAudit(req, {
        entity: referenceType as FinanceAuditEntity,
        entityId: ticket['reference_id'] as string,
        entityRef: source.referenceNo ?? String(ticket['reference_no'] ?? ''),
        action: 'deleted',
        newValues: {
          softDeleted: true,
          deletedVia: 'finance_help_desk',
          queryNo: ticket['query_no'],
          reason,
          // Deleting a voucher rewrites the running balance on every later row.
          // How many rows moved, and where the book landed, is the part of a
          // deletion an auditor most needs and cannot reconstruct afterwards.
          ...(source.balancesRewritten
            ? { balancesRewritten: source.balancesRewritten, closingBalance: source.closingBalance ?? null }
            : {}),
          ...(source.ledgerRemoved ? { ledgerEntriesRemoved: source.ledgerRemoved } : {}),
          ...(source.ledgerReversed ? { ledgerEntriesReversed: source.ledgerReversed } : {}),
        },
      });

      try {
        if (ticket['raised_by']) {
          await notify({
            type: 'finance_query_amended',
            title: `${source.referenceNo} deleted`,
            message: `${reason}\nQuery ID: ${ticket['query_no']}`,
            targetUserId: ticket['raised_by'] as string,
            relatedId: ticket['id'] as string,
          });
        }
      } catch { /* best-effort */ }

      res.json({
        success: true,
        referenceNo: source.referenceNo,
        balancesRewritten: source.balancesRewritten ?? 0,
        ledgerRemoved: source.ledgerRemoved ?? null,
        ledgerReversed: source.ledgerReversed ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Delete the QUERY (not the record it names). Soft, and admin-only.
 *
 * Kept separate from `/​:id/record` because they are genuinely different acts:
 * one removes a wrong voucher from the books, the other removes a query that
 * should not have been raised. Migration 60 did both at once from a single
 * button, which is how deleting a duplicate help-desk entry could take a posted
 * voucher with it.
 */
router.delete('/:id', requireFinanceHelpDeskAdmin(), validate(DeleteFinanceRecordSchema), async (req: AuthRequest, res, next) => {
  try {
    const { reason } = req.body as { reason: string };

    const ticket = await getTicket(req.params.id as string);
    if (!ticket) {
      res.status(404).json({ error: 'Query not found' });
      return;
    }
    if (ticket['deleted_at']) {
      res.status(409).json({ error: `Query ${ticket['query_no']} is already deleted.` });
      return;
    }

    const { error } = await db
      .from('finance_tickets')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: req.user!.uid,
        deleted_by_name: req.user!.email,
        delete_reason: reason,
      })
      .eq('id', ticket.id);
    if (error) throw error;

    await logFinanceAudit(req, {
      entity: 'finance_ticket',
      entityId: ticket.id,
      entityRef: ticket['query_no'] as string,
      action: 'deleted',
      // The query's TEXT is deliberately not copied into the trail — unlike
      // migration 60, it does not need to be. The row is still there.
      newValues: { softDeleted: true, reason },
    });

    res.json({ success: true, queryNo: ticket['query_no'] });
  } catch (err) {
    next(err);
  }
});

/**
 * Turn a `raise exception` from amend_finance_record into an HTTP status.
 *
 * Every message that function raises is written for a person — "field X is not
 * amendable on a salary payment (…)", "the finance day Y is closed" — and
 * passing them through as a 500 would replace a usable sentence with "Internal
 * server error". They are all caller mistakes, so 409 is the honest code: the
 * request was well-formed and the state refused it.
 */
function asAmendError(error: { message?: string; code?: string }): Error {
  const message = error.message ?? 'The correction could not be applied.';
  // PostgREST surfaces a plpgsql RAISE as P0001. Anything else — a constraint
  // violation, a connection failure — is a real fault and keeps its 500.
  const status = error.code === 'P0001' ? 409 : 500;
  return Object.assign(new Error(message), { status });
}
