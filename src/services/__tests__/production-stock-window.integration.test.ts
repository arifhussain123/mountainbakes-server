import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { usePglite } from '../../db/testing';

/**
 * Production Stock over a From–To window, and the opening that has to survive
 * a ledger longer than one read.
 *
 * The real `data_engine_aggregate` (and the condition builder it uses) is lifted
 * from the baseline, so the sums are Postgres's. DB_MAX_ROWS is 3: before the
 * fix the opening was Σ over the first DB_MAX_ROWS ledger rows only, so with
 * more movements than that it came out short.
 */

process.env['DB_MAX_ROWS'] = '3';

const BASELINE = readFileSync(join(__dirname, '../../../prisma/migrations/0_baseline/migration.sql'), 'utf8');
function lift(head: string, tail: string): string {
  const start = BASELINE.indexOf(head);
  assert.ok(start >= 0, `not in the baseline: ${head}`);
  const end = BASELINE.indexOf(tail, start);
  assert.ok(end > start, `no end found for: ${head}`);
  return `${BASELINE.slice(start, end + tail.length)}\n`;
}

const BUN = '50000000-0000-4000-8000-000000000001';
const RUSK = '50000000-0000-4000-8000-000000000002';

let db: PGlite;
let svc: typeof import('../production-stock.service');

async function move(product: string, type: string, delta: number, day: string) {
  await db.query(
    `insert into production_stock_history (product_id, product_name, type, delta, balance_after, ref_id, business_date)
     values ($1, 'x', $2, $3, 0, 'ref', $4)`,
    [product, type, delta, day],
  );
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create schema app;
    create type branch_production_order_status as enum ('pending', 'awaiting_verification', 'verified', 'rejected', 'cancelled');
    ${lift('CREATE TYPE public.production_stock_movement_type AS ENUM (', ');')}
    create table products (
      id uuid primary key, name text not null, stock_code text, is_active boolean default true,
      category_id uuid, category_name text);
    create table production_stock_history (
      id uuid primary key default gen_random_uuid(), legacy_id text, product_id uuid not null, product_name text not null,
      type production_stock_movement_type not null, delta numeric(14,3) not null, balance_after numeric(14,3) not null,
      ref_id text not null, business_date date not null, created_at timestamptz default now(), branch_id uuid,
      production_order_id uuid, created_by uuid, created_by_name text, reason text, remarks text,
      transaction_no text, metadata jsonb);
    create table production_orders (id uuid primary key default gen_random_uuid(), status branch_production_order_status not null);
    create table production_order_items (
      id uuid primary key default gen_random_uuid(), production_order_id uuid not null references production_orders(id), product_id uuid,
      qty numeric(14,3) not null, approved_qty numeric(14,3));
    ${lift('CREATE FUNCTION app.data_engine_literal(', '$$;')}
    ${lift('CREATE FUNCTION app.data_engine_condition(', '$$;')}
    ${lift('CREATE FUNCTION public.data_engine_aggregate(', '$$;')}
  `);
  await db.query(`insert into products (id, name, stock_code) values ($1, 'Bun', 'STK-1'), ($2, 'Rusk', 'STK-2')`, [BUN, RUSK]);

  // Bun: 1 Nov +10 prepared, −4 delivered, −1 sold   → closes 1 Nov at 5
  //      2 Nov +20 prepared, −8 delivered, +2 adjust  → closes 2 Nov at 19
  //      3 Nov +6 prepared, −10 delivered, +3 return transfer → closes 3 Nov at 18
  await move(BUN, 'prepare', 10, '2026-11-01');
  await move(BUN, 'transfer_out', -4, '2026-11-01');
  await move(BUN, 'sale', -1, '2026-11-01');
  await move(BUN, 'prepare', 20, '2026-11-02');
  await move(BUN, 'transfer_out', -8, '2026-11-02');
  await move(BUN, 'adjustment', 2, '2026-11-02');
  await move(BUN, 'prepare', 6, '2026-11-03');
  await move(BUN, 'transfer_out', -10, '2026-11-03');
  await move(BUN, 'return_transfer', 3, '2026-11-03');
  // Rusk: 30 prepared on 1 Nov, nothing after.
  await move(RUSK, 'prepare', 30, '2026-11-01');

  await usePglite(db);
  svc = await import('../production-stock.service');
});

const row = (rows: { productId: string }[], id: string) => {
  const r = rows.find((x) => x.productId === id);
  assert.ok(r, `no row for ${id}`);
  return r as Awaited<ReturnType<typeof svc.getProductionStockWindowRows>>[number];
};

describe('Production Stock over a window', () => {
  test('a single day opens on the previous closing even when the ledger is longer than one read', async () => {
    const bun = row(await svc.getProductionStockRows('2026-11-03'), BUN);
    assert.equal(bun.opening, 19); // six earlier movements, cap is 3
    assert.equal(bun.preparedToday, 6);
    assert.equal(bun.demandFulfilled, 10);
    assert.equal(bun.returnTransferIn, 3);
    assert.equal(bun.balance, 18);
  });

  test('From–To: opening at the start of From, closing at the end of To, movements summed', async () => {
    const rows = await svc.getProductionStockWindowRows('2026-11-02', '2026-11-03');
    const bun = row(rows, BUN);
    assert.equal(bun.opening, 5);
    assert.equal(bun.preparedToday, 26);
    assert.equal(bun.demandFulfilled, 18);
    assert.equal(bun.adjustment, 2);
    assert.equal(bun.returnTransferIn, 3);
    assert.equal(bun.soldToday, 0);
    assert.equal(bun.balance, 18);
    const rusk = row(rows, RUSK);
    assert.equal(rusk.opening, 30);
    assert.equal(rusk.balance, 30);
  });

  test('different windows give different sheets', async () => {
    const first = row(await svc.getProductionStockWindowRows('2026-11-01', '2026-11-01'), BUN);
    assert.deepEqual([first.opening, first.balance], [0, 5]);
    const whole = row(await svc.getProductionStockWindowRows('2026-11-01', '2026-11-03'), BUN);
    assert.deepEqual([whole.opening, whole.preparedToday, whole.soldToday, whole.balance], [0, 36, 1, 18]);
  });

  test('one product\'s figures read the same way', async () => {
    const f = await svc.getProductionStockFigures(BUN, '2026-11-03');
    assert.deepEqual([f.opening, f.preparedToday, f.balance], [19, 6, 18]);
  });
});
