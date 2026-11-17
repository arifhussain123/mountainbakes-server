-- Store feature flags — let new inventory modules (Suppliers, Purchase Orders,
-- Stock Counts, Transfers, …) ship dark and be turned on per store once ready.
--
-- A missing row means the feature is OFF. The API fills the known-key list from
-- the shared STORE_FEATURE_KEYS constant and left-joins this table, so adding a
-- new feature key needs only a code change, never a migration. feature_key is a
-- free TEXT (not an enum) for the same additive reason.
create table public.store_features (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.store_departments (id) on delete cascade,
  feature_key      text not null check (btrim(feature_key) <> ''),
  enabled          boolean not null default false,
  updated_by       uuid references public.users (id) on delete set null,
  updated_by_name  text,
  updated_at       timestamptz not null default now(),
  unique (store_id, feature_key)
);
