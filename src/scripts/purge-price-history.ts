import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * One-time maintenance script: permanently delete EVERY document in
 * `product_price_history` (the price-change audit log). Used to wipe old/test
 * price records for a clean slate.
 *
 * Safe by design:
 *  - Runs as a DRY RUN by default (prints the count, deletes nothing).
 *  - Only deletes when passed `--confirm`.
 *  - Does NOT touch `products` (live prices stay), `price_activation_locks`, or
 *    any other collection.
 *
 * Usage (from server/):
 *   pnpm purge:price-history              # dry run — shows how many exist
 *   pnpm purge:price-history -- --confirm # permanently delete them all
 */

const serviceAccount = JSON.parse(
  readFileSync(resolve(process.cwd(), 'credentials/serviceAccount.json'), 'utf-8'),
) as admin.ServiceAccount;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mountain-bakes',
});

const db = admin.firestore();

const COLLECTION = 'product_price_history';
const BATCH = 400; // under Firestore's 500-op WriteBatch cap
const confirmed = process.argv.includes('--confirm');

async function main() {
  console.log('Mountain Bakes ERP — Purge Price History');
  console.log('========================================');

  const total = (await db.collection(COLLECTION).count().get()).data().count;
  console.log(`Found ${total} docs in ${COLLECTION}`);

  if (total === 0) {
    console.log('Nothing to delete.');
    process.exit(0);
  }

  if (!confirmed) {
    console.log('\nDRY RUN — nothing deleted.');
    console.log('Re-run with --confirm to permanently delete ALL of them:');
    console.log('  npm run purge:price-history -- --confirm\n');
    process.exit(0);
  }

  let deleted = 0;
  for (;;) {
    const q = await db.collection(COLLECTION).limit(BATCH).get();
    if (q.empty) break;
    const batch = db.batch();
    q.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += q.size;
    console.log(`  deleted ${deleted}/${total}`);
  }

  console.log(`\n✔ Deleted ${deleted} price-history records.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nPurge failed:', e.message);
  process.exit(1);
});
