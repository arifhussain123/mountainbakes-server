import type { WhatsAppConfig } from './config';
import type { SendOutcome, TemplateSend, TextSend, WhatsAppProvider } from './provider';

/**
 * WhatsApp Business Platform Cloud API — POST /{phone-number-id}/messages on
 * graph.facebook.com, authenticated with the system-user access token.
 *
 * A 200 from this endpoint means Meta ACCEPTED the message, nothing more. The
 * outbox records it as `accepted`; `sent`, `delivered`, `read` and `failed`
 * arrive later as webhook status events (webhook.ts), and only they move the
 * message on. Nothing here claims delivery.
 *
 * Calls `fetch` directly, as twilio.provider.ts does: one endpoint does not
 * justify an SDK dependency.
 */

const TIMEOUT_MS = 15_000;

/** Meta error codes worth retrying: throttling and transient platform faults. */
const RETRYABLE = new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131000, 131016, 131056, 133004]);
/** Outside the 24-hour customer-service window: only a template may be sent. */
const NEEDS_TEMPLATE = new Set([470, 131047]);

interface GraphError {
  error?: { code?: number; error_subcode?: number; message?: string; error_data?: { details?: string } };
}

export class MetaCloudProvider implements WhatsAppProvider {
  readonly name = 'meta' as const;

  constructor(private readonly cfg: WhatsAppConfig) {}

  sendTemplate(msg: TemplateSend): Promise<SendOutcome> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: msg.to,
      type: 'template',
      template: {
        name: msg.template,
        language: { code: msg.language },
        components: msg.params.length
          ? [{ type: 'body', parameters: msg.params.map((text) => ({ type: 'text', text: templateSafe(text) })) }]
          : [],
      },
    });
  }

  sendText(msg: TextSend): Promise<SendOutcome> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: msg.to,
      type: 'text',
      text: { body: msg.body.slice(0, 4096), preview_url: true },
    });
  }

  private async post(body: unknown): Promise<SendOutcome> {
    if (this.cfg.missing.length > 0) {
      return { ok: false, retryable: false, code: 'not_configured', error: `WhatsApp is not configured: ${this.cfg.missing.join(', ')} not set` };
    }
    const url = `https://graph.facebook.com/${this.cfg.apiVersion}/${encodeURIComponent(this.cfg.phoneNumberId)}/messages`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout: the request may or may not have reached
      // Meta. Retrying risks a duplicate MESSAGE (never a duplicate demand —
      // the outbox row is the same row), which is the lesser harm.
      return { ok: false, retryable: true, code: 'network', error: (err as Error).name === 'TimeoutError' ? 'Timed out' : 'Network error' };
    }

    const json = (await res.json().catch(() => ({}))) as GraphError & { messages?: Array<{ id?: string }> };
    const id = json.messages?.[0]?.id;
    if (res.ok && id) return { ok: true, providerMessageId: id };

    const code = json.error?.code ?? res.status;
    const message = json.error?.error_data?.details || json.error?.message || `HTTP ${res.status}`;
    return {
      ok: false,
      retryable: res.status >= 500 || res.status === 429 || RETRYABLE.has(code),
      needsTemplate: NEEDS_TEMPLATE.has(code),
      code: String(code),
      error: message.slice(0, 500),
    };
  }
}

/**
 * Meta refuses a template variable containing a newline, a tab or more than
 * four consecutive spaces. Collapse them rather than fail the send.
 */
export function templateSafe(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000) || '-';
}
