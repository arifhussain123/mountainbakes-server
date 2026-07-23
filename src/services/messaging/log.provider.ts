import type { MessageProvider, OutboundMessage, SendResult } from './provider';

/**
 * The default provider: writes the message to the server log instead of sending
 * it anywhere.
 *
 * This is deliberately the fallback whenever no real provider is configured, so
 * the whole closing pipeline (report generation → recipient fan-out → delivery
 * logging → retry → escalation) is fully exercisable with zero credentials and
 * without messaging a real customer by accident. Every attempt still produces a
 * notification_logs row, so the admin UI looks identical to a live run.
 */
export class LogProvider implements MessageProvider {
  readonly name = 'log';

  async send(message: OutboundMessage): Promise<SendResult> {
    const preview = message.body.replace(/\n+/g, ' | ').slice(0, 160);
    console.log(`[messaging:log] ${message.channel} → ${message.to} :: ${preview}`);
    // A deterministic, obviously-fake id so these are easy to spot in the logs table.
    return { ok: true, messageId: `log-${message.channel}-${Date.now()}` };
  }
}
