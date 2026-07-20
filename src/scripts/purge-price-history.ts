import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

/**
 * One-time maintenance script: permanently delete EVERY row in
 * `product_price_history` (the price-change audit log). Used to wipe old/test
 * price records for a clean slate.
 *
 * Safe by design:
 *  - Runs as a DRY RUN by default (prints the count, deletes nothing).
 *  - Only deletes when passed `--confirm`.
 *  - Does NOT touch `products` (live prices stay), `price_activation_locks`, or
 *    any other table.
 *
 * Usage (from server/):
 *   pnpm purge:price-history              # dry run — shows how many exist
 *   pnpm purge:price-history -- --confirm # permanently delete them all
 */

const TABLE = 'product_price_history';
const confirmed = process.argv.includes('--confirm');

async function main() {
  console.log('Mountain Bakes ERP — Purge Price History');
  console.log('========================================');

  const { count, error: countErr } = await supabaseAdmin
    .from(TABLE)
    .select('*', { count: 'exact', head: true });
  if (countErr) throw countErr;

  const total = count ?? 0;
  console.log(`Found ${total} rows in ${TABLE}`);

  if (total === 0) {
    console.log('Nothing to delete.');
    process.exit(0);
  }

  if (!confirmed) {
    console.log('\nDRY RUN — nothing deleted.');
    console.log('Re-run with --confirm to permanently delete ALL of them:');
    console.log('  pnpm purge:price-history -- --confirm\n');
    process.exit(0);
  }

  // PostgREST refuses an unfiltered delete; `id is not null` matches every row
  // (id is the non-null primary key).
  const { error: delErr } = await supabaseAdmin.from(TABLE).delete().not('id', 'is', null);
  if (delErr) throw delErr;

  console.log(`\n✔ Deleted ${total} price-history records.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nPurge failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
