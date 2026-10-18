import { randomUUID } from 'crypto';
import { dbFor } from '../db';
import type { ProductionReturn } from '../shared';
import { rowToApi } from '../utils/case';
import { getAttachmentsByIds } from './attachments.service';
import { priceReturnRows } from './returns-summary.service';
import { applyStockMovement, commitBranchReturn } from './stock.service';
import { isBusinessDayClosed } from './business-day.service';

const db = dbFor('branch-returns');

/**
 * Branch → Return Stock: reading, correcting, resubmitting and withdrawing a
 * branch's own returns.
 *
 * The list side is a branch-scoped read of `production_returns`; the write side
 * is the part with teeth.
 *
 * WHAT A PENDING RETURN HAS ALREADY DONE. Since auto-approval was removed,
 * `POST /api/stock/return` inserts the record `pending` and moves ONE of the two
 * ledgers:
 *
 *   1. branch `stock`             −qty   (`stock_history` type 'return')   ← done
 *   2. Branch Return Stock (`return_stock`)  +qty   ('return_in')          ← NOT yet
 *      (never `production_stock` — a return is not production stock; migration 139)
 *
 * The pool credit waits for Production to approve. That asymmetry is the whole
 * reason this file is short now: a correction here only ever has to move the
 * BRANCH side, because the pool side has not happened. The old version had to
 * unwind both, and could be refused outright when the returned units had already
 * been used out of the pool — a failure mode that no longer exists, since a
 * pending return never put anything in the pool to be used.
 *
 * Reversal keeps the SAME `type: 'return'` on the branch ledger rather than
 * filing itself as an 'adjustment'. That is load-bearing: `computeStockRows` and
 * `computeBranchStockHistory` derive the Returned column as `returned -= delta`,
 * so a positive 'return' delta nets the units back out of that column and the
 * branch's Returned figure lands on what was really returned. Filed as an
 * 'adjustment' it would instead read as "returned 10, and separately +10
 * appeared from nowhere" — the exact confusion documented at the `type: 'return'`
 * line in production-returns.routes.ts, from the other direction.
 *
 * Each compensating movement carries a FRESH refId. The `UNIQUE (ref_id,
 * product_id, type)` idempotency key means reusing the original return's id would
 * silently no-op — the original movement already holds that key — and the edit
 * would appear to succeed while moving nothing. Retry safety comes from the
 * route's `idempotent()` middleware instead, which is the layer that can tell a
 * retry from a second deliberate correction — and only for a caller that sends
 * an `Idempotency-Key`. The middleware passes a request without one straight
 * through, so for the web app these are ordinary non-idempotent writes and the
 * UI confirms before sending rather than relying on a replay being free.
 */

/** Row shape as stored; `business_date` is remapped to `date` for the API contract. */
interface ReturnRow {
  id: string;
  branch_id: string;
  product_id: string;
  product_name: string;
  qty: number | string;
  status: string;
  source: string | null;
  business_date: string;
}

/**
 * The two statuses in which a return is still OPEN and so still the branch's to
 * change: awaiting Production, or handed back by them to be corrected. Both
 * hold the same stock position — units off the branch, nothing in the pool —
 * which is why one list covers every write in this file.
 *
 * `accepted` and `rejected` are terminal and appear nowhere here. That is the
 * rule the Return Stock page's Change and Delete buttons are enforcing: before
 * Production has decided, yes; afterwards, never.
 */
const OPEN_STATUSES = ['pending', 'returned'];

/** Thrown when a return exists but may no longer be altered. Carries its own status. */
export class ReturnLockedError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ReturnLockedError';
  }
}

/** Thrown when the return is not this caller's to touch. */
export class ReturnNotFoundError extends Error {
  status = 404;
  constructor() {
    super('Return not found');
    this.name = 'ReturnNotFoundError';
  }
}

/**
 * The branch's own returns, most recent first.
 *
 * Scoped to one branch and one window rather than reusing
 * `GET /api/production-returns`: that router is `super_admin` + `production_user`
 * only and answers with every branch's returns, which is both a wider read than a
 * branch may have and a larger one than it needs.
 *
 * `business_date` is remapped to `date` here for the same reason the Production
 * list does it — `rowToApi` only camelCases keys, so without the remap every row
 * reaches the client with `date: undefined` and the table renders a column of
 * placeholders.
 */
const OPEN_OR_CLOSED_STATUSES = ['pending', 'accepted', 'rejected', 'returned'];

