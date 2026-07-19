/**
 * Mountain Bakes — Supabase seed.
 *
 * Ported from the original Firebase seed (Firestore + Firebase Auth). Auth is now
 * Supabase and the data lives in Postgres, so this writes to `auth.users` via the
 * Admin API and to the tables created by supabase/migrations/*.sql.
 *
 * Run:  node scripts/seed.js        (reads .env — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *
 * IDEMPOTENT. Every step is insert-if-absent; re-running never overwrites data you
 * have edited by hand, and never resets the order counter.
 */
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error(
    'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n' +
      'This must be the SECRET service-role key, not the anon/publishable one.'
  );
  process.exit(1);
}

// service_role bypasses RLS, which is what lets this script write reference data.
const db = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUPER_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@mountainbakes.com';
const SUPER_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@123';
const SUPER_ADMIN_NAME = 'Super Admin';

const BRANCHES = [
  { name: 'DHA Branch', slug: 'dha', address: 'DHA Phase 6, Karachi', city: 'Karachi', phone: '021-35310000', is_active: true },
  { name: 'Gulshan Branch', slug: 'gulshan', address: 'Gulshan-e-Iqbal, Karachi', city: 'Karachi', phone: '021-34810000', is_active: true },
  { name: 'Clifton Branch', slug: 'clifton', address: 'Clifton Block 5, Karachi', city: 'Karachi', phone: '021-35870000', is_active: true },
  { name: 'North Nazimabad Branch', slug: 'north-nazimabad', address: 'North Nazimabad, Karachi', city: 'Karachi', phone: '021-36610000', is_active: true },
];

const CATEGORIES = [
  { name: 'Cakes', slug: 'cakes', sort_order: 1, is_active: true },
  { name: 'Bread', slug: 'bread', sort_order: 2, is_active: true },
  { name: 'Cookies', slug: 'cookies', sort_order: 3, is_active: true },
  { name: 'Pastries', slug: 'pastries', sort_order: 4, is_active: true },
  { name: 'Drinks', slug: 'drinks', sort_order: 5, is_active: true },
  { name: 'Snacks', slug: 'snacks', sort_order: 6, is_active: true },
  { name: 'Custom Cakes', slug: 'custom-cakes', sort_order: 7, is_active: true },
];

function bail(step, error) {
  console.error(`\nSeed failed at ${step}: ${error.message || error}`);
  process.exit(1);
}

/** supabase-js has no getUserByEmail — page through the admin list to find one. */
async function findAuthUserByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) bail('listUsers', error);
    const hit = data.users.find(u => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
}

async function createSuperAdmin() {
  console.log('\n── Super Admin ──────────────────────────');

  let user = await findAuthUserByEmail(SUPER_ADMIN_EMAIL);
  if (user) {
    console.log(`  Already exists: ${user.id}`);
  } else {
    const { data, error } = await db.auth.admin.createUser({
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: SUPER_ADMIN_NAME },
    });
    if (error) bail('createUser', error);
    user = data.user;
    console.log(`  Created: ${user.id}`);
  }

  // Role/branch live in app_metadata → embedded in the JWT → read by
  // middleware/auth.ts and by the RLS policies (app.jwt_role / app.jwt_branch_id).
  // These keys are camelCase on purpose; the SQL accessors look them up verbatim.
  const { error: claimsError } = await db.auth.admin.updateUserById(user.id, {
    app_metadata: { role: 'super_admin', branchId: null, branchName: null },
  });
  if (claimsError) bail('setClaims', claimsError);
  console.log('  ✔ app_metadata claims set (role: super_admin)');

  // public.users mirrors the claims and is the source of truth for them.
  const { error: rowError } = await db.from('users').upsert(
    {
      id: user.id,
      email: SUPER_ADMIN_EMAIL,
      display_name: SUPER_ADMIN_NAME,
      role: 'super_admin',
      branch_id: null,
      branch_name: null,
      status: 'active',
    },
    { onConflict: 'id' }
  );
  if (rowError) bail('users row', rowError);
  console.log('  ✔ public.users profile row upserted');

  return user.id;
}

