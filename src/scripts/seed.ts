import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
// Reuse the server's own Admin bootstrap rather than repeating it here. That gives
// the seeder all three credential sources (FIREBASE_SERVICE_ACCOUNT raw JSON,
// _BASE64, or _PATH) instead of a hardcoded credentials/serviceAccount.json, and
// picks up projectId / storageBucket from the environment. Importing this module
// initialises Firebase Admin as a side effect.
import { adminDb, admin } from '../config/firebase';

const db = adminDb;

// Supabase admin (service_role) — creates the auth user. Firestore still holds
// the app's user/branch/category data this phase.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\nMissing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Set them in server/.env, then run:  tsx --env-file .env src/scripts/seed.ts\n');
  process.exit(1);
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUPER_ADMIN_EMAIL = 'admin@mountainbakes.com';
const SUPER_ADMIN_PASSWORD = 'Admin@123';
const SUPER_ADMIN_NAME = 'Super Admin';

// Non-admin accounts. Branch users are linked by branch `slug` (resolved to the
// Firestore branch id after seedBranches runs). Password is a shared bootstrap
// value and every account is flagged mustChangePassword so it cannot survive
// first login — see the forced-password-change gate in the web middleware.
const DEFAULT_STAFF_PASSWORD = 'Mountain@123';

const STAFF_USERS: Array<{
  email: string;
  name: string;
  role: 'production_user' | 'branch_manager';
  branchSlug: string | null;
}> = [
  { email: 'production@mountainbakes.com', name: 'Production User', role: 'production_user', branchSlug: null },
  { email: 'dha@mountainbakes.com', name: 'DHA Branch Manager', role: 'branch_manager', branchSlug: 'dha' },
  { email: 'north@mountainbakes.com', name: 'North Nazimabad Branch Manager', role: 'branch_manager', branchSlug: 'north-nazimabad' },
  { email: 'gulshan@mountainbakes.com', name: 'Gulshan Branch Manager', role: 'branch_manager', branchSlug: 'gulshan' },
  { email: 'clifton@mountainbakes.com', name: 'Clifton Branch Manager', role: 'branch_manager', branchSlug: 'clifton' },
];

const BRANCHES = [
  { name: 'DHA Branch', slug: 'dha', address: 'DHA Phase 6, Karachi', phone: '021-35310000', isActive: true },
  { name: 'Gulshan Branch', slug: 'gulshan', address: 'Gulshan-e-Iqbal, Karachi', phone: '021-34810000', isActive: true },
  { name: 'Clifton Branch', slug: 'clifton', address: 'Clifton Block 5, Karachi', phone: '021-35870000', isActive: true },
  { name: 'North Nazimabad Branch', slug: 'north-nazimabad', address: 'North Nazimabad, Karachi', phone: '021-36610000', isActive: true },
];

const CATEGORIES = [
  { name: 'Cakes', slug: 'cakes', sortOrder: 1, isActive: true },
  { name: 'Bread', slug: 'bread', sortOrder: 2, isActive: true },
  { name: 'Cookies', slug: 'cookies', sortOrder: 3, isActive: true },
  { name: 'Pastries', slug: 'pastries', sortOrder: 4, isActive: true },
  { name: 'Drinks', slug: 'drinks', sortOrder: 5, isActive: true },
  { name: 'Snacks', slug: 'snacks', sortOrder: 6, isActive: true },
  { name: 'Custom Cakes', slug: 'custom-cakes', sortOrder: 7, isActive: true },
];

