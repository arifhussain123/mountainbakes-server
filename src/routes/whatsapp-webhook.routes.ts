import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { whatsappConfig } from '../services/whatsapp/config';
import { processWebhookEvents, storeWebhookPayload, verificationChallenge, verifySignature } from '../services/whatsapp/webhook';

/**
 * The WhatsApp Cloud API webhook: GET for Meta's verification handshake, POST
 * for messages and delivery receipts.
 *
 * Mounted in app.ts BEFORE the JSON body parser, with its own raw parser: the
 * signature is an HMAC of the exact bytes Meta sent, and a body that has been
 * parsed and re-serialised no longer matches it.
 *
 * Callback URL to register in the Meta app: https://<api host>/api/whatsapp/webhook
 */
export const router = Router();

router.use(rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));

router.get('/', (req, res) => {
  const challenge = verificationChallenge(req.query as Record<string, unknown>);
  if (challenge === null) {
    res.sendStatus(403);
    return;
  }
  res.type('text/plain').send(challenge);
});

router.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const { appSecret } = whatsappConfig();
  if (!verifySignature(raw, req.get('x-hub-signature-256') ?? undefined, appSecret)) {
    // Never logs the body or the header: neither is ours to keep.
    res.sendStatus(401);
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }

  let fresh: Awaited<ReturnType<typeof storeWebhookPayload>>;
  try {
    fresh = await storeWebhookPayload(body);
  } catch (err) {
    // Not stored: a 500 makes Meta deliver it again, which is what we want.
    console.error('[whatsapp] webhook store failed', (err as Error).message);
    res.sendStatus(500);
    return;
  }
  res.sendStatus(200);
  // Processed after answering. Anything this pass misses, the outbox worker's
  // recovery sweep picks up from whatsapp_webhook_events.
  void processWebhookEvents(fresh);
});
