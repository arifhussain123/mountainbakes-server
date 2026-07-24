/**
 * Provider-agnostic outbound messaging.
 *
 * Business logic (the closing dispatcher) only ever sees this interface, so
 * swapping WhatsApp Business API for Twilio, Vonage, or anything else is a
 * config change rather than a code change. Every provider must:
 *
 *   - never throw for a delivery failure — return { ok: false, error } instead,
 *     so the dispatcher can log and retry per its own policy;
 *   - be safe to call with either channel; if it cannot serve a channel it
 *     returns ok:false rather than silently sending over the other one.
 */

export type OutboundChannel = 'whatsapp' | 'sms';

export interface OutboundMessage {
  to: string;        // E.164, e.g. +923001234567
  body: string;
  channel: OutboundChannel;
}

export interface SendResult {
  ok: boolean;
  /** Provider-side id, stored as notification_logs.provider_message_id. */
  messageId?: string;
  error?: string;
}

export interface MessageProvider {
  /** Stable slug recorded on every log row (`log`, `twilio`, …). */
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}
