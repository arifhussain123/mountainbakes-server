/**
 * Mountain Bakes — Supabase seed.
 *
 * Auth is Supabase and the data lives in Postgres, so this writes to `auth.users`
 * via the Admin API and to the tables created by supabase/migrations/*.sql.
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

/**
 * Catalogue. `category` is a CATEGORIES slug — the real category_id is a uuid
 * generated when that row was inserted, so it is resolved at run time (see
 * seedProducts). Prices are PKR.
 *
 * `sku` is the natural key for insert-if-absent. Note products.sku has no UNIQUE
 * constraint in the schema, so uniqueness here is a convention this seed keeps,
 * not something the database enforces.
 */
const PRODUCTS = [
  // Cakes
  { sku: 'CAK-001', name: 'Chocolate Fudge Cake 1 lb', category: 'cakes', price: 1200, cost_price: 700, description: 'Rich chocolate fudge cake' },
  { sku: 'CAK-002', name: 'Chocolate Fudge Cake 2 lb', category: 'cakes', price: 2200, cost_price: 1300, description: 'Rich chocolate fudge cake, 2 lb' },
  { sku: 'CAK-003', name: 'Black Forest Cake 1 lb', category: 'cakes', price: 1300, cost_price: 780, description: 'Cherries and cream on chocolate sponge' },
  { sku: 'CAK-004', name: 'Red Velvet Cake 1 lb', category: 'cakes', price: 1450, cost_price: 850, description: 'Red velvet with cream cheese frosting' },

  // Bread
  { sku: 'BRD-001', name: 'White Sandwich Bread', category: 'bread', price: 180, cost_price: 95, description: 'Soft white sandwich loaf' },
  { sku: 'BRD-002', name: 'Whole Wheat Bread', category: 'bread', price: 220, cost_price: 120, description: 'Wholemeal loaf' },
  { sku: 'BRD-003', name: 'Burger Buns (6 pcs)', category: 'bread', price: 160, cost_price: 85, description: 'Sesame-topped burger buns' },

  // Cookies
  { sku: 'CKY-001', name: 'Chocolate Chip Cookies (250 g)', category: 'cookies', price: 450, cost_price: 240, description: 'Chewy chocolate chip cookies' },
  { sku: 'CKY-002', name: 'Butter Cookies (250 g)', category: 'cookies', price: 400, cost_price: 210, description: 'Classic butter cookies' },
  { sku: 'CKY-003', name: 'Almond Biscotti (200 g)', category: 'cookies', price: 520, cost_price: 290, description: 'Twice-baked almond biscotti' },

  // Pastries
  { sku: 'PST-001', name: 'Chocolate Pastry', category: 'pastries', price: 180, cost_price: 95, description: 'Single-serve chocolate pastry' },
  { sku: 'PST-002', name: 'Pineapple Pastry', category: 'pastries', price: 170, cost_price: 90, description: 'Single-serve pineapple pastry' },
  { sku: 'PST-003', name: 'Butter Croissant', category: 'pastries', price: 200, cost_price: 110, description: 'Flaky all-butter croissant' },

  // Drinks
  { sku: 'DRK-001', name: 'Mineral Water 500 ml', category: 'drinks', price: 60, cost_price: 35, description: 'Bottled mineral water' },
  { sku: 'DRK-002', name: 'Soft Drink 345 ml', category: 'drinks', price: 90, cost_price: 60, description: 'Chilled canned soft drink' },
  { sku: 'DRK-003', name: 'Cold Coffee 400 ml', category: 'drinks', price: 320, cost_price: 170, description: 'Iced blended coffee' },

  // Snacks
  { sku: 'SNK-001', name: 'Chicken Patty', category: 'snacks', price: 150, cost_price: 80, description: 'Puff pastry chicken patty' },
  { sku: 'SNK-002', name: 'Vegetable Samosa', category: 'snacks', price: 60, cost_price: 30, description: 'Spiced potato samosa' },
  { sku: 'SNK-003', name: 'Chicken Roll', category: 'snacks', price: 180, cost_price: 100, description: 'Paratha-wrapped chicken roll' },

  // Custom Cakes
  { sku: 'CST-001', name: 'Custom Birthday Cake (per lb)', category: 'custom-cakes', price: 1600, cost_price: 900, description: 'Made to order — priced per pound' },
  { sku: 'CST-002', name: 'Custom Wedding Tier (per tier)', category: 'custom-cakes', price: 6500, cost_price: 3800, description: 'Made to order — priced per tier' },
];

/**
 * Staff logins for local development.
 *
 * Sign-in is by EMAIL — there is no separate "branch id" login. A branch manager
 * is a normal account whose branch_id links them to a branch; that link is what
 * scopes their orders, stock and reports, and it is mirrored into app_metadata so
 * the JWT claims (and therefore the RLS policies) agree with the profile row.
 *
 * `branch` is a BRANCHES slug, resolved to the real uuid at run time.
 * Passwords are overridable via env; the defaults are development-only.
 */
