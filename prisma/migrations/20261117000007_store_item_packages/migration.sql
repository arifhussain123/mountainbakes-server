-- Items v2: multiple purchase packages per item (e.g. Bag 50 KG AND Bag 25 KG),
-- each with its own conversion to base units. The item's existing purchase_unit
-- + conversion_qty stays as the DEFAULT package (backfilled below); extra
-- packages are added per item. Prices and receipts still carry their own
-- (package_name, package_qty) free-form — tying them to this list is a later phase.
create table public.store_item_packages (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.store_items (id) on delete cascade,
  package_name  text not null check (btrim(package_name) <> ''),
  package_qty   numeric(14,3) not null check (package_qty > 0),
  is_default    boolean not null default false,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (item_id, package_name, package_qty)
);
create index store_item_packages_item_idx on public.store_item_packages (item_id) where is_active;
-- One default package per item.
create unique index store_item_packages_one_default on public.store_item_packages (item_id) where is_default;

-- Backfill every item's current single package as its default.
insert into public.store_item_packages (item_id, package_name, package_qty, is_default, sort_order)
select id, purchase_unit, conversion_qty, true, 0 from public.store_items;
