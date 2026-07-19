import dotenv from 'dotenv';

// Load local env (server/.env) for development. On hosts (Heroku/etc.) the real
// environment variables are already present and take precedence — dotenv only
// fills gaps. This MUST run before ./src/app is loaded, because route modules
// initialise Firebase Admin from env at import time; the dynamic import below
// guarantees that ordering.
dotenv.config();

async function main() {
  const { app, allowedOrigins } = await import('./src/app');
  const { startDailyClosingScheduler } = await import('./src/scheduler/daily-closing.job');
  const { startPriceActivationScheduler } = await import('./src/scheduler/price-activation.job');
  const { activateDuePrices } = await import('./src/services/price.service');

  // Hosts inject the port via PORT; fall back to API_PORT for local dev. Bind
  // 0.0.0.0 so the container/dyno is reachable externally.
  const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3001', 10);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mountain Bakes API listening on port ${PORT}`);
    console.log('[cors] Allowed origins:', allowedOrigins.join(', ') || '(none configured)');
    // Arm the 2:00 AM Karachi end-of-day closing (idempotent; respects Auto Close).
    startDailyClosingScheduler();
    // Arm 2:00 AM future-dated price activation + catch up any missed run on boot.
    startPriceActivationScheduler();
    activateDuePrices({ trigger: 'startup' }).catch((err) => console.error('[price-activation] startup catch-up threw:', err));
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
