import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';
import { MockWhatsAppProvider } from '../whatsapp/mock.provider';
import { setWhatsAppProvider } from '../whatsapp/provider';
import { processOutboxOnce, setOutboxAutoKick } from '../whatsapp/outbox';
import { verifySignature } from '../whatsapp/webhook';

/**
 * WhatsApp Purchasing (migration 20261020000002), end to end.
 *
 * pglite runs the WHOLE production schema (prisma/migrations/0_baseline) and
 * then the new migration verbatim — so ledger posting, counters and the
 * finance immutability triggers are the live ones, not stubs. Requests go
 * through the real routers (auth, roles, idempotency, validation, finance
 * permissions); WhatsApp is the mock provider, and the outbox worker is driven
 * by hand so every send is observable. Webhooks are signed exactly as Meta
 * signs them.
 *
 * Run: npx tsx --test src/services/__tests__/whatsapp-purchasing.integration.test.ts
 */

// The baseline indexes with pg_trgm. Its contrib subpath is an `exports` entry
// this tsconfig's module resolution cannot see; Node resolves it at run time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm') as { pg_trgm: import('@electric-sql/pglite').Extension };

const PRISMA = join(__dirname, '../../../prisma/migrations');
const BASELINE = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
const MIGRATION = readFileSync(join(PRISMA, '20261020000002_whatsapp_purchasing/migration.sql'), 'utf8');

const APP_SECRET = 'test-app-secret-for-signatures';
const VERIFY_TOKEN = 'verify-token-for-the-handshake';
const PHONE_NUMBER_ID = '109876543210';

interface Actor { id: string; email: string; role: string }
const ACTORS: Record<string, Actor> = {
  prod: { id: '10000000-0000-4000-8000-000000000001', email: 'prod@mb.test', role: 'production_user' },
  prod2: { id: '10000000-0000-4000-8000-000000000002', email: 'prod2@mb.test', role: 'production_user' },
  fin: { id: '10000000-0000-4000-8000-000000000003', email: 'fin@mb.test', role: 'finance_manager' },
  accountant: { id: '10000000-0000-4000-8000-000000000004', email: 'acc@mb.test', role: 'accountant' },
  branch: { id: '10000000-0000-4000-8000-000000000005', email: 'branch@mb.test', role: 'branch_manager' },
};
const TOKENS: Record<string, string> = {};

let db: PGlite;
let server: Server;
let base: string;
const mock = new MockWhatsAppProvider();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { Authorization: `Bearer ${TOKENS[as]}` } : {}), 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Json = text;
  try { parsed = JSON.parse(text); } catch { /* plain text (the webhook challenge) */ }
  return { status: res.status, body: parsed };
}

const portal = (token: string, method: string, path: string, body?: unknown) =>
  call(null, method, `/api/supplier-portal${path}`, body, { 'X-Supplier-Token': token });

