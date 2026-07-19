import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createSign } from 'crypto';
import * as https from 'https';
import * as admin from 'firebase-admin';

const saPath = resolve(process.cwd(), 'credentials/serviceAccount.json');
const sa = JSON.parse(readFileSync(saPath, 'utf-8')) as {
  client_email: string; private_key: string; project_id: string;
};

const PROJECT = sa.project_id;

// ── JWT / token helpers ────────────────────────────────────────────
function b64u(s: string) {
  return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(scope: string) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64u(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now }));
  const sig = createSign('RSA-SHA256').update(`${hdr}.${pay}`).sign(sa.private_key, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${hdr}.${pay}.${sig}`;
}

function httpReq(method: string, url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const isForm = headers['Content-Type']?.includes('urlencoded');
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (r) => {
      let raw = '';
      r.on('data', d => raw += d);
      r.on('end', () => {
        const parsed = JSON.parse(raw);
        if (r.statusCode && r.statusCode >= 400) rej(new Error(`HTTP ${r.statusCode}: ${JSON.stringify(parsed)}`));
        else res(parsed);
      });
    });
    req.on('error', rej);
    req.write(data);
    req.end();
  });
}

async function getToken(scope: string): Promise<string> {
  const jwt = makeJwt(scope);
  const res = await httpReq('POST', 'https://oauth2.googleapis.com/token',
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  ) as { access_token: string };
  return res.access_token;
}

// ── Auth REST ──────────────────────────────────────────────────────
async function createOrGetUser(token: string, email: string, password: string, displayName: string): Promise<string> {
  // Try to look up existing user
  try {
    const res = await httpReq('POST',
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`,
      { email: [email] },
      { Authorization: `Bearer ${token}` }
    ) as { users?: Array<{ localId: string }> };
    if (res.users && res.users.length > 0) {
      console.log(`  Already exists: ${res.users[0].localId}`);
      return res.users[0].localId;
    }
  } catch { /* not found, will create */ }

  const res = await httpReq('POST',
    `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`,
    { email, password, displayName, emailVerified: true },
    { Authorization: `Bearer ${token}` }
  ) as { localId: string };
  console.log(`  Created: ${res.localId}`);
  return res.localId;
}

// ── Firestore REST ────────────────────────────────────────────────
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function toFirestoreValue(val: unknown): unknown {
  if (val === null) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return { integerValue: String(val) };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function toFirestoreDoc(obj: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return { fields };
}

async function fsSet(token: string, collection: string, docId: string, data: Record<string, unknown>) {
  const now = new Date().toISOString();
  const doc = toFirestoreDoc({ ...data, createdAt: now, updatedAt: now });
  await httpReq('PATCH',
    `${FS_BASE}/${collection}/${docId}`,
    doc,
    { Authorization: `Bearer ${token}` }
  );
}

async function fsAdd(token: string, collection: string, data: Record<string, unknown>) {
  const now = new Date().toISOString();
  const doc = toFirestoreDoc({ ...data, createdAt: now, updatedAt: now });
  const res = await httpReq('POST', `${FS_BASE}/${collection}`, doc, { Authorization: `Bearer ${token}` }) as { name: string };
  return res.name.split('/').pop() as string;
}

async function fsQuery(token: string, collection: string, field: string, value: string): Promise<boolean> {
  try {
    const res = await httpReq('POST', `${FS_BASE}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } },
        limit: 1,
      }
    }, { Authorization: `Bearer ${token}` }) as Array<{ document?: unknown }>;
    return Array.isArray(res) && res.length > 0 && !!res[0].document;
  } catch { return false; }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('Mountain Bakes ERP — Database Seed');
  console.log('====================================');

  const authScope = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase';
  console.log('\nGetting access token...');
  const token = await getToken(authScope);
  console.log('✔ Authenticated');

  // Super Admin
  console.log('\n── Super Admin ──────────────────────────');
  const uid = await createOrGetUser(token, 'admin@mountainbakes.com', 'Admin@123', 'Super Admin');

  // Set custom claims via Admin SDK (using same service account)
  admin.initializeApp({ credential: admin.credential.cert(sa as admin.ServiceAccount), projectId: PROJECT });
  await admin.auth().setCustomUserClaims(uid, { role: 'super_admin', branchId: null, branchName: null });
  console.log('  ✔ Custom claims set (role: super_admin)');

  await fsSet(token, 'users', uid, {
    uid, email: 'admin@mountainbakes.com', displayName: 'Super Admin',
    role: 'super_admin', branchId: null, branchName: null, status: 'active',
  });
  console.log('  ✔ Firestore user doc created');

  // Branches
  console.log('\n── Branches ─────────────────────────────');
  const branches = [
    { name: 'DHA Branch', slug: 'dha', address: 'DHA Phase 6, Karachi', phone: '021-35310000', isActive: true },
    { name: 'Gulshan Branch', slug: 'gulshan', address: 'Gulshan-e-Iqbal, Karachi', phone: '021-34810000', isActive: true },
    { name: 'Clifton Branch', slug: 'clifton', address: 'Clifton Block 5, Karachi', phone: '021-35870000', isActive: true },
    { name: 'North Nazimabad Branch', slug: 'north-nazimabad', address: 'North Nazimabad, Karachi', phone: '021-36610000', isActive: true },
  ];
  for (const b of branches) {
    if (await fsQuery(token, 'branches', 'slug', b.slug)) { console.log(`  Skipping: ${b.name}`); continue; }
    await fsAdd(token, 'branches', { ...b, managerId: null });
    console.log(`  + ${b.name}`);
  }
  console.log('  ✔ Done');

  // Categories
  console.log('\n── Categories ───────────────────────────');
  const cats = [
    { name: 'Cakes', slug: 'cakes', sortOrder: 1, isActive: true },
    { name: 'Bread', slug: 'bread', sortOrder: 2, isActive: true },
    { name: 'Cookies', slug: 'cookies', sortOrder: 3, isActive: true },
    { name: 'Pastries', slug: 'pastries', sortOrder: 4, isActive: true },
    { name: 'Drinks', slug: 'drinks', sortOrder: 5, isActive: true },
    { name: 'Snacks', slug: 'snacks', sortOrder: 6, isActive: true },
    { name: 'Custom Cakes', slug: 'custom-cakes', sortOrder: 7, isActive: true },
  ];
  for (const c of cats) {
    if (await fsQuery(token, 'categories', 'slug', c.slug)) { console.log(`  Skipping: ${c.name}`); continue; }
    await fsAdd(token, 'categories', c);
    console.log(`  + ${c.name}`);
  }
  console.log('  ✔ Done');

  // Counter & Settings
  console.log('\n── Counter & Settings ───────────────────');
  await fsSet(token, 'counters', 'orders', { count: 0 });
  console.log('  ✔ Order counter initialized');
  await fsSet(token, 'settings', 'app', {
    companyName: 'Mountain Bakes', gstRate: 5, currency: 'PKR',
    receiptFooter: 'Thank you for choosing Mountain Bakes!', logoUrl: null, theme: 'light',
  });
  console.log('  ✔ Settings initialized');

  console.log('\n====================================');
  console.log('✔ Seed complete!\n');
  console.log('Super Admin login:');
  console.log('  Email:    admin@mountainbakes.com');
  console.log('  Password: Admin@123');
  console.log('\nNext: open http://localhost:3000/login\n');
  process.exit(0);
}

main().catch(e => { console.error('\nSeed failed:', e.message); process.exit(1); });