/**
 * Shape a page of `production_returns` rows for the API: `business_date` becomes
 * `date`, `photo_attachment_id` becomes a signed `photo`, and each row gains its
 * `productCode`, `unitPrice` and `amount` — priced by the same query the monthly
 * summary uses (`returns-summary.service.ts`), so a row and the total it rolls
 * up into always agree.
 *
 * Shared by the branch list here and Production's queue
 * (production-returns.routes.ts) so the two cannot disagree about what a return
 * looks like. One attachment query and one signing call for the whole page,
 * however many rows share a photo — every product of one submission does.
 *
 * WHO MAY SEE A PHOTO is decided by the caller's own row filter, not here: a
 * branch only ever reaches this with its own branch's rows, and the URL minted
 * for them dies in an hour.
 */
export async function toReturnsApi(data: unknown[]): Promise<ProductionReturn[]> {
  const rows = rowToApi<Record<string, unknown>[]>(data ?? []);
  const [photos, pricing] = await Promise.all([
    getAttachmentsByIds('branch_return', rows.map((r) => r['photoAttachmentId'] as string | null)),
    priceReturnRows(rows.map((r) => r['id'] as string)),
  ]);
  return rows.map(({ businessDate, photoAttachmentId, ...rest }) => {
    const price = pricing.get(rest['id'] as string);
    return {
      ...rest,
      date: businessDate,
      photo: photos.get(photoAttachmentId as string) ?? null,
      productCode: price?.productCode ?? null,
      unitPrice: price?.unitPrice ?? null,
      amount: price?.amount ?? null,
    };
  }) as unknown as ProductionReturn[];
}

/** Allowlist for `?sortBy=` — `date` is this API's own rename of `business_date` (see below). */
const BRANCH_RETURN_SORTABLE_COLUMNS: Record<string, string> = {
  date: 'business_date',
  createdAt: 'created_at',
  reviewedAt: 'reviewed_at',
  productName: 'product_name',
  qty: 'qty',
  status: 'status',
};

export async function listBranchReturns(
  branchId: string,
  opts: {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    productId?: string;
    status?: string;
    search?: string;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  } = {},
): Promise<{ returns: ProductionReturn[]; total: number }> {
  const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 200);
  const offset = Math.max(Number(opts.offset ?? 0), 0);
  const sortCol = (opts.sortBy && BRANCH_RETURN_SORTABLE_COLUMNS[opts.sortBy]) || 'created_at';
  const ascending = opts.sortDir === 'asc';

  let q = db
    .from('production_returns')
    .select('*', { count: 'exact' })
    .eq('branch_id', branchId)
    .order(sortCol, { ascending })
    .range(offset, offset + limit - 1);

  if (opts.from) q = q.gte('business_date', opts.from);
  if (opts.to) q = q.lte('business_date', opts.to);
  if (opts.productId) q = q.eq('product_id', opts.productId);
  if (opts.status && OPEN_OR_CLOSED_STATUSES.includes(opts.status)) q = q.eq('status', opts.status);

  // Free-text search over the reason and product name — same convention as
  // GET /api/products: strip `or` filter syntax, then ilike.
  if (opts.search?.trim()) {
    const term = opts.search.trim().replace(/[(),*]/g, ' ').trim();
    if (term) q = q.or(`reason.ilike.%${term}%,product_name.ilike.%${term}%,legacy_id.ilike.%${term}%`);
  }

  const { data, error, count } = await q;
  if (error) throw error;

  return { returns: await toReturnsApi(data ?? []), total: count ?? 0 };
}

/**
 * Load a return and decide whether this caller may still alter it.
 *
 * Three gates, and each blocks a genuinely different mistake:
 *
 * - **Branch.** The row must belong to the caller's branch. Admin passes
 *   `branchId` null to skip this one.
 * - **Source.** Only `source = 'branch'` rows. A Production-recorded return is
 *   Production's record of what it received, reviewed on their own screen; a
 *   branch editing it would restate the other party's books.
 * - **Status.** Only while Production has not decided — `pending` or `returned`.
 *   This is the gate the feature is really about, and it replaced a
 *   `status === 'accepted'` check plus a "current business day only" rule that
 *   together were standing in for it. Back when every branch return was inserted
 *   already accepted there was no unreviewed state to gate on, so "today" was the
 *   nearest available proxy for "not yet settled". There is a real one now.
 *
 * WHY THE DAY RULE HAD TO GO, and what replaced it. Returns are raised at
 * closing, in the evening; Production reviews them the next morning, which is a
 * new business day. Keeping "today only" would therefore have blocked the branch
 * from correcting almost everything Production handed back — and a `returned`
 * row the branch cannot fix and Production will not re-review is a deadlock with
 * no way out of it. What remains is the guard that was doing the real work:
 * a CLOSED business day may not be restated, whatever its returns say, because
 * it has been snapshotted and reported on. An open past day is fair game.
 *
 * The cost of allowing it is that a correction's stock movement is stamped with
 * TODAY while the return record keeps its original `business_date`, so the two
 * days' Returned columns net to the corrected figure rather than one day showing
 * it outright. That is ordinary double-entry — a movement belongs to the day it
 * happened — and it is not optional anyway: `applyStockMovement` stamps
 * `businessDateStr()` itself and takes no date.
 */
