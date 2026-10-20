import type { WhatsAppConnectionStatus, WhatsAppConversation, WhatsAppMessage } from '../../shared';
import { whatsappConfig } from '../whatsapp/config';
import { kickOutbox } from '../whatsapp/outbox';
import { api, call, clientError, db, notFound, waId, type Actor } from './common';
import { shapeMessage } from './demands.service';
import { replyMessage } from './messages';

/**
 * The conversation side of the WhatsApp Purchasing page: every message to and
 * from the authorized Production number, failed sends and their retry, and
 * the Unmatched queue for messages nobody can be sure about.
 */

type Row = Record<string, unknown>;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const MESSAGE_SELECT =
  '*, conversation:whatsapp_conversations(wa_id), outbox:whatsapp_outbox(attempts, next_attempt_at, status), demand:purchase_demands(demand_no), supplier:suppliers(name)';

export async function connectionStatus(): Promise<WhatsAppConnectionStatus> {
  const cfg = whatsappConfig();
  const [numRes, pendingRes, failedRes] = await Promise.all([
    cfg.phoneNumberId
      ? db.from('whatsapp_business_numbers').select('*').eq('phone_number_id', cfg.phoneNumberId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from('whatsapp_outbox').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing']),
    db.from('whatsapp_messages').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
  ]);
  if (numRes.error) throw clientError(numRes.error);
  const num = numRes.data as Row | null;
  const state: WhatsAppConnectionStatus['state'] =
    cfg.provider === 'mock' ? 'mock' : cfg.missing.length > 0 ? 'configuration_required' : num?.['last_webhook_at'] ? 'connected' : 'awaiting_webhook';
  return {
    provider: cfg.provider,
    state,
    phoneNumberId: cfg.phoneNumberId || null,
    displayPhoneNumber: cfg.displayNumber || (num?.['display_phone_number'] as string) || null,
    authorized: cfg.provider === 'meta' && !!cfg.phoneNumberId,
    apiVersion: cfg.apiVersion,
    lastWebhookAt: (num?.['last_webhook_at'] as string) ?? null,
    missing: cfg.missing,
    templates: { demand: cfg.templateDemand, update: cfg.templateUpdate, language: cfg.templateLanguage },
    outbox: { pending: pendingRes.count ?? 0, failed: failedRes.count ?? 0 },
  };
}

export async function listConversations(opts: { search?: string; limit?: number; offset?: number }): Promise<{ conversations: WhatsAppConversation[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = db.from('whatsapp_conversations').select('*, supplier:suppliers(name)', { count: 'exact' });
  const term = opts.search?.replace(/[(),*%]/g, ' ').trim();
  if (term) q = q.or(`wa_id.ilike.%${term.replace(/\D/g, '') || term}%,profile_name.ilike.%${term}%`);
  const { data, error, count } = await q.order('last_message_at', { ascending: false, nullsFirst: false }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  const rows = (data ?? []) as Row[];

  // Last message per conversation, one query for the page.
  const ids = rows.map((r) => String(r['id']));
  const last = new Map<string, Row>();
  if (ids.length) {
    const { data: msgs, error: mErr } = await db
      .from('whatsapp_messages')
      .select('conversation_id, body, direction, status, created_at')
      .in('conversation_id', ids)
      .order('created_at', { ascending: false })
      .limit(500);
    if (mErr) throw clientError(mErr);
    for (const m of (msgs ?? []) as Row[]) if (!last.has(String(m['conversation_id']))) last.set(String(m['conversation_id']), m);
  }

  return {
    conversations: rows.map((r) => {
      const supplier = (Array.isArray(r['supplier']) ? r['supplier'][0] : r['supplier']) as Row | null;
      const inbound = r['last_inbound_at'] ? new Date(String(r['last_inbound_at'])).getTime() : 0;
      const m = last.get(String(r['id']));
      return {
        id: String(r['id']),
        waId: String(r['wa_id']),
        supplierId: (r['supplier_id'] as string) ?? null,
        supplierName: (supplier?.['name'] as string) ?? null,
        profileName: (r['profile_name'] as string) ?? null,
        lastInboundAt: (r['last_inbound_at'] as string) ?? null,
        lastMessageAt: (r['last_message_at'] as string) ?? null,
        unreadCount: Number(r['unread_count'] ?? 0),
        windowOpenUntil: inbound && Date.now() - inbound < WINDOW_MS ? new Date(inbound + WINDOW_MS).toISOString() : null,
        lastMessage: m ? api(m) : null,
      } as WhatsAppConversation;
    }),
    total: count ?? 0,
  };
}

export async function listMessages(opts: {
  conversationId?: string;
  supplierId?: string;
  demandId?: string;
  filter?: 'failed' | 'unmatched' | 'inbound' | 'outbound';
  limit?: number;
  offset?: number;
}): Promise<{ messages: WhatsAppMessage[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = db.from('whatsapp_messages').select(MESSAGE_SELECT, { count: 'exact' });
  if (opts.conversationId) q = q.eq('conversation_id', opts.conversationId);
  if (opts.supplierId) q = q.eq('supplier_id', opts.supplierId);
  if (opts.demandId) q = q.eq('demand_id', opts.demandId);
  if (opts.filter === 'failed') q = q.eq('status', 'failed');
  if (opts.filter === 'unmatched') q = q.eq('match_status', 'unmatched');
  if (opts.filter === 'inbound' || opts.filter === 'outbound') q = q.eq('direction', opts.filter);
  const { data, error, count } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  return { messages: ((data ?? []) as Row[]).map(shapeMessage), total: count ?? 0 };
}

/** Opening a conversation marks it read. */
export async function markConversationRead(id: string): Promise<void> {
  const { error } = await db.from('whatsapp_conversations').update({ unread_count: 0 }).eq('id', id);
  if (error) throw clientError(error);
}

async function oneMessage(id: string): Promise<WhatsAppMessage> {
  const { data, error } = await db.from('whatsapp_messages').select(MESSAGE_SELECT).eq('id', id).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw notFound('Message');
  return shapeMessage(data as Row);
}

export async function retryMessage(id: string, actor: Actor): Promise<WhatsAppMessage> {
  await call('whatsapp_retry_message', { p_message_id: id, p_actor_id: actor.uid, p_actor_name: actor.name });
  kickOutbox();
  return oneMessage(id);
}

export async function reviewMessage(id: string, input: { action: 'assign' | 'dismiss'; supplierId?: string | null; demandId?: string | null }, actor: Actor): Promise<WhatsAppMessage> {
  await call('whatsapp_review_message', {
    p_message_id: id,
    p_action: input.action,
    p_supplier_id: input.supplierId ?? null,
    p_demand_id: input.demandId ?? null,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  return oneMessage(id);
}

/**
 * A free-text reply to a conversation. Only inside the 24-hour window (the
 * contact wrote within the last day): outside it WhatsApp accepts templates
 * only, and a template cannot carry an arbitrary message, so this refuses up
 * front instead of queueing something that can only fail.
 */
export async function reply(conversationId: string, input: { body: string; demandId?: string | null; clientRequestId?: string }, actor: Actor): Promise<WhatsAppMessage> {
  const { data: conv, error } = await db.from('whatsapp_conversations').select('*').eq('id', conversationId).maybeSingle();
  if (error) throw clientError(error);
  if (!conv) throw notFound('Conversation');
  const inbound = conv['last_inbound_at'] ? new Date(String(conv['last_inbound_at'])).getTime() : 0;
  if (!inbound || Date.now() - inbound >= WINDOW_MS) {
    throw Object.assign(
      new Error('The 24-hour reply window is closed: WhatsApp only allows approved templates until the supplier writes again. Use "Resend link" on the demand instead.'),
      { status: 409 },
    );
  }
  if (input.demandId) {
    const { data: d } = await db.from('purchase_demands').select('supplier_id').eq('id', input.demandId).maybeSingle();
    if (!d || (conv['supplier_id'] && d['supplier_id'] !== conv['supplier_id'])) {
      throw Object.assign(new Error('That demand is not with this supplier.'), { status: 400 });
    }
  }
  const message = replyMessage(String(conv['wa_id']), input.body.trim(), {
    supplierId: (conv['supplier_id'] as string) ?? null,
    demandId: input.demandId ?? null,
    dedupeKey: `reply:${conversationId}:${input.clientRequestId ?? `${actor.uid}:${Date.now()}`}`,
  });
  const row = await call<Row>('whatsapp_queue_reply', { p_message: message, p_actor_id: actor.uid, p_actor_name: actor.name });
  kickOutbox();
  return oneMessage(String(row['id']));
}

/** For tests and the status panel: the WhatsApp id of a stored number. */
export const toWaId = waId;
