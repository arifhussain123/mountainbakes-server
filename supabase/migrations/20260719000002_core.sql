-- 02: core reference entities — branches, categories, products, customers, users.
--
-- On denormalised *_name columns (branch_name, product_name, category_name):
-- The legacy system copied these onto nearly every row. They are PRESERVED here rather
-- than normalised away, because in several places they are genuine point-in-time
-- snapshots (an order must keep the product name as sold, even if the product is
-- later renamed). Where a column is a cache rather than a snapshot it is called
-- out in a comment. Do not "clean these up" without checking which kind it is.

-- ---------------------------------------------------------------------------
-- branches
-- ---------------------------------------------------------------------------
create table branches (
  id             uuid primary key default gen_random_uuid(),
  legacy_id      text unique,
  name           text not null,
  slug           text not null unique,
  location       text,
  phone          text,
  address        text,
  city           text,
  manager_id     uuid,          -- FK added in 02b below (circular with users)
  manager_name   text,          -- cache of users.display_name
  is_active      boolean not null default true,
  daily_budget   numeric(14,2),
  weekly_budget  numeric(14,2),
  monthly_budget numeric(14,2),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Delete is a soft-delete (is_active = false) in the app; this partial index
-- backs the very common `where is_active` listing.
create index branches_active_idx on branches (name) where is_active;

create trigger branches_touch before update on branches
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- users
--
-- PK is the Supabase Auth user id — the same deterministic external ID strategy
-- the legacy system used (record id = auth uid). The FK to auth.users with ON DELETE
-- CASCADE means deleting the auth user reaps the profile row, which the old
-- code had to do by hand in two steps.
--
-- role/branch_id are ALSO mirrored into app_metadata (and therefore the JWT).
-- This table is the source of truth; app_metadata is the read-optimised copy
-- that RLS and the API read. Any write to role/branch_id here must be paired
-- with a supabaseAdmin.auth.admin.updateUserById() call, or they drift.
-- ---------------------------------------------------------------------------
create table users (
  id                       uuid primary key references auth.users (id) on delete cascade,
  email                    text not null unique,
  display_name             text,
  phone                    text,
  username                 text unique,
  role                     user_role not null,
  branch_id                uuid references branches (id) on delete set null,
  branch_name              text,        -- cache of branches.name
  status                   user_status not null default 'active',
  last_login_at            timestamptz,
  must_change_password     boolean not null default false,
  last_password_reset      timestamptz,
  password_reset_by        uuid references users (id) on delete set null,
  password_reset_by_name   text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Backs the users listing: optional status + optional role filter, newest first.
create index users_created_idx     on users (created_at desc);
create index users_role_status_idx on users (role, status, created_at desc);
create index users_branch_idx      on users (branch_id) where branch_id is not null;

create trigger users_touch before update on users
  for each row execute function app.touch_updated_at();

alter table branches
  add constraint branches_manager_fk
  foreign key (manager_id) references users (id) on delete set null;

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
create table categories (
  id         uuid primary key default gen_random_uuid(),
  legacy_id  text unique,
  name       text not null,
  slug       text not null unique,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index categories_active_idx on categories (sort_order, name) where is_active;

create trigger categories_touch before update on categories
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- products
--
-- `price` is the CURRENT active price. It is mutated only by price.service.ts,
-- either directly on an immediate change or by the activation job — always
-- inside the same transaction that appends the product_price_history row.
-- Nothing else may write it; see migration 06.
-- ---------------------------------------------------------------------------
create table products (
  id            uuid primary key default gen_random_uuid(),
  legacy_id     text unique,
  name          text not null,
  category_id   uuid references categories (id) on delete restrict,
  category_name text,                 -- cache of categories.name
  sku           text,
  price         numeric(14,2) not null default 0,
  cost_price    numeric(14,2),
  description   text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- SKU is the natural key used by the price-import path (price.service.ts). It
-- was NOT unique in the legacy system, so the ETL may surface duplicates. This unique
-- index is deliberately partial (ignores NULLs and inactive rows) so the import
-- lookup is unambiguous without breaking legacy rows that never had a SKU.
create unique index products_sku_key on products (sku) where sku is not null and is_active;

create index products_category_active_idx on products (category_id) where is_active;
create index products_active_name_idx     on products (name) where is_active;

create trigger products_touch before update on products
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- customers
--
-- total_orders / total_spent are running aggregates. The legacy system updated them
-- with FieldValue.increment AFTER the order write and outside its transaction,
-- so an order could exist without its customer stats moving. The port should
-- fold this into the sale transaction (see migration 03) — numeric(14,2) also
-- removes the float accumulation drift the old float column had.
-- ---------------------------------------------------------------------------
create table customers (
  id           uuid primary key default gen_random_uuid(),
  legacy_id    text unique,
  name         text not null,
  phone        text,
  email        text,
  address      text,
  branch_id    uuid references branches (id) on delete set null,
  branch_name  text,                  -- cache of branches.name
  total_orders integer not null default 0,
  total_spent  numeric(14,2) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index customers_branch_idx on customers (branch_id, name);
create index customers_phone_idx  on customers (phone) where phone is not null;

create trigger customers_touch before update on customers
  for each row execute function app.touch_updated_at();
