import type {
  StoreConfirmIssueInput,
  StoreDecisionInput,
  StoreDemand,
  StoreDemandInput,
  StoreDemandStatus,
  StoreIssue,
  StoreIssueInput,
  StorePage,
} from '../../shared';
import { api, call, clientError, db, httpError, searchTerm, tell, type StoreActor } from './common';

/**
 * Production asks for dry items; the Store approves or rejects each line,
 * issues what it approved (FIFO over the batches) and Production confirms what
 * arrived. Every step is one database function that locks what it changes,
 * so a stale screen is refused with a sentence, never applied twice.
 */

const page = (limit?: number, offset?: number) => ({ l: Math.min(Math.max(limit ?? 50, 1), 200), o: Math.max(offset ?? 0, 0) });

async function demandJson(id: string): Promise<StoreDemand> {
  const d = await call<unknown>('store_get_demand', { p_id: id });
  if (!d) throw httpError(404, 'Demand not found');
  return api<StoreDemand>(d);
}

export async function listDemands(opts: {
  status?: StoreDemandStatus[];
  mine?: string; // requester's user id (Production sees only its own)
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<StorePage<StoreDemand>> {
  const { l, o } = page(opts.limit, opts.offset);
  let q = db.from('store_demands').select('id', { count: 'exact' });
  if (opts.status?.length) q = q.in('status', opts.status);
  if (opts.mine) q = q.eq('requested_by', opts.mine);
  if (opts.from) q = q.gte('demand_date', opts.from);
  if (opts.to) q = q.lte('demand_date', opts.to);
  const term = searchTerm(opts.search);
  if (term) q = q.or(`demand_no.ilike.%${term}%,requested_by_name.ilike.%${term}%,remarks.ilike.%${term}%`);
  const { data, error, count } = await q.order('demand_date', { ascending: false }).order('created_at', { ascending: false }).range(o, o + l - 1);
  if (error) throw clientError(error);
  const ids = (data ?? []).map((r) => r['id'] as string);
  const rows = ids.length ? api<StoreDemand[]>(await call('store_get_demands', { p_ids: ids })) : [];
  return { rows, total: count ?? 0 };
}

/** Counts per status, for the tabs. */
export async function demandCounts(mine?: string): Promise<Record<StoreDemandStatus | 'all', number>> {
  const out = { all: 0, pending_review: 0, ready_to_issue: 0, issued: 0, received: 0, rejected: 0, cancelled: 0 } as Record<StoreDemandStatus | 'all', number>;
  for (const s of ['pending_review', 'ready_to_issue', 'issued', 'received', 'rejected', 'cancelled'] as StoreDemandStatus[]) {
    let q = db.from('store_demands').select('id', { count: 'exact', head: true }).eq('status', s);
    if (mine) q = q.eq('requested_by', mine);
    const { count, error } = await q;
    if (error) throw clientError(error);
    out[s] = count ?? 0;
    out.all += count ?? 0;
  }
  return out;
}

export async function getDemand(id: string, actor: StoreActor): Promise<StoreDemand> {
  const d = await demandJson(id);
  if (actor.role === 'production_user' && d.requestedBy !== actor.uid) throw httpError(404, 'Demand not found');
  return d;
}

export async function createDemand(input: StoreDemandInput, actor: StoreActor): Promise<StoreDemand> {
  const d = api<StoreDemand>(await call('store_create_demand', { p_actor_id: actor.uid, p_actor_name: actor.name, p_input: input }));
  await tell({
    type: 'store_demand',
    title: `Dry items demand ${d.demandNo}`,
    message: `${actor.name} asked for ${d.lines.length} item${d.lines.length === 1 ? '' : 's'}, needed by ${d.requiredDate}.`,
    targetRole: 'store_user',
    relatedId: d.id,
  });
  return d;
}

export async function cancelDemand(id: string, actor: StoreActor): Promise<StoreDemand> {
  return api<StoreDemand>(await call('store_cancel_demand', { p_actor_id: actor.uid, p_actor_name: actor.name, p_actor_role: actor.role, p_id: id }));
}

export async function decideLine(lineId: string, input: StoreDecisionInput, actor: StoreActor): Promise<StoreDemand> {
  const d = api<StoreDemand>(await call('store_decide_line', {
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
    p_line_id: lineId,
    p_decision: input.decision,
    p_qty: input.decision === 'approve' ? (input.qty ?? null) : null,
    p_reason: input.decision === 'undo' ? null : (input.note ?? null),
  }));
  if (input.decision !== 'undo') await reviewed(d, actor);
  return d;
}

export async function approveAll(demandId: string, actor: StoreActor): Promise<{ demand: StoreDemand; approved: number; skipped: number }> {
  const r = api<{ demand: StoreDemand; approved: number; skipped: number }>(
    await call('store_approve_all', { p_actor_id: actor.uid, p_actor_name: actor.name, p_demand_id: demandId }),
  );
  if (r.approved > 0) await reviewed(r.demand, actor);
  return r;
}

/** Tell the requester once every line has been decided. */
async function reviewed(d: StoreDemand, actor: StoreActor): Promise<void> {
  if (!d.requestedBy || d.lines.some((l) => l.status === 'pending')) return;
  const ok = d.lines.filter((l) => l.status === 'approved' || l.status === 'issued').length;
  await tell({
    type: 'store_demand_reviewed',
    title: `${d.demandNo} reviewed by the Store`,
    message: `${ok} of ${d.lines.length} line${d.lines.length === 1 ? '' : 's'} approved by ${actor.name}.`,
    targetUserId: d.requestedBy,
    relatedId: d.id,
  });
}

// ── Issues ──────────────────────────────────────────────────────────────────

export async function issue(input: StoreIssueInput, actor: StoreActor): Promise<StoreIssue> {
  const s = api<StoreIssue>(await call('store_issue_stock', { p_actor_id: actor.uid, p_actor_name: actor.name, p_input: input }));
  const { data: d } = await db.from('store_demands').select('requested_by').eq('id', s.demandId).maybeSingle();
  if (d?.['requested_by']) {
    await tell({
      type: 'store_issue',
      title: `${s.issueNo} issued for ${s.demandNo}`,
      message: `${s.lines.length} item${s.lines.length === 1 ? '' : 's'} handed to ${s.receivedByName}. Confirm what you received.`,
      targetUserId: d['requested_by'] as string,
      relatedId: s.demandId,
    });
  }
  return s;
}

export async function listIssues(opts: { demandId?: string; mine?: string; status?: string; from?: string; to?: string; search?: string; limit?: number; offset?: number }): Promise<StorePage<StoreIssue>> {
  const { l, o } = page(opts.limit, opts.offset);
  let demandIds: string[] | null = null;
  if (opts.mine) {
    const { data, error } = await db.from('store_demands').select('id').eq('requested_by', opts.mine).range(0, 999);
    if (error) throw clientError(error);
    demandIds = (data ?? []).map((r) => r['id'] as string);
    if (!demandIds.length) return { rows: [], total: 0 };
  }
  let q = db.from('store_issues').select('id', { count: 'exact' });
  if (opts.demandId) q = q.eq('demand_id', opts.demandId);
  if (demandIds) q = q.in('demand_id', demandIds);
  if (opts.status) q = q.eq('status', opts.status);
  if (opts.from) q = q.gte('issue_date', opts.from);
  if (opts.to) q = q.lte('issue_date', opts.to);
  const term = searchTerm(opts.search);
  if (term) q = q.or(`issue_no.ilike.%${term}%,received_by_name.ilike.%${term}%`);
  const { data, error, count } = await q.order('issue_date', { ascending: false }).order('created_at', { ascending: false }).range(o, o + l - 1);
  if (error) throw clientError(error);
  const ids = (data ?? []).map((r) => r['id'] as string);
  const rows = ids.length ? api<StoreIssue[]>(await call('store_get_issues', { p_ids: ids })) : [];
  return { rows, total: count ?? 0 };
}

export async function getIssue(id: string, actor: StoreActor): Promise<StoreIssue> {
  const rows = api<StoreIssue[]>(await call('store_get_issues', { p_ids: [id] }));
  const s = rows[0];
  if (!s) throw httpError(404, 'Issue not found');
  if (actor.role === 'production_user') {
    const { data } = await db.from('store_demands').select('requested_by').eq('id', s.demandId).maybeSingle();
    if (data?.['requested_by'] !== actor.uid) throw httpError(404, 'Issue not found');
  }
  return s;
}

export async function confirmIssue(id: string, input: StoreConfirmIssueInput, actor: StoreActor): Promise<StoreIssue> {
  await getIssue(id, actor); // scope check for Production
  const s = api<StoreIssue>(await call('store_confirm_issue', {
    p_actor_id: actor.uid, p_actor_name: actor.name, p_issue_id: id, p_lines: input.lines ?? [], p_note: input.note ?? null,
  }));
  const diff = s.status === 'received_with_difference';
  const message = diff
    ? `${actor.name} confirmed ${s.issueNo} with a difference: ${s.confirmNote ?? ''}`.trim()
    : `${actor.name} confirmed ${s.issueNo} received in full.`;
  await tell({ type: 'store_issue_received', title: `${s.issueNo} ${diff ? 'received with a difference' : 'received'}`, message, targetRole: 'store_user', relatedId: s.demandId });
  if (diff) await tell({ type: 'store_issue_received', title: `${s.issueNo}: issued and received differ`, message, targetRole: 'super_admin', relatedId: s.demandId });
  return s;
}
