-- 03: orders, order line items, the order-number counter, and expenses.

-- ---------------------------------------------------------------------------
-- Order numbers.
--
-- Firestore used a `counters/orders` document incremented inside the sale
-- transaction, producing gapless MB-000125 numbers seeded at 124.
--
-- A Postgres SEQUENCE is deliberately NOT used: sequences are non-transactional
-- and leave gaps on rollback. The business treats order numbers as gapless, so
-- this keeps the counter-row semantics. The row lock serialises order creation,
-- which is acceptable here (one dyno, modest order rate) and is exactly what
-- Firestore was already doing.
-- ---------------------------------------------------------------------------
create table counters (
  id    text primary key,
  count bigint not null
);

insert into counters (id, count) values ('orders', 124);

create or replace function next_order_number() returns text
  language plpgsql
  as $$
  declare
    next_count bigint;
  begin
    update counters set count = count + 1
      where id = 'orders'
      returning count into next_count;

    if not found then
      raise exception 'counters row "orders" is missing';
    end if;

    return 'MB-' || lpad(next_count::text, 6, '0');
  end;
  $$;

-- ---------------------------------------------------------------------------
-- orders
--
-- created_at is the business-relevant instant AND the reporting axis. Firestore
-- filtered on it with inclusive bounds (>= from AND <= to) derived from
-- businessDayBounds(). Keep the bounds INCLUSIVE when porting: switching to a
-- half-open `< to` silently drops the final millisecond of a business day.
--
-- business_date is denormalised from created_at at insert time so day-scoped
-- reporting is a plain indexed equality instead of a range over a computed
-- Karachi offset. The app must populate it via businessDateStr() — it cannot be
-- a generated column, because the 02:00 rollover is app policy, not a timezone.
-- ---------------------------------------------------------------------------
create table orders (
  id                uuid primary key default gen_random_uuid(),
  legacy_id         text unique,
  order_number      text not null unique,
  branch_id         uuid not null references branches (id) on delete restrict,
  branch_name       text,
  customer_id       uuid references customers (id) on delete set null,
  customer_name     text,
  customer_phone    text,
  customer_address  text,
  subtotal          numeric(14,2) not null,
  discount_total    numeric(14,2) not null default 0,
  delivery_charges  numeric(14,2) not null default 0,
  tax_rate          numeric(6,3)  not null default 0,
  tax_amount        numeric(14,2) not null default 0,
  grand_total       numeric(14,2) not null,
  payment_method    payment_method not null,
  status            order_status not null default 'pending',
  notes             text,
  -- Only present on the POS/cash path.
  received_cash     numeric(14,2),
  cash_returned     numeric(14,2),
  created_by        uuid references users (id) on delete set null,
  created_by_name   text,
  business_date     date not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Branch order queues: `where branch_id = ? and status in (...)` newest-first.
create index orders_branch_status_idx on orders (branch_id, status, created_at desc);
-- Reporting: date-range scans, optionally narrowed by branch.
create index orders_created_idx        on orders (created_at);
create index orders_branch_created_idx on orders (branch_id, created_at desc);
create index orders_business_date_idx  on orders (business_date, branch_id);
-- Production queue reads pending/preparing/ready oldest-first across branches.
create index orders_status_created_idx on orders (status, created_at) ;
create index orders_customer_idx       on orders (customer_id) where customer_id is not null;

create trigger orders_touch before update on orders
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- order_items — was the embedded orders.items[] array in Firestore.
--
-- Every column here is a POINT-IN-TIME SNAPSHOT of the product as sold. It must
-- never be resolved through to products at read time, or historical receipts
-- and reports change retroactively when a product is renamed or repriced.
-- product_id is therefore ON DELETE SET NULL, not CASCADE — deleting a product
-- must not erase sales history.
-- ---------------------------------------------------------------------------
create table order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders (id) on delete cascade,
  product_id    uuid references products (id) on delete set null,
  product_name  text not null,
  category_id   uuid references categories (id) on delete set null,
  category_name text,
  unit_price    numeric(14,2) not null,
  qty           numeric(14,3) not null,
  discount      numeric(14,2) not null default 0,
  line_total    numeric(14,2) not null,
  line_no       integer not null,
  constraint order_items_qty_positive check (qty > 0)
);

create index order_items_order_idx   on order_items (order_id, line_no);
create index order_items_product_idx on order_items (product_id) where product_id is not null;

-- ---------------------------------------------------------------------------
-- expenses (shop-level)
-- ---------------------------------------------------------------------------
create table expenses (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  branch_id       uuid not null references branches (id) on delete restrict,
  branch_name     text,
  business_date   date not null,       -- was the 'date' string field
  description     text not null,
  payment_method  expense_payment_method not null,
  amount          numeric(14,2) not null,
  remarks         text,
  created_by      uuid references users (id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now()
);

create index expenses_branch_date_idx on expenses (branch_id, business_date desc);
create index expenses_created_idx     on expenses (created_at);
create index expenses_date_idx        on expenses (business_date);

-- ---------------------------------------------------------------------------
-- production_expenses (central kitchen, not branch-scoped)
-- ---------------------------------------------------------------------------
create table production_expenses (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  category        text not null,
  description     text,
  amount          numeric(14,2) not null,
  payment_method  production_expense_payment_method not null,
  supplier        text,
  notes           text,
  business_date   date not null,
  created_by      uuid references users (id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now()
);

create index production_expenses_date_idx    on production_expenses (business_date desc);
create index production_expenses_created_idx on production_expenses (created_at);