async function webhook(payload: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const res = await fetch(`${base}/api/whatsapp/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  return res.status;
}

const q = async (sql: string, params: unknown[] = []) => (await db.query<Json>(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
const num = async (sql: string, params: unknown[] = []) => Number(Object.values(await one(sql, params))[0]);

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Pull the raw token out of the link the mock was asked to send. */
function lastLinkToken(): string {
  for (let i = mock.sent.length - 1; i >= 0; i--) {
    const s = mock.sent[i]!;
    const text = s.body ?? (s.params ?? []).join(' ');
    const m = /supplier-portal\/#t=([A-Za-z0-9_-]+)/.exec(text);
    if (m) return m[1]!;
  }
  throw new Error('no link sent');
}

let supplierSeq = 0;
async function newSupplier(overrides: Record<string, unknown> = {}) {
  supplierSeq += 1;
  const res = await call('prod', 'POST', '/api/purchasing/suppliers', {
    name: `Supplier ${supplierSeq}`,
    whatsappNumber: `0300 12${String(supplierSeq).padStart(5, '0')}`,
    whatsappOptIn: true,
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const tomorrow = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

function demandBody(supplierId: string, extra: Record<string, unknown> = {}) {
  return {
    supplierId,
    priority: 'urgent',
    requiredDate: tomorrow(),
    paymentPreference: 'cash',
    items: [
      { itemName: 'Flour', requestedQty: 10, unit: 'kg' },
      { itemName: 'Butter', requestedQty: 5, unit: 'kg' },
    ],
    ...extra,
  };
}

/** Create → verify → send. Returns the demand and the supplier's raw token. */
async function sentDemand(supplierId: string, extra: Record<string, unknown> = {}) {
  const created = await call('prod', 'POST', '/api/purchasing/demands', demandBody(supplierId, extra));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const v = await call('prod', 'POST', `/api/purchasing/demands/${created.body.id}/verify`, { revision: created.body.revision });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.ok, true, JSON.stringify(v.body.checks));
  const sent = await call('prod', 'POST', `/api/purchasing/demands/${created.body.id}/send`, { revision: v.body.demand.revision });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await processOutboxOnce();
  return { demand: sent.body, token: lastLinkToken() };
}

const detail = async (id: string) => (await call('prod', 'GET', `/api/purchasing/demands/${id}`)).body;

function quotation(d: Json, overrides: Record<string, unknown> = {}) {
  const flour = d.items.find((i: Json) => i.itemName === 'Flour');
  const butter = d.items.find((i: Json) => i.itemName === 'Butter');
  return {
    items: [
      { demandItemId: flour.id, itemName: 'Flour', unit: 'kg', availableQty: 8, unitRate: 150, availability: 'partial' },
      { demandItemId: butter.id, itemName: 'Butter', unit: 'kg', availableQty: 5, unitRate: 1200.5, availability: 'available' },
    ],
    deliveryCharge: 300,
    ...overrides,
  };
}

async function approveLatest(id: string, as = 'prod') {
  const d = await detail(id);
  const latest = d.quotations.at(-1);
  const r = await call(as, 'POST', `/api/purchasing/demands/${id}/quotations/${latest.id}/decision`, { version: latest.version, decision: 'approve' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await processOutboxOnce();
  return d;
}

/** A bill exactly as quoted, for the approved quotation. */
function billFor(d: Json, overrides: Record<string, unknown> = {}) {
  const q2 = d.quotations.find((x: Json) => x.id === d.approvedQuotationId);
  return {
    supplierBillNo: `B-${Math.random().toString(36).slice(2, 8)}`,
    invoiceDate: new Date().toISOString().slice(0, 10),
    items: q2.items.filter((l: Json) => l.availableQty > 0).map((l: Json) => ({ quotationItemId: l.id, qty: l.availableQty, unitRate: l.unitRate })),
    deliveryCharge: q2.deliveryCharge,
    ...overrides,
  };
}

/** Supplier → quoted, approved, billed, bill approved: ready for receipt and payment. */
async function billedDemand() {
  const s = await newSupplier();
  const { demand, token } = await sentDemand(s.id);
  assert.equal((await portal(token, 'POST', '/quotation', quotation(demand))).status, 200);
  await approveLatest(demand.id);
  const billToken = lastLinkToken();
  const d = await detail(demand.id);
  const b = await portal(billToken, 'POST', '/bill', billFor(d));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const d2 = await detail(demand.id);
  const bill = d2.bills.at(-1);
  const r = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/bills/${bill.id}/decision`, { decision: 'approve' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await processOutboxOnce();
  return { supplier: s, demand: await detail(demand.id), token: billToken };
}

async function ensureItem(name: string, unit = 'kg'): Promise<string> {
  const existing = await one(`select id from purchase_items where lower(name) = lower($1) and unit = $2`, [name, unit]);
  if (existing) return existing.id;
  const r = await call('prod', 'POST', '/api/purchasing/items', { name, unit });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}

before(async () => {
  process.env['JWT_SECRET'] = 'whatsapp-purchasing-test-secret-long-enough';
  process.env['WHATSAPP_PROVIDER'] = 'mock';
  process.env['WHATSAPP_APP_SECRET'] = APP_SECRET;
  process.env['WHATSAPP_WEBHOOK_VERIFY_TOKEN'] = VERIFY_TOKEN;
  process.env['WHATSAPP_PHONE_NUMBER_ID'] = PHONE_NUMBER_ID;
  process.env['SUPPLIER_PORTAL_URL'] = 'https://web.test';

  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`create extension pg_trgm; create schema app;
    create role anon; create role authenticated; create role service_role; create role mb_api;`);
  await db.exec(BASELINE);
  // The dump empties search_path for its own session; the API's connections have the default.
  await db.exec('reset search_path');
  // Configuration rows the live database has and a schema-only baseline does not.
  await db.exec(`insert into counters (id, count) values
    ('users', 0), ('finance_payment_voucher', 0), ('finance_receipt_voucher', 0) on conflict do nothing`);
  await db.exec(MIGRATION);

  for (const a of Object.values(ACTORS)) {
    await db.query(`insert into users (id, email, display_name, role) values ($1, $2, $2, $3)`, [a.id, a.email, a.role]);
  }

  await usePglite(db);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);
  for (const [name, a] of Object.entries(ACTORS)) {
    const session = await prisma.auth_sessions.create({
      data: { user_id: a.id, client: 'web', expires_at: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    TOKENS[name] = signAccessToken(a.id, session.id).token;
  }

  setWhatsAppProvider(mock);
  setOutboxAutoKick(false);

  const express = (await import('express')).default;
  const { router: webhookRouter } = await import('../../routes/whatsapp-webhook.routes');
  const { router: purchasingRouter } = await import('../../routes/purchasing.routes');
  const { router: portalRouter } = await import('../../routes/supplier-portal.routes');
  const { router: financeRouter } = await import('../../routes/finance-supplier-payments.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use('/api/whatsapp/webhook', webhookRouter);
  app.use(express.json());
  app.use('/api/purchasing', purchasingRouter);
  app.use('/api/supplier-portal', portalRouter);
  app.use('/api/finance/supplier-payments', financeRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  setWhatsAppProvider(null);
  await db?.close();
});

// ── Suppliers ────────────────────────────────────────────────────────────────

describe('suppliers', () => {
  test('a local number is stored in E.164', async () => {
    const s = await newSupplier({ whatsappNumber: '0321-7654321' });
    assert.equal(s.whatsappNumber, '+923217654321');
  });

  test('an invalid number, a number already in use, and a missing opt-in are refused', async () => {
    assert.equal((await call('prod', 'POST', '/api/purchasing/suppliers', { name: 'X', whatsappNumber: '12ab', whatsappOptIn: true })).status, 400);
    const s = await newSupplier();
    const dup = await call('prod', 'POST', '/api/purchasing/suppliers', { name: 'Y', whatsappNumber: s.whatsappNumber, whatsappOptIn: true });
    assert.equal(dup.status, 409);
    const noConsent = await call('prod', 'POST', '/api/purchasing/suppliers', { name: 'Z', whatsappNumber: '0333 9998887' });
    assert.equal(noConsent.status, 400);
    assert.match(noConsent.body.error, /agreed to receive WhatsApp/);
  });
});

// ── Demands ──────────────────────────────────────────────────────────────────

describe('demands', () => {
  test('a valid urgent demand gets a backend id MB-WA-YYYYMMDD-NNNN and starts as a draft', async () => {
    const s = await newSupplier();
    const r = await call('prod', 'POST', '/api/purchasing/demands', demandBody(s.id));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.demandNo, /^MB-WA-\d{8}-\d{4}$/);
    assert.equal(r.body.status, 'draft');
    assert.equal(r.body.priority, 'urgent');
    assert.equal(r.body.items.length, 2);
    const second = await call('prod', 'POST', '/api/purchasing/demands', demandBody(s.id, { priority: 'normal' }));
    assert.equal(second.body.priority, 'normal');
    assert.equal(Number(second.body.demandNo.slice(-4)), Number(r.body.demandNo.slice(-4)) + 1);
  });

  test('an empty demand, a bad quantity, a bad unit and a bad priority are refused', async () => {
    const s = await newSupplier();
    for (const body of [
      demandBody(s.id, { items: [] }),
      demandBody(s.id, { items: [{ itemName: 'Flour', requestedQty: 0, unit: 'kg' }] }),
      demandBody(s.id, { items: [{ itemName: 'Flour', requestedQty: -2, unit: 'kg' }] }),
      demandBody(s.id, { items: [{ itemName: 'Flour', requestedQty: 1.2345, unit: 'kg' }] }),
      demandBody(s.id, { items: [{ itemName: '  ', requestedQty: 1, unit: 'kg' }] }),
      demandBody(s.id, { items: [{ itemName: 'Flour', requestedQty: 1, unit: 'tonnes' }] }),
      demandBody(s.id, { priority: 'asap' }),
      demandBody(s.id, { paymentPreference: 'credit' }),
    ]) {
      const r = await call('prod', 'POST', '/api/purchasing/demands', body);
      assert.equal(r.status, 400, JSON.stringify({ body, res: r.body }));
    }
  });

  test('a retried create (same clientRequestId) returns the first demand, not a second', async () => {
    const s = await newSupplier();
    const body = demandBody(s.id, { clientRequestId: 'retry-key-0001' });
    const a = await call('prod', 'POST', '/api/purchasing/demands', body);
    const b = await call('prod', 'POST', '/api/purchasing/demands', body);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.body.id);
    assert.equal(await num(`select count(*) from purchase_demands where client_request_id = 'retry-key-0001'`), 1);
  });

  test('only Production (and Super Admin) reach purchasing; nobody without a session does', async () => {
    assert.equal((await call('branch', 'GET', '/api/purchasing/demands')).status, 403);
    assert.equal((await call('fin', 'GET', '/api/purchasing/demands')).status, 403);
    assert.equal((await call(null, 'GET', '/api/purchasing/demands')).status, 401);
    assert.equal((await call('prod', 'GET', '/api/purchasing/demands')).status, 200);
  });

  test('verify blocks a past required date; an edit after verify un-verifies and Send is refused', async () => {
    const s = await newSupplier();
    const past = await call('prod', 'POST', '/api/purchasing/demands', demandBody(s.id, { requiredDate: '2020-01-01' }));
    const v1 = await call('prod', 'POST', `/api/purchasing/demands/${past.body.id}/verify`, { revision: past.body.revision });
    assert.equal(v1.body.ok, false);
    assert.equal(v1.body.checks.find((c: Json) => c.key === 'requiredDate').ok, false);
    assert.equal((await detail(past.body.id)).status, 'draft');

    const d = await call('prod', 'POST', '/api/purchasing/demands', demandBody(s.id));
    const v = await call('prod', 'POST', `/api/purchasing/demands/${d.body.id}/verify`, { revision: d.body.revision });
    assert.equal(v.body.ok, true);
    assert.equal(v.body.demand.status, 'verified');
    // The mock provider is a warning, never a pass.
    assert.equal(v.body.checks.find((c: Json) => c.key === 'provider').ok, false);
    const edited = await call('prod', 'PUT', `/api/purchasing/demands/${d.body.id}`, { ...demandBody(s.id), revision: v.body.demand.revision });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.status, 'draft');
    const send = await call('prod', 'POST', `/api/purchasing/demands/${d.body.id}/send`, { revision: edited.body.revision });
    assert.equal(send.status, 409);
    assert.equal(await num(`select count(*) from whatsapp_outbox where dedupe_key = $1`, [`demand:${d.body.id}:sent`]), 0);
  });

  test('send queues one message with a link; sending again is refused; the token leaves the database once sent', async () => {
    const s = await newSupplier();
    const before = mock.sent.length;
    const { demand, token } = await sentDemand(s.id);
    assert.equal(demand.status, 'awaiting_supplier');
    assert.equal(mock.sent.length, before + 1);
    const sent = mock.sent.at(-1)!;
    // No inbound message yet: the 24-hour window is closed, so the template went.
    assert.equal(sent.kind, 'template');
    assert.equal(sent.template, 'mb_purchase_demand');
    assert.equal(sent.params!.length, 6);
    assert.equal(sent.to, s.whatsappNumber.slice(1));

    const again = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/send`, { revision: demand.revision });
    assert.equal(again.status, 409);

    const msg = await one(`select * from whatsapp_messages where demand_id = $1`, [demand.id]);
    assert.equal(msg.status, 'accepted');
    assert.ok(!String(msg.body).includes(token), 'displayed body masks the token');
    const out = await one(`select * from whatsapp_outbox where message_id = $1`, [msg.id]);
    assert.ok(!JSON.stringify(out).includes(token), 'outbox keeps no token after sending');
    assert.equal(await num(`select count(*) from supplier_access_tokens where token_hash like '%' || $1 || '%'`, [token]), 0);
  });
});

// ── Supplier portal and quotations ───────────────────────────────────────────

describe('supplier portal and quotations', () => {
  test('a bad, expired or replaced link is refused; a good one sees only its demand', async () => {
    assert.equal((await portal('x'.repeat(43), 'GET', '/demand')).status, 401);
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    const v = await portal(token, 'GET', '/demand');
    assert.equal(v.status, 200);
    assert.equal(v.body.demandNo, demand.demandNo);
    assert.equal(v.body.items.length, 2);
    assert.equal(v.body.canQuote, true);
    for (const k of ['supplierId', 'paymentPreference', 'creditAmountRequested', 'createdByName', 'balance', 'payments']) {
      assert.ok(!(k in v.body), `${k} must not reach the supplier`);
    }

    await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/resend-link`);
    await processOutboxOnce();
    assert.equal((await portal(token, 'GET', '/demand')).status, 410);
    const fresh = lastLinkToken();
    assert.equal((await portal(fresh, 'GET', '/demand')).status, 200);

    await db.query(`update supplier_access_tokens set expires_at = now() - interval '1 minute' where demand_id = $1 and revoked_at is null`, [demand.id]);
    const expired = await portal(fresh, 'GET', '/demand');
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, 'expired');
  });

  test('the supplier removes, changes and substitutes items; totals are the server\'s', async () => {
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    const flour = demand.items.find((i: Json) => i.itemName === 'Flour');
    const butter = demand.items.find((i: Json) => i.itemName === 'Butter');
    const r = await portal(token, 'POST', '/quotation', {
      items: [
        { demandItemId: flour.id, itemName: 'Flour', unit: 'kg', availableQty: 8, unitRate: 150.25, availability: 'partial' },
        { demandItemId: butter.id, itemName: 'Butter', unit: 'kg', availableQty: 0, unitRate: 0, availability: 'unavailable' },
        { substituteForDemandItemId: butter.id, itemName: 'Margarine', unit: 'kg', availableQty: 5, unitRate: 600, availability: 'substitute' },
      ],
      deliveryCharge: 250,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 1);
    // 8 × 150.25 = 1202 ; 5 × 600 = 3000 ; + 250 delivery
    assert.equal(r.body.total, 4452);
    const d = await detail(demand.id);
    assert.equal(d.status, 'quotation_received');
    const lines = d.quotations[0].items;
    assert.deepEqual(lines.map((l: Json) => [l.itemName, l.lineTotal]), [['Flour', 1202], ['Butter', 0], ['Margarine', 3000]]);
    assert.equal(lines[1].requestedQty, 5);
  });

  test('an unavailable line with a quantity, or a line not on the demand, is refused', async () => {
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    const flour = demand.items[0];
    const bad1 = await portal(token, 'POST', '/quotation', { items: [{ demandItemId: flour.id, itemName: 'Flour', availableQty: 3, unitRate: 10, availability: 'unavailable' }] });
    assert.equal(bad1.status, 400);
    const bad2 = await portal(token, 'POST', '/quotation', { items: [{ demandItemId: '00000000-0000-4000-8000-0000000000ff', itemName: 'X', availableQty: 3, unitRate: 10, availability: 'available' }] });
    assert.equal(bad2.status, 400);
    assert.equal((await detail(demand.id)).quotations.length, 0);
  });

  test('a revised quotation withdraws the approval of the earlier version and needs approving again', async () => {
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    await portal(token, 'POST', '/quotation', quotation(demand));
    await approveLatest(demand.id);
    let d = await detail(demand.id);
    assert.equal(d.status, 'awaiting_supplier_bill');
    assert.equal(d.approvedQuotationId, d.quotations[0].id);

    const billLink = lastLinkToken();
    const v2 = await portal(billLink, 'POST', '/quotation', quotation(demand, { deliveryCharge: 500 }));
    assert.equal(v2.status, 200, JSON.stringify(v2.body));
    d = await detail(demand.id);
    assert.equal(d.status, 'quotation_received');
    assert.equal(d.approvedQuotationId, null);
    assert.deepEqual(d.quotations.map((x: Json) => [x.version, x.status]), [[1, 'superseded'], [2, 'submitted']]);
    assert.ok(d.events.some((e: Json) => e.event === 'approval_withdrawn'));

    // Approving the version the reviewer saw earlier is refused.
    const stale = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/quotations/${d.quotations[0].id}/decision`, { version: 1, decision: 'approve' });
    assert.equal(stale.status, 409);
    // A bill cannot be sent while the new version is unapproved.
    assert.equal((await portal(billLink, 'POST', '/bill', { supplierBillNo: 'B1', invoiceDate: '2026-10-20', items: [{ quotationItemId: d.quotations[1].items[0].id, qty: 1, unitRate: 1 }] })).status, 409);
  });

  test('request changes and reject need a reason; a rejected demand\'s link stops working', async () => {
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    await portal(token, 'POST', '/quotation', quotation(demand));
    const d = await detail(demand.id);
    const qid = d.quotations[0].id;
    assert.equal((await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/quotations/${qid}/decision`, { version: 1, decision: 'reject' })).status, 400);
    const changes = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/quotations/${qid}/decision`, { version: 1, decision: 'request_changes', reason: 'Rate for butter is too high' });
    assert.equal(changes.status, 200);
    assert.equal(changes.body.status, 'changes_requested');
    await processOutboxOnce();
    const link = lastLinkToken();
    const view = await portal(link, 'GET', '/demand');
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal((await portal(token, 'GET', '/demand')).status, 410, 'the first link was replaced');
    assert.match(view.body.productionNote, /too high/);

    await portal(link, 'POST', '/quotation', quotation(demand));
    const d2 = await detail(demand.id);
    const rej = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/quotations/${d2.quotations[1].id}/decision`, { version: 2, decision: 'reject', reason: 'Found another supplier' });
    assert.equal(rej.body.status, 'rejected');
    assert.equal((await portal(link, 'GET', '/demand')).status, 410);
    assert.equal((await portal(link, 'POST', '/quotation', quotation(demand))).status, 410);
  });
});

