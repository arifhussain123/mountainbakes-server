import { dbFor } from '../../db';
import { whatsappConfig } from './config';
import { getWhatsAppProvider, type SendOutcome } from './provider';

const db = dbFor('whatsapp');

/**
 * The outbox worker: sends what the purchasing functions queued, after their
 * transaction committed.
 *
 * Every business action that tells a supplier something writes a
 * whatsapp_messages row ('queued') and a whatsapp_outbox row in the SAME
 * transaction as the change itself (app.enqueue_whatsapp). So a demand is
 * never sent without its record existing, and a record is never committed
 * without its message queued. This loop picks the rows up, calls the provider
 * and reports back with whatsapp_complete_outbox — no network call ever runs
 * inside a database transaction.
 *
 * TEXT OR TEMPLATE is decided here, at send time, not when the row was queued:
 * free text is only allowed within 24 hours of the contact's last message, so
 * whether the window is open is a fact about NOW. A row carries both; outside
 * the window the approved template goes instead. A text-only row (a staff
 * reply) whose window has closed fails with a message saying so.
 *
 * Safe to run on several processes at once: rows are leased with
 * `for update skip locked`, and a lease that lapses (a process died mid-send)
 * returns the row to the queue.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const BATCH = 10;
// Outlives the slowest batch (each row: a 15 s text attempt, then a 15 s
// template fallback), so a second process — a deploy's overlap — never
// re-claims a row this one is still sending. A process that dies mid-batch
// delays those rows by this much, which is the cheaper failure.
const LEASE_SECONDS = BATCH * 30 + 60;

interface OutboxRow {
  id: string;
  message_id: string;
  to_wa_id: string;
  text_body: string | null;
  template_name: string | null;
  template_language: string;
  template_params: unknown;
  attempts: number;
}

async function windowOpen(waId: string): Promise<boolean> {
  const { data } = await db.from('whatsapp_conversations').select('last_inbound_at').eq('wa_id', waId).maybeSingle();
  const at = data?.last_inbound_at ? new Date(String(data.last_inbound_at)).getTime() : 0;
  return at > 0 && Date.now() - at < WINDOW_MS;
}

async function deliver(row: OutboxRow): Promise<{ outcome: SendOutcome; usedTemplate: boolean }> {
  const provider = getWhatsAppProvider();
  const params = Array.isArray(row.template_params) ? row.template_params.map(String) : [];
  const template = row.template_name
    ? { to: row.to_wa_id, template: row.template_name, language: row.template_language, params }
    : null;

  if (row.text_body && (await windowOpen(row.to_wa_id))) {
    const outcome = await provider.sendText({ to: row.to_wa_id, body: row.text_body });
    if (!outcome.ok && outcome.needsTemplate && template) {
      return { outcome: await provider.sendTemplate(template), usedTemplate: true };
    }
    return { outcome, usedTemplate: false };
  }
  if (template) return { outcome: await provider.sendTemplate(template), usedTemplate: true };
  return {
    outcome: {
      ok: false,
      retryable: false,
      needsTemplate: true,
      code: 'window_closed',
      error: 'The 24-hour reply window is closed. A free-text message can only go after the supplier writes again.',
    },
    usedTemplate: false,
  };
}

/** Send every due row once. Returns how many were attempted. */
export async function processOutboxOnce(): Promise<number> {
  const { data, error } = await db.rpc<OutboxRow[]>('whatsapp_claim_outbox', { p_limit: BATCH, p_lease_seconds: LEASE_SECONDS });
  if (error) throw error;
  const rows = data ?? [];
  const provider = getWhatsAppProvider().name;

  for (const row of rows) {
    let result: { outcome: SendOutcome; usedTemplate: boolean };
    try {
      result = await deliver(row);
    } catch (err) {
      result = { outcome: { ok: false, retryable: true, code: 'exception', error: (err as Error).message }, usedTemplate: false };
    }
    const { outcome, usedTemplate } = result;
    const { error: doneErr } = await db.rpc('whatsapp_complete_outbox', {
      p_id: row.id,
      p_ok: outcome.ok,
      p_provider: provider,
      p_provider_message_id: outcome.ok ? outcome.providerMessageId : null,
      p_used_template: usedTemplate,
      p_retryable: outcome.ok ? false : outcome.retryable,
      p_error_code: outcome.ok ? null : outcome.code,
      p_error: outcome.ok ? null : outcome.error,
    });
    if (doneErr) console.error('[whatsapp] could not record outbox result', row.id, doneErr.message);
    // Never the body: it may carry a supplier link.
    if (!outcome.ok) console.warn(`[whatsapp] send failed (${outcome.code}) for outbox ${row.id}, attempt ${row.attempts}`);
  }
  return rows.length;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Drain: a busy queue does not wait a whole interval between batches.
    for (let i = 0; i < 20 && (await processOutboxOnce()) === BATCH; i++);
    const { processPendingWebhookEvents } = await import('./webhook');
    await processPendingWebhookEvents();
  } catch (err) {
    console.error('[whatsapp] outbox tick failed', (err as Error).message);
  } finally {
    running = false;
  }
}

let autoKick = true;

/** Tests drive the worker by hand (processOutboxOnce) and switch this off. */
export function setOutboxAutoKick(on: boolean): void {
  autoKick = on;
}

/** Ask for a send now rather than at the next interval — after a commit that queued one. */
export function kickOutbox(): void {
  if (autoKick) setImmediate(() => void tick());
}

export function startWhatsAppOutboxWorker(): void {
  if (timer) return;
  const every = Number(process.env['WHATSAPP_OUTBOX_INTERVAL_MS']) || 5_000;
  timer = setInterval(() => void tick(), Math.max(1_000, every));
  timer.unref?.();
  const cfg = whatsappConfig();
  console.log(
    `[whatsapp] outbox worker every ${Math.max(1_000, every)}ms, provider=${cfg.provider}` +
      (cfg.provider === 'mock' ? ' (messages are recorded, NOT delivered)' : ''),
  );
}

export function stopWhatsAppOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
