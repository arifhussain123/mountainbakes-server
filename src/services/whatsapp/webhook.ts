import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { dbFor } from '../../db';
import { notify } from '../push.service';
import { whatsappConfig } from './config';

const db = dbFor('whatsapp');

/**
 * Inbound side of the Cloud API: the verification handshake, the signature
 * check, and turning each delivery into stored events that are processed once.
 *
 * ORDER OF WORK for a POST, and why:
 *   1. Signature (X-Hub-Signature-256: HMAC-SHA256 of the RAW body with the
 *      app secret). Anything unsigned or mis-signed is refused before it is
 *      parsed, let alone stored.
 *   2. Store every message / status in whatsapp_webhook_events under a dedupe
 *      key (`msg:<wamid>`, `status:<wamid>:<status>`). Meta redelivers what it
 *      did not see a 200 for, and sometimes what it did; the unique key makes
 *      the second copy a no-op.
 *   3. Answer 200 — then process. A slow database must not turn into Meta
 *      retrying a delivery we already hold. Whatever the in-request pass does
 *      not finish, the outbox worker's tick picks up (processPendingWebhookEvents).
 *
 * Processing never approves, rejects or pays anything. An inbound message is
 * stored, tied to a supplier by its sender's number and to a demand only when
 * that is certain, and Production is told. Everything else is a person's call.
 */

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** GET handshake: echo the challenge only for our own verify token. */
export function verificationChallenge(query: Record<string, unknown>): string | null {
  const { verifyToken } = whatsappConfig();
  if (!verifyToken) return null;
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return challenge;
}

interface StoredEvent {
  id: string;
  dedupe_key: string;
  kind: 'message' | 'status' | 'other';
  payload: Record<string, unknown>;
  attempts?: number;
}

/** Split a webhook body into one stored event per message / status. Returns the NEW ones. */
export async function storeWebhookPayload(body: unknown): Promise<StoredEvent[]> {
  const entries = Array.isArray((body as { entry?: unknown })?.entry) ? ((body as { entry: unknown[] }).entry) : [];
  const rows: Array<Omit<StoredEvent, 'id'>> = [];

  for (const entry of entries) {
    const changes = Array.isArray((entry as { changes?: unknown }).changes) ? (entry as { changes: unknown[] }).changes : [];
    for (const change of changes) {
      const value = ((change as { value?: unknown }).value ?? {}) as Record<string, unknown>;
      const metadata = (value['metadata'] ?? {}) as Record<string, unknown>;
      const contacts = Array.isArray(value['contacts']) ? (value['contacts'] as Array<Record<string, unknown>>) : [];
      const messages = Array.isArray(value['messages']) ? (value['messages'] as Array<Record<string, unknown>>) : [];
      const statuses = Array.isArray(value['statuses']) ? (value['statuses'] as Array<Record<string, unknown>>) : [];

      for (const m of messages) {
        const contact = contacts.find((c) => c['wa_id'] === m['from']) ?? contacts[0];
        rows.push({ dedupe_key: `msg:${String(m['id'])}`, kind: 'message', payload: { metadata, contact, message: m } });
      }
      for (const s of statuses) {
        rows.push({ dedupe_key: `status:${String(s['id'])}:${String(s['status'])}`, kind: 'status', payload: { metadata, status: s } });
      }
      if (messages.length === 0 && statuses.length === 0) {
        const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
        rows.push({ dedupe_key: `other:${hash}`, kind: 'other', payload: { field: (change as { field?: unknown }).field, value } });
      }
    }
  }
  if (rows.length === 0) return [];

  const { data, error } = await db
    .from('whatsapp_webhook_events')
    .upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true })
    .select('id, dedupe_key, kind, payload');
  if (error) throw error;
  return (data ?? []) as StoredEvent[];
}

function authorizedNumberId(): string | null {
  return whatsappConfig().phoneNumberId || null;
}

async function touchNumber(metadata: Record<string, unknown>): Promise<boolean> {
  const id = typeof metadata['phone_number_id'] === 'string' ? metadata['phone_number_id'] : null;
  if (!id) return false;
  const authorized = id === authorizedNumberId();
  await db.from('whatsapp_business_numbers').upsert(
    {
      phone_number_id: id,
      display_phone_number: typeof metadata['display_phone_number'] === 'string' ? metadata['display_phone_number'] : null,
      is_authorized: authorized,
      purpose: authorized ? 'production' : 'other',
      last_webhook_at: new Date().toISOString(),
    },
    { onConflict: 'phone_number_id' },
  );
  return authorized;
}

/** What a person reads for an inbound message of any type. */
export function inboundBody(m: Record<string, unknown>): { type: string; body: string | null; media: Record<string, unknown> | null } {
  const type = String(m['type'] ?? 'unknown');
  const part = (m[type] ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'text':
      return { type, body: String((part['body'] as string) ?? ''), media: null };
    case 'button':
      return { type, body: String(part['text'] ?? part['payload'] ?? ''), media: null };
    case 'interactive': {
      const reply = (part['button_reply'] ?? part['list_reply'] ?? {}) as Record<string, unknown>;
      return { type, body: String(reply['title'] ?? ''), media: null };
    }
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker': {
      // The media itself stays with Meta (id + type only); nothing is
      // downloaded or exposed through the API.
      const caption = typeof part['caption'] === 'string' ? part['caption'] : '';
      const filename = typeof part['filename'] === 'string' ? ` ${part['filename']}` : '';
      return {
        type,
        body: `[${type}${filename}]${caption ? ` ${caption}` : ''}`,
        media: { id: part['id'] ?? null, mimeType: part['mime_type'] ?? null, filename: part['filename'] ?? null },
      };
    }
    case 'location':
      return { type, body: `[location] ${String(part['name'] ?? '')} ${String(part['latitude'] ?? '')},${String(part['longitude'] ?? '')}`.trim(), media: null };
    default:
      return { type, body: `[${type} message]`, media: null };
  }
}