// ── Bills ────────────────────────────────────────────────────────────────────

describe('bills', () => {
  test('an unapproved quotation cannot be billed, received or paid', async () => {
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    await portal(token, 'POST', '/quotation', quotation(demand));
    const d = await detail(demand.id);
    assert.equal((await portal(token, 'POST', '/bill', { supplierBillNo: 'B9', invoiceDate: '2026-10-20', items: [{ quotationItemId: d.quotations[0].items[0].id, qty: 8, unitRate: 150 }] })).status, 409);
    assert.equal((await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/payments`, { method: 'cash', amount: 100, paidOn: '2026-10-20' })).status, 409);
    const itemId = await ensureItem('Flour');
    assert.equal((await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/receipts`, { items: [{ billItemId: d.quotations[0].items[0].id, itemId, receivedQty: 1 }] })).status, 409);
  });

  test('a bill that differs from the quotation needs its differences accepted, with a reason', async () => {
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    await portal(token, 'POST', '/quotation', quotation(demand));
    await approveLatest(demand.id);
    const link = lastLinkToken();
    const d = await detail(demand.id);
    const body = billFor(d);
    body.items[0].unitRate = 160; // flour 150 → 160
    const b = await portal(link, 'POST', '/bill', { ...body, discount: 100, otherCharges: 50 });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    // 8 × 160 + 5 × 1200.5 + 300 delivery + 50 other − 100 discount
    assert.equal(b.body.grandTotal, 1280 + 6002.5 + 300 + 50 - 100);
    assert.equal(b.body.differsFromQuotation, true);

    const bill = (await detail(demand.id)).bills[0];
    assert.deepEqual(bill.differences.map((x: Json) => x.field).sort(), ['other_charges', 'rate']);
    const plain = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/bills/${bill.id}/decision`, { decision: 'approve' });
    assert.equal(plain.status, 409);
    const noReason = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/bills/${bill.id}/decision`, { decision: 'approve', acceptDifferences: true });
    assert.equal(noReason.status, 400);
    const ok = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/bills/${bill.id}/decision`, { decision: 'approve', acceptDifferences: true, reason: 'Flour price went up today' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'awaiting_delivery');
  });

  test('a rejected bill creates no payable and sends a fresh link for a corrected one', async () => {
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    await portal(token, 'POST', '/quotation', quotation(demand));
    await approveLatest(demand.id);
    const link = lastLinkToken();
    await portal(link, 'POST', '/bill', billFor(await detail(demand.id)));
    const bill = (await detail(demand.id)).bills[0];
    const rej = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/bills/${bill.id}/decision`, { decision: 'reject', reason: 'Wrong bill number' });
    assert.equal(rej.body.status, 'awaiting_supplier_bill');
    await processOutboxOnce();
    const balances = (await call('prod', 'GET', `/api/purchasing/suppliers/balances?supplierId=${s.id}`)).body;
    assert.equal(balances[0].billed, 0);
    assert.equal(balances[0].outstanding, 0);
    assert.equal((await portal(link, 'GET', '/demand')).status, 410);
    const fresh = lastLinkToken();
    const view = await portal(fresh, 'GET', '/demand');
    assert.equal(view.body.canBill, true);
    assert.match(view.body.productionNote, /Wrong bill number/);
    assert.equal((await portal(fresh, 'POST', '/bill', billFor(await detail(demand.id)))).status, 200);
  });
});

