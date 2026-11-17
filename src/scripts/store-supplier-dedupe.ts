import 'dotenv/config';
import { dbFor, disconnectPrisma } from '../db';

/**
 * Phase 2 — Supplier dedupe. Fill each receipt's NULL supplier_id from its
 * free-text supplier_name, deduping by normalised name into the shared supplier
 * master (public.suppliers).
 *
 * SAFE BY DESIGN
 *   • DRY RUN by default — prints the plan, writes nothing. Pass --apply to write.
 *   • NEVER rewrites store_receipts.supplier_name; it only fills a NULL supplier_id.
 *   • Records every name → supplier in store_supplier_name_map, so the pass is
 *     auditable and reversible, and re-running is idempotent (already-linked
 *     receipts and already-mapped names are skipped).
 *
 * Usage (from mountainbakes-server/):
 *   pnpm store:supplier-dedupe             # dry run (report only)
 *   pnpm store:supplier-dedupe -- --apply  # write
 */

const db = dbFor('scripts');
const apply = process.argv.slice(2).includes('--apply');

/** Fold case and collapse inner whitespace so "Khan  Mills" == "khan mills". */
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function fail(message: string): never {
  throw new Error(message);
}

async function readAll<T>(table: string, cols: string, scope: (q: ReturnType<typeof db.from>) => unknown): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (scope(db.from(table).select(cols)) as any).range(from, from + 999);
    if (error) fail(`${table} read: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log('Mountain Bakes ERP — Supplier dedupe');
  console.log('====================================');
  console.log(apply ? 'MODE: APPLY (writing)\n' : 'MODE: DRY RUN (no writes)\n');

  // 1. Receipts with a free-text name but no master link yet.
  const unlinked = await readAll<{ id: string; supplier_name: string }>(
    'store_receipts', 'id, supplier_name', (q) => (q as { is: (c: string, v: null) => unknown }).is('supplier_id', null),
  );
  console.log(`Unlinked receipts (no supplier_id): ${unlinked.length}`);
  if (unlinked.length === 0) {
    console.log('\nNothing to link. Done.');
    return;
  }

  // 2. Group by normalised name.
  const groups = new Map<string, { raw: string; receiptIds: string[] }>();
  for (const r of unlinked) {
    const key = norm(r.supplier_name);
    if (!key) continue;
    const g = groups.get(key) ?? { raw: r.supplier_name.trim(), receiptIds: [] };
    g.receiptIds.push(r.id);
    groups.set(key, g);
  }
  console.log(`Distinct supplier names:            ${groups.size}\n`);

  // 3. Existing suppliers (by normalised name) and any prior mappings.
  const suppliers = await readAll<{ id: string; name: string }>('suppliers', 'id, name', (q) => (q as { is: (c: string, v: null) => unknown }).is('deleted_at', null));
  const supByName = new Map<string, string>();
  for (const s of suppliers) supByName.set(norm(s.name), s.id);

  const { data: prior, error: mapErr } = await db.from('store_supplier_name_map').select('normalized_name, supplier_id');
  if (mapErr) fail(`map read: ${mapErr.message}`);
  const priorMap = new Map<string, string>();
  for (const m of (prior ?? []) as { normalized_name: string; supplier_id: string }[]) priorMap.set(m.normalized_name, m.supplier_id);

  // 4. Resolve each name → supplier (prior map, else match, else create), then link.
  let matched = 0;
  let created = 0;
  let linked = 0;
  for (const [key, g] of groups) {
    let supplierId = priorMap.get(key) ?? supByName.get(key);
    const willCreate = !supplierId;

    if (willCreate) {
      created += 1;
      if (apply) {
        const { data, error } = await db.from('suppliers').insert({ name: g.raw }).select('id').single();
        if (error) fail(`create supplier "${g.raw}": ${error.message}`);
        supplierId = (data as { id: string }).id;
        supByName.set(key, supplierId);
      }
    } else {
      matched += 1;
    }

    console.log(`  ${willCreate ? 'NEW  ' : 'MATCH'}  ${g.raw.slice(0, 32).padEnd(34)} ${String(g.receiptIds.length).padStart(4)} receipt(s)`);

    if (apply && supplierId) {
      if (!priorMap.has(key)) {
        const { error: insErr } = await db.from('store_supplier_name_map').insert({
          normalized_name: key, raw_name: g.raw, supplier_id: supplierId, created_supplier: willCreate, receipts_linked: g.receiptIds.length,
        });
        if (insErr) fail(`map insert "${key}": ${insErr.message}`);
      }
      // Link only the receipts still NULL, by id — never touches supplier_name.
      const { count, error: upErr } = await db.from('store_receipts')
        .update({ supplier_id: supplierId }, { count: 'exact' })
        .is('supplier_id', null)
        .in('id', g.receiptIds);
      if (upErr) fail(`link receipts for "${key}": ${upErr.message}`);
      linked += count ?? 0;
    }
  }

  console.log('\n------------------------------------');
  console.log(`Matched to existing suppliers: ${matched}`);
  console.log(`New suppliers ${apply ? 'created' : 'to create'}:        ${created}`);
  console.log(`Receipts ${apply ? 'linked' : 'to link'}:              ${apply ? linked : unlinked.length}`);
  if (!apply) console.log('\nDry run only. Re-run with  -- --apply  to write.');
  console.log('store_receipts.supplier_name was not changed.\n');
}

main()
  .catch((e) => {
    console.error('\nDedupe failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