/** The receipt statuses whatsapp_apply_status acts on. */
const KNOWN_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

async function processEvent(ev: StoredEvent): Promise<void> {
  const metadata = (ev.payload['metadata'] ?? {}) as Record<string, unknown>;

  if (ev.kind === 'other') {
    await markProcessed(ev.id, null);
    return;
  }
  const authorized = await touchNumber(metadata);
  if (!authorized) {
    // Another number on the same app (a branch line, a test number): stored
    // for the record, never acted on by purchasing.
    await markProcessed(ev.id, 'not the authorized Production number');
    return;
  }

  if (ev.kind === 'status') {
    const s = ev.payload['status'] as Record<string, unknown>;
    const errors = Array.isArray(s['errors']) ? (s['errors'] as Array<Record<string, unknown>>) : [];
    const err = errors[0];
    const ts = Number(s['timestamp']);
    const { data, error } = await db.rpc<boolean>('whatsapp_apply_status', {
      p_provider_message_id: String(s['id']),
      p_status: String(s['status']),
      p_at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
      p_error_code: err ? String(err['code'] ?? '') : null,
      p_error_title: err ? String(err['title'] ?? '') : null,
      p_error_detail: err ? String(((err['error_data'] as Record<string, unknown>)?.['details'] as string) ?? err['message'] ?? '') : null,
    });
    if (error) throw error;
    // A receipt can overtake our own record of the send: Meta answers the send
    // and fires the status webhook at once, and whatsapp_complete_outbox may
    // not have stored the message id yet. Left unprocessed, the recovery sweep
    // tries again (five attempts) instead of losing the status.
    if (data === false && KNOWN_STATUSES.has(String(s['status']))) {
      throw new Error('status for a message id not recorded yet');
    }
    await markProcessed(ev.id, null);
    return;
  }

  const m = ev.payload['message'] as Record<string, unknown>;
  const contact = (ev.payload['contact'] ?? {}) as Record<string, unknown>;
  const profile = (contact['profile'] ?? {}) as Record<string, unknown>;
  const { type, body, media } = inboundBody(m);
  const ts = Number(m['timestamp']);
  const context = (m['context'] ?? {}) as Record<string, unknown>;
  const { data, error } = await db.rpc<{ id: string; duplicate: boolean; matchStatus: string; supplierId: string | null; demandId: string | null }>(
    'whatsapp_record_inbound',
    {
      p: {
        providerMessageId: String(m['id']),
        waId: String(m['from'] ?? '').replace(/\D/g, ''),
        profileName: typeof profile['name'] === 'string' ? profile['name'] : null,
        type,
        body,
        media,
        replyToProviderId: typeof context['id'] === 'string' ? context['id'] : null,
        phoneNumberId: metadata['phone_number_id'] ?? null,
        at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
      },
    },
  );
  if (error) throw error;
  await markProcessed(ev.id, null);

  if (data && !data.duplicate) {
    const who = typeof profile['name'] === 'string' ? profile['name'] : `+${String(m['from'] ?? '')}`;
    try {
      await notify({
        type: 'purchase_message',
        title: data.matchStatus === 'matched' ? 'Supplier message' : 'Unmatched WhatsApp message',
        message: `${who}: ${(body ?? '').slice(0, 140)}`,
        targetRole: 'production_user',
        relatedId: data.demandId ?? data.id,
      });
    } catch (err) {
      console.error('[whatsapp] notify failed', (err as Error).message);
    }
  }
}

async function markProcessed(id: string, note: string | null): Promise<void> {
  await db.from('whatsapp_webhook_events').update({ processed_at: new Date().toISOString(), last_error: note }).eq('id', id);
}

async function processSafely(ev: StoredEvent): Promise<void> {
  try {
    await processEvent(ev);
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? 'error';
    console.error('[whatsapp] webhook event failed', ev.dedupe_key, message);
    await db
      .from('whatsapp_webhook_events')
      .update({ attempts: (ev.attempts ?? 0) + 1, last_error: message })
      .eq('id', ev.id);
  }
}

export async function processWebhookEvents(events: StoredEvent[]): Promise<void> {
  for (const ev of events) await processSafely(ev);
}

/** The recovery pass: anything stored but not processed (a crash, a DB blip). */
export async function processPendingWebhookEvents(): Promise<void> {
  const cutoff = new Date(Date.now() - 10_000).toISOString();
  const { data, error } = await db
    .from('whatsapp_webhook_events')
    .select('id, dedupe_key, kind, payload, attempts')
    .is('processed_at', null)
    .lt('received_at', cutoff)
    .lt('attempts', 5)
    .order('received_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  await processWebhookEvents((data ?? []) as StoredEvent[]);
}