// ── Receipt and ingredient stock ─────────────────────────────────────────────

describe('goods receipt and stock', () => {
  test('nothing reaches stock before a receipt; partial receipts add the accepted quantity once', async () => {
    const { demand } = await billedDemand();
    const flourId = await ensureItem('Flour');
    const butterId = await ensureItem('Butter');
    const stock = async (id: string) => num(`select coalesce((select balance from ingredient_stock where item_id = $1), 0)`, [id]);
    const flour0 = await stock(flourId);
    const butter0 = await stock(butterId);

    const bill = demand.bills.find((b: Json) => b.status === 'approved');
    const flourLine = bill.items.find((i: Json) => i.itemName === 'Flour');
    const butterLine = bill.items.find((i: Json) => i.itemName === 'Butter');
    const body = { clientRequestId: `receipt-${demand.id}`, items: [{ billItemId: flourLine.id, itemId: flourId, receivedQty: 5, damagedQty: 1 }] };
    const r = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/receipts`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'partially_received');
    assert.equal(await stock(flourId), flour0 + 4);

    const again = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/receipts`, body);
    assert.equal(again.status, 200);
    assert.equal(await stock(flourId), flour0 + 4, 'a retried receipt does not count twice');

    const tooMany = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/receipts`, { items: [{ billItemId: flourLine.id, itemId: flourId, receivedQty: 4 }] });
    assert.equal(tooMany.status, 409, 'only 3 of the 8 billed are still owed');

    const rest = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/receipts`, {
      items: [{ billItemId: flourLine.id, itemId: flourId, receivedQty: 2 }, { billItemId: butterLine.id, itemId: butterId, receivedQty: 5 }],
      final: true,
      notes: 'One bag of flour never came',
    });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal(rest.body.status, 'received');
    assert.deepEqual(rest.body.shortages.map((x: Json) => [x.item, x.short]), [['Flour', 1]]);
    assert.equal(await stock(flourId), flour0 + 6);
    assert.equal(await stock(butterId), butter0 + 5);
    assert.equal(await num(`select count(*) from ingredient_stock_movements where demand_id = $1`, [demand.id]), 3);
    // The movement ledger is append-only.
    await assert.rejects(db.query(`delete from ingredient_stock_movements where demand_id = $1`, [demand.id]));
  });
});

// ── Payments, credit and the Finance ledger ──────────────────────────────────

