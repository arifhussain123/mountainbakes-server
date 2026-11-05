import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { usePglite } from '../../db/testing';
import { getDiscountDayCheck } from '../discount-day-check.service';

/**
 * The Product breakdown's queries, run for real in pglite over stub tables:
 * per-product till discounts for one branch-day (cancelled sales and other
 * days/branches left out), set against that day's non-rejected claims.
 */

const STUBS = `
  create type order_status as enum ('pending', 'preparing', 'ready', 'delivered', 'cancelled');
  create type branch_discount_status as enum ('pending', 'approved', 'rejected', 'returned');
  create table orders (
    id uuid primary key default gen_random_uuid(), branch_id uuid not null,
    business_date date not null, status order_status not null default 'delivered',
    discount_total numeric(14,2) not null default 0);
  create table order_items (
    id uuid primary key default gen_random_uuid(), order_id uuid not null references orders (id),
    product_id uuid, product_name text not null, qty numeric(14,3) not null,
    discount numeric(14,2) not null default 0);
  create table branch_discounts (
    id uuid primary key default gen_random_uuid(), branch_id uuid not null,
    demand_number text, amount numeric(14,2) not null,
    status branch_discount_status not null default 'pending',
    business_date date not null, created_at timestamptz not null default now());
`;

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const CAKE = '20000000-0000-4000-8000-000000000001';
const BUN = '20000000-0000-4000-8000-000000000002';
const DAY = '2026-11-04';

let db: PGlite;

async function sale(branch: string, date: string, status: string, lines: [string | null, string, number, number][]) {
  const total = lines.reduce((s, l) => s + l[3], 0);
  const { rows } = await db.query<{ id: string }>(
    `insert into orders (branch_id, business_date, status, discount_total) values ($1, $2, $3, $4) returning id`,
    [branch, date, status, total],
  );
  for (const [pid, name, qty, disc] of lines) {
    await db.query(
      `insert into order_items (order_id, product_id, product_name, qty, discount) values ($1, $2, $3, $4, $5)`,
      [rows[0]!.id, pid, name, qty, disc],
    );
  }
}

async function claim(branch: string, amount: number, status: string, date = DAY) {
  await db.query(
    `insert into branch_discounts (branch_id, demand_number, amount, status, business_date) values ($1, 'DMD-000001', $2, $3, $4)`,
    [branch, amount, status, date],
  );
}

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);

  await sale(A, DAY, 'delivered', [[CAKE, 'Chocolate Cake', 1, 150], [BUN, 'Bun', 4, 0]]);
  await sale(A, DAY, 'pending', [[CAKE, 'Chocolate Cake', 2, 100.5], [BUN, 'Bun', 2, 20]]);
  await sale(A, DAY, 'delivered', [[null, 'Old Pastry', 1, 30]]); // product since deleted
  await sale(A, DAY, 'cancelled', [[CAKE, 'Chocolate Cake', 1, 999]]); // not a sale
  await sale(A, '2026-11-03', 'delivered', [[CAKE, 'Chocolate Cake', 1, 888]]); // other day
  await sale(B, DAY, 'delivered', [[CAKE, 'Chocolate Cake', 1, 777]]); // other branch

  await claim(A, 200, 'approved');
  await claim(A, 50, 'pending');
  await claim(A, 500, 'rejected'); // refused — not claimed
  await claim(A, 1000, 'approved', '2026-11-03'); // other day

  await usePglite(db);
});

test('groups the day’s till discounts by product and compares them with the claims', async () => {
  const r = await getDiscountDayCheck({ branchId: A, date: DAY });

  assert.deepEqual(r.products, [
    { productId: CAKE, productName: 'Chocolate Cake', qty: 3, discount: 250.5 },
    { productId: null, productName: 'Old Pastry', qty: 1, discount: 30 },
    { productId: BUN, productName: 'Bun', qty: 2, discount: 20 },
  ]);
  assert.equal(r.actualTotal, 300.5);
  assert.equal(r.claimedTotal, 250);
  assert.equal(r.difference, -50.5);
  assert.equal(r.matches, false);
  assert.deepEqual(r.claims.map((c) => [c.amount, c.status]), [[200, 'approved'], [50, 'pending']]);
});

test('a day with no till discounts and no claims matches at zero', async () => {
  const r = await getDiscountDayCheck({ branchId: B, date: '2026-11-01' });
  assert.deepEqual(r.products, []);
  assert.equal(r.actualTotal, 0);
  assert.equal(r.claimedTotal, 0);
  assert.equal(r.matches, true);
});
