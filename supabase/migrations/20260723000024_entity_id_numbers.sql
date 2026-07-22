-- 22: Human-readable per-entity ID numbers.
--
-- Gives four entity groups a stable, human-readable identifier, mirroring the
-- existing order-number pattern from migration 000003 (MB-000125): one `counters`
-- row per entity + a `next_*_number()` function + a `text not null unique` column.
--
--   Expenses (branch + production kitchen)  →  EXP-000001   (shared counter)
--   Demand (production_orders)              →  DMD-000001
--   Price history                           →  PRC-000001
--   Stock (per product, shown on Stock)     →  STK-000001
--
-- Sales already have `orders.order_number` (MB-######) and are not touched here.
--
-- A Postgres SEQUENCE is deliberately NOT used (same reasoning as 000003):
-- sequences leave gaps on rollback. The counter-row UPDATE ... RETURNING is atomic
-- under row locking, so concurrent callers never collide.
--
-- The number column's DEFAULT is the (volatile) next_*_number() function. Because
-- the default is volatile, ADD COLUMN rewrites the table and evaluates the default
-- once per existing row — so every current row is back-filled with its own unique
-- number, and every future INSERT gets one automatically, including rows inserted
-- by RPC/SQL functions (POS sale, stock movements, price activation). No
-- application code needs to allocate these numbers.

-- ---------------------------------------------------------------------------
-- Counter rows. Seeded at 0; the volatile-default back-fill on ADD COLUMN below
-- advances each one to the current row count.
-- ---------------------------------------------------------------------------
insert into counters (id, count) values
  ('expenses',      0),
  ('demand',        0),
  ('price_history', 0),
  ('stock',         0)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Allocators. One per prefix; the two expense tables share the 'expenses'
-- counter so EXP-###### is unique across both branch and production expenses.
-- ---------------------------------------------------------------------------
create or replace function next_expense_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'expenses' returning count into next_count;
    if not found then raise exception 'counters row "expenses" is missing'; end if;
    return 'EXP-' || lpad(next_count::text, 6, '0');
  end;
  $$;

create or replace function next_demand_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'demand' returning count into next_count;
    if not found then raise exception 'counters row "demand" is missing'; end if;
    return 'DMD-' || lpad(next_count::text, 6, '0');
  end;
  $$;

create or replace function next_price_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'price_history' returning count into next_count;
    if not found then raise exception 'counters row "price_history" is missing'; end if;
    return 'PRC-' || lpad(next_count::text, 6, '0');
  end;
  $$;

create or replace function next_stock_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'stock' returning count into next_count;
    if not found then raise exception 'counters row "stock" is missing'; end if;
    return 'STK-' || lpad(next_count::text, 6, '0');
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Number columns. The volatile default back-fills existing rows on ADD COLUMN
-- (table rewrite) and auto-numbers every future insert.
-- ---------------------------------------------------------------------------
alter table expenses
  add column expense_number text not null unique default next_expense_number();

alter table production_expenses
  add column expense_number text not null unique default next_expense_number();

alter table production_orders
  add column demand_number text not null unique default next_demand_number();

alter table product_price_history
  add column price_number text not null unique default next_price_number();

alter table products
  add column stock_code text not null unique default next_stock_number();
