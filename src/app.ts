import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { setupRoutes } from './routes/index';
import { errorHandler } from './middleware/errorHandler';

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mountain-bakes-api' }));

setupRoutes(app);
app.use(errorHandler);
