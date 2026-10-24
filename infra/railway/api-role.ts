import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pgConnectionEnv } from '../../src/services/backup/postgresBackup';

/**
 * Give the API's database role its password, and write down the connection
 * string the API is to use.
 *
 *   pnpm railway:role            set it (or re-apply the one on file)
 *   pnpm railway:role --rotate   throw the old one away and make a new one
 *
 * bootstrap.sql creates `mb_api` with no password, so that no credential lives
 * in a file that is committed. This sets one and writes
 * infra/railway/.secrets.env (git-ignored, mode 600), printing only where that
 * file is — never the secret. The file is then the one place to copy
 * DATABASE_URL from into the API service's Railway Variables.
 *
 * WHY THE API DOES NOT USE THE `postgres` LOGIN Railway hands out. That login
 * owns the database: it can drop it. The API needs to read and write rows and
 * call functions, and a role that can do only that is the difference between a
 * bug and a catastrophe. It is also where the 8-second statement limit lives
 * (bootstrap.sql), which an administrator's own connection must not have.
 *
 * RE-RUNNING without --rotate re-applies the password already on file. That is
 * what a fresh `railway:migrate --reset-target` needs: the role survives the
 * wipe, so nothing changes, but it is safe to run either way.
 *
 * --rotate on a live system stops the API until DATABASE_URL is updated in
 * its Railway Variables. It is for a leak, not for routine.
 */

const FILE = path.join(__dirname, '.secrets.env');

/** URL-safe, so it can sit in a connection string without escaping. */
const password = () => randomBytes(24).toString('base64url');

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** SQL goes in on stdin, so a password never appears in the process list. */
function psqlStdin(env: Record<string, string>, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', (e) => reject(new Error(`could not start psql: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`psql failed: ${err.trim().split('\n')[0]}`))));
    child.stdin.end(sql);
  });
}

async function main() {
  const rotate = process.argv.includes('--rotate');
  const target = (process.env.RAILWAY_DB_URL || '').trim();
  if (!target) throw new Error('RAILWAY_DB_URL is required');
  const targetEnv = pgConnectionEnv(target);
  if (!new URL(target).searchParams.get('sslmode')) targetEnv.PGSSLMODE = 'prefer';
  if (/supabase/i.test(targetEnv.PGHOST)) throw new Error('The target host is Supabase. Refusing.');

  const onFile = existsSync(FILE) && !rotate ? parseEnvFile(await readFile(FILE, 'utf8')) : {};
  const reused = Boolean(onFile.MB_API_PASSWORD);
  const apiPassword = onFile.MB_API_PASSWORD || password();

  // The password is base64url, so there is nothing in it for a quote to end.
  await psqlStdin(targetEnv, `alter role mb_api login password '${apiPassword}';`);

  // The same server the administrator URL names, as the API's own role.
  const apiUrl = new URL(target);
  apiUrl.username = 'mb_api';
  apiUrl.password = apiPassword;

  await writeFile(
    FILE,
    `# Mountain Bakes — the API's database login on Railway. NEVER COMMIT. Generated ${new Date().toISOString()}
# Regenerate with: pnpm railway:role --rotate   (stops the API until its Variables are updated)

MB_API_PASSWORD=${apiPassword}

# ── Where it goes ──────────────────────────────────────────────────────────
# Railway · the API service's Variables
#   DATABASE_URL=${apiUrl.toString()}
#
# That is Railway's PUBLIC address, which works from anywhere. The
# administrator URL (RAILWAY_DB_URL, user postgres) stays where it is: it is for
# the copy, for migrations and for backups, and never for the running API.
`,
    { mode: 0o600 },
  );
  await chmod(FILE, 0o600);

  console.log(`[role] mb_api on ${targetEnv.PGHOST}:${targetEnv.PGPORT}/${targetEnv.PGDATABASE} ${reused ? 'has the password already on file' : 'has a new password'}`);
  console.log(`[role] the API's DATABASE_URL is in ${path.relative(process.cwd(), FILE)} — copy it to the API's Railway Variables from there`);
}

main().catch((err) => {
  console.error('[role]', err instanceof Error ? err.message : err);
  process.exit(1);
});
