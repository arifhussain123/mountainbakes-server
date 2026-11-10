import type { StorePage, StoreQuery, StoreQueryInput, StoreQueryMessage, StoreQueryMessageInput, StoreQueryStatus } from '../../shared';
import { STORE_QUERY_STATUS_LABELS } from '../../shared';
import { api, clientError, db, httpError, searchTerm, tell, type StoreActor } from './common';
import { audit } from './catalog.service';

/**
 * The Store help desk. A Store keeper or Production raises a query (optionally
 * about a receipt, demand or issue, named by its number); Admin answers it in a
 * thread and moves it along Open → In review → Responded → Resolved / Rejected.
 * Every reply and status change is a message row, so the conversation and its
 * resolution history are never rewritten. Admin's delete archives.
 */

const side = (role: string): StoreQueryMessage['authorSide'] =>
  role === 'super_admin' ? 'admin' : role === 'production_user' ? 'production' : 'store';

async function idOf(table: string, column: string, value: string | null | undefined, what: string): Promise<string | null> {
  const v = value?.trim().toUpperCase();
  if (!v) return null;
  const { data, error } = await db.from(table).select('id').eq(column, v).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw httpError(400, `${what} ${v} was not found.`);
  return data['id'] as string;
}

const SELECT = '*, receipt:store_receipts(receipt_no), demand:store_demands(demand_no), issue:store_issues(issue_no)';

function shape(r: Record<string, unknown>): StoreQuery {
  const { receipt, demand, issue, ...rest } = r as Record<string, unknown> & {
    receipt?: { receiptNo: string } | null; demand?: { demandNo: string } | null; issue?: { issueNo: string } | null;
  };
  return {
    ...(rest as unknown as StoreQuery),
    relatedReceiptNo: (receipt as { receiptNo?: string } | null)?.receiptNo ?? null,
    relatedDemandNo: (demand as { demandNo?: string } | null)?.demandNo ?? null,
    relatedIssueNo: (issue as { issueNo?: string } | null)?.issueNo ?? null,
  };
}

export async function createQuery(input: StoreQueryInput, actor: StoreActor): Promise<StoreQuery> {
  const [rid, did, iid] = await Promise.all([
    idOf('store_receipts', 'receipt_no', input.relatedReceiptNo, 'Receipt'),
    idOf('store_demands', 'demand_no', input.relatedDemandNo, 'Demand'),
    idOf('store_issues', 'issue_no', input.relatedIssueNo, 'Issue'),
  ]);
  const { data, error } = await db.from('store_queries').insert({
    subject: input.subject.trim(),
    query_type: input.queryType,
    description: input.description.trim(),
    related_receipt_id: rid,
    related_demand_id: did,
    related_issue_id: iid,
    raised_by: actor.uid,
    raised_by_name: actor.name,
    raised_by_role: actor.role,
  }).select('id, query_no').single();
  if (error) throw clientError(error);
  await audit('query', data['id'] as string, data['query_no'] as string, 'raised', input.subject.trim(), actor);
  await tell({
    type: 'store_query',
    title: `Store query ${data['query_no'] as string}`,
    message: `${actor.name}: ${input.subject.trim()}`,
    targetRole: 'super_admin',
    relatedId: data['id'] as string,
  });
  return getQuery(data['id'] as string, actor);
}

