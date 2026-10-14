import { disconnectPrisma } from '../db';
import { changeUserEmail, type EmailChangeLine } from '../services/user-email.service';

/**
 * Change the email address an account signs in with AND every copy of that
 * address kept in the records — from the server.
 *
 *   pnpm user:change-email old@example.com new@example.com            rehearsal
 *   pnpm user:change-email old@example.com new@example.com --apply    for real
 *
 * Users → Actions → Change Email Address changes the sign-in address and
 * leaves history naming the old one. This is for the case where the old
 * address should stop appearing in existing records too (see
 * user-email.service, `records: 'rewrite'`, for what that touches and what it
 * cannot). WITHOUT --apply IT IS A REHEARSAL that saves nothing and prints
 * every column it would change and every one it would leave.
 */
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [from, to] = args.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  if (!from || !to || !from.includes('@')) {
    throw new Error('Usage: pnpm user:change-email <current email> <new email> [--apply]');
  }

  const result = await changeUserEmail({
    user: { email: from },
    to,
    records: 'rewrite',
    apply,
    actor: { id: null, name: 'Server command (user:change-email)' },
  });
  const { changed, left } = result;

  const width = Math.max(...[...changed, ...left].map((l) => l.where.length), 10);
  const print = (l: EmailChangeLine) => console.log(`  ${l.where.padEnd(width)}  ${String(l.rows).padStart(6)}${l.why ? `   ${l.why}` : ''}`);

  console.log(`Account: ${result.from} (${result.displayName || 'no name'}, ${result.role}, ${result.status})`);
  console.log(`New address: ${result.to}\n`);
  console.log(apply ? 'Changed (rows):' : 'Would change (rows):');
  changed.forEach(print);
  if (left.length > 0) {
    console.log(`\nLeft as ${apply ? 'they were' : 'they are'} — still showing ${result.from} (rows):`);
    left.forEach(print);
  }
  const total = changed.reduce((n, l) => n + l.rows, 0);
  console.log(
    apply
      ? `\nDone: ${total} values in ${changed.length} columns now read ${result.to}.`
      : `\nREHEARSAL — nothing was saved. ${total} values in ${changed.length} columns would change. Add --apply to do it.`,
  );
}

main()
  .catch((err) => {
    console.error('[user:change-email]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
