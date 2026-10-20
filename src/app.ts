import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { setupRoutes } from './routes/index';
import { errorHandler } from './middleware/errorHandler';
import { dbFor } from './db';
import { router as whatsappWebhookRouter } from './routes/whatsapp-webhook.routes';

const db = dbFor('health');

/** The configured Express application (no network binding — see ../server.ts). */
export const app = express();

app.use(helmet());

// Allowed browser origins. Defaults to the web URL, but accepts a comma-separated
// CORS_ORIGINS override for LAN IPs / deployed domains. localhost and 127.0.0.1 on
// any port are always allowed in practice, since they're the same dev machine.
export const allowedOrigins = (process.env.CORS_ORIGINS || process.env.NEXT_PUBLIC_WEB_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Non-browser requests (curl, server-to-server) send no Origin header.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    // Disallowed origin: omit CORS headers so the browser blocks it, without
    // throwing (which would surface as a noisy 500 on every foreign preflight).
    callback(null, false);
  },
  credentials: true,
}));
// The WhatsApp webhook reads its body raw — Meta signs the exact bytes — so it
// is mounted ahead of the JSON parser, which would otherwise consume them.
app.use('/api/whatsapp/webhook', whatsappWebhookRouter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  // The notification feed is polled on a timer by every open tab and carries
  // its own per-user limiter (routes/notifications.routes.ts). Counted here it
  // would spend this shared allowance on idle tabs.
  skip: (req) => req.method === 'GET' && req.path === '/api/notifications',
}));

/**
 * Liveness, plus whether the database answers.
 *
 * One HEAD read of the singleton `settings` row — no body, no count. Reports
 * two words and nothing else: no host, no error text, nothing a stranger could
 * learn the deployment from. 503 when the database does not answer, so an
 * uptime monitor sees the outage that a static 200 would hide.
 */
app.get('/health', async (_req, res) => {
  let database: 'connected' | 'unreachable' = 'unreachable';
  try {
    const { error } = await db.from('settings').select('id', { head: true }).limit(1);
    if (!error) database = 'connected';
  } catch {
    // Network-level failure — already 'unreachable'.
  }
  res
    .status(database === 'connected' ? 200 : 503)
    .json({ status: database === 'connected' ? 'ok' : 'degraded', service: 'mountain-bakes-api', database });
});

setupRoutes(app);
// An unmatched route answers in the API's own {error} shape, not Express's HTML
// "Cannot DELETE /…" page, which the client used to show verbatim in a toast.
app.use((req, res) => {
  res.status(404).json({ error: `No API route for ${req.method} ${req.path}` });
});
app.use(errorHandler);