async function loadEditable(id: string, branchId: string | null): Promise<ReturnRow> {
  const { data, error } = await db
    .from('production_returns')
    .select('id, branch_id, product_id, product_name, qty, status, source, business_date')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;

  const row = data as ReturnRow | null;
  // A row belonging to another branch is reported as absent rather than as
  // forbidden — "not found" does not confirm to one branch that another branch
  // has a return with this id.
  if (!row || (branchId !== null && row.branch_id !== branchId)) throw new ReturnNotFoundError();

  if (row.source !== 'branch') {
    throw new ReturnLockedError('This return was recorded by Production and can only be changed there.');
  }
  if (!OPEN_STATUSES.includes(row.status)) {
    throw new ReturnLockedError(
      row.status === 'accepted'
        ? 'Production has approved this return, so it can no longer be changed or deleted.'
        : 'Production has rejected this return, so it can no longer be changed or deleted. The stock is back on your balance.',
    );
  }
  if (await isBusinessDayClosed(row.business_date)) {
    throw new ReturnLockedError(
      `${row.business_date} has been closed, so its returns can no longer be changed. ` +
        'Raise a Help Desk query to correct a closed day.',
    );
  }

  return row;
}

/**
 * Put `units` back onto the branch balance.
 *
 * One movement, not two. A pending return has not credited the production pool,
 * so there is nothing there to take back — this used to check the pool first and
 * refuse when the returned units had already been used, which cannot happen to
 * units that never arrived.
 *
 * No `businessDate`: `applyStockMovement` stamps `businessDateStr()` itself and
 * takes none. The movement belongs to the day the correction was made, which may
 * be later than the return's own day — see `loadEditable`.
 */
async function giveUnitsBackToBranch(row: ReturnRow, branchId: string, units: number): Promise<void> {
  await applyStockMovement({
    branchId,
    productId: row.product_id,
    productName: row.product_name,
    delta: units,
    type: 'return',
    refId: randomUUID(),
  });
}

/**
 * Take a further `units` off the branch — raising an open return's quantity.
 *
 * Via `commitBranchReturn` rather than a bare movement: it validates
 * qty <= balance under a row lock and throws `InsufficientStockError` without
 * writing, so asking to return more than the shop still holds is refused rather
 * than driving the balance negative.
 */
async function takeUnitsFromBranch(row: ReturnRow, branchId: string, units: number): Promise<void> {
  await commitBranchReturn({
    branchId,
    productId: row.product_id,
    productName: row.product_name,
    qty: units,
    refId: randomUUID(),
  });
}

/**
 * The columns that move a handed-back return onto Production's queue again.
 *
 * The status is the point; clearing `reviewed_*` is the part that is easy to
 * forget and wrong to skip. Those columns were stamped when Production sent the
 * row back — a send-back is a review — and leaving them on a row that is once
 * more `pending` would have the branch's own Return Stock page name a reviewer
 * for a return nobody has yet decided, and Production's queue show a decision
 * against a row still sitting in it.
 */
function backToPendingPatch(): Record<string, unknown> {
  return { status: 'pending', reviewed_by: null, reviewed_by_name: null, reviewed_at: null };
}

