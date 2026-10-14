import dotenv from 'dotenv';

dotenv.config();

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  console.error(
    `[server] Node ${process.versions.node} is too old — this API needs Node 24.\n` +
      `         Run 'nvm use' in this terminal (server/.nvmrc pins 24), or open a new shell.`
  );
  process.exit(1);
}

function assertConfigured() {
  const problems: string[] = [];
  if (!(process.env.DATABASE_URL || '').trim()) {
    problems.push('DATABASE_URL is not set — the Postgres connection the API serves from');
  }
  if ((process.env.JWT_SECRET || '').length < 32) {
    problems.push('JWT_SECRET is not set (or is shorter than 32 characters) — the key the API signs access tokens with');
  }
  const files: string[] = [];
  if (!(process.env.FILES_S3_BUCKET || '').trim()) files.push('FILES_S3_BUCKET is not set — the S3 bucket uploaded photos and the logo are kept in');
  if (!/^https?:\/\/[^/]+\/?$/.test((process.env.PUBLIC_API_URL || '').trim())) {
    files.push("PUBLIC_API_URL is not set to this API's public origin — the logo is served from it");
  }
  if (files.length > 0) console.warn(`[server] file storage is not configured; screens that show photos will fail:\n  - ${files.join('\n  - ')}`);

  if (problems.length > 0) {
    console.error(`[server] cannot start:\n  - ${problems.join('\n  - ')}\n         See .env.example.`);
    process.exit(1);
  }
}

async function main() {
  assertConfigured();
  const { app, allowedOrigins } = await import('./src/app');
  const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3001', 10);
  app.listen(PORT, '0.0.0.0', () => {
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