export async function listQueries(opts: {
  actor: StoreActor;
  status?: StoreQueryStatus;
  search?: string;
  archived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<StorePage<StoreQuery> & { counts: Record<StoreQueryStatus | 'all', number> }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const mine = opts.actor.role === 'super_admin' ? null : opts.actor.uid;
  const base = (head = false) => {
    let q = db.from('store_queries').select(head ? 'id' : SELECT, { count: 'exact', head });
    q = opts.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
    if (mine) q = q.eq('raised_by', mine);
    return q;
  };
  let q = base();
  if (opts.status) q = q.eq('status', opts.status);
  const term = searchTerm(opts.search);
  if (term) q = q.or(`query_no.ilike.%${term}%,subject.ilike.%${term}%,raised_by_name.ilike.%${term}%`);
  const { data, error, count } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  const rows = api<Array<Record<string, unknown>>>(data ?? []).map(shape);

  // The latest Admin reply, for the list.
  if (rows.length) {
    const { data: msgs, error: mErr } = await db.from('store_query_messages').select('query_id, body, created_at')
      .in('query_id', rows.map((r) => r.id)).eq('author_side', 'admin').not('body', 'is', null)
      .order('created_at', { ascending: false }).range(0, 999);
    if (mErr) throw clientError(mErr);
    const last = new Map<string, string>();
    for (const m of api<Array<{ queryId: string; body: string }>>(msgs ?? [])) if (!last.has(m.queryId)) last.set(m.queryId, m.body);
    for (const r of rows) r.lastReply = last.get(r.id) ?? null;
  }

  const counts = { all: 0 } as Record<StoreQueryStatus | 'all', number>;
  for (const s of Object.keys(STORE_QUERY_STATUS_LABELS) as StoreQueryStatus[]) {
    const { count: c, error: cErr } = await base(true).eq('status', s);
    if (cErr) throw clientError(cErr);
    counts[s] = c ?? 0;
    counts.all += c ?? 0;
  }
  return { rows, total: count ?? 0, counts };
}

export async function getQuery(id: string, actor: StoreActor): Promise<StoreQuery> {
  const { data, error } = await db.from('store_queries').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw httpError(404, 'Query not found');
  const q = shape(api<Record<string, unknown>>(data));
  if (actor.role !== 'super_admin' && q.raisedBy !== actor.uid) throw httpError(404, 'Query not found');
  const { data: msgs, error: mErr } = await db.from('store_query_messages').select('*').eq('query_id', id).order('created_at').range(0, 999);
  if (mErr) throw clientError(mErr);
  q.messages = api<StoreQueryMessage[]>(msgs ?? []);
  return q;
}

/**
 * A reply and/or a status change. The raiser may reply (and so reopen a
 * Responded query); only Admin changes the status.
 */
export async function addMessage(id: string, input: StoreQueryMessageInput, actor: StoreActor): Promise<StoreQuery> {
  const q = await getQuery(id, actor);
  const isAdmin = actor.role === 'super_admin';
  if (input.status && !isAdmin) throw httpError(403, 'Only Admin changes the status of a query.');
  if (q.archivedAt) throw httpError(409, `${q.queryNo} is archived.`);
  if (!isAdmin && (q.status === 'resolved' || q.status === 'rejected')) throw httpError(409, `${q.queryNo} is closed. Raise a new query.`);
  const body = input.body?.trim() || null;
  let next: StoreQueryStatus | null = input.status ?? null;
  if (!next && isAdmin && body && (q.status === 'open' || q.status === 'in_review')) next = 'responded';
  if (!next && !isAdmin && body && q.status === 'responded') next = 'open';
  if (next === q.status) next = null;

  const { error } = await db.from('store_query_messages').insert({
    query_id: id, author_id: actor.uid, author_name: actor.name, author_side: side(actor.role), body, status_change: next,
  });
  if (error) throw clientError(error);
  if (next) {
    const { error: uErr } = await db.from('store_queries').update({ status: next }).eq('id', id);
    if (uErr) throw clientError(uErr);
    await audit('query', id, q.queryNo, `status ${next}`, body, actor);
  }
  if (isAdmin && q.raisedBy) {
    await tell({
      type: 'store_query_reply',
      title: `${q.queryNo}: ${next ? STORE_QUERY_STATUS_LABELS[next] : 'new reply'}`,
      message: body ?? `Admin marked it ${next ? STORE_QUERY_STATUS_LABELS[next].toLowerCase() : ''}.`,
      targetUserId: q.raisedBy,
      relatedId: id,
    });
  } else if (!isAdmin) {
    await tell({ type: 'store_query_reply', title: `${q.queryNo}: reply from ${actor.name}`, message: body ?? '', targetRole: 'super_admin', relatedId: id });
  }
  return getQuery(id, actor);
}

/** Admin's delete: the query leaves the queue; it and its thread are kept. */
export async function archiveQuery(id: string, actor: StoreActor): Promise<void> {
  const q = await getQuery(id, actor);
  if (q.status !== 'resolved' && q.status !== 'rejected') throw httpError(409, 'Resolve or reject a query before deleting it.');
  const { error } = await db.from('store_queries').update({ archived_at: new Date().toISOString(), archived_by: actor.uid, archived_by_name: actor.name }).eq('id', id);
  if (error) throw clientError(error);
  await audit('query', id, q.queryNo, 'archived', null, actor);
}