async function createSuperAdmin() {
  console.log('\n── Super Admin ──────────────────────────');

  // Supabase has no getUserByEmail; list and match. Fresh projects are small.
  const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw listErr;
  const existing = list.users.find((u) => u.email?.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase());

  let uid: string;
  if (existing) {
    uid = existing.id;
    console.log(`  Already exists: ${uid}`);
    await supabaseAdmin.auth.admin.updateUserById(uid, {
      app_metadata: { role: 'super_admin', branchId: null, branchName: null },
    });
  } else {
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: { displayName: SUPER_ADMIN_NAME },
      app_metadata: { role: 'super_admin', branchId: null, branchName: null },
    });
    if (createErr || !created.user) throw createErr ?? new Error('Failed to create super admin');
    uid = created.user.id;
    console.log(`  Created: ${uid}`);
  }
  console.log('  ✔ app_metadata set (role: super_admin)');

  await db.collection('users').doc(uid).set({
    uid,
    email: SUPER_ADMIN_EMAIL,
    displayName: SUPER_ADMIN_NAME,
    role: 'super_admin',
    branchId: null,
    branchName: null,
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log('  ✔ Firestore user doc created');
}

async function seedStaffUsers() {
  console.log('\n── Staff Users ──────────────────────────');

  const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw listErr;

  for (const staff of STAFF_USERS) {
    // Resolve the branch id/name from the slug — branches are seeded first.
    let branchId: string | null = null;
    let branchName: string | null = null;
    if (staff.branchSlug) {
      const snap = await db.collection('branches').where('slug', '==', staff.branchSlug).limit(1).get();
      if (snap.empty) {
        console.log(`  ! Skipping ${staff.email} — branch '${staff.branchSlug}' not found`);
        continue;
      }
      branchId = snap.docs[0].id;
      branchName = (snap.docs[0].data() as { name: string }).name;
    }

    const claims = { role: staff.role, branchId, branchName, mustChangePassword: true };
    const existing = list.users.find((u) => u.email?.toLowerCase() === staff.email.toLowerCase());

    let uid: string;
    if (existing) {
      uid = existing.id;
      // Do NOT reset the password of an existing account — only re-assert claims.
      await supabaseAdmin.auth.admin.updateUserById(uid, { app_metadata: claims });
      console.log(`  = ${staff.email} (exists, claims updated)`);
    } else {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: staff.email,
        password: DEFAULT_STAFF_PASSWORD,
        email_confirm: true,
        user_metadata: { displayName: staff.name },
        app_metadata: claims,
      });
      if (createErr || !created.user) throw createErr ?? new Error(`Failed to create ${staff.email}`);
      uid = created.user.id;
      console.log(`  + ${staff.email} (${staff.role}${branchName ? ` @ ${branchName}` : ''})`);
    }

    await db.collection('users').doc(uid).set({
      uid,
      email: staff.email,
      displayName: staff.name,
      role: staff.role,
      branchId,
      branchName,
      status: 'active',
      mustChangePassword: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  console.log('  ✔ Done');
}

async function seedBranches() {
  console.log('\n── Branches ─────────────────────────────');
  for (const branch of BRANCHES) {
    const existing = await db.collection('branches').where('slug', '==', branch.slug).limit(1).get();
    if (!existing.empty) {
      console.log(`  Skipping (exists): ${branch.name}`);
      continue;
    }
    await db.collection('branches').add({
      ...branch,
      managerId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  + ${branch.name}`);
  }
  console.log('  ✔ Done');
}

async function seedCategories() {
  console.log('\n── Categories ───────────────────────────');
  for (const cat of CATEGORIES) {
    const existing = await db.collection('categories').where('slug', '==', cat.slug).limit(1).get();
    if (!existing.empty) {
      console.log(`  Skipping (exists): ${cat.name}`);
      continue;
    }
    await db.collection('categories').add({
      ...cat,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  + ${cat.name}`);
  }
  console.log('  ✔ Done');
}

async function initOrderCounter() {
  console.log('\n── Order Counter ────────────────────────');
  const ref = db.collection('counters').doc('orders');
  const snap = await ref.get();
  if (snap.exists) {
    console.log(`  Already exists (count: ${(snap.data() as { count: number }).count})`);
  } else {
    await ref.set({ count: 0 });
    console.log('  ✔ Counter initialized at 0');
  }
}

async function initSettings() {
  console.log('\n── App Settings ─────────────────────────');
  const ref = db.collection('settings').doc('app');
  const snap = await ref.get();
  if (snap.exists) {
    console.log('  Already exists');
  } else {
    await ref.set({
      companyName: 'Mountain Bakes',
      gstRate: 5,
      currency: 'PKR',
      receiptFooter: 'Thank you for choosing Mountain Bakes!',
      logoUrl: null,
      theme: 'light',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('  ✔ Settings initialized');
  }
}

async function main() {
  console.log('Mountain Bakes ERP — Database Seed');
  console.log('====================================');

  await createSuperAdmin();
  await seedBranches();
  await seedStaffUsers(); // after seedBranches — resolves branchId from slug
  await seedCategories();
  await initOrderCounter();
  await initSettings();

  console.log('\n====================================');
  console.log('✔ Seed complete!\n');
  console.log('Super Admin login:');
  console.log(`  Email:    ${SUPER_ADMIN_EMAIL}`);
  console.log(`  Password: ${SUPER_ADMIN_PASSWORD}`);
  console.log('\nNext: open http://localhost:3000/login and sign in.\n');
  process.exit(0);
}

main().catch(e => {
  console.error('\nSeed failed:', e.message);
  process.exit(1);
});
