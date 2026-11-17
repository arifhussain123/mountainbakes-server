import 'dotenv/config';
import { dbFor, disconnectPrisma } from '../db';

/**
 * One-off maintenance script: permanently remove a Store-keeper account AND all
 * Dry Items Store data — a full reset of the store module — to clear the dummy
 * data entered while testing it.
 *
 * WHAT IT DELETES
 *   • Every operational row in the store module: queries and their messages,
 *     stock movements, batch allocations, issues, demands, receipts, stock
 *     adjustments, batches, and the item catalogue with its prices.
 *   • The named account's `users` row. Postgres then CASCADES everything keyed
 *     to that user — its credentials, store_account, auth sessions, push
 *     subscriptions, notifications and password-reset tokens — automatically.
 *
 * WHAT IT KEEPS (seeded reference data from the migration, not dummy entries)
 *   • store_departments — the "Dry Items Store" itself.
 *   • store_lookups     — categories, units, adjustment reasons.
 *
 * SAFE BY DESIGN — mirrors purge-price-history.ts
 *   • DRY RUN by default: prints every count, deletes nothing.
 *   • Deletes only when passed --confirm.
 *   • The catalogue, batches, movements and adjustments carry no per-store
 *     column, so the wipe is MODULE-WIDE. If more than one store department or
 *     more than one keeper account exists, wiping would take another keeper's
 *     data with it — so it refuses to run without --force as well.
 *   • Pre-checks the one ON DELETE RESTRICT foreign key to users
 *     (finance_ai_captures.created_by); if the account owns any such row it
 *     stops rather than hit a mid-run constraint error.
 *
 * Usage (from mountainbakes-server/):
 *   pnpm purge:store-account store@mountainbakes.com                      # dry run
 *   pnpm purge:store-account store@mountainbakes.com -- --confirm         # delete
 *   pnpm purge:store-account store@mountainbakes.com -- --confirm --force # shared store
 */

const db = dbFor('scripts');

// The store data tables, CHILD → PARENT. Every ON DELETE RESTRICT foreign key
// runs from a table higher in this list to one lower, so deleting top-down
// never trips a constraint. Reference tables (store_departments, store_lookups)
// and the account table (store_accounts, cascaded by the user delete) are
// deliberately NOT here.
const STORE_TABLES = [
  'store_query_messages',
  'store_queries',
  'store_movements',
  'store_batch_allocations',
  'store_issue_items',
  'store_issues',
  'store_demand_items',
  'store_demands',
  'store_batches',
  'store_receipts',
  'store_adjustments',
  'store_item_prices',
  'store_items',
  'store_audit_events',
] as const;

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const forced = args.includes('--force');
const email = args.find((a) => !a.startsWith('--'))?.trim();

/** Abort with a message; routed through the .catch so the connection still closes. */
function fail(message: string): never {
  throw new Error(message);
}

async function countAll(table: string): Promise<number> {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) fail(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function countEq(table: string, column: string, value: unknown): Promise<number> {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true }).eq(column, value);
  if (error) fail(`count ${table}.${column}: ${error.message}`);
  return count ?? 0;
}

