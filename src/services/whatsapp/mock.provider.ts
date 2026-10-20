import { randomUUID } from 'node:crypto';
import type { SendOutcome, TemplateSend, TextSend, WhatsAppProvider } from './provider';

export interface MockSent {
  kind: 'template' | 'text';
  to: string;
  template?: string;
  params?: string[];
  body?: string;
  providerMessageId: string;
}

/**
 * Stands in for Meta until credentials exist, and in tests. Records what it
 * was asked to send and answers like the Cloud API accepting it — which is
 * all it claims: the message is never delivered to anyone, and the page says
 * "Mock provider" beside the connection so nobody reads it otherwise. No
 * delivery receipt ever arrives for a mock id.
 *
 * `failNext` queues outcomes for tests (a rate limit, a closed window).
 */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'mock' as const;
  readonly sent: MockSent[] = [];
  private queued: SendOutcome[] = [];

  failNext(...outcomes: SendOutcome[]): void {
    this.queued.push(...outcomes);
  }

  reset(): void {
    this.sent.length = 0;
    this.queued.length = 0;
  }

  async sendTemplate(msg: TemplateSend): Promise<SendOutcome> {
    const queued = this.queued.shift();
    if (queued) return queued;
    const providerMessageId = `mock.${randomUUID()}`;
    this.sent.push({ kind: 'template', to: msg.to, template: msg.template, params: msg.params, providerMessageId });
    return { ok: true, providerMessageId };
  }

  async sendText(msg: TextSend): Promise<SendOutcome> {
    const queued = this.queued.shift();
    if (queued) return queued;
    const providerMessageId = `mock.${randomUUID()}`;
    this.sent.push({ kind: 'text', to: msg.to, body: msg.body, providerMessageId });
    return { ok: true, providerMessageId };
  }
}