/** Insert-if-absent on a natural key; never clobbers rows already there. */
async function seedTable(label, table, rows, conflictKey) {
  console.log(`\n── ${label} ─────────────────────────────`);

  const { data: existing, error: readError } = await db.from(table).select(conflictKey);
  if (readError) bail(`${table} read`, readError);
  const have = new Set(existing.map(r => r[conflictKey]));

  const missing = rows.filter(r => !have.has(r[conflictKey]));
  for (const r of rows) {
    console.log(have.has(r[conflictKey]) ? `  Skipping (exists): ${r.name}` : `  + ${r.name}`);
  }

  if (missing.length) {
    const { error } = await db.from(table).insert(missing);
    if (error) bail(`${table} insert`, error);
  }
  console.log(`  ✔ ${label} seeded (${missing.length} new, ${rows.length - missing.length} existing)`);
}

async function checkOrderCounter() {
  console.log('\n── Order Counter ────────────────────────');
  const { data, error } = await db.from('counters').select('count').eq('id', 'orders').maybeSingle();
  if (error) bail('counters', error);

  if (!data) {
    // Only reachable if the row was deleted — next_order_number() raises without it.
    const { error: insertError } = await db.from('counters').insert({ id: 'orders', count: 0 });
    if (insertError) bail('counters insert', insertError);
    console.log('  ✔ Counter row was missing — recreated at 0');
    return;
  }

  // Deliberately NOT reset. The migration seeds this at 124 to continue the
  // Firestore order numbering; zeroing it would re-issue MB-000001… and collide
  // with orders that already exist.
  console.log(`  Left untouched at ${data.count} (next order: MB-${String(data.count + 1).padStart(6, '0')})`);
}

async function initSettings() {
  console.log('\n── App Settings ─────────────────────────');
  const { data, error } = await db.from('settings').select('id').maybeSingle();
  if (error) bail('settings read', error);

  if (data) {
    console.log('  Already exists');
    return;
  }

  const { error: insertError } = await db.from('settings').insert({
    id: true, // singleton row — the table has a `check (id)` constraint
    company_name: 'Mountain Bakes',
    currency: 'PKR',
    currency_symbol: 'Rs',
    gst_rate: 5,
    gst_enabled: false, // rate is configured but tax stays OFF until someone opts in
    receipt_footer: 'Thank you for choosing Mountain Bakes!',
    logo_url: null,
    theme: 'light',
    // Business day runs 08:00 → 02:00 Karachi. isWithinOrderWindow() compares these
    // as 'HH:MM' strings and tolerates the past-midnight wrap.
    business_start_time: '08:00',
    business_closing_time: '02:00',
    order_start_time: '08:00',
    order_end_time: '02:00',
    auto_close_business: true,
    auto_stock_closing: true,
  });
  if (insertError) bail('settings insert', insertError);
  console.log('  ✔ Settings initialized');
}

async function main() {
  console.log('Mountain Bakes — Supabase Seed');
  console.log('====================================');
  console.log(`Target: ${url}`);

  await createSuperAdmin();
  await seedTable('Branches', 'branches', BRANCHES, 'slug');
  await seedTable('Categories', 'categories', CATEGORIES, 'slug');
  await checkOrderCounter();
  await initSettings();

  console.log('\n====================================');
  console.log('✔ Seed complete!\n');
  console.log('Super Admin login:');
  console.log(`  Email:    ${SUPER_ADMIN_EMAIL}`);
  console.log(`  Password: ${SUPER_ADMIN_PASSWORD}`);
  console.log('\n  ⚠ Change this password before exposing the app publicly.');
  console.log('\nNext: open http://localhost:3000/login and sign in.\n');
  process.exit(0);
}

main().catch(e => {
  console.error('\nSeed failed:', e.message);
  process.exit(1);
});