describe('payments and credit', () => {
  test('a payment waits for Finance; approval posts one PV; overpaying and double-posting are refused', async () => {
    const { demand } = await billedDemand();
    const total = demand.totals.billTotal as number;
    const pay = (amount: number, extra: Record<string, unknown> = {}) =>
      call('prod', 'POST', `/api/purchasing/demands/${demand.id}/payments`, { method: 'cash', amount, paidOn: new Date().toISOString().slice(0, 10), ...extra });

    const first = await pay(1000, { clientRequestId: `pay-${demand.id}-1` });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.status, 'pending_approval');
    const dup = await pay(1000, { clientRequestId: `pay-${demand.id}-1` });
    assert.equal(dup.body.id, first.body.id);
    assert.equal(await num(`select count(*) from supplier_payments where demand_id = $1`, [demand.id]), 1);
    assert.equal((await detail(demand.id)).paymentStatus, 'unpaid', 'a recorded payment is not a paid one');

    assert.equal((await pay(total)).status, 409, 'pending + new may not exceed the bill');
    assert.equal((await pay(10, { method: 'easypaisa' })).status, 400, 'Easypaisa needs a reference');

    assert.equal((await call('accountant', 'POST', `/api/finance/supplier-payments/${first.body.id}/approve`, {})).status, 403);
    assert.equal((await call('prod', 'POST', `/api/finance/supplier-payments/${first.body.id}/approve`, {})).status, 403);
    const ok = await call('fin', 'POST', `/api/finance/supplier-payments/${first.body.id}/approve`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'posted');
    assert.match(ok.body.voucherNo, /^PV-/);
    const entry = await one(`select * from ledger_entries where source_id = $1`, [first.body.id]);
    assert.equal(Number(entry.credit), 1000);
    assert.equal(entry.source_type, 'vendor_payment');
    assert.equal(entry.ledger_head_name, 'Raw Materials');
    assert.equal((await call('fin', 'POST', `/api/finance/supplier-payments/${first.body.id}/approve`, {})).status, 409);
    assert.equal((await detail(demand.id)).paymentStatus, 'partially_paid');

    const restAmt = Math.round((total - 1000) * 100) / 100;
    const second = await pay(restAmt, { method: 'bank', referenceNo: 'IBFT-778899' });
    await call('fin', 'POST', `/api/finance/supplier-payments/${second.body.id}/approve`, {});
    assert.equal((await detail(demand.id)).paymentStatus, 'paid');

    // Reversal: an opposite RV entry, the PV stays (marked reversed), status recomputed.
    const rev = await call('fin', 'POST', `/api/finance/supplier-payments/${second.body.id}/reverse`, { reason: 'Transfer bounced' });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    assert.match(rev.body.reversalVoucherNo, /^RV-/);
    const pv = await one(`select * from ledger_entries where id = (select ledger_entry_id from supplier_payments where id = $1)`, [second.body.id]);
    assert.equal(pv.status, 'reversed');
    assert.equal(pv.deleted_at, null);
    const rv = await one(`select * from ledger_entries where reverses_entry_id = $1`, [pv.id]);
    assert.equal(Number(rv.debit), restAmt);
    assert.equal((await detail(demand.id)).paymentStatus, 'partially_paid');
  });

  test('credit is no liability until Finance approves it; repayments settle it', async () => {
    const { supplier, demand } = await billedDemand();
    const total = demand.totals.billTotal as number;
    const req = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/credits`, { amount: total, terms: '30 days', dueDate: tomorrow() });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal(req.body.status, 'pending_approval');
    const bal = async () => (await call('fin', 'GET', `/api/finance/supplier-payments/balances?supplierId=${supplier.id}`)).body[0];
    assert.equal((await bal()).creditOutstanding, 0);
    assert.equal((await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/credits`, { amount: 1 })).status, 409, 'one open credit per bill');

    const dec = await call('fin', 'POST', `/api/finance/supplier-payments/credits/${req.body.id}/decision`, { decision: 'approve' });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    assert.equal(dec.body.status, 'active');
    assert.equal((await bal()).creditOutstanding, total);

    const repay = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/payments`, { method: 'cash', amount: total, paidOn: new Date().toISOString().slice(0, 10), creditId: req.body.id });
    assert.equal(repay.status, 201, JSON.stringify(repay.body));
    await call('fin', 'POST', `/api/finance/supplier-payments/${repay.body.id}/approve`, {});
    const after = await bal();
    assert.equal(after.creditOutstanding, 0);
    assert.equal(after.outstanding, 0);
    assert.equal((await one(`select status from supplier_credits where id = $1`, [req.body.id])).status, 'settled');
  });
});

// ── WhatsApp transport ───────────────────────────────────────────────────────

const inboundPayload = (from: string, id: string, text: string, extra: Record<string, unknown> = {}, phoneNumberId = PHONE_NUMBER_ID) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '923001110000', phone_number_id: phoneNumberId },
        contacts: [{ profile: { name: 'Ali Traders' }, wa_id: from }],
        messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra }],
      },
    }],
  }],
});

const statusPayload = (wamid: string, status: string, errors?: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '923001110000', phone_number_id: PHONE_NUMBER_ID },
    statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '923000000000', ...(errors ? { errors } : {}) }],
  } }] }],
});

describe('WhatsApp webhook', () => {
  test('the verification handshake echoes the challenge only for our token', async () => {
    const ok = await call(null, 'GET', `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(String(ok.body), '12345');
    assert.equal((await call(null, 'GET', '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  });

  test('an unsigned or mis-signed delivery is refused and stores nothing', async () => {
    const before = await num(`select count(*) from whatsapp_webhook_events`);
    assert.equal(await webhook(inboundPayload('923001234567', 'wamid.BAD', 'hi'), 'wrong-secret'), 401);
    assert.equal(verifySignature(Buffer.from('{}'), undefined, APP_SECRET), false);
    assert.equal(await num(`select count(*) from whatsapp_webhook_events`), before);
  });

  test('an inbound message is matched to the supplier\'s one open demand; a redelivery is ignored', async () => {
    const s = await newSupplier();
    const { demand } = await sentDemand(s.id);
    const wa = s.whatsappNumber.slice(1);
    assert.equal(await webhook(inboundPayload(wa, 'wamid.IN1', 'Flour rate is 150 today')), 200);
    await until(async () => (await num(`select count(*) from whatsapp_messages where provider_message_id = 'wamid.IN1'`)) === 1, 'inbound stored');
    assert.equal(await webhook(inboundPayload(wa, 'wamid.IN1', 'Flour rate is 150 today')), 200);
    await new Promise((r) => setTimeout(r, 100));
    const rows = await q(`select * from whatsapp_messages where provider_message_id = 'wamid.IN1'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].match_status, 'matched');
    assert.equal(rows[0].demand_id, demand.id);
    // Matching changed nothing about the demand.
    assert.equal((await detail(demand.id)).status, 'awaiting_supplier');
    const bell = await one(`select * from notifications where type = 'purchase_message' order by created_at desc limit 1`);
    assert.match(bell.message, /Flour rate/);
  });

  test('a message from an unknown number goes to the Unmatched queue, and can be assigned', async () => {
    assert.equal(await webhook(inboundPayload('923339990000', 'wamid.UNK', 'Who is this?')), 200);
    await until(async () => (await num(`select count(*) from whatsapp_messages where provider_message_id = 'wamid.UNK'`)) === 1, 'unmatched stored');
    const list = await call('prod', 'GET', '/api/purchasing/messages?filter=unmatched');
    const m = list.body.messages.find((x: Json) => x.providerMessageId === 'wamid.UNK');
    assert.equal(m.matchStatus, 'unmatched');
    const s = await newSupplier();
    const r = await call('prod', 'POST', `/api/purchasing/messages/${m.id}/review`, { action: 'assign', supplierId: s.id });
    assert.equal(r.body.matchStatus, 'assigned');
  });

  test('a delivery for another phone number is stored and not acted on', async () => {
    assert.equal(await webhook(inboundPayload('923001234500', 'wamid.OTHER', 'hello', {}, '999')), 200);
    await until(async () => (await num(`select count(*) from whatsapp_webhook_events where dedupe_key = 'msg:wamid.OTHER' and processed_at is not null`)) === 1, 'processed');
    assert.equal(await num(`select count(*) from whatsapp_messages where provider_message_id = 'wamid.OTHER'`), 0);
  });

  test('receipts move a message forward only; a failure is recorded with its error', async () => {
    const s = await newSupplier();
    const { demand } = await sentDemand(s.id);
    const m = await one(`select * from whatsapp_messages where demand_id = $1 and direction = 'outbound'`, [demand.id]);
    // The mock's id; a real one would be a wamid.
    const id = m.provider_message_id as string;
    for (const st of ['delivered', 'read', 'sent']) assert.equal(await webhook(statusPayload(id, st)), 200);
    await until(async () => (await one(`select status from whatsapp_messages where id = $1`, [m.id])).status === 'read', 'read');
    await new Promise((r) => setTimeout(r, 100));
    const after = await one(`select * from whatsapp_messages where id = $1`, [m.id]);
    assert.equal(after.status, 'read', 'a late "sent" does not undo "read"');
    assert.ok(after.delivered_at && after.read_at && after.sent_at);

    const { demand: d2 } = await sentDemand((await newSupplier()).id);
    const m2 = await one(`select * from whatsapp_messages where demand_id = $1`, [d2.id]);
    await webhook(statusPayload(m2.provider_message_id, 'failed', [{ code: 131026, title: 'Message undeliverable' }]));
    await until(async () => (await one(`select status from whatsapp_messages where id = $1`, [m2.id])).status === 'failed', 'failed');
    const failed = await call('prod', 'GET', '/api/purchasing/messages?filter=failed');
    assert.ok(failed.body.messages.some((x: Json) => x.id === m2.id && x.errorCode === '131026'));
  });
});

describe('outbox', () => {
  test('a rate limit backs off and retries; a hard failure fails; Retry resends the same message, no new demand', async () => {
    const s = await newSupplier();
    const created = await call('prod', 'POST', '/api/purchasing/demands', demandBody(s.id));
    const v = await call('prod', 'POST', `/api/purchasing/demands/${created.body.id}/verify`, { revision: created.body.revision });
    await call('prod', 'POST', `/api/purchasing/demands/${created.body.id}/send`, { revision: v.body.demand.revision });

    mock.failNext({ ok: false, retryable: true, code: '130429', error: 'Rate limit hit' });
    await processOutboxOnce();
    let out = await one(`select * from whatsapp_outbox where dedupe_key = $1`, [`demand:${created.body.id}:sent`]);
    assert.equal(out.status, 'pending');
    assert.equal(out.attempts, 1);
    assert.ok(new Date(out.next_attempt_at).getTime() > Date.now(), 'backed off');

    await db.query(`update whatsapp_outbox set next_attempt_at = now(), max_attempts = 2 where id = $1`, [out.id]);
    mock.failNext({ ok: false, retryable: false, code: '131026', error: 'Message undeliverable' });
    await processOutboxOnce();
    out = await one(`select * from whatsapp_outbox where id = $1`, [out.id]);
    assert.equal(out.status, 'failed');
    const msg = await one(`select * from whatsapp_messages where id = $1`, [out.message_id]);
    assert.equal(msg.status, 'failed');

    const demandsBefore = await num(`select count(*) from purchase_demands`);
    const messagesBefore = await num(`select count(*) from whatsapp_messages`);
    const retry = await call('prod', 'POST', `/api/purchasing/messages/${msg.id}/retry`);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    await processOutboxOnce();
    assert.equal((await one(`select status from whatsapp_messages where id = $1`, [msg.id])).status, 'accepted');
    assert.equal(await num(`select count(*) from purchase_demands`), demandsBefore);
    assert.equal(await num(`select count(*) from whatsapp_messages`), messagesBefore);
  });

  test('inside the 24-hour window an update goes as text; when WhatsApp says the window closed, the template goes', async () => {
    const s = await newSupplier();
    const { demand, token } = await sentDemand(s.id);
    await webhook(inboundPayload(s.whatsappNumber.slice(1), `wamid.WIN-${demand.id}`, 'Sending rates now'));
    await until(async () => (await num(`select count(*) from whatsapp_messages where provider_message_id = $1`, [`wamid.WIN-${demand.id}`])) === 1, 'inbound');
    await portal(token, 'POST', '/quotation', quotation(demand));
    await approveLatest(demand.id);
    assert.equal(mock.sent.at(-1)!.kind, 'text');

    const d = await detail(demand.id);
    mock.failNext({ ok: false, retryable: false, needsTemplate: true, code: '131047', error: 'Re-engagement message' });
    await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/resend-link`);
    await processOutboxOnce();
    const last = mock.sent.at(-1)!;
    assert.equal(last.kind, 'template');
    assert.equal(last.template, 'mb_purchase_update');
    assert.equal(last.params![0], d.demandNo);
  });

  test('a free-text reply outside the window is refused up front', async () => {
    const s = await newSupplier();
    await sentDemand(s.id);
    const conv = await one(`select id from whatsapp_conversations where wa_id = $1`, [s.whatsappNumber.slice(1)]);
    const r = await call('prod', 'POST', `/api/purchasing/conversations/${conv.id}/reply`, { body: 'Any update?' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /24-hour/);
  });
});

// ── The whole workflow ───────────────────────────────────────────────────────

// ── Review findings (2026-10-20) ─────────────────────────────────────────────

describe('settling a bill: credit and payments together', () => {
  const today = () => new Date().toISOString().slice(0, 10);

  test('credit and direct payments together may not exceed the bill, whichever comes first', async () => {
    const { demand } = await billedDemand();
    const total = demand.totals.billTotal as number;
    const credit = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/credits`, { amount: total });
    assert.equal(credit.status, 201, JSON.stringify(credit.body));
    const pay = (amount: number) => call('prod', 'POST', `/api/purchasing/demands/${demand.id}/payments`, { method: 'cash', amount, paidOn: today() });
    assert.equal((await pay(total)).status, 409, 'a credit waiting for Finance already holds the whole bill');
    await call('fin', 'POST', `/api/finance/supplier-payments/credits/${credit.body.id}/decision`, { decision: 'approve', approvedAmount: total - 500 });
    assert.equal((await pay(501)).status, 409);
    assert.equal((await pay(500)).status, 201, 'the part Finance did not put on credit can be paid');
    assert.equal(
      (await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/credits`, { amount: 1 })).status,
      409,
      'nothing is left to put on credit',
    );
  });

  test('a repayment may not exceed its credit, so credit outstanding never goes below zero', async () => {
    const { supplier, demand } = await billedDemand();
    const total = demand.totals.billTotal as number;
    const credit = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/credits`, { amount: total });
    await call('fin', 'POST', `/api/finance/supplier-payments/credits/${credit.body.id}/decision`, { decision: 'approve', approvedAmount: 100 });
    const repay = (amount: number) =>
      call('prod', 'POST', `/api/purchasing/demands/${demand.id}/payments`, { method: 'cash', amount, paidOn: today(), creditId: credit.body.id });
    assert.equal((await repay(total)).status, 409);
    const ok = await repay(100);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await repay(0.01)).status, 409, 'pending repayments count too');
    await call('fin', 'POST', `/api/finance/supplier-payments/${ok.body.id}/approve`, {});
    const bal = (await call('fin', 'GET', `/api/finance/supplier-payments/balances?supplierId=${supplier.id}`)).body[0];
    assert.equal(bal.creditOutstanding, 0);
  });

  test('a payment cannot be dated in the future or before its demand', async () => {
    const { demand } = await billedDemand();
    const pay = (paidOn: string) => call('prod', 'POST', `/api/purchasing/demands/${demand.id}/payments`, { method: 'cash', amount: 1, paidOn });
    assert.equal((await pay('2099-01-01')).status, 400);
    assert.equal((await pay('2001-01-01')).status, 400);
  });

  test('a request id from another demand is refused, not answered with that demand\'s record', async () => {
    const a = await sentDemand((await newSupplier()).id);
    const b = await sentDemand((await newSupplier()).id);
    const shared = `shared-${a.demand.id}`;
    assert.equal((await portal(a.token, 'POST', '/quotation', { ...quotation(a.demand), clientRequestId: shared })).status, 200);
    const other = await portal(b.token, 'POST', '/quotation', { ...quotation(b.demand), clientRequestId: shared });
    assert.equal(other.status, 409, JSON.stringify(other.body));
    assert.equal((await detail(b.demand.id)).quotations.length, 0);
  });

  test('received goods go only into a stock item measured in the billed unit', async () => {
    const { demand } = await billedDemand();
    const flourLine = demand.bills.find((b: Json) => b.status === 'approved').items.find((i: Json) => i.itemName === 'Flour');
    const sugarGrams = await ensureItem('Sugar', 'g');
    const r = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/receipts`, {
      items: [{ billItemId: flourLine.id, itemId: sugarGrams, receivedQty: 1 }],
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(await num(`select count(*) from ingredient_stock_movements where demand_id = $1`, [demand.id]), 0);
  });
});

