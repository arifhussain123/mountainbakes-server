import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * The Demand Record accounting restructure (docs/demand-record-accounting-migration.md)
 * end to end, on the REAL baseline tables and SQL functions with both Demand
 * Record migrations applied the way `prisma migrate deploy` applies them.
 *
 * The data is the spec's worked example. Aliabad (its own 80%) receives
 * DMD-000123 and DMD-000124; Beta (Finance Settings' 75%) one demand in
 * September, so it carries a balance into October.
 *
 *   DMD-000123 10-01  45,000 − return 1,200 − discount 1,000 = 42,800
 *                     share 34,240, due 34,240, received 28,000 → remaining 6,240
 *   DMD-000124 10-02  50,000 − 0 − discount 2,000 = 48,000
 *                     share 38,400, due 6,240 + 38,400 = 44,640, received 42,200 → 2,440
 *   Beta DMD-000201 09-30  10,000 → share 7,500, received 5,000 → 2,500 carried
 *
 * The go-live migration runs after the data exists, as it does in production.
 */

const PRISMA = join(__dirname, '../../../prisma/migrations');
const BASELINE = readFileSync(join(PRISMA, '0_baseline/migration.sql'), 'utf8');
const LEDGER_MIGRATION = readFileSync(join(PRISMA, '20261024000001_branch_account_ledger/migration.sql'), 'utf8');
const GO_LIVE = readFileSync(join(PRISMA, '20261024000002_demand_record_go_live/migration.sql'), 'utf8');

function lift(head: string, tail: string): string {
  const start = BASELINE.indexOf(head);
  assert.ok(start >= 0, `not in the baseline: ${head}`);
  const end = BASELINE.indexOf(tail, start);
  assert.ok(end > start, `no end found for: ${head}`);
  return `${BASELINE.slice(start, end + tail.length)}\n`;
}
const type = (name: string) => lift(`CREATE TYPE public.${name} AS ENUM (`, ');');
const table = (name: string) => lift(`CREATE TABLE public.${name} (`, '\n);');
const fn = (qualified: string) => lift(`CREATE FUNCTION ${qualified}(`, '$$;');

const TYPES = [
  'price_change_source', 'price_change_status', 'branch_production_order_status', 'production_return_disposition',
  'production_return_status', 'branch_discount_status', 'cash_transfer_status', 'order_status', 'payment_method',
  'finance_account', 'finance_ledger_source', 'ledger_entry_status', 'ledger_head_type',
];
const TABLES = [
  'branches', 'products', 'product_price_history', 'production_orders', 'production_order_items',
  'production_returns', 'branch_discounts', 'cash_transfers', 'orders', 'finance_settings', 'finance_audit_logs',
  'ledger_heads', 'ledger_entries',
];
const FUNCTIONS = [
  'app.finance_received_head_ids', 'app.finance_order_values', 'public.finance_monthly_dashboard',
  'public.finance_dashboard_records', 'public.finance_ledger_totals',
];

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create function app.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create function app.is_super_admin() returns boolean language sql as $$ select false $$;
  create function app.jwt_branch_id() returns uuid language sql as $$ select null::uuid $$;
  create function public.next_demand_number() returns text language sql as $$ select 'DMD-' || substr(md5(random()::text), 1, 6) $$;
  create function public.next_stock_number() returns text language sql as $$ select 'SKU-' || substr(md5(random()::text), 1, 6) $$;
  create function public.next_price_number() returns text language sql as $$ select 'PRC-' || substr(md5(random()::text), 1, 6) $$;
  create function app.next_finance_number(p_key text, p_prefix text) returns text language sql as $$ select p_prefix || '-' || substr(md5(random()::text), 1, 6) $$;
  create table counters (id text primary key, count bigint not null);
  create table users (id uuid primary key default gen_random_uuid(), email text);
`;

const ALIABAD = '40000000-0000-4000-8000-0000000000a1';
const BETA = '40000000-0000-4000-8000-0000000000b2';
const BUN = '50000000-0000-4000-8000-000000000001';
const D1 = '60000000-0000-4000-8000-000000000123';
const D2 = '60000000-0000-4000-8000-000000000124';
const B1 = '60000000-0000-4000-8000-000000000201';
const D3 = '60000000-0000-4000-8000-000000000125';

let db: PGlite;
let prisma: PrismaClient;
let incomeHead: string;
let slipBefore: unknown;
let countsBefore: Record<string, string>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function order(id: string, branch: string, businessDate: string, submittedAt: string, demand: string, qty: number) {
  await db.query(
    `insert into production_orders (id, branch_id, branch_name, business_date, submitted_at, demand_number, status)
     values ($1, $2, (select name from branches where id = $2), $3, $4, $5, 'pending')`,
    [id, branch, businessDate, submittedAt, demand]);
  await db.query(
    `insert into production_order_items (production_order_id, product_id, product_name, qty, approved_qty, unit_price, line_no)
     values ($1, $2, 'Bun', $3, $3, 100, 1)`, [id, BUN, qty]);
}
const deliver = async (id: string) => {
  for (const s of ['awaiting_verification', 'verified', 'approved']) {
    await db.query(`update production_orders set status = $2::branch_production_order_status where id = $1`, [id, s]);
  }
};
async function returnRow(branch: string, businessDate: string, createdAt: string, qty: number) {
  await db.query(
    `insert into production_returns (branch_id, branch_name, product_id, product_name, qty, status, business_date, created_at)
     values ($1, 'x', $2, 'Bun', $3, 'accepted', $4, $5)`, [branch, BUN, qty, businessDate, createdAt]);
}
async function discount(branch: string, orderId: string, amount: number, createdAt: string) {
  await db.query(
    `insert into branch_discounts (branch_id, production_order_id, amount, reason, status, business_date, created_at)
     values ($1, $2, $3, 'test', 'approved', $4::timestamptz::date, $4)`, [branch, orderId, amount, createdAt]);
}
/** An approved deposit and the income-ledger entry its approval posts, as in production. */
async function deposit(branch: string, amount: number, createdAt: string) {
  const entry = await db.query<{ id: string }>(
    `insert into ledger_entries (voucher_no, seq, entry_date, ledger_head_id, ledger_head_name, ledger_head_type, description,
                                 debit, credit, balance, account, source_type, branch_id, branch_name)
     values (substr(md5(random()::text), 1, 8), (select coalesce(max(seq), 0) + 1 from ledger_entries),
             $1::timestamptz::date, $2, 'Company Share', 'income', 'Cash transfer', $3, 0, 0,
             (enum_range(null::finance_account))[1], 'cash_transfer', $4, 'x')
     returning id`, [createdAt, incomeHead, amount, branch]);
  await db.query(
    `insert into cash_transfers (branch_id, branch_name, amount, cash_amount, business_date, created_at, status, ledger_entry_id, approved_at)
     values ($1, 'x', $2, $2, $3::timestamptz::date, $3, 'approved', $4, $3)`, [branch, amount, createdAt, entry.rows[0]!.id]);
}

/** Row counts plus a checksum of every row, for the tables the migration must not touch. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of ['production_orders', 'production_order_items', 'production_returns', 'branch_discounts', 'cash_transfers', 'ledger_entries', 'branches', 'products']) {
    const r = await db.query<{ n: number; h: string }>(`select count(*)::int as n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${t} x`);
    out[t] = `${r.rows[0]!.n}:${r.rows[0]!.h}`;
  }
  return out;
}

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  for (const t of TYPES) await db.exec(type(t));
  for (const t of TABLES) await db.exec(table(t));
  await db.exec(`
    alter table branches add primary key (id);
    alter table products add primary key (id);
    alter table production_orders add primary key (id);
    alter table production_order_items add primary key (id);
    alter table production_order_items add foreign key (production_order_id) references production_orders (id);
    alter table production_returns add primary key (id);
    alter table branch_discounts add primary key (id);
    alter table cash_transfers add primary key (id);
    alter table orders add primary key (id);
    alter table finance_audit_logs add primary key (id);
    alter table ledger_heads add primary key (id);
    alter table ledger_entries add primary key (id);
  `);
  for (const f of FUNCTIONS) await db.exec(fn(f));
  await db.exec(`
    insert into finance_settings (company_share_pct, branch_share_pct) values (75, 25);
    insert into branches (id, name, slug, company_share_pct, created_at) values ('${ALIABAD}', 'Aliabad Branch', 'aliabad', 80, '2026-09-20T10:00:00+05');
    insert into branches (id, name, slug, created_at) values ('${BETA}', 'Beta Branch', 'beta', '2026-09-25T10:00:00+05');
    insert into products (id, name, price) values ('${BUN}', 'Bun', 100);
  `);
  incomeHead = (await db.query<{ id: string }>(
    `insert into ledger_heads (code, name, type) values ('INC-COMPANY-SHARE', 'Company Share', 'income') returning id`)).rows[0]!.id;

  await db.exec(`begin;${LEDGER_MIGRATION}commit;`);

  // Delivered before go-live, as every live demand was: the trigger freezes
  // their % as they leave pending, the go-live freezes anything it missed.
  await order(B1, BETA, '2026-09-30', '2026-09-30T09:00:00+05', 'DMD-000201', 100);
  await deliver(B1);
  await deposit(BETA, 5000, '2026-09-30T15:00:00+05');

  await order(D1, ALIABAD, '2026-10-01', '2026-10-01T09:00:00+05', 'DMD-000123', 450);
  await deliver(D1);
  await returnRow(ALIABAD, '2026-10-01', '2026-10-01T12:00:00+05', 12);
  await discount(ALIABAD, D1, 1000, '2026-10-01T13:00:00+05');
  await deposit(ALIABAD, 28000, '2026-10-01T15:00:00+05');

  await order(D2, ALIABAD, '2026-10-02', '2026-10-02T09:00:00+05', 'DMD-000124', 500);
  await deliver(D2);
  await discount(ALIABAD, D2, 2000, '2026-10-02T13:00:00+05');
  await deposit(ALIABAD, 42200, '2026-10-02T15:00:00+05');

  await usePglite(db);
  prisma = new PrismaClient({ adapter: new PrismaPGlite(db) });
  setPrisma(prisma);

  // What the POS slip prints for DMD-000124's previous order, and every source
  // row, BEFORE the go-live migration — compared after it.
  const { getPreviousOrderBalance } = await import('../previous-balance.service');
  slipBefore = await getPreviousOrderBalance(D2);
  countsBefore = await snapshot();

  await db.exec(`begin;${GO_LIVE}commit;`);
});

after(async () => {
  await db?.close();
});

const svc = () => import('../branch-account.service');
const rowOf = async (orderId: string) => {
  const r = await (await svc()).getDemandRecordRows(null);
  return r!.rows.find((x) => x.orderId === orderId)!;
};

test('the go-live migration switches the Demand Record on from the start of the web, freezes every %, and audits it', async () => {
  const s = await db.query<{ start: string }>(`select to_char(account_ledger_start, 'YYYY-MM-DD') as start from finance_settings`);
  // The first branch was created on 09-20 — before the first demand (09-30).
  assert.equal(s.rows[0]!.start, '2026-09-20');
  const snaps = await db.query<{ id: string; pct: number }>(
    `select production_order_id::text as id, company_share_pct::float8 as pct from production_order_share_snapshots order by 1`);
  assert.deepEqual(snaps.rows.map((r) => [r.id, r.pct]), [[D1, 80], [D2, 80], [B1, 75]].sort());
  const audit = await db.query<{ n: number; v: Json }>(
    `select count(*)::int as n, max(new_values::text)::jsonb as v from finance_audit_logs where entity = 'branch_account'`);
  assert.equal(audit.rows[0]!.n, 1);
  assert.equal(audit.rows[0]!.v.startDate, '2026-09-20');
});

test('Test I / H — no source row changed, and running the migration again changes nothing', async () => {
  assert.deepEqual(await snapshot(), countsBefore);
  await db.exec(`begin;${GO_LIVE}commit;`);
  assert.deepEqual(await snapshot(), countsBefore);
  const again = await db.query<{ start: string; snaps: number; audits: number }>(
    `select to_char((select account_ledger_start from finance_settings), 'YYYY-MM-DD') as start,
            (select count(*)::int from production_order_share_snapshots) as snaps,
            (select count(*)::int from finance_audit_logs) as audits`);
  assert.deepEqual(again.rows[0], { start: '2026-09-20', snaps: 3, audits: 1 });
});

test('Test A — first demand: Demand 42,800, Company Share 34,240, Amount Due 34,240, Remaining 6,240', async () => {
  const r = await rowOf(D1);
  assert.equal(r.totalDemandAmount, 45000);
  assert.equal(r.returns, 1200);
  assert.equal(r.returnsQty, 12); // the quantity stays its own field
  assert.equal(r.discount, 1000);
  assert.equal(r.demand, 42800);
  assert.equal(r.sharePct, 80);
  assert.equal(r.companyShare, 34240);
  assert.equal(r.previousBalance, 0);
  assert.equal(r.amountDue, 34240);
  assert.equal(r.received, 28000);
  assert.equal(r.remaining, 6240);
  // The original names carry the same figures, for the screens that read them.
  assert.equal(r.gTotal, r.demand);
  assert.equal(r.closingBalance, r.remaining);
});

test('Test B — the next demand carries 6,240: Amount Due 44,640, Remaining 2,440', async () => {
  const r = await rowOf(D2);
  assert.equal(r.demand, 48000);
  assert.equal(r.companyShare, 38400);
  assert.equal(r.previousBalance, 6240);
  assert.equal(r.amountDue, 44640);
  assert.equal(r.received, 42200);
  assert.equal(r.remaining, 2440);
});

test('Test D — each branch carries only its own balance', async () => {
  const beta = await rowOf(B1);
  assert.equal(beta.companyShare, 7500); // Finance Settings' 75%
  assert.equal(beta.remaining, 2500);
  // Aliabad's first demand starts from 0, not from Beta's 2,500.
  assert.equal((await rowOf(D1)).previousBalance, 0);
});

test('Test E — every approved payment is counted exactly once', async () => {
  const all = (await (await svc()).getDemandRecordRows(null))!.rows;
  const counted = all.reduce((s, r) => s + r.received, 0);
  const deposits = await db.query<{ total: number; n: number }>(
    `select coalesce(sum(amount), 0)::float8 as total, count(*)::int as n from cash_transfers
      where status = 'approved' and deleted_at is null`);
  assert.equal(counted, deposits.rows[0]!.total);
  assert.equal(counted, 75200);
  // Nothing was copied anywhere: still one transfer and one ledger entry per payment.
  const entries = await db.query<{ n: number }>(`select count(*)::int as n from ledger_entries`);
  assert.equal(entries.rows[0]!.n, deposits.rows[0]!.n);
});

test('Test F — Finance Dashboard income: Demand is the net demand, Company Share on it, last month carried', async () => {
  const { getFinanceMonthlyDashboard, getFinanceDashboardRecords } = await import('../finance-monthly-dashboard.service');
  const dash = await getFinanceMonthlyDashboard({ month: '2026-10', branchId: null });
  const day = (date: string, branchId: string) => dash.days.find((d) => d.date === date && d.branchId === branchId)!;
  assert.equal(day('2026-10-01', ALIABAD).demand, 42800);
  assert.equal(day('2026-10-01', ALIABAD).companyShare, 34240);
  assert.equal(day('2026-10-01', ALIABAD).received, 28000);
  assert.equal(day('2026-10-02', ALIABAD).demand, 48000);
  assert.equal(day('2026-10-02', ALIABAD).companyShare, 38400);
  assert.equal(dash.summary.demand, 90800);
  assert.equal(dash.summary.companyShare, 72640);
  assert.equal(dash.summary.received, 70200);
  // Beta carries its September Remaining into October. Aliabad had nothing
  // before October, so it carries 0 — a real figure, shown rather than blank.
  const byBranch = (xs: { branchId: string | null; balance: number | null }[]) =>
    [...xs].sort((a, b) => String(a.branchId).localeCompare(String(b.branchId)));
  assert.deepEqual(byBranch(dash.previous), byBranch([{ branchId: BETA, balance: 2500 }, { branchId: ALIABAD, balance: 0 }]));
  assert.equal(dash.summary.lastMonthBalance, 2500);
  // October's activity plus what was carried in is every branch's Remaining at month end.
  assert.equal(dash.summary.lastMonthBalance! + dash.summary.companyShare - dash.summary.received, 2440 + 2500);

  // The drill-down behind each figure adds up to it.
  const base = { from: '2026-10-01', to: '2026-10-31', branchId: null, noBranch: false, ledgerHeadId: null, search: null, page: 1, pageSize: 25 };
  const demand = await getFinanceDashboardRecords({ ...base, metric: 'demand' });
  assert.equal(demand.amount, 90800);
  assert.deepEqual(demand.rows.map((r) => [r.reference, r.amount]), [['DMD-000123', 42800], ['DMD-000124', 48000]]);
  assert.match(demand.rows[0]!.detail!, /Delivered 45,000\.00 − Return 1,200\.00 − Discount 1,000\.00/);
  const share = await getFinanceDashboardRecords({ ...base, metric: 'share' });
  assert.equal(share.amount, 72640);
  assert.equal(share.rows[1]!.detail, '80% of 48,000.00');
  // Received is the cash transfers' Total Amount, each row opening its voucher.
  const received = await getFinanceDashboardRecords({ ...base, metric: 'received' });
  assert.equal(received.amount, 70200);
  assert.deepEqual(received.rows.map((r) => r.amount), [28000, 42200]);
  assert.ok(received.rows.every((r) => r.source.startsWith('Cash transfer · ') && r.detail?.startsWith('Cash ')));
});

test('Test G — the POS slip prints exactly what it printed before the migration', async () => {
  const { getPreviousOrderBalance } = await import('../previous-balance.service');
  // A real slip, not an empty one: DMD-000124's previous order is DMD-000123 at the slip's own rules.
  assert.equal((slipBefore as Json).previous.demandNumber, 'DMD-000123');
  assert.equal((slipBefore as Json).deliveredValue, 45000);
  assert.deepEqual(await getPreviousOrderBalance(D2), slipBefore);
});

test('Test C — a later % change leaves recorded demands as they were; a new demand takes the new %', async () => {
  await db.query(`update branches set company_share_pct = 70 where id = $1`, [ALIABAD]);
  assert.equal((await rowOf(D1)).companyShare, 34240);
  assert.equal((await rowOf(D2)).companyShare, 38400);
  await order(D3, ALIABAD, '2026-10-03', '2026-10-03T09:00:00+05', 'DMD-000125', 100);
  await deliver(D3);
  const r = await rowOf(D3);
  assert.equal(r.sharePct, 70);
  assert.equal(r.companyShare, 7000);
  assert.equal(r.previousBalance, 2440);
  assert.equal(r.amountDue, 9440);
});
