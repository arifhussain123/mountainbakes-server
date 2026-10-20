import { whatsappConfig } from './config';
import { MetaCloudProvider } from './meta.provider';
import { MockWhatsAppProvider } from './mock.provider';

/**
 * The seam between WhatsApp Purchasing and whoever carries the message.
 *
 * Separate from services/messaging/ (the Twilio SMS / closing-summary path) on
 * purpose: that interface is one string to one number, fire and forget. This
 * one sends approved templates, reports whether a failure is worth retrying,
 * and returns the provider's message id that delivery receipts arrive against.
 *
 * A provider never throws for a delivery failure; it returns ok:false.
 */

export interface TemplateSend {
  to: string; // WhatsApp id: country code + number, digits only
  template: string;
  language: string;
  /** Body variables {{1}}, {{2}} … in order. */
  params: string[];
}

export interface TextSend {
  to: string;
  body: string;
}

export type SendOutcome =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      /** Worth trying again later (rate limit, timeout, 5xx). */
      retryable: boolean;
      /** The free-text window is closed: send the template instead. */
      needsTemplate?: boolean;
      code: string;
      error: string;
    };

export interface WhatsAppProvider {
  readonly name: 'meta' | 'mock';
  sendTemplate(msg: TemplateSend): Promise<SendOutcome>;
  sendText(msg: TextSend): Promise<SendOutcome>;
}

let override: WhatsAppProvider | null = null;

/** Tests hand in their own provider. */
export function setWhatsAppProvider(next: WhatsAppProvider | null): void {
  override = next;
}

export function getWhatsAppProvider(): WhatsAppProvider {
  if (override) return override;
  const cfg = whatsappConfig();
  if (cfg.provider === 'meta') return new MetaCloudProvider(cfg);
  return mockSingleton;
}

const mockSingleton = new MockWhatsAppProvider();