describe('messages: links, assignment, late receipts', () => {
  test('a link message that WhatsApp failed after accepting cannot be retried; Resend link mints a new one', async () => {
    const { demand } = await sentDemand((await newSupplier()).id);
    const m = await one(`select * from whatsapp_messages where demand_id = $1 and direction = 'outbound'`, [demand.id]);
    await webhook(statusPayload(m.provider_message_id, 'failed', [{ code: 131047, title: 'Re-engagement message' }]));
    await until(async () => (await one(`select status from whatsapp_messages where id = $1`, [m.id])).status === 'failed', 'failed');
    const retry = await call('prod', 'POST', `/api/purchasing/messages/${m.id}/retry`);
    assert.equal(retry.status, 409);
    assert.match(retry.body.error, /Resend link/);
    const sentBefore = mock.sent.length;
    assert.equal((await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/resend-link`)).status, 200);
    await processOutboxOnce();
    assert.equal(mock.sent.length, sentBefore + 1);
    assert.doesNotMatch(JSON.stringify(mock.sent.at(-1)), /#t=•••/, 'the new message carries a live link');
  });

  test('a message from a known supplier cannot be filed under another supplier\'s demand', async () => {
    const x = await newSupplier();
    await sentDemand(x.id);
    const { demand: yDemand } = await sentDemand((await newSupplier()).id);
    assert.equal(await webhook(inboundPayload(x.whatsappNumber.slice(1), 'wamid.XTOY', 'rates attached')), 200);
    await until(async () => (await num(`select count(*) from whatsapp_messages where provider_message_id = 'wamid.XTOY'`)) === 1, 'stored');
    const m = await one(`select * from whatsapp_messages where provider_message_id = 'wamid.XTOY'`);
    const r = await call('prod', 'POST', `/api/purchasing/messages/${m.id}/review`, { action: 'assign', demandId: yDemand.id });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal((await one(`select supplier_id from whatsapp_messages where id = $1`, [m.id])).supplier_id, x.id);
  });

  test('a receipt that arrives before the send is recorded is kept for the recovery sweep, not dropped', async () => {
    assert.equal(await webhook(statusPayload('wamid.NOT-YET', 'delivered')), 200);
    await until(
      async () => (await num(`select attempts from whatsapp_webhook_events where dedupe_key like '%wamid.NOT-YET%'`)) >= 1,
      'attempted',
    );
    const ev = await one(`select processed_at from whatsapp_webhook_events where dedupe_key like '%wamid.NOT-YET%'`);
    assert.equal(ev.processed_at, null);
  });

  test('a long reason is shortened in the template, never the link after it', async () => {
    const { changesRequestedMessage } = await import('../purchasing/messages');
    const url = 'https://web.test/supplier-portal/#t=' + 'a'.repeat(43);
    const msg = changesRequestedMessage(
      { id: 'd', demand_no: 'MB-WA-20261020-9999', supplier_id: 's', supplier_name: 'S', supplier_whatsapp: '+923001234567', priority: 'normal', required_date: '2026-10-21' },
      1,
      'x'.repeat(1000),
      { token: 'a'.repeat(43), hash: 'h'.repeat(64), expiresAt: '', url, maskedUrl: 'https://web.test/supplier-portal/#t=•••' },
    );
    assert.ok(msg.params[1]!.endsWith(url), 'the link survives');
    assert.ok(msg.params[1]!.length <= 1000);
  });
});

describe('end to end', () => {
  test('urgent flour + butter: demand → 8 of 10 flour quoted → approved → bill → Bykea → received → paid, reconciled', async () => {
    const s = await newSupplier({ name: 'Punjab Flour & Dairy' });
    const flourId = await ensureItem('Flour');
    const butterId = await ensureItem('Butter');
    const stock0 = { flour: await num(`select coalesce((select balance from ingredient_stock where item_id = $1), 0)`, [flourId]), butter: await num(`select coalesce((select balance from ingredient_stock where item_id = $1), 0)`, [butterId]) };

    // 1–3. Create, verify, forward; the mock records the outbound message.
    const { demand, token } = await sentDemand(s.id, {
      items: [{ itemId: flourId, itemName: 'Flour', requestedQty: 10, unit: 'kg' }, { itemId: butterId, itemName: 'Butter', requestedQty: 5, unit: 'kg' }],
    });
    assert.equal(mock.sent.at(-1)!.params![1], demand.demandNo);

    // 4–5. Supplier: 8 flour, 5 butter, rates.
    const flour = demand.items[0];
    const butter = demand.items[1];
    const qv = await portal(token, 'POST', '/quotation', {
      items: [
        { demandItemId: flour.id, itemName: 'Flour', availableQty: 8, unitRate: 140, availability: 'partial' },
        { demandItemId: butter.id, itemName: 'Butter', availableQty: 5, unitRate: 1100, availability: 'available' },
      ],
      deliveryCharge: 0,
      estimatedDeliveryDate: tomorrow(),
    });
    assert.equal(qv.body.total, 8 * 140 + 5 * 1100);

    // 6. Production approves that exact version.
    await approveLatest(demand.id);
    const billLink = lastLinkToken();

    // 7. Supplier bill.
    const d1 = await detail(demand.id);
    const bill = await portal(billLink, 'POST', '/bill', billFor(d1, { supplierBillNo: 'PFD-5521' }));
    assert.equal(bill.body.grandTotal, 6620);
    assert.equal(bill.body.differsFromQuotation, false);

    // 8. Bill approved; Bykea booked.
    const billRow = (await detail(demand.id)).bills[0];
    await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/bills/${billRow.id}/decision`, { decision: 'approve' });
    const del = await call('prod', 'PUT', `/api/purchasing/demands/${demand.id}/delivery`, { provider: 'bykea', bookingReference: 'BYK-88', estimatedFee: 350, feePaidBy: 'mountain_bakes', status: 'dispatched' });
    assert.equal(del.status, 200, JSON.stringify(del.body));

    // 9. Goods received in full.
    const d2 = await detail(demand.id);
    const approved = d2.bills.find((b: Json) => b.status === 'approved');
    const rc = await call('prod', 'POST', `/api/purchasing/demands/${demand.id}/receipts`, {
      items: approved.items.map((l: Json) => ({ billItemId: l.id, itemId: l.itemName === 'Flour' ? flourId : butterId, receivedQty: l.qty })),
    });
    assert.equal(rc.body.status, 'received');

    // 10. Paid in cash; Finance approves.
    const pay = await call('prod2', 'POST', `/api/purchasing/demands/${demand.id}/payments`, { method: 'cash', amount: 6620, paidOn: new Date().toISOString().slice(0, 10) });
    await call('fin', 'POST', `/api/finance/supplier-payments/${pay.body.id}/approve`, {});

    // 11. Reconcile.
    const final = await detail(demand.id);
    assert.equal(final.status, 'received');
    assert.equal(final.paymentStatus, 'paid');
    assert.equal(final.deliveryStatus, 'delivered');
    assert.equal(final.totals.outstanding, 0);
    assert.equal(await num(`select balance from ingredient_stock where item_id = $1`, [flourId]), stock0.flour + 8);
    assert.equal(await num(`select balance from ingredient_stock where item_id = $1`, [butterId]), stock0.butter + 5);
    assert.equal(await num(`select coalesce(sum(credit), 0) from ledger_entries where source_type = 'vendor_payment' and source_id = $1`, [pay.body.id]), 6620);
    const bal = (await call('prod', 'GET', `/api/purchasing/suppliers/balances?supplierId=${s.id}`)).body[0];
    assert.deepEqual([bal.billed, bal.paid, bal.outstanding], [6620, 6620, 0]);
    assert.deepEqual(
      final.events.map((e: Json) => e.event).filter((e: string) => !e.startsWith('message')),
      ['created', 'verified', 'sent', 'quotation_submitted', 'quotation_approved', 'bill_submitted', 'bill_approved', 'delivery_updated', 'goods_received', 'payment_recorded', 'payment_posted'],
    );
    assert.equal((await portal(billLink, 'GET', '/demand')).status, 410, 'the supplier link closes once goods are received');

    // 12. The page shows the conversation and the current state.
    const msgs = await call('prod', 'GET', `/api/purchasing/messages?demandId=${demand.id}`);
    assert.ok(msgs.body.messages.length >= 3);
    const summary = await call('prod', 'GET', '/api/purchasing/summary');
    assert.ok(summary.body.buckets.completed >= 1);
    const listed = await call('prod', 'GET', '/api/purchasing/demands?bucket=completed');
    assert.ok(listed.body.demands.some((x: Json) => x.id === demand.id && x.paidTotal === 6620 && x.billTotal === 6620));

    // Replays of everything above changed nothing.
    const status = await webhook(statusPayload(String((await one(`select provider_message_id from whatsapp_messages where demand_id = $1 order by created_at limit 1`, [demand.id])).provider_message_id), 'delivered'));
    assert.equal(status, 200);
    assert.equal(await num(`select count(*) from supplier_payments where demand_id = $1`, [demand.id]), 1);
    assert.equal(await num(`select count(*) from purchase_receipts where demand_id = $1`, [demand.id]), 1);
  });
});

describe('connection status', () => {
  test('reports the mock provider and never a secret', async () => {
    const r = await call('prod', 'GET', '/api/purchasing/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.provider, 'mock');
    assert.equal(r.body.state, 'mock');
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(APP_SECRET) && !text.includes(VERIFY_TOKEN));
  });
});

describe('query-layer catalog', () => {
  test('src/db/catalog.generated.json describes every new table and function exactly as the migration creates them', async () => {
    const { CATALOG_QUERY, shapeCatalog } = await import('../../db/catalog-query');
    const committed = JSON.parse(readFileSync(join(__dirname, '../../db/catalog.generated.json'), 'utf8'));
    await db.exec(`set search_path = ''`);
    const live = shapeCatalog((await db.query<Json>(CATALOG_QUERY)).rows[0].json_build_object) as Json;
    await db.exec('reset search_path');
    const tables = Object.keys(live.tables).filter((t) => /^(purchase_|supplier|ingredient_|whatsapp_)/.test(t) || t === 'suppliers');
    const fns = Object.keys(live.functions).filter((f) => /^(purchase_|supplier_|ingredient_|whatsapp_)/.test(f));
    assert.ok(tables.length >= 20 && fns.length >= 25);
    for (const t of tables) assert.deepEqual(committed.tables[t], live.tables[t], `table ${t} — rerun the catalog merge`);
    for (const f of fns) assert.deepEqual(committed.functions[f], live.functions[f], `function ${f} — rerun the catalog merge`);
  });
});

describe('Meta Cloud API provider', () => {
  test('sends the documented payload and classifies errors', async () => {
    const { MetaCloudProvider, templateSafe } = await import('../whatsapp/meta.provider');
    const { whatsappConfig } = await import('../whatsapp/config');
    const cfg = { ...whatsappConfig(), provider: 'meta' as const, accessToken: 'tok', phoneNumberId: '111', missing: [] };
    const provider = new MetaCloudProvider(cfg);
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: Json; auth: string }> = [];
    let reply: { status: number; body: Json } = { status: 200, body: { messages: [{ id: 'wamid.OK' }] } };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>)['Authorization']) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch;
    try {
      const ok = await provider.sendTemplate({ to: '923001234567', template: 'mb_purchase_demand', language: 'en', params: ['a\nb', 'c'] });
      assert.deepEqual(ok, { ok: true, providerMessageId: 'wamid.OK' });
      assert.equal(calls[0]!.url, `https://graph.facebook.com/${cfg.apiVersion}/111/messages`);
      assert.equal(calls[0]!.auth, 'Bearer tok');
      assert.equal(calls[0]!.body.template.components[0].parameters[0].text, 'a b', 'no newline in a template variable');

      reply = { status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } };
      const window = await provider.sendText({ to: '923001234567', body: 'hi' });
      assert.equal(window.ok, false);
      if (!window.ok) assert.deepEqual([window.needsTemplate, window.retryable], [true, false]);

      reply = { status: 429, body: { error: { code: 130429, message: 'Rate limit hit' } } };
      const limited = await provider.sendText({ to: '923001234567', body: 'hi' });
      if (!limited.ok) assert.equal(limited.retryable, true);

      reply = { status: 400, body: { error: { code: 132001, message: 'Template name does not exist' } } };
      const missing = await provider.sendText({ to: '923001234567', body: 'hi' });
      if (!missing.ok) assert.deepEqual([missing.retryable, missing.code], [false, '132001']);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(templateSafe('a    b\t\tc'), 'a   b c');
  });
});
