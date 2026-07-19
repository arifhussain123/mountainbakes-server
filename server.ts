import dotenv from 'dotenv';

// Load local env (server/.env) for development. On hosts (Heroku/etc.) the real
// environment variables are already present and take precedence — dotenv only
// fills gaps. This MUST run before ./src/app is loaded, because route modules
// initialise Firebase Admin from env at import time; the dynamic import below
// guarantees that ordering.
dotenv.config();

/**
 * Fail fast, and legibly, on an unsupported Node version.
 *
 * Without this the symptom is "Node.js detected but native WebSocket not found"
 * thrown from deep inside @supabase/realtime-js — global WebSocket only exists
 * from Node 22, and supabase-js declares engines >= 22. package.json pins 24.x.
 * The nvm default alias is not enough on its own: sourcing nvm.sh does not apply
 * it, so a stale PATH can still hand this process Node 20.
 */
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  console.error(
    `[server] Node ${process.versions.node} is too old — this API needs Node 24 ` +
      `(>= 22 at minimum, for native WebSocket support in @supabase/supabase-js).\n` +
      `         Run 'nvm use' in this terminal (server/.nvmrc pins 24), or open a new shell.`
  );
  process.exit(1);
}

async function main() {
  const { app, allowedOrigins } = await import('./src/app');

  // ─── Schedulers: disabled until the migration reaches them ──────────────────
  // Both jobs pull in services that still import ../config/firebase
  // (daily-closing.service, price.service). Even though these are dynamic
  // imports, they are awaited during startup, so an unported module fails the
  // boot exactly like a static one. Re-enable each import together with its
  // call below once its service is on Supabase.
  //
  // const { startDailyClosingScheduler } = await import('./src/scheduler/daily-closing.job');
  // const { startPriceActivationScheduler } = await import('./src/scheduler/price-activation.job');
  // const { activateDuePrices } = await import('./src/services/price.service');

  // Hosts inject the port via PORT; fall back to API_PORT for local dev. Bind
  // 0.0.0.0 so the container/dyno is reachable externally.
  const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3001', 10);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mountain Bakes API listening on port ${PORT}`);
    console.log('[cors] Allowed origins:', allowedOrigins.join(', ') || '(none configured)');
    console.warn(
      '[scheduler] Daily closing and price activation are DISABLED during the ' +
        'Firestore→Supabase migration. The 2:00 AM close will not run and ' +
        'future-dated prices will not activate until those services are ported.'
    );
    // Arm the 2:00 AM Karachi end-of-day closing (idempotent; respects Auto Close).
    // startDailyClosingScheduler();
    // Arm 2:00 AM future-dated price activation + catch up any missed run on boot.
    // startPriceActivationScheduler();
    // activateDuePrices({ trigger: 'startup' }).catch((err) => console.error('[price-activation] startup catch-up threw:', err));
    if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) {
      console.warn(
        '[cors] CORS_ORIGINS is not set — only localhost is allowed. Set it to your ' +
          'deployed web origin (e.g. https://mountain-bakes-web.herokuapp.com) or the browser will block requests.'
      );
    }
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