async function deleteAll(table: string): Promise<number> {
  // `id is not null` matches every row (id is the non-null primary key) — the
  // same every-row filter purge-price-history uses, since an unfiltered delete
  // is refused.
  const { count, error } = await db.from(table).delete({ count: 'exact' }).not('id', 'is', null);
  if (error) fail(`delete ${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log('Mountain Bakes ERP — Purge Store Account + Store Data');
  console.log('====================================================');

  if (!email || !email.includes('@')) {
    fail('Usage: pnpm purge:store-account <email> [-- --confirm [--force]]');
  }

  // ── Resolve the account ──────────────────────────────────────────────────
  // ilike, LIKE metacharacters escaped: match the address whatever its
  // capitalisation, exactly as the seed's findUserByEmail does.
  const escaped = email.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: user, error: userErr } = await db
    .from('users')
    .select('id, email, display_name, role, status')
    .ilike('email', escaped)
    .maybeSingle();
  if (userErr) fail(`users read: ${userErr.message}`);
  if (!user) fail(`No account with email ${email}.`);

  const userId = user.id as string;
  console.log(`\nAccount:  ${user.email}`);
  console.log(`          ${user.display_name || 'no name'} · role=${user.role} · status=${user.status}`);
  console.log(`          id=${userId}`);
  if (user.role !== 'store_user') {
    console.log(`\n⚠  This account's role is "${user.role}", not "store_user" — double-check this is the right address.`);
  }

  // ── Its store_account and department ──────────────────────────────────────
  const { data: account, error: accErr } = await db
    .from('store_accounts')
    .select('id, store_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (accErr) fail(`store_accounts read: ${accErr.message}`);

  let departmentLabel = '(none — this user has no store_account)';
  if (account) {
    const { data: dept, error: deptErr } = await db
      .from('store_departments')
      .select('name, store_code')
      .eq('id', account.store_id)
      .maybeSingle();
    if (deptErr) fail(`store_departments read: ${deptErr.message}`);
    departmentLabel = dept ? `${dept.name} (${dept.store_code})` : `id=${account.store_id}`;
  }
  console.log(`Store:    ${departmentLabel}`);

  // ── Shared-store guard ────────────────────────────────────────────────────
  const totalAccounts = await countAll('store_accounts');
  const totalDepartments = await countAll('store_departments');
  const otherAccounts = totalAccounts - (account ? 1 : 0);
  const shared = otherAccounts > 0 || totalDepartments > 1;

  console.log(`\nStore module: ${totalAccounts} keeper account(s), ${totalDepartments} department(s).`);
  if (shared) {
    console.log(
      '⚠  SHARED STORE — the catalogue, batches, movements and adjustments have no\n' +
      '   per-store column, so this wipe clears the WHOLE module, including the\n' +
      `   data visible to ${otherAccounts} other keeper account(s) / extra department(s). Needs --force.`,
    );
  }

  // ── Blocker pre-check: the one RESTRICT foreign key to users ──────────────
  const aiCaptures = await countEq('finance_ai_captures', 'created_by', userId);
  if (aiCaptures > 0) {
    console.log(
      `\n⚠  ${aiCaptures} finance_ai_captures row(s) were created by this account. That\n` +
      '   foreign key is ON DELETE RESTRICT, so the account delete will fail until\n' +
      '   they are reassigned or removed (unexpected for a store account).',
    );
  }

  // ── Counts ────────────────────────────────────────────────────────────────
  console.log('\nStore data to delete (whole module):');
  let grandTotal = 0;
  for (const table of STORE_TABLES) {
    const n = await countAll(table);
    grandTotal += n;
    console.log(`  ${table.padEnd(26)} ${String(n).padStart(8)}`);
  }
  console.log(`  ${'-'.repeat(26)} ${'-'.repeat(8)}`);
  console.log(`  ${'TOTAL store rows'.padEnd(26)} ${String(grandTotal).padStart(8)}`);
  console.log('\nThen: 1 users row (cascades its credentials, store_account, sessions,');
  console.log('      push subscriptions, notifications and reset tokens).');
  console.log('Kept: store_departments and store_lookups (seeded reference data).');

  // ── Decide ────────────────────────────────────────────────────────────────
  if (!confirmed) {
    console.log('\nDRY RUN — nothing deleted.');
    console.log('Re-run to delete for real:');
    console.log(`  pnpm purge:store-account ${email} -- --confirm${shared ? ' --force' : ''}\n`);
    return;
  }

  if (shared && !forced) {
    fail('Shared store detected — refusing without --force. Review the dry run above first.');
  }
  if (aiCaptures > 0) {
    fail(`Blocked: ${aiCaptures} finance_ai_captures row(s) hold this account (ON DELETE RESTRICT). Resolve those first.`);
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  console.log('\nDeleting…');
  let deleted = 0;
  for (const table of STORE_TABLES) {
    const n = await deleteAll(table);
    deleted += n;
    if (n > 0) console.log(`  ${table.padEnd(26)} ${String(n).padStart(8)} deleted`);
  }

  const { count: usersDeleted, error: delUserErr } = await db
    .from('users')
    .delete({ count: 'exact' })
    .eq('id', userId);
  if (delUserErr) fail(`delete user: ${delUserErr.message}`);

  console.log(`\n✔ Done. Deleted ${deleted} store row(s) and ${usersDeleted ?? 0} account.`);
  console.log(`  ${user.email} and its login are gone; the Dry Items Store is empty.\n`);
}

main()
  .catch((e) => {
    console.error('\nPurge failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