const STAFF = [
  {
    email: process.env.SEED_MANAGER_EMAIL || 'dha.manager@mountainbakes.com',
    password: process.env.SEED_MANAGER_PASSWORD || 'Manager@123',
    display_name: 'DHA Branch Manager',
    role: 'branch_manager',
    branch: 'dha',
  },
  {
    email: process.env.SEED_MANAGER2_EMAIL || 'gulshan.manager@mountainbakes.com',
    password: process.env.SEED_MANAGER2_PASSWORD || 'Manager@123',
    display_name: 'Gulshan Branch Manager',
    role: 'branch_manager',
    branch: 'gulshan',
  },
  {
    email: process.env.SEED_PRODUCTION_EMAIL || 'production@mountainbakes.com',
    password: process.env.SEED_PRODUCTION_PASSWORD || 'Production@123',
    display_name: 'Production User',
    role: 'production_user',
    branch: null, // production is not branch-scoped
  },
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

/**
 * Resolve each product's category slug to the real category row, then seed.
 *
 * category_name is denormalised onto products (it is a cache of categories.name,
 * and products.routes.ts keeps it in step on update) so it is written here too —
 * leaving it null would show blank categories on the products page.
 *
 * Must run AFTER seedTable('Categories', ...).
 */
async function seedProducts() {
  const { data: categories, error } = await db.from('categories').select('id, name, slug');
  if (error) bail('categories read', error);

  const bySlug = new Map(categories.map(c => [c.slug, c]));

  const rows = PRODUCTS.map(p => {
    const category = bySlug.get(p.category);
    if (!category) bail('product category lookup', new Error(`No category with slug "${p.category}" (product ${p.sku})`));
    return {
      name: p.name,
      sku: p.sku,
      category_id: category.id,
      category_name: category.name,
      price: p.price,
      cost_price: p.cost_price,
      description: p.description,
      is_active: true,
    };
  });

  await seedTable('Products', 'products', rows, 'sku');
}

/**
 * Create the branch-manager / production logins. Idempotent: an account that
 * already exists is left alone (password included, so a changed password is not
 * reset by re-running).
 *
 * Must run AFTER seedTable('Branches', ...) — branch slugs are resolved here.
 */
async function seedStaff() {
  console.log('\n── Staff Logins ─────────────────────────');

  const { data: branches, error } = await db.from('branches').select('id, name, slug');
  if (error) bail('branches read', error);
  const bySlug = new Map(branches.map(b => [b.slug, b]));

  for (const person of STAFF) {
    let branch = null;
    if (person.branch) {
      branch = bySlug.get(person.branch);
      if (!branch) bail('staff branch lookup', new Error(`No branch with slug "${person.branch}" for ${person.email}`));
    }

    const existing = await findAuthUserByEmail(person.email);
    let uid;

    if (existing) {
      uid = existing.id;
      console.log(`  Skipping (exists): ${person.email}`);
    } else {
      const { data, error: createError } = await db.auth.admin.createUser({
        email: person.email,
        password: person.password,
        email_confirm: true,
        user_metadata: { displayName: person.display_name },
      });
      if (createError) bail(`createUser ${person.email}`, createError);
      uid = data.user.id;
      console.log(`  + ${person.email}  (${person.role}${branch ? ` @ ${branch.name}` : ''})`);
    }

    // Claims are refreshed even for an existing account, so a branch that was
    // renamed or re-pointed does not leave a stale branchId in the JWT.
    const { error: claimsError } = await db.auth.admin.updateUserById(uid, {
      app_metadata: {
        role: person.role,
        branchId: branch ? branch.id : null,
        branchName: branch ? branch.name : null,
      },
    });
    if (claimsError) bail(`setClaims ${person.email}`, claimsError);

    const { error: rowError } = await db.from('users').upsert(
      {
        id: uid,
        email: person.email,
        display_name: person.display_name,
        role: person.role,
        branch_id: branch ? branch.id : null,
        branch_name: branch ? branch.name : null,
        status: 'active',
      },
      { onConflict: 'id' }
    );
    if (rowError) bail(`users row ${person.email}`, rowError);
  }

  console.log(`  ✔ Staff logins ready (${STAFF.length} accounts)`);
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
  // supabase order numbering; zeroing it would re-issue MB-000001… and collide
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
  await seedProducts();
  await seedStaff();
  await checkOrderCounter();
  await initSettings();

  console.log('\n====================================');
  console.log('✔ Seed complete!\n');
  console.log('Logins (sign in with the EMAIL — there is no separate branch id login):\n');
  console.log(`  super_admin      ${SUPER_ADMIN_EMAIL}  /  ${SUPER_ADMIN_PASSWORD}`);
  for (const p of STAFF) {
    console.log(`  ${p.role.padEnd(16)} ${p.email}  /  ${p.password}`);
  }
  console.log('\n  ⚠ Development credentials. Change them before exposing the app publicly.');
  console.log('\nNext: open http://localhost:3000/login and sign in.\n');
  process.exit(0);
}

main().catch(e => {
  console.error('\nSeed failed:', e.message);
  process.exit(1);
});