/**
 * Change an open return's quantity and/or reason.
 *
 * Only the DIFFERENCE is moved. Reversing the whole return and re-applying it at
 * the new figure would foot to the same balance, but it writes two movements
 * where one will do and — worse — briefly returns every unit to the branch, so a
 * concurrent sale could take units the branch was never meant to have back.
 *
 * Raising the quantity can fail (the branch may no longer hold the extra units);
 * lowering it cannot, since it only credits the branch. Either way the movement
 * is attempted BEFORE the row is touched, so a refusal leaves nothing written.
 *
 * A row Production handed back goes to `pending` on save — the correction IS the
 * resubmission, and leaving it at `returned` would strand a fixed return waiting
 * on a branch that has already done its part. `resubmitBranchReturn` is the
 * no-change version of the same step, for a branch that disputes the figure
 * rather than correcting it.
 *
 * The one window this leaves is the reverse: units moved, then the row update
 * fails, so the record still reads the old figure while the ledger has already
 * changed. That is the same split-transaction weakness the whole return path
 * carries (see the note in migration 20260719000005's `production_returns`
 * header) and closing it properly means a Postgres function, not a reordering
 * here — every ordering leaves one of the two halves exposed.
 */
export async function reviseBranchReturn(params: {
  id: string;
  branchId: string | null;
  qty: number;
  reason?: string;
}): Promise<ProductionReturn> {
  const row = await loadEditable(params.id, params.branchId);
  const branchId = row.branch_id;
  const diff = params.qty - Number(row.qty);

  if (diff > 0) {
    await takeUnitsFromBranch(row, branchId, diff);
  } else if (diff < 0) {
    await giveUnitsBackToBranch(row, branchId, -diff);
  }

  const patch: Record<string, unknown> = { qty: params.qty };
  if (params.reason !== undefined) patch['reason'] = params.reason;
  if (row.status === 'returned') Object.assign(patch, backToPendingPatch());

  const { data, error } = await db
    .from('production_returns')
    .update(patch)
    .eq('id', params.id)
    .select('*')
    .single();
  if (error) throw error;

  const { businessDate, ...rest } = rowToApi<Record<string, unknown>>(data);
  return { ...rest, date: businessDate } as ProductionReturn;
}

/**
 * Send a handed-back return to Production again, unchanged.
 *
 * The counterpart to a Change on a `returned` row: Production disputed the
 * figure, the branch stands by it, and this puts the ball back in their court
 * without pretending to correct something. Moves no stock — the units have been
 * off the branch since it was raised and the pool has never held them, so
 * nothing about the ledger changes when the row's status does.
 *
 * Deliberately narrower than `loadEditable`: that admits `pending` too, and
 * resubmitting an already-pending return would be a no-op the branch could
 * mistake for having done something.
 */
export async function resubmitBranchReturn(id: string, branchId: string | null): Promise<ProductionReturn> {
  const row = await loadEditable(id, branchId);
  if (row.status !== 'returned') {
    throw new ReturnLockedError('This return is already waiting on Production.');
  }

  // Guarded on `status = 'returned'` rather than on the id alone, so a double
  // submit cannot walk a row Production has since decided back to pending. A
  // zero-row result means they got there first between the load and this update.
  const { data, error } = await db
    .from('production_returns')
    .update(backToPendingPatch())
    .eq('id', id)
    .eq('status', 'returned')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ReturnLockedError('Production has just reviewed this return.');

  const { businessDate, ...rest } = rowToApi<Record<string, unknown>>(data);
  return { ...rest, date: businessDate } as ProductionReturn;
}

/**
 * Withdraw an open return entirely: units back to the branch, then the record
 * removed.
 *
 * The row is DELETED rather than flagged. The stock ledger keeps the full story —
 * the original movement and its reversal both stay in `stock_history`, so the
 * audit trail is intact — while `production_returns` is the list of returns that
 * stand, and a withdrawn one does not. Leaving a tombstone here would put it back
 * on Production's queue as something they still have to decide.
 *
 * NOT ATOMIC, and it cannot be made so from here: the movement and the delete are
 * two PostgREST calls and so two transactions. The stock moves first because that
 * is the failure that reports itself — a refused reversal leaves the return
 * standing and the branch sees an unchanged row. The reverse order would delete
 * the record and then discover the units cannot come back, losing the only
 * remaining description of what to put right. If the delete itself fails after the
 * units have moved, the row survives with its units already back on the branch and
 * a second withdraw would move them twice, so the route wraps this in
 * `idempotent()`; a true fix is a `withdraw_branch_return(p_id)` Postgres
 * function, the same shape as `commit_branch_return`.
 */
export async function withdrawBranchReturn(id: string, branchId: string | null): Promise<void> {
  const row = await loadEditable(id, branchId);
  await giveUnitsBackToBranch(row, row.branch_id, Number(row.qty));

  const { error } = await db.from('production_returns').delete().eq('id', id);
  if (error) throw error;
}
