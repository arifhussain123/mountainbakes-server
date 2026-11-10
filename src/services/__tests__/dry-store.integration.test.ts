import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';
import { signAccessToken } from '../auth/tokens';

/**
 * Dry Items Store (migrations 20261110000001/2), end to end.
 *
 * pglite runs the whole production schema (0_baseline and every migration
 * after it, in order), then requests go through the real /api/store router:
 * auth, role and account-switch checks, validation, idempotency, the database
 * functions. DB_MAX_ROWS is tiny so anything that forgets to page shows up.
 *
 * Run: node --import tsx --test src/services/__tests__/dry-store.integration.test.ts
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm') as { pg_trgm: import('@electric-sql/pglite').Extension };

const PRISMA = join(__dirname, '../../../prisma/migrations');
const MIGRATIONS = readdirSync(PRISMA).filter((d) => /^\d/.test(d)).sort();

interface Actor { id: string; email: string; role: string }
const ACTORS: Record<string, Actor> = {
  admin: { id: '20000000-0000-4000-8000-000000000001', email: 'admin@mb.test', role: 'super_admin' },
  store: { id: '20000000-0000-4000-8000-000000000002', email: 'store@mb.test', role: 'store_user' },
  prod: { id: '20000000-0000-4000-8000-000000000003', email: 'prod@mb.test', role: 'production_user' },
  prod2: { id: '20000000-0000-4000-8000-000000000004', email: 'prod2@mb.test', role: 'production_user' },
  fin: { id: '20000000-0000-4000-8000-000000000005', email: 'fin@mb.test', role: 'finance_manager' },
  auditor: { id: '20000000-0000-4000-8000-000000000006', email: 'aud@mb.test', role: 'finance_auditor' },
  branch: { id: '20000000-0000-4000-8000-000000000007', email: 'branch@mb.test', role: 'branch_manager' },
};
const TOKENS: Record<string, string> = {};

let db: PGlite;
let server: Server;
let base: string;
let today = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(as: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/store${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKENS[as]}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Json = text;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

const ok = async (as: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
  const r = await call(as, method, path, body, headers);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const q = async (sql: string, params: unknown[] = []) => (await db.query<Json>(sql, params)).rows;
const num = async (sql: string, params: unknown[] = []) => Number(Object.values((await q(sql, params))[0])[0]);

const item = (code: string, name: string, extra: Record<string, unknown> = {}) => ({
  itemCode: code, name, category: 'Nuts & Dried Fruit', baseUnit: 'KG', purchaseUnit: 'Box', conversionQty: 1, minStock: 5, ...extra,
});

before(async () => {
  process.env['JWT_SECRET'] = 'dry-store-test-secret-long-enough-for-hs256';
  process.env['DB_MAX_ROWS'] = '3';

  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`create extension pg_trgm; create schema app;
    create role anon; create role authenticated; create role service_role; create role mb_api;`);
  for (const m of MIGRATIONS) {
    await db.exec(readFileSync(join(PRISMA, m, 'migration.sql'), 'utf8'));
    if (m === '0_baseline') {
      await db.exec('reset search_path');
      await db.exec(`insert into counters (id, count) values
        ('users', 0), ('finance_payment_voucher', 0), ('finance_receipt_voucher', 0) on conflict do nothing`);
    }
  }
  for (const a of Object.values(ACTORS)) {
    await db.query(`insert into users (id, email, display_name, role) values ($1, $2, $2, $3)`, [a.id, a.email, a.role]);
  }
  today = (await q(`select app.karachi_business_date()::text as d`))[0].d;

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

  const express = (await import('express')).default;
  const { router } = await import('../../routes/store.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/store', router);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

// Shared through the workflow below.
let almonds: Json;
let cashews: Json;
let almondBox: Json;

describe('accounts and the store id', () => {
  test('the store exists with a generated id; a Store keeper gets default switches', async () => {
    const me = await ok('store', 'GET', '/me');
    assert.match(me.store.storeCode, /^DRY-STORE-\d{3}$/);
    assert.equal(me.role, 'store_user');
    assert.equal(me.can.receive, true);
    assert.equal(me.can['prices.edit'], false);
    assert.equal(me.can.accounts, false);
  });

  test('Admin lists and sets a Store keeper\'s switches; nobody else may', async () => {
    const list = await ok('admin', 'GET', '/accounts');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, null);
    assert.equal((await call('store', 'GET', '/accounts')).status, 403);
    const saved = await ok('admin', 'PUT', `/accounts/${ACTORS.store!.id}`, { canManageItems: true, canEditPrices: false, canAdjustStock: true, canIssue: true });
    assert.ok(saved.id);
  });

  test('a branch account is shut out of the Store entirely', async () => {
    assert.equal((await call('branch', 'GET', '/items')).status, 403);
    assert.equal((await call('branch', 'GET', '/me')).status, 403);
  });
});

describe('items and Price Control', () => {
  test('the Store keeper creates items with backend ids; duplicates are refused', async () => {
    almonds = await ok('store', 'POST', '/items', item('alm-001', 'Almonds'));
    assert.match(almonds.itemNo, /^DRY-\d{3}$/);
    assert.equal(almonds.itemCode, 'ALM-001');
    cashews = await ok('store', 'POST', '/items', item('CSH-001', 'Cashew Nuts'));
    assert.equal((await call('store', 'POST', '/items', item('ALM-002', 'almonds'))).status, 409);
    assert.equal((await call('store', 'POST', '/items', item('ALM-001', 'Other'))).status, 409);
    assert.equal((await call('store', 'POST', '/items', item('X', 'Bad code'))).status, 400);
    assert.equal((await call('store', 'POST', '/items', item('BAD-1', 'Bad unit', { baseUnit: 'Furlong' }))).status, 400);
  });

  test('a Store keeper cannot set prices unless Admin allows it; Finance Manager can', async () => {
    const body = { itemId: almonds.id, packageName: 'Box', packageQty: 1, price: 2000, effectiveFrom: today };
    assert.equal((await call('store', 'POST', '/prices', body)).status, 403);
    assert.equal((await call('auditor', 'POST', '/prices', body)).status, 403);
    almondBox = await ok('fin', 'POST', '/prices', body);
    assert.match(almondBox.priceNo, /^PRC-\d{4}$/);
    assert.equal(almondBox.state, 'active');
    await ok('admin', 'POST', '/prices', { itemId: cashews.id, packageName: 'Box', packageQty: 1, price: 3000, effectiveFrom: today });
  });

  test('a past effective date and a same-day duplicate are refused', async () => {
    assert.equal((await call('admin', 'POST', '/prices', { itemId: almonds.id, packageName: 'Box', packageQty: 1, price: 1, effectiveFrom: '2020-01-01' })).status, 400);
    assert.equal((await call('admin', 'POST', '/prices', { itemId: almonds.id, packageName: 'Box', packageQty: 1, price: 2100, effectiveFrom: today })).status, 409);
  });
});

describe('receiving keeps every batch at its own price', () => {
  test('first batch 50 KG at Rs. 2,000 and second 30 KG at Rs. 2,200 stay separate', async () => {
    const r1 = await ok('store', 'POST', '/receipts', {
      receiptDate: today, supplierName: 'Hashmi Dry Fruits', clientRequestId: randomUUID(),
      lines: [{ itemId: almonds.id, priceId: almondBox.id, packages: 50, batchNo: 'H-1' }],
    });
    assert.match(r1.receiptNo, /^RCV-\d{6}$/);
    assert.equal(r1.totalAmount, 100000);

    // A Store keeper may not override a price; Admin may, with a reason.
    const overrideLine = { itemId: almonds.id, priceId: almondBox.id, packages: 30, overridePrice: 2200, overrideReason: 'New invoice rate' };
    assert.equal((await call('store', 'POST', '/receipts', { receiptDate: today, supplierName: 'Hashmi Dry Fruits', lines: [overrideLine] })).status, 409);
    assert.equal((await call('admin', 'POST', '/receipts', { receiptDate: today, supplierName: 'Hashmi Dry Fruits', lines: [{ ...overrideLine, overrideReason: '' }] })).status, 400);
    const r2 = await ok('admin', 'POST', '/receipts', { receiptDate: today, supplierName: 'Hashmi Dry Fruits', lines: [overrideLine] });
    assert.equal(r2.totalAmount, 66000);

    const batches = await q(`select received_qty::float q, remaining_qty::float r, unit_cost::float c from store_batches where item_id = $1 order by created_at`, [almonds.id]);
    assert.deepEqual(batches, [{ q: 50, r: 50, c: 2000 }, { q: 30, r: 30, c: 2200 }]);
    assert.equal(await num(`select available_qty from store_items where id = $1`, [almonds.id]), 80);
  });

  test('the same supplier, date and items is flagged until confirmed; a retry with the same request id is not doubled', async () => {
    const body = { receiptDate: today, supplierName: 'Hashmi Dry Fruits', lines: [{ itemId: almonds.id, priceId: almondBox.id, packages: 50 }] };
    const dup = await call('store', 'POST', '/receipts', body);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.details.code, 'duplicate_receipt');
    assert.match(dup.body.details.duplicateOf, /^RCV-/);

    const cashBody = { receiptDate: today, supplierName: 'Metro', clientRequestId: randomUUID(), lines: [{ itemId: cashews.id, priceId: (await q(`select id from store_item_prices where item_id = $1`, [cashews.id]))[0].id, packages: 10 }] };
    const a = await ok('store', 'POST', '/receipts', cashBody);
    const b = await ok('store', 'POST', '/receipts', { ...cashBody, confirmDuplicate: true });
    assert.equal(a.id, b.id);
    assert.equal(await num(`select available_qty from store_items where id = $1`, [cashews.id]), 10);
  });

  test('a new price never changes the price of stock already received', async () => {
    const tomorrow = (await q(`select ($1::date + 1)::text d`, [today]))[0].d;
    await ok('admin', 'POST', '/prices', { itemId: almonds.id, packageName: 'Box', packageQty: 1, price: 2500, effectiveFrom: tomorrow });
    const prices = await ok('admin', 'GET', `/prices?itemId=${almonds.id}&history=true`);
    assert.deepEqual(prices.map((p: Json) => p.state).sort(), ['active', 'scheduled']);
    const costs = await q(`select unit_cost::float c from store_batches where item_id = $1 order by created_at`, [almonds.id]);
    assert.deepEqual(costs.map((c) => c.c), [2000, 2200]);
  });
});

describe('demand → approval → FIFO issue → receipt', () => {
  let demand: Json;
  let issue: Json;

  test('Production raises a demand; only Production may', async () => {
    const body = { requiredDate: today, remarks: 'Morning batch', clientRequestId: randomUUID(), lines: [{ itemId: almonds.id, qty: 60 }, { itemId: cashews.id, qty: 15 }] };
    assert.equal((await call('store', 'POST', '/demands', body)).status, 403);
    demand = await ok('prod', 'POST', '/demands', body);
    assert.match(demand.demandNo, /^DRD-\d{6}$/);
    assert.equal(demand.status, 'pending_review');
    const again = await ok('prod', 'POST', '/demands', body);
    assert.equal(again.id, demand.id, 'a retried submit returns the first demand');
    assert.equal(await num(`select count(*) from store_demands`), 1);
  });

  test('invalid quantities are refused', async () => {
    assert.equal((await call('prod', 'POST', '/demands', { requiredDate: today, lines: [{ itemId: almonds.id, qty: 0 }] })).status, 400);
    assert.equal((await call('prod', 'POST', '/demands', { requiredDate: '2020-01-01', lines: [{ itemId: almonds.id, qty: 1 }] })).status, 400);
    assert.equal((await call('prod', 'POST', '/demands', { requiredDate: today, lines: [{ itemId: almonds.id, qty: 1 }, { itemId: almonds.id, qty: 2 }] })).status, 400);
  });

  test('Production sees only its own demands', async () => {
    assert.equal((await ok('prod2', 'GET', '/demands')).total, 0);
    assert.equal((await call('prod2', 'GET', `/demands/${demand.id}`)).status, 404);
    assert.equal((await ok('prod', 'GET', '/demands')).total, 1);
  });

  test('approval cannot exceed free stock; partial approval needs a reason', async () => {
    const cash = demand.lines.find((l: Json) => l.itemId === cashews.id);
    const r = await call('store', 'POST', `/demand-lines/${cash.id}/decision`, { decision: 'approve' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /free/);
    assert.equal((await call('store', 'POST', `/demand-lines/${cash.id}/decision`, { decision: 'approve', qty: 10 })).status, 400);
    const d = await ok('store', 'POST', `/demand-lines/${cash.id}/decision`, { decision: 'approve', qty: 10, note: 'Only 10 KG in store' });
    assert.equal(d.lines.find((l: Json) => l.id === cash.id).approvedQty, 10);
  });

  test('approve-all approves what fits; production cannot approve', async () => {
    assert.equal((await call('prod', 'POST', `/demands/${demand.id}/approve-all`)).status, 403);
    const r = await ok('store', 'POST', `/demands/${demand.id}/approve-all`);
    assert.equal(r.approved, 1);
    assert.equal(r.demand.status, 'ready_to_issue');
    assert.equal(await num(`select count(*) from notifications where type = 'store_demand_reviewed' and target_user_id = $1`, [ACTORS.prod!.id]), 1);
  });

  test('stock cannot be adjusted under what is committed silently: the adjustment is refused below zero, allowed above', async () => {
    assert.equal((await call('store', 'POST', '/adjustments', { itemId: almonds.id, direction: 'out', qty: 500, reason: 'Damaged' })).status, 409);
    assert.equal((await call('store', 'POST', '/adjustments', { itemId: almonds.id, direction: 'out', qty: 1, reason: 'Other' })).status, 400);
  });

  test('issuing drains the oldest batch first and keeps each batch\'s cost', async () => {
    assert.equal((await call('prod', 'POST', '/issues', { demandId: demand.id, receivedBy: 'Imran' })).status, 403);
    issue = await ok('store', 'POST', '/issues', { demandId: demand.id, receivedBy: 'Imran', clientRequestId: randomUUID() });
    assert.match(issue.issueNo, /^ISS-\d{6}$/);
    const alm = issue.lines.find((l: Json) => l.itemId === almonds.id);
    assert.deepEqual(alm.batches.map((b: Json) => [b.qty, b.unitCost]), [[50, 2000], [10, 2200]]);
    assert.equal(alm.costAmount, 122000);
    assert.equal(await num(`select available_qty from store_items where id = $1`, [almonds.id]), 20);
    assert.deepEqual((await q(`select remaining_qty::float r from store_batches where item_id = $1 order by created_at`, [almonds.id])).map((b) => b.r), [0, 20]);
    const d = await ok('store', 'GET', `/demands/${demand.id}`);
    assert.equal(d.status, 'issued');
    assert.equal((await call('store', 'POST', '/issues', { demandId: demand.id, receivedBy: 'Imran' })).status, 409, 'nothing approved is left');
  });

  test('Production confirms with a difference, which needs a note and reaches Admin', async () => {
    const alm = issue.lines.find((l: Json) => l.itemId === almonds.id);
    assert.equal((await call('prod', 'POST', `/issues/${issue.id}/confirm`, { lines: [{ issueItemId: alm.id, receivedQty: 59 }] })).status, 400);
    const s = await ok('prod', 'POST', `/issues/${issue.id}/confirm`, { lines: [{ issueItemId: alm.id, receivedQty: 59 }], note: 'One kilo short' });
    assert.equal(s.status, 'received_with_difference');
    assert.equal(await num(`select count(*) from notifications where type = 'store_issue_received' and target_role = 'super_admin'`), 1);
    assert.equal((await call('prod', 'POST', `/issues/${issue.id}/confirm`, {})).status, 409);
    assert.equal((await ok('store', 'GET', `/demands/${demand.id}`)).status, 'received');
  });

  test('quantity maintenance: opening + received − issued ± adjusted = closing', async () => {
    await ok('store', 'POST', '/adjustments', { itemId: almonds.id, direction: 'out', qty: 2, reason: 'Damaged', note: 'Torn box' });
    await ok('store', 'POST', '/adjustments', { itemId: almonds.id, direction: 'in', qty: 1, reason: 'Returned from Production' });
    assert.equal((await call('store', 'POST', '/adjustments', { itemId: almonds.id, direction: 'in', qty: 1, reason: 'Opening stock' })).status, 409, 'opening stock is Admin\'s');
    const s = await ok('store', 'GET', `/stock?from=${today}&to=${today}`);
    const a = s.rows.find((r: Json) => r.id === almonds.id);
    assert.equal(a.received, 80);
    assert.equal(a.issued, 60);
    assert.equal(a.adjusted, -2);
    assert.equal(a.returned, 1);
    assert.equal(a.closing, a.opening + a.received + a.returned - a.issued + a.adjusted);
    assert.equal(a.closing, 19);
    assert.equal(a.availableQty, 19);
    const ledger = await ok('store', 'GET', `/items/${almonds.id}/ledger?from=${today}&to=${today}`);
    assert.equal(ledger.closing, 19);
    assert.equal(ledger.rows.at(-1).balance, 19);
    // Batches still add up to the balance.
    assert.equal(await num(`select sum(remaining_qty) from store_batches where item_id = $1`, [almonds.id]), 19);
  });
});

describe('concurrency and negative stock', () => {
  test('two issues racing for the last stock: one succeeds, nothing goes negative', async () => {
    const bag = await ok('store', 'POST', '/items', item('RSN-001', 'Raisins'));
    const price = await ok('admin', 'POST', '/prices', { itemId: bag.id, packageName: 'Box', packageQty: 1, price: 900, effectiveFrom: today });
    await ok('store', 'POST', '/receipts', { receiptDate: today, supplierName: 'Race', lines: [{ itemId: bag.id, priceId: price.id, packages: 5 }] });
    const d1 = await ok('prod', 'POST', '/demands', { requiredDate: today, lines: [{ itemId: bag.id, qty: 5 }] });
    await ok('store', 'POST', `/demand-lines/${d1.lines[0].id}/decision`, { decision: 'approve' });
    const d2 = await ok('prod', 'POST', '/demands', { requiredDate: today, lines: [{ itemId: bag.id, qty: 5 }] });
    // Free stock is now 0, so the second approval is refused outright.
    assert.equal((await call('store', 'POST', `/demand-lines/${d2.lines[0].id}/decision`, { decision: 'approve' })).status, 409);
    // Remove stock behind the approval, then race two issues of the first demand.
    await ok('store', 'POST', '/adjustments', { itemId: bag.id, direction: 'out', qty: 3, reason: 'Spillage' });
    const [a, b] = await Promise.all([
      call('store', 'POST', '/issues', { demandId: d1.id, receivedBy: 'A', lines: [{ lineId: d1.lines[0].id, qty: 2 }] }),
      call('store', 'POST', '/issues', { demandId: d1.id, receivedBy: 'B', lines: [{ lineId: d1.lines[0].id, qty: 2 }] }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(await num(`select available_qty from store_items where id = $1`, [bag.id]), 0);
    assert.equal(await num(`select count(*) from store_batches where remaining_qty < 0`), 0);
  });
});

describe('queries', () => {
  test('a Store keeper raises a query about a receipt; Admin responds and resolves; history stays', async () => {
    const rc = (await q(`select receipt_no from store_receipts order by created_at limit 1`))[0].receipt_no;
    const query = await ok('store', 'POST', '/queries', { subject: 'Bag torn', queryType: 'quantity_difference', description: 'One box arrived torn', relatedReceiptNo: rc });
    assert.match(query.queryNo, /^SQ-\d{6}$/);
    assert.equal(query.relatedReceiptNo, rc);
    assert.equal((await call('store', 'POST', `/queries/${query.id}/messages`, { status: 'resolved' })).status, 403);
    const replied = await ok('admin', 'POST', `/queries/${query.id}/messages`, { body: 'Checked: write it off as Damaged.' });
    assert.equal(replied.status, 'responded');
    const resolved = await ok('admin', 'POST', `/queries/${query.id}/messages`, { status: 'resolved' });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.messages.length, 2);
    const mine = await ok('store', 'GET', '/queries');
    assert.equal(mine.rows[0].lastReply, 'Checked: write it off as Damaged.');
    assert.equal((await call('prod', 'GET', `/queries/${query.id}`)).status, 404, 'Production cannot read the Store keeper\'s query');
    await ok('admin', 'DELETE', `/queries/${query.id}`);
    assert.equal(await num(`select count(*) from store_query_messages where query_id = $1`, [query.id]), 2);
  });
});

describe('reports, dashboard and Finance', () => {
  test('every report runs and exports; the dashboard answers', async () => {
    for (const t of ['daily_receiving', 'monthly_receiving', 'item_stock', 'purchase_price_history', 'production_demand', 'approved_demand', 'stock_issuance', 'remaining_stock', 'stock_adjustment', 'stock_valuation']) {
      const r = await ok('auditor', 'GET', `/reports/${t}?from=${today}&to=${today}`);
      assert.ok(Array.isArray(r.rows), t);
    }
    const x = await call('store', 'GET', `/reports/stock_issuance/export?from=${today}&to=${today}`);
    assert.equal(x.status, 200);
    assert.match(String(x.headers.get('content-type')), /spreadsheetml/);
    const dash = await ok('store', 'GET', `/dashboard?from=${today}&to=${today}&period=day`);
    assert.ok(dash.receivedToday.amount > 0);
    assert.equal((await call('prod', 'GET', '/dashboard')).status, 403);
  });

  test('nothing the Store did reached the Finance ledger', async () => {
    // The ledger (post_finance_ledger_entry writes ledger_entries), Finance's
    // own transactions, and expenses: all untouched by receiving and issuing.
    for (const t of ['ledger_entries', 'finance_transactions', 'expenses']) {
      assert.equal(await num(`select count(*) from public.${t}`), 0, t);
    }
  });
});
