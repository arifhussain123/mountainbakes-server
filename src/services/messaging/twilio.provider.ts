import type { MessageProvider, OutboundMessage, SendResult } from './provider';

/**
 * Twilio adapter for both SMS and WhatsApp.
 *
 * Uses Twilio's REST API directly over fetch rather than pulling in the SDK — the
 * call is one form POST, and avoiding the dependency keeps the server's install
 * small (Node 24 has global fetch).
 *
 * Config (all from env; secrets never live in the settings row):
 *   TWILIO_ACCOUNT_SID    ACxxxxxxxx
 *   TWILIO_AUTH_TOKEN     the account's auth token
 *   TWILIO_SMS_FROM       a Twilio SMS-capable number, e.g. +14155551234
 *   TWILIO_WHATSAPP_FROM  the WhatsApp sender, e.g. +14155238886
 *
 * NOTE on WhatsApp: outside a 24-hour customer-service window Meta only permits
 * PRE-APPROVED TEMPLATE messages. A daily closing summary is an unsolicited
 * business-initiated message, so in production the body must correspond to an
 * approved template or Twilio rejects it (error 63016). That rejection surfaces
 * here as { ok:false, error }, which the dispatcher logs and retries.
 */
export class TwilioProvider implements MessageProvider {
  readonly name = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly smsFrom: string,
    private readonly whatsappFrom: string,
  ) {}

  /** True when the env holds enough to actually send. */
  static fromEnv(): TwilioProvider | null {
    const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const smsFrom = (process.env.TWILIO_SMS_FROM || '').trim();
    const waFrom = (process.env.TWILIO_WHATSAPP_FROM || '').trim();
    if (!sid || !token) return null;
    if (!smsFrom && !waFrom) return null;
    return new TwilioProvider(sid, token, smsFrom, waFrom);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const isWhatsApp = message.channel === 'whatsapp';
    const from = isWhatsApp ? this.whatsappFrom : this.smsFrom;
    if (!from) {
      return { ok: false, error: `Twilio has no ${message.channel} sender configured` };
    }

    const body = new URLSearchParams({
      From: isWhatsApp ? `whatsapp:${from}` : from,
      To: isWhatsApp ? `whatsapp:${message.to}` : message.to,
      Body: message.body,
    });

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );

      const payload = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
      if (!res.ok) {
        const detail = payload.message || `HTTP ${res.status}`;
        return { ok: false, error: payload.code ? `${detail} (Twilio ${payload.code})` : detail };
      }
      return { ok: true, messageId: payload.sid };
    } catch (err) {
      // Network-level failure — the dispatcher's retry policy decides what happens next.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
