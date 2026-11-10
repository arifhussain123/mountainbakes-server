-- Dry Items Store: a department that receives dry items, keeps them in
-- costed batches, and issues them to Bakery Production against an approved
-- demand.
--
--   item master ── price control (per package, effective-dated, never edited)
--        │
--   receiving ──► one BATCH per receipt line (qty, unit cost, remaining)
--        │
--   Production demand ──► Store approves / rejects each line
--        │
--   issue ──► FIFO allocation over the batches ──► Production confirms receipt
--
-- THE RULES THIS SCHEMA HOLDS, whatever the API does:
--
--   * Stock moves ONLY through the functions below, each one transaction that
--     locks the item rows (`for update`, in id order) before it reads a
--     balance. `store_items.available_qty` and every batch's `remaining_qty`
--     carry `>= 0` CHECKs as the backstop, so two racing issues cannot take
--     the same last kilo: the second waits for the lock and is refused.
--   * The sum of an item's batch `remaining_qty` is its `available_qty`. Every
--     increase creates a batch; every decrease drains batches oldest first.
--   * A batch keeps the price it was bought at forever. Price Control is a
--     separate, effective-dated list: a change inserts a new row and never
--     edits an old one, and a receipt copies the price it used.
--   * Every quantity change writes one `store_movements` row (the ledger).
--   * NOTHING here touches a finance table or function. Store figures are
--     operational reporting only (owner's rule, dryStore.md §11).
--
-- Status columns are text with CHECK constraints, not enums. Additive only.
-- ---------------------------------------------------------------------------

-- Document numbers: one counter row per series, created on first use.
--   DRY-STORE-001, DRY-001, PRC-0001, RCV-000001, BAT-000001, DRD-000001,
--   ISS-000001, ADJ-000001, SQ-000001.
-- (DRD, not DMD: DMD- is already the branch→Production demand number.)
create function app.next_store_number(p_key text, p_prefix text, p_width integer default 6) returns text
  language plpgsql as $$
  declare v bigint;
  begin
    insert into public.counters (id, count) values (p_key, 1)
    on conflict (id) do update set count = public.counters.count + 1
    returning count into v;
    return p_prefix || '-' || case when length(v::text) >= p_width then v::text else lpad(v::text, p_width, '0') end;
  end;
  $$;

-- Quantities that may be fractional. Everything else (Gram, Packet, Piece…) is
-- counted in whole units.
create function app.store_unit_allows_fraction(p_unit text) returns boolean
  language sql immutable as $$
  select lower(btrim(coalesce(p_unit, ''))) in ('kg', 'litre', 'liter');
  $$;

-- Today's business date, for the API (app.* is not callable from it).
create function public.store_business_date() returns date
  language sql stable as $$ select app.karachi_business_date(); $$;

-- ---------------------------------------------------------------------------
-- Department, accounts, settings
-- ---------------------------------------------------------------------------

create table public.store_departments (
  id              uuid primary key default gen_random_uuid(),
  store_code      text not null unique default app.next_store_number('store_department', 'DRY-STORE', 3),
  name            text not null check (btrim(name) <> ''),
  -- Receipts and opening stock cannot be dated before this. Null: no limit.
  opening_date    date,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger store_departments_touch before update on public.store_departments
  for each row execute function app.touch_updated_at();

insert into public.store_departments (name) values ('Dry Items Store');

-- One row per Store keeper account (users.role = 'store_user'): which store,
-- and what Admin has allowed it beyond the role's defaults.
create table public.store_accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references public.users (id) on delete cascade,
  store_id          uuid not null references public.store_departments (id) on delete restrict,
  can_manage_items  boolean not null default true,
  can_edit_prices   boolean not null default false,
  can_adjust_stock  boolean not null default true,
  can_issue         boolean not null default true,
  notes             text,
  created_by        uuid references public.users (id) on delete set null,
  created_by_name   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger store_accounts_touch before update on public.store_accounts
  for each row execute function app.touch_updated_at();

-- Configurable pick-lists: categories, units, adjustment reasons.
create table public.store_lookups (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('category', 'base_unit', 'purchase_unit', 'adjust_reason')),
  value       text not null check (btrim(value) <> '' and length(value) <= 40),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index store_lookups_kind_value on public.store_lookups (kind, lower(value));

insert into public.store_lookups (kind, value, sort_order) values
  ('category', 'Flour & Starch', 10), ('category', 'Sugar & Sweeteners', 20), ('category', 'Dairy', 30),
  ('category', 'Chocolate & Cocoa', 40), ('category', 'Leavening', 50), ('category', 'Nuts & Dried Fruit', 60),
  ('category', 'Other', 990),
  ('base_unit', 'KG', 10), ('base_unit', 'Gram', 20), ('base_unit', 'Litre', 30), ('base_unit', 'Packet', 40),
  ('base_unit', 'Piece', 50), ('base_unit', 'Box', 60), ('base_unit', 'Case', 70),
  ('purchase_unit', 'Bag', 10), ('purchase_unit', 'Case', 20), ('purchase_unit', 'Box', 30), ('purchase_unit', 'Packet', 40),
  ('purchase_unit', 'Tin', 50), ('purchase_unit', 'Carton', 60), ('purchase_unit', 'Piece', 70),
  ('adjust_reason', 'Damaged', 10), ('adjust_reason', 'Expired', 20), ('adjust_reason', 'Spillage', 30),
  ('adjust_reason', 'Count correction', 40), ('adjust_reason', 'Other', 990);

create function app.store_assert_lookup(p_kind text, p_value text, p_label text) returns text
  language plpgsql stable as $$
  declare v text;
  begin
    select value into v from public.store_lookups
     where kind = p_kind and lower(value) = lower(btrim(coalesce(p_value, ''))) and is_active;
    if v is null then
      raise exception '% "%" is not in Store Settings.', p_label, coalesce(p_value, '') using errcode = '22023';
    end if;
    return v;
  end;
  $$;

-- What happened to what, by whom: item history, price changes, account and
-- settings edits, query status changes. Written by the functions and the API.
create table public.store_audit_events (
  id           uuid primary key default gen_random_uuid(),
  entity       text not null check (entity in ('item', 'price', 'receipt', 'demand', 'issue', 'adjustment', 'account', 'settings', 'query')),
  entity_id    uuid,
  entity_ref   text,
  action       text not null,
  detail       text,
  before_data  jsonb,
  after_data   jsonb,
  actor_id     uuid references public.users (id) on delete set null,
  actor_name   text,
  actor_role   text,
  created_at   timestamptz not null default now()
);
create index store_audit_entity_idx on public.store_audit_events (entity, entity_id, created_at desc);

create function app.store_audit(
  p_entity text, p_entity_id uuid, p_ref text, p_action text, p_detail text,
  p_actor_id uuid, p_actor_name text, p_before jsonb default null, p_after jsonb default null, p_actor_role text default null
) returns void
  language sql as $$
  insert into public.store_audit_events (entity, entity_id, entity_ref, action, detail, before_data, after_data, actor_id, actor_name, actor_role)
  values (p_entity, p_entity_id, p_ref, p_action, nullif(p_detail, ''), p_before, p_after, p_actor_id, p_actor_name, p_actor_role);
  $$;

-- ---------------------------------------------------------------------------
-- Items and Price Control
-- ---------------------------------------------------------------------------

create table public.store_items (
  id                uuid primary key default gen_random_uuid(),
  item_no           text not null unique default app.next_store_number('store_item', 'DRY', 3),
  item_code         text not null check (item_code ~ '^[A-Z0-9-]{2,12}$'),
  name              text not null check (btrim(name) <> ''),
  category          text not null,
  base_unit         text not null,
  purchase_unit     text not null,
  -- How many base units one purchase unit holds: 1 Bag = 50 KG.
  conversion_qty    numeric(14,3) not null check (conversion_qty > 0),
  min_stock         numeric(14,3) not null default 0 check (min_stock >= 0),
  -- Written only by app.store_move. Equal to the item's batch remainders.
  available_qty     numeric(14,3) not null default 0 check (available_qty >= 0),
  status            text not null default 'active' check (status in ('active', 'inactive')),
  remarks           text,
  -- Optional link to the WhatsApp Purchasing catalog. Nothing flows across it.
  purchase_item_id  uuid references public.purchase_items (id) on delete set null,
  created_by        uuid references public.users (id) on delete set null,
  created_by_name   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger store_items_touch before update on public.store_items
  for each row execute function app.touch_updated_at();
create unique index store_items_name_key on public.store_items (lower(name));
create unique index store_items_code_key on public.store_items (item_code);

create table public.store_item_prices (
  id                uuid primary key default gen_random_uuid(),
  price_no          text not null unique default app.next_store_number('store_price', 'PRC', 4),
  item_id           uuid not null references public.store_items (id) on delete restrict,
  -- The package it is bought in (a purchase unit) and how many base units it holds.
  package_name      text not null,
  package_qty       numeric(14,3) not null check (package_qty > 0),
  -- Price of ONE whole package.
  price             numeric(14,2) not null check (price > 0),
  effective_from    date not null,
  status            text not null default 'active' check (status in ('active', 'inactive')),
  created_by        uuid references public.users (id) on delete set null,
  created_by_name   text,
  created_at        timestamptz not null default now(),
  deactivated_by    uuid references public.users (id) on delete set null,
  deactivated_by_name text,
  deactivated_at    timestamptz
);
create unique index store_prices_one_per_day on public.store_item_prices (item_id, package_name, package_qty, effective_from) where status = 'active';
create index store_prices_item_idx on public.store_item_prices (item_id, effective_from desc);

-- Where a price stands on a day: inactive, scheduled (starts later),
-- superseded (a newer price for the same package has started) or active.
create function app.store_price_state(p public.store_item_prices, p_day date) returns text
  language sql stable as $$
  select case
    when p.status = 'inactive' then 'inactive'
    when p.effective_from > p_day then 'scheduled'
    when exists (
      select 1 from public.store_item_prices q
       where q.id <> p.id and q.status = 'active' and q.item_id = p.item_id
         and q.package_name = p.package_name and q.package_qty = p.package_qty
         and q.effective_from <= p_day
         and (q.effective_from > p.effective_from or (q.effective_from = p.effective_from and q.created_at > p.created_at))
    ) then 'superseded'
    else 'active'
  end;
  $$;

-- The controlled price of ONE base unit on a day: the active price of the
-- item's largest package. Null when the item has no active price.
create function app.store_unit_price(p_item uuid, p_day date) returns numeric
  language sql stable as $$
  select round(p.price / p.package_qty, 4) from public.store_item_prices p
   where p.item_id = p_item and app.store_price_state(p, p_day) = 'active'
   order by p.package_qty desc, p.effective_from desc
   limit 1;
  $$;

-- ---------------------------------------------------------------------------
-- Receipts, batches, movements
-- ---------------------------------------------------------------------------

create table public.store_receipts (
  id                 uuid primary key default gen_random_uuid(),
  receipt_no         text not null unique default app.next_store_number('store_receipt', 'RCV'),
  store_id           uuid not null references public.store_departments (id) on delete restrict,
  receipt_date       date not null,
  supplier_id        uuid references public.suppliers (id) on delete set null,
  supplier_name      text not null check (btrim(supplier_name) <> ''),
  invoice_no         text,
  remarks            text,
  total_amount       numeric(14,2) not null default 0,
  client_request_id  uuid unique,
  received_by        uuid references public.users (id) on delete set null,
  received_by_name   text,
  created_at         timestamptz not null default now()
);
create index store_receipts_date_idx on public.store_receipts (receipt_date desc, created_at desc);

-- One batch per receipt line, plus one per stock-in adjustment / opening count.
-- Never updated except remaining_qty.
create table public.store_batches (
  id                 uuid primary key default gen_random_uuid(),
  batch_no           text not null unique default app.next_store_number('store_batch', 'BAT'),
  item_id            uuid not null references public.store_items (id) on delete restrict,
  source             text not null check (source in ('receipt', 'opening', 'adjustment', 'return')),
  receipt_id         uuid references public.store_receipts (id) on delete restrict,
  line_no            integer,
  price_id           uuid references public.store_item_prices (id) on delete restrict,
  package_name       text,
  package_qty        numeric(14,3),
  packages           integer check (packages is null or packages >= 1),
  -- Price Control's price per package on the day, and what was actually paid.
  list_price         numeric(14,2),
  price_per_package  numeric(14,2),
  override_reason    text,
  unit_cost          numeric(14,4) not null check (unit_cost >= 0),
  received_qty       numeric(14,3) not null check (received_qty > 0),
  remaining_qty      numeric(14,3) not null check (remaining_qty >= 0 and remaining_qty <= received_qty),
  amount             numeric(14,2) not null check (amount >= 0),
  supplier_batch_no  text,
  expiry_date        date,
  received_at        date not null,
  created_at         timestamptz not null default now(),
  check (source <> 'receipt' or (receipt_id is not null and price_id is not null and packages is not null))
);
create index store_batches_fifo_idx on public.store_batches (item_id, received_at, created_at) where remaining_qty > 0;
create index store_batches_receipt_idx on public.store_batches (receipt_id);

-- ---------------------------------------------------------------------------
-- Demands and issues
-- ---------------------------------------------------------------------------

create table public.store_demands (
  id                 uuid primary key default gen_random_uuid(),
  demand_no          text not null unique default app.next_store_number('store_demand', 'DRD'),
  store_id           uuid not null references public.store_departments (id) on delete restrict,
  demand_date        date not null,
  required_date      date not null,
  -- The requester and their staff ID (MBU-…), the "Production ID" on the slip.
  requested_by       uuid references public.users (id) on delete set null,
  requested_by_name  text,
  production_code    text,
  remarks            text,
  status             text not null default 'pending_review' check (status in (
                       'pending_review', 'ready_to_issue', 'issued', 'received', 'rejected', 'cancelled')),
  client_request_id  uuid unique,
  cancelled_at       timestamptz,
  cancelled_by       uuid references public.users (id) on delete set null,
  cancelled_by_name  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger store_demands_touch before update on public.store_demands
  for each row execute function app.touch_updated_at();
create index store_demands_status_idx on public.store_demands (status, required_date);
create index store_demands_date_idx on public.store_demands (demand_date desc, created_at desc);

create table public.store_demand_items (
  id                 uuid primary key default gen_random_uuid(),
  demand_id          uuid not null references public.store_demands (id) on delete cascade,
  line_no            integer not null,
  item_id            uuid not null references public.store_items (id) on delete restrict,
  item_name          text not null,
  unit               text not null,
  requested_qty      numeric(14,3) not null check (requested_qty > 0),
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'issued')),
  -- Approved may be less than requested (a partial approval); the rest is rejected.
  approved_qty       numeric(14,3) check (approved_qty is null or (approved_qty >= 0 and approved_qty <= requested_qty)),
  issued_qty         numeric(14,3) not null default 0 check (issued_qty >= 0),
  received_qty       numeric(14,3) not null default 0 check (received_qty >= 0),
  -- Price Control's unit price when the line was approved: the demand valuation.
  unit_price         numeric(14,4),
  remarks            text,
  decision_note      text,
  decided_by         uuid references public.users (id) on delete set null,
  decided_by_name    text,
  decided_at         timestamptz,
  unique (demand_id, item_id),
  unique (demand_id, line_no),
  check (issued_qty <= coalesce(approved_qty, 0)),
  check (status <> 'rejected' or nullif(btrim(coalesce(decision_note, '')), '') is not null)
);
create index store_demand_items_item_idx on public.store_demand_items (item_id) where status = 'approved';

create table public.store_issues (
  id                 uuid primary key default gen_random_uuid(),
  issue_no           text not null unique default app.next_store_number('store_issue', 'ISS'),
  demand_id          uuid not null references public.store_demands (id) on delete restrict,
  store_id           uuid not null references public.store_departments (id) on delete restrict,
  issue_date         date not null,
  issued_by          uuid references public.users (id) on delete set null,
  issued_by_name     text,
  -- Who in Production took the goods, as typed by the Store keeper.
  received_by_name   text not null check (btrim(received_by_name) <> ''),
  remarks            text,
  status             text not null default 'issued' check (status in ('issued', 'received', 'received_with_difference')),
  confirmed_by       uuid references public.users (id) on delete set null,
  confirmed_by_name  text,
  confirmed_at       timestamptz,
  confirm_note       text,
  total_cost         numeric(14,2) not null default 0,
  client_request_id  uuid unique,
  created_at         timestamptz not null default now()
);
create index store_issues_date_idx on public.store_issues (issue_date desc, created_at desc);
create index store_issues_demand_idx on public.store_issues (demand_id);

create table public.store_issue_items (
  id                 uuid primary key default gen_random_uuid(),
  issue_id           uuid not null references public.store_issues (id) on delete cascade,
  demand_item_id     uuid not null references public.store_demand_items (id) on delete restrict,
  item_id            uuid not null references public.store_items (id) on delete restrict,
  item_name          text not null,
  unit               text not null,
  issued_qty         numeric(14,3) not null check (issued_qty > 0),
  received_qty       numeric(14,3) check (received_qty is null or received_qty >= 0),
  -- Actual FIFO cost of what left the store (sum of its allocations).
  cost_amount        numeric(14,2) not null default 0,
  -- The demand valuation price, copied from the demand line.
  unit_price         numeric(14,4)
);
create index store_issue_items_issue_idx on public.store_issue_items (issue_id);

create table public.store_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  adj_no             text not null unique default app.next_store_number('store_adjustment', 'ADJ'),
  item_id            uuid not null references public.store_items (id) on delete restrict,
  kind               text not null check (kind in ('adjustment', 'opening', 'return')),
  direction          text not null check (direction in ('in', 'out')),
  qty                numeric(14,3) not null check (qty > 0),
  reason             text not null check (btrim(reason) <> ''),
  note               text,
  business_date      date not null,
  value              numeric(14,2) not null default 0,
  client_request_id  uuid unique,
  created_by         uuid references public.users (id) on delete set null,
  created_by_name    text,
  created_at         timestamptz not null default now(),
  check (kind = 'adjustment' or direction = 'in')
);
create index store_adjustments_date_idx on public.store_adjustments (business_date desc, created_at desc);

-- Which batches an issue line (or a stock-out adjustment) drained, at what cost.
create table public.store_batch_allocations (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references public.store_batches (id) on delete restrict,
  item_id            uuid not null references public.store_items (id) on delete restrict,
  issue_item_id      uuid references public.store_issue_items (id) on delete restrict,
  adjustment_id      uuid references public.store_adjustments (id) on delete restrict,
  qty                numeric(14,3) not null check (qty > 0),
  unit_cost          numeric(14,4) not null,
  amount             numeric(14,2) not null,
  created_at         timestamptz not null default now(),
  check ((issue_item_id is null) <> (adjustment_id is null))
);
create index store_alloc_issue_idx on public.store_batch_allocations (issue_item_id);
create index store_alloc_batch_idx on public.store_batch_allocations (batch_id);

-- The ledger: every change to an item's quantity.
create table public.store_movements (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references public.store_items (id) on delete restrict,
  type               text not null check (type in ('opening', 'receipt', 'issue', 'adjustment', 'return')),
  qty_delta          numeric(14,3) not null check (qty_delta <> 0),
  balance_after      numeric(14,3) not null check (balance_after >= 0),
  -- Cost of the quantity moved (+ in, − out).
  value              numeric(14,2) not null default 0,
  business_date      date not null,
  ref_no             text not null,
  detail             text,
  receipt_id         uuid references public.store_receipts (id) on delete restrict,
  batch_id           uuid references public.store_batches (id) on delete restrict,
  issue_id           uuid references public.store_issues (id) on delete restrict,
  demand_id          uuid references public.store_demands (id) on delete restrict,
  adjustment_id      uuid references public.store_adjustments (id) on delete restrict,
  created_by         uuid references public.users (id) on delete set null,
  created_by_name    text,
  created_at         timestamptz not null default now()
);
create index store_movements_item_idx on public.store_movements (item_id, business_date, created_at);
create index store_movements_date_idx on public.store_movements (business_date, type);

-- ---------------------------------------------------------------------------
-- Queries (Store help desk)
-- ---------------------------------------------------------------------------

create table public.store_queries (
  id                  uuid primary key default gen_random_uuid(),
  query_no            text not null unique default app.next_store_number('store_query', 'SQ'),
  subject             text not null check (btrim(subject) <> ''),
  query_type          text not null check (query_type in (
                        'stock_receiving', 'missing_stock', 'quantity_difference', 'price_difference',
                        'production_demand', 'stock_issuance', 'incorrect_transaction', 'other')),
  description         text not null check (btrim(description) <> ''),
  related_receipt_id  uuid references public.store_receipts (id) on delete set null,
  related_demand_id   uuid references public.store_demands (id) on delete set null,
  related_issue_id    uuid references public.store_issues (id) on delete set null,
  status              text not null default 'open' check (status in ('open', 'in_review', 'responded', 'resolved', 'rejected')),
  raised_by           uuid references public.users (id) on delete set null,
  raised_by_name      text,
  raised_by_role      text,
  archived_at         timestamptz,
  archived_by         uuid references public.users (id) on delete set null,
  archived_by_name    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger store_queries_touch before update on public.store_queries
  for each row execute function app.touch_updated_at();
create index store_queries_status_idx on public.store_queries (status, created_at desc) where archived_at is null;

create table public.store_query_messages (
  id            uuid primary key default gen_random_uuid(),
  query_id      uuid not null references public.store_queries (id) on delete cascade,
  author_id     uuid references public.users (id) on delete set null,
  author_name   text,
  author_side   text not null check (author_side in ('store', 'production', 'admin')),
  body          text,
  -- Set when this entry moved the query (e.g. 'resolved').
  status_change text,
  created_at    timestamptz not null default now(),
  check (nullif(btrim(coalesce(body, '')), '') is not null or status_change is not null)
);
create index store_query_messages_idx on public.store_query_messages (query_id, created_at);

-- ---------------------------------------------------------------------------
-- Stock primitives
-- ---------------------------------------------------------------------------

-- Approved but not yet issued, across live demands.
create function app.store_committed(p_item uuid) returns numeric
  language sql stable as $$
  select coalesce(sum(i.approved_qty - i.issued_qty), 0)
    from public.store_demand_items i
    join public.store_demands d on d.id = i.demand_id
   where i.item_id = p_item and i.status = 'approved' and d.cancelled_at is null;
  $$;

-- Apply one quantity change and write its ledger row. The caller holds the
-- item's row lock (this takes it again, harmlessly, to be safe on its own).
create function app.store_move(
  p_item uuid, p_delta numeric, p_type text, p_date date, p_ref text, p_detail text, p_value numeric,
  p_receipt uuid, p_batch uuid, p_issue uuid, p_demand uuid, p_adjustment uuid,
  p_actor_id uuid, p_actor_name text
) returns void
  language plpgsql as $$
  declare v_item public.store_items%rowtype; v_bal numeric(14,3);
  begin
    select * into v_item from public.store_items where id = p_item for update;
    if not found then raise exception 'Store item % does not exist.', p_item using errcode = 'P0002'; end if;
    v_bal := v_item.available_qty + p_delta;
    if v_bal < 0 then
      raise exception 'Not enough % in store: % % available.', v_item.name, v_item.available_qty, v_item.base_unit using errcode = 'P0001';
    end if;
    update public.store_items set available_qty = v_bal where id = p_item;
    insert into public.store_movements
      (item_id, type, qty_delta, balance_after, value, business_date, ref_no, detail,
       receipt_id, batch_id, issue_id, demand_id, adjustment_id, created_by, created_by_name)
    values
      (p_item, p_type, p_delta, v_bal, coalesce(p_value, 0), p_date, p_ref, p_detail,
       p_receipt, p_batch, p_issue, p_demand, p_adjustment, p_actor_id, p_actor_name);
  end;
  $$;

-- Take p_qty out of an item's batches, oldest first. Returns the cost taken.
create function app.store_drain_fifo(p_item uuid, p_qty numeric, p_issue_item uuid, p_adjustment uuid) returns numeric
  language plpgsql as $$
  declare
    b       record;
    v_left  numeric(14,3) := p_qty;
    v_take  numeric(14,3);
    v_amt   numeric(14,2);
    v_cost  numeric(14,2) := 0;
  begin
    for b in
      select id, remaining_qty, unit_cost from public.store_batches
       where item_id = p_item and remaining_qty > 0
       order by received_at, created_at, batch_no
       for update
    loop
      exit when v_left <= 0;
      v_take := least(v_left, b.remaining_qty);
      v_amt := round(v_take * b.unit_cost, 2);
      update public.store_batches set remaining_qty = remaining_qty - v_take where id = b.id;
      insert into public.store_batch_allocations (batch_id, item_id, issue_item_id, adjustment_id, qty, unit_cost, amount)
      values (b.id, p_item, p_issue_item, p_adjustment, v_take, b.unit_cost, v_amt);
      v_cost := v_cost + v_amt;
      v_left := v_left - v_take;
    end loop;
    if v_left > 0 then
      raise exception 'Store batches are short by % for this item. Ask Admin to check the stock ledger.', v_left using errcode = 'P0001';
    end if;
    return v_cost;
  end;
  $$;

create function app.store_the_store() returns public.store_departments
  language plpgsql stable as $$
  declare v public.store_departments%rowtype;
  begin
    select * into v from public.store_departments where is_active order by created_at limit 1;
    if not found then raise exception 'The Dry Items Store is not set up.' using errcode = 'P0001'; end if;
    return v;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- JSON shapes the API returns
-- ---------------------------------------------------------------------------

create function app.store_receipt_json(p_id uuid) returns jsonb
  language sql stable as $$
  select to_jsonb(r) || jsonb_build_object(
    'lines', coalesce((
      select jsonb_agg(to_jsonb(b) || jsonb_build_object('item_no', i.item_no, 'item_code', i.item_code, 'item_name', i.name, 'base_unit', i.base_unit) order by b.line_no)
        from public.store_batches b join public.store_items i on i.id = b.item_id
       where b.receipt_id = r.id), '[]'::jsonb))
    from public.store_receipts r where r.id = p_id;
  $$;

create function app.store_demand_json(p_id uuid) returns jsonb
  language sql stable as $$
  select to_jsonb(d) || jsonb_build_object(
    'lines', coalesce((
      select jsonb_agg(to_jsonb(l) || jsonb_build_object(
               'item_no', i.item_no, 'item_code', i.item_code,
               'available_qty', i.available_qty,
               'committed_qty', app.store_committed(i.id),
               'current_unit_price', app.store_unit_price(i.id, app.karachi_business_date()),
               'issue_nos', (select coalesce(jsonb_agg(distinct s.issue_no), '[]'::jsonb)
                               from public.store_issue_items si join public.store_issues s on s.id = si.issue_id
                              where si.demand_item_id = l.id)) order by l.line_no)
        from public.store_demand_items l join public.store_items i on i.id = l.item_id
       where l.demand_id = d.id), '[]'::jsonb),
    'issues', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'issue_no', s.issue_no, 'issue_date', s.issue_date, 'status', s.status) order by s.created_at)
        from public.store_issues s where s.demand_id = d.id), '[]'::jsonb))
    from public.store_demands d where d.id = p_id;
  $$;

create function app.store_issue_json(p_id uuid) returns jsonb
  language sql stable as $$
  select to_jsonb(s) || jsonb_build_object(
    'demand_no', d.demand_no, 'production_code', d.production_code, 'requested_by_name', d.requested_by_name,
    'lines', coalesce((
      select jsonb_agg(to_jsonb(si) || jsonb_build_object(
               'item_no', i.item_no,
               'batches', (select coalesce(jsonb_agg(jsonb_build_object('batch_no', b.batch_no, 'qty', a.qty, 'unit_cost', a.unit_cost, 'amount', a.amount, 'received_at', b.received_at) order by b.received_at, b.created_at), '[]'::jsonb)
                             from public.store_batch_allocations a join public.store_batches b on b.id = a.batch_id
                            where a.issue_item_id = si.id)) order by i.name)
        from public.store_issue_items si join public.store_items i on i.id = si.item_id
       where si.issue_id = s.id), '[]'::jsonb))
    from public.store_issues s join public.store_demands d on d.id = s.demand_id where s.id = p_id;
  $$;

-- The same shapes, callable by the API.
create function public.store_get_demand(p_id uuid) returns jsonb
  language sql stable as $$ select app.store_demand_json(p_id); $$;

create function public.store_get_demands(p_ids uuid[]) returns jsonb
  language sql stable as $$
  select coalesce(jsonb_agg(app.store_demand_json(d.id) order by d.demand_date desc, d.created_at desc), '[]'::jsonb)
    from public.store_demands d where d.id = any (p_ids);
  $$;

create function public.store_get_issues(p_ids uuid[]) returns jsonb
  language sql stable as $$
  select coalesce(jsonb_agg(app.store_issue_json(s.id) order by s.issue_date desc, s.created_at desc), '[]'::jsonb)
    from public.store_issues s where s.id = any (p_ids);
  $$;

create function app.store_refresh_demand(p_id uuid) returns void
  language plpgsql as $$
  declare v text;
  begin
    select case
      when d.cancelled_at is not null then 'cancelled'
      when exists (select 1 from public.store_demand_items i where i.demand_id = d.id and i.status = 'pending') then 'pending_review'
      when exists (select 1 from public.store_demand_items i where i.demand_id = d.id and i.status = 'approved') then 'ready_to_issue'
      when exists (select 1 from public.store_demand_items i where i.demand_id = d.id and i.issued_qty > 0) then
        case when exists (select 1 from public.store_issues s where s.demand_id = d.id and s.status = 'issued') then 'issued' else 'received' end
      else 'rejected'
    end into v
    from public.store_demands d where d.id = p_id;
    update public.store_demands set status = v where id = p_id and status is distinct from v;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------

-- Create (p_id null) or edit an item. p_input: {itemCode, name, category,
-- baseUnit, purchaseUnit, conversionQty, minStock, remarks, purchaseItemId?}
create function public.store_save_item(p_actor_id uuid, p_actor_name text, p_id uuid, p_input jsonb) returns jsonb
  language plpgsql as $$
  declare
    v_old   public.store_items%rowtype;
    v_new   public.store_items%rowtype;
    v_code  text := upper(btrim(coalesce(p_input->>'itemCode', '')));
    v_name  text := btrim(coalesce(p_input->>'name', ''));
    v_cat   text := app.store_assert_lookup('category', p_input->>'category', 'Category');
    v_base  text := app.store_assert_lookup('base_unit', p_input->>'baseUnit', 'Base unit');
    v_pur   text := app.store_assert_lookup('purchase_unit', p_input->>'purchaseUnit', 'Purchase unit');
    v_conv  numeric := nullif(p_input->>'conversionQty', '')::numeric;
    v_min   numeric := coalesce(nullif(p_input->>'minStock', '')::numeric, 0);
    v_rem   text := nullif(btrim(coalesce(p_input->>'remarks', '')), '');
    v_link  uuid := nullif(p_input->>'purchaseItemId', '')::uuid;
    v_diff  text[] := '{}';
  begin
    if v_name = '' then raise exception 'Enter the item name.' using errcode = '22023'; end if;
    if v_code !~ '^[A-Z0-9-]{2,12}$' then raise exception 'Item code: use 2–12 letters, numbers or dashes.' using errcode = '22023'; end if;
    if v_conv is null or v_conv <= 0 then raise exception 'Conversion quantity must be above 0.' using errcode = '22023'; end if;
    if v_min < 0 then raise exception 'Low-stock level must be 0 or more.' using errcode = '22023'; end if;
    if exists (select 1 from public.store_items where lower(name) = lower(v_name) and id is distinct from p_id) then
      raise exception 'An item named "%" already exists.', v_name using errcode = 'P0001';
    end if;
    if exists (select 1 from public.store_items where item_code = v_code and id is distinct from p_id) then
      raise exception 'Item code % is already used.', v_code using errcode = 'P0001';
    end if;

    if p_id is null then
      insert into public.store_items (item_code, name, category, base_unit, purchase_unit, conversion_qty, min_stock, remarks, purchase_item_id, created_by, created_by_name)
      values (v_code, v_name, v_cat, v_base, v_pur, v_conv, v_min, v_rem, v_link, p_actor_id, p_actor_name)
      returning * into v_new;
      perform app.store_audit('item', v_new.id, v_new.item_no, 'created', null, p_actor_id, p_actor_name, null, to_jsonb(v_new));
      return to_jsonb(v_new);
    end if;

    select * into v_old from public.store_items where id = p_id for update;
    if not found then raise exception 'Store item not found.' using errcode = 'P0002'; end if;
    if v_old.base_unit <> v_base and exists (select 1 from public.store_movements where item_id = p_id) then
      raise exception 'Stock has already moved in %. Create a new item instead of changing the base unit.', v_old.base_unit using errcode = 'P0001';
    end if;
    update public.store_items set
      item_code = v_code, name = v_name, category = v_cat, base_unit = v_base, purchase_unit = v_pur,
      conversion_qty = v_conv, min_stock = v_min, remarks = v_rem, purchase_item_id = v_link
     where id = p_id
     returning * into v_new;
    if v_old.item_code <> v_new.item_code then v_diff := v_diff || format('Code: %s → %s', v_old.item_code, v_new.item_code); end if;
    if v_old.name <> v_new.name then v_diff := v_diff || format('Name: %s → %s', v_old.name, v_new.name); end if;
    if v_old.category <> v_new.category then v_diff := v_diff || format('Category: %s → %s', v_old.category, v_new.category); end if;
    if v_old.base_unit <> v_new.base_unit then v_diff := v_diff || format('Base unit: %s → %s', v_old.base_unit, v_new.base_unit); end if;
    if v_old.purchase_unit <> v_new.purchase_unit then v_diff := v_diff || format('Purchase unit: %s → %s', v_old.purchase_unit, v_new.purchase_unit); end if;
    if v_old.conversion_qty <> v_new.conversion_qty then v_diff := v_diff || format('Conversion: %s → %s', v_old.conversion_qty, v_new.conversion_qty); end if;
    if v_old.min_stock <> v_new.min_stock then v_diff := v_diff || format('Low-stock level: %s → %s', v_old.min_stock, v_new.min_stock); end if;
    if v_old.remarks is distinct from v_new.remarks then v_diff := v_diff || format('Remarks: %s → %s', coalesce(v_old.remarks, '—'), coalesce(v_new.remarks, '—')); end if;
    if v_old.purchase_item_id is distinct from v_new.purchase_item_id then v_diff := v_diff || 'Purchasing link changed'::text; end if;
    perform app.store_audit('item', p_id, v_new.item_no, 'edited',
      coalesce(nullif(array_to_string(v_diff, '; '), ''), 'No changes'), p_actor_id, p_actor_name, to_jsonb(v_old), to_jsonb(v_new));
    return to_jsonb(v_new);
  end;
  $$;

create function public.store_set_item_status(p_actor_id uuid, p_actor_name text, p_id uuid, p_active boolean) returns jsonb
  language plpgsql as $$
  declare v public.store_items%rowtype;
  begin
    select * into v from public.store_items where id = p_id for update;
    if not found then raise exception 'Store item not found.' using errcode = 'P0002'; end if;
    if not p_active and exists (
      select 1 from public.store_demand_items l join public.store_demands d on d.id = l.demand_id
       where l.item_id = p_id and l.status in ('pending', 'approved') and d.cancelled_at is null
    ) then
      raise exception '% has open production demand. Decide or issue it first.', v.name using errcode = 'P0001';
    end if;
    update public.store_items set status = case when p_active then 'active' else 'inactive' end where id = p_id returning * into v;
    perform app.store_audit('item', p_id, v.item_no, case when p_active then 'activated' else 'deactivated' end, null, p_actor_id, p_actor_name);
    return to_jsonb(v);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Price Control
-- ---------------------------------------------------------------------------

-- p_input: {itemId, packageName, packageQty, price, effectiveFrom}
create function public.store_add_price(p_actor_id uuid, p_actor_name text, p_actor_role text, p_input jsonb) returns jsonb
  language plpgsql as $$
  declare
    v_item  public.store_items%rowtype;
    v_pkg   text := app.store_assert_lookup('purchase_unit', p_input->>'packageName', 'Purchase package');
    v_qty   numeric := nullif(p_input->>'packageQty', '')::numeric;
    v_price numeric := nullif(p_input->>'price', '')::numeric;
    v_from  date := nullif(p_input->>'effectiveFrom', '')::date;
    v_today date := app.karachi_business_date();
    v_cur   public.store_item_prices%rowtype;
    v_new   public.store_item_prices%rowtype;
  begin
    select * into v_item from public.store_items where id = nullif(p_input->>'itemId', '')::uuid for update;
    if not found then raise exception 'Select an item.' using errcode = '22023'; end if;
    if v_item.status <> 'active' then raise exception '% is inactive.', v_item.name using errcode = 'P0001'; end if;
    if v_qty is null or v_qty <= 0 then raise exception 'Enter how much one package holds.' using errcode = '22023'; end if;
    if v_price is null or v_price <= 0 then raise exception 'Enter a price above 0.' using errcode = '22023'; end if;
    if v_from is null then raise exception 'Select the date the price starts.' using errcode = '22023'; end if;
    if v_from < v_today then raise exception 'The effective date must be today or later. Past prices stay as recorded.' using errcode = '22023'; end if;
    if exists (select 1 from public.store_item_prices where status = 'active' and item_id = v_item.id
                 and package_name = v_pkg and package_qty = v_qty and effective_from = v_from) then
      raise exception 'A price for this package already starts on this date.' using errcode = 'P0001';
    end if;
    select * into v_cur from public.store_item_prices p
     where p.item_id = v_item.id and p.package_name = v_pkg and p.package_qty = v_qty and app.store_price_state(p, v_today) = 'active'
     limit 1;
    insert into public.store_item_prices (item_id, package_name, package_qty, price, effective_from, created_by, created_by_name)
    values (v_item.id, v_pkg, v_qty, round(v_price, 2), v_from, p_actor_id, p_actor_name)
    returning * into v_new;
    perform app.store_audit('price', v_new.id, v_new.price_no, 'created',
      format('%s · %s of %s %s · Rs. %s from %s%s', v_item.name, v_pkg, v_qty, v_item.base_unit, v_new.price, v_from,
             case when v_cur.id is null then '' else format(' (was Rs. %s, %s)', v_cur.price, v_cur.price_no) end),
      p_actor_id, p_actor_name, null, to_jsonb(v_new), p_actor_role);
    perform app.store_audit('item', v_item.id, v_item.item_no, 'price set',
      format('%s: %s of %s %s at Rs. %s from %s', v_new.price_no, v_pkg, v_qty, v_item.base_unit, v_new.price, v_from),
      p_actor_id, p_actor_name, null, null, p_actor_role);
    return to_jsonb(v_new) || jsonb_build_object('state', app.store_price_state(v_new, v_today));
  end;
  $$;

create function public.store_deactivate_price(p_actor_id uuid, p_actor_name text, p_actor_role text, p_id uuid) returns jsonb
  language plpgsql as $$
  declare v public.store_item_prices%rowtype;
  begin
    select * into v from public.store_item_prices where id = p_id for update;
    if not found then raise exception 'Price not found.' using errcode = 'P0002'; end if;
    if v.status = 'inactive' then raise exception '% is already inactive.', v.price_no using errcode = 'P0001'; end if;
    update public.store_item_prices
       set status = 'inactive', deactivated_by = p_actor_id, deactivated_by_name = p_actor_name, deactivated_at = now()
     where id = p_id returning * into v;
    perform app.store_audit('price', v.id, v.price_no, 'deactivated', null, p_actor_id, p_actor_name, null, null, p_actor_role);
    return to_jsonb(v) || jsonb_build_object('state', 'inactive');
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Receiving
-- ---------------------------------------------------------------------------

-- p_input: {receiptDate, supplierId?, supplierName?, invoiceNo?, remarks?,
--   clientRequestId?, confirmDuplicate?, lines: [{itemId, priceId, packages,
--   overridePrice?, overrideReason?, batchNo?, expiryDate?}]}
-- Prices come from Price Control; only Admin may override one, with a reason.
create function public.store_receive_stock(p_actor_id uuid, p_actor_name text, p_actor_role text, p_input jsonb) returns jsonb
  language plpgsql as $$
  declare
    v_store     public.store_departments%rowtype := app.store_the_store();
    v_today     date := app.karachi_business_date();
    v_date      date := coalesce(nullif(p_input->>'receiptDate', '')::date, app.karachi_business_date());
    v_req       uuid := nullif(p_input->>'clientRequestId', '')::uuid;
    v_sup_id    uuid := nullif(p_input->>'supplierId', '')::uuid;
    v_sup_name  text := nullif(btrim(coalesce(p_input->>'supplierName', '')), '');
    v_lines     jsonb := p_input->'lines';
    v_receipt   public.store_receipts%rowtype;
    v_item      public.store_items%rowtype;
    v_price     public.store_item_prices%rowtype;
    v_batch     public.store_batches%rowtype;
    r           record;
    v_existing  uuid;
    v_sig       text;
    v_dup       text;
    v_pkgs      numeric;
    v_ovr       numeric;
    v_ppp       numeric(14,2);
    v_qty       numeric(14,3);
    v_amt       numeric(14,2);
    v_total     numeric(14,2) := 0;
    v_expiry    date;
    v_seen      text[] := '{}';
  begin
    if v_req is not null then
      select id into v_existing from public.store_receipts where client_request_id = v_req;
      if found then return app.store_receipt_json(v_existing); end if;
    end if;
    if v_date > v_today then raise exception 'The receiving date can''t be in the future.' using errcode = '22023'; end if;
    if v_store.opening_date is not null and v_date < v_store.opening_date then
      raise exception 'The receiving date is before the store went live (%).', v_store.opening_date using errcode = '22023';
    end if;
    if v_sup_id is not null then
      select name into v_sup_name from public.suppliers where id = v_sup_id and deleted_at is null;
      if not found then raise exception 'Supplier not found.' using errcode = 'P0002'; end if;
    end if;
    if v_sup_name is null then raise exception 'Select the supplier.' using errcode = '22023'; end if;
    if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
      raise exception 'Add at least one item.' using errcode = '22023';
    end if;

    -- The same supplier, date and items already saved: refuse unless confirmed.
    select string_agg((x->>'itemId') || ':' || (x->>'packages'), ',' order by (x->>'itemId'), (x->>'packages'))
      into v_sig from jsonb_array_elements(v_lines) x;
    if not coalesce((p_input->>'confirmDuplicate')::boolean, false) then
      select rc.receipt_no into v_dup from public.store_receipts rc
       where lower(rc.supplier_name) = lower(v_sup_name) and rc.receipt_date = v_date
         and (select string_agg(b.item_id::text || ':' || b.packages::text, ',' order by b.item_id::text, b.packages::text)
                from public.store_batches b where b.receipt_id = rc.id) = v_sig
       limit 1;
      if v_dup is not null then
        raise exception 'DUPLICATE_RECEIPT:%', v_dup using errcode = 'P0001';
      end if;
    end if;

    -- Lock every item on the receipt, in one order, before reading anything.
    perform 1 from public.store_items
     where id in (select (x->>'itemId')::uuid from jsonb_array_elements(v_lines) x)
     order by id for update;

    insert into public.store_receipts (store_id, receipt_date, supplier_id, supplier_name, invoice_no, remarks, client_request_id, received_by, received_by_name)
    values (v_store.id, v_date, v_sup_id, v_sup_name, nullif(btrim(coalesce(p_input->>'invoiceNo', '')), ''),
            nullif(btrim(coalesce(p_input->>'remarks', '')), ''), v_req, p_actor_id, p_actor_name)
    returning * into v_receipt;

    for r in select x.value as l, x.ordinality as n from jsonb_array_elements(v_lines) with ordinality x loop
      select * into v_item from public.store_items where id = nullif(r.l->>'itemId', '')::uuid;
      if not found then raise exception 'Line %: select an item.', r.n using errcode = '22023'; end if;
      if v_item.status <> 'active' then raise exception '% is inactive and can''t be received.', v_item.name using errcode = 'P0001'; end if;
      select * into v_price from public.store_item_prices where id = nullif(r.l->>'priceId', '')::uuid and item_id = v_item.id;
      if not found then raise exception '%: select the package delivered.', v_item.name using errcode = '22023'; end if;
      if app.store_price_state(v_price, v_date) <> 'active' then
        raise exception '%: price % is not current on %. Reload and pick the package again.', v_item.name, v_price.price_no, v_date using errcode = 'P0001';
      end if;
      if (v_item.id::text || v_price.id::text) = any (v_seen) then
        raise exception '% (%) appears twice. Combine them into one line.', v_item.name, v_price.package_name using errcode = '22023';
      end if;
      v_seen := v_seen || (v_item.id::text || v_price.id::text);
      v_pkgs := nullif(r.l->>'packages', '')::numeric;
      if v_pkgs is null or v_pkgs < 1 or v_pkgs <> trunc(v_pkgs) then
        raise exception '%: number of packages must be a whole number, 1 or more.', v_item.name using errcode = '22023';
      end if;
      v_ovr := nullif(r.l->>'overridePrice', '')::numeric;
      if v_ovr is not null then
        if p_actor_role <> 'super_admin' then raise exception 'Only Admin can override a price.' using errcode = 'P0001'; end if;
        if v_ovr <= 0 then raise exception '%: override price must be above 0.', v_item.name using errcode = '22023'; end if;
        if nullif(btrim(coalesce(r.l->>'overrideReason', '')), '') is null then
          raise exception '%: give a reason for the override.', v_item.name using errcode = '22023';
        end if;
      end if;
      v_expiry := nullif(r.l->>'expiryDate', '')::date;
      if v_expiry is not null and v_expiry <= v_date then
        raise exception '%: expiry must be after the receiving date.', v_item.name using errcode = '22023';
      end if;
      v_ppp := coalesce(v_ovr, v_price.price);
      v_qty := v_pkgs * v_price.package_qty;
      v_amt := round(v_pkgs * v_ppp, 2);
      insert into public.store_batches
        (item_id, source, receipt_id, line_no, price_id, package_name, package_qty, packages, list_price, price_per_package,
         override_reason, unit_cost, received_qty, remaining_qty, amount, supplier_batch_no, expiry_date, received_at)
      values
        (v_item.id, 'receipt', v_receipt.id, r.n, v_price.id, v_price.package_name, v_price.package_qty, v_pkgs::integer, v_price.price, v_ppp,
         case when v_ovr is null then null else btrim(r.l->>'overrideReason') end,
         round(v_ppp / v_price.package_qty, 4), v_qty, v_qty, v_amt,
         nullif(btrim(coalesce(r.l->>'batchNo', '')), ''), v_expiry, v_date)
      returning * into v_batch;
      perform app.store_move(v_item.id, v_qty, 'receipt', v_date, v_receipt.receipt_no,
        format('%s · %s × %s of %s @ Rs. %s%s', v_sup_name, v_pkgs, v_price.package_name, v_price.package_qty, v_ppp,
               case when v_batch.supplier_batch_no is null then '' else ' · batch ' || v_batch.supplier_batch_no end),
        v_amt, v_receipt.id, v_batch.id, null, null, null, p_actor_id, p_actor_name);
      v_total := v_total + v_amt;
    end loop;

    update public.store_receipts set total_amount = v_total where id = v_receipt.id;
    return app.store_receipt_json(v_receipt.id);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Adjustments (and opening stock, and returns from Production)
-- ---------------------------------------------------------------------------

-- p_input: {itemId, direction 'in'|'out', qty, reason, note?, businessDate?, clientRequestId?}
--   reason 'Opening stock'            → kind opening (Admin only, in only)
--   reason 'Returned from Production' → kind return (in only)
--   any other reason                  → kind adjustment; must be in Store Settings
create function public.store_adjust_stock(p_actor_id uuid, p_actor_name text, p_actor_role text, p_input jsonb) returns jsonb
  language plpgsql as $$
  declare
    v_store   public.store_departments%rowtype := app.store_the_store();
    v_today   date := app.karachi_business_date();
    v_date    date := coalesce(nullif(p_input->>'businessDate', '')::date, app.karachi_business_date());
    v_req     uuid := nullif(p_input->>'clientRequestId', '')::uuid;
    v_dir     text := p_input->>'direction';
    v_qty     numeric := nullif(p_input->>'qty', '')::numeric;
    v_reason  text := btrim(coalesce(p_input->>'reason', ''));
    v_note    text := nullif(btrim(coalesce(p_input->>'note', '')), '');
    v_kind    text;
    v_item    public.store_items%rowtype;
    v_adj     public.store_adjustments%rowtype;
    v_batch   public.store_batches%rowtype;
    v_cost    numeric(14,2);
    v_uc      numeric(14,4);
    v_found   uuid;
  begin
    if v_req is not null then
      select id into v_found from public.store_adjustments where client_request_id = v_req;
      if found then return (select to_jsonb(a) from public.store_adjustments a where a.id = v_found); end if;
    end if;
    if v_dir not in ('in', 'out') then raise exception 'Choose add or remove.' using errcode = '22023'; end if;
    if v_qty is null or v_qty <= 0 then raise exception 'Enter a quantity above 0.' using errcode = '22023'; end if;
    if v_date > v_today then raise exception 'The date can''t be in the future.' using errcode = '22023'; end if;
    if lower(v_reason) = 'opening stock' then
      v_kind := 'opening'; v_reason := 'Opening stock';
      if p_actor_role <> 'super_admin' then raise exception 'Only Admin records opening stock.' using errcode = 'P0001'; end if;
    elsif lower(v_reason) = 'returned from production' then
      v_kind := 'return'; v_reason := 'Returned from Production';
    else
      v_kind := 'adjustment';
      v_reason := app.store_assert_lookup('adjust_reason', v_reason, 'Reason');
    end if;
    if v_kind <> 'adjustment' and v_dir <> 'in' then raise exception '% only adds stock.', v_reason using errcode = '22023'; end if;
    if lower(v_reason) = 'other' and v_note is null then raise exception 'Describe the reason.' using errcode = '22023'; end if;
    if v_store.opening_date is not null and v_date < v_store.opening_date and v_kind <> 'opening' then
      raise exception 'The date is before the store went live (%).', v_store.opening_date using errcode = '22023';
    end if;

    select * into v_item from public.store_items where id = nullif(p_input->>'itemId', '')::uuid for update;
    if not found then raise exception 'Select an item.' using errcode = '22023'; end if;
    if not app.store_unit_allows_fraction(v_item.base_unit) and v_qty <> trunc(v_qty) then
      raise exception 'Whole % only.', lower(v_item.base_unit) using errcode = '22023';
    end if;
    if v_dir = 'out' and v_qty > v_item.available_qty then
      raise exception 'Only % % of % in store. Stock can''t go below zero.', v_item.available_qty, v_item.base_unit, v_item.name using errcode = 'P0001';
    end if;

    insert into public.store_adjustments (item_id, kind, direction, qty, reason, note, business_date, client_request_id, created_by, created_by_name)
    values (v_item.id, v_kind, v_dir, v_qty, v_reason, v_note, v_date, v_req, p_actor_id, p_actor_name)
    returning * into v_adj;

    if v_dir = 'out' then
      v_cost := app.store_drain_fifo(v_item.id, v_qty, null, v_adj.id);
      update public.store_adjustments set value = -v_cost where id = v_adj.id returning * into v_adj;
      perform app.store_move(v_item.id, -v_qty, 'adjustment', v_date, v_adj.adj_no,
        v_reason || coalesce(' · ' || v_note, ''), -v_cost, null, null, null, null, v_adj.id, p_actor_id, p_actor_name);
    else
      v_uc := coalesce(app.store_unit_price(v_item.id, v_date), 0);
      insert into public.store_batches (item_id, source, unit_cost, received_qty, remaining_qty, amount, received_at)
      values (v_item.id, v_kind, v_uc, v_qty, v_qty, round(v_qty * v_uc, 2), v_date)
      returning * into v_batch;
      update public.store_adjustments set value = v_batch.amount where id = v_adj.id returning * into v_adj;
      perform app.store_move(v_item.id, v_qty, v_kind, v_date, v_adj.adj_no,
        v_reason || coalesce(' · ' || v_note, ''), v_batch.amount, null, v_batch.id, null, null, v_adj.id, p_actor_id, p_actor_name);
    end if;
    perform app.store_audit('adjustment', v_adj.id, v_adj.adj_no, v_kind,
      format('%s %s%s %s · %s', v_item.name, case when v_dir = 'in' then '+' else '−' end, v_qty, v_item.base_unit, v_reason),
      p_actor_id, p_actor_name, null, null, p_actor_role);
    return to_jsonb(v_adj) || jsonb_build_object('item_name', v_item.name, 'item_no', v_item.item_no, 'base_unit', v_item.base_unit);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Production demand
-- ---------------------------------------------------------------------------

-- p_input: {requiredDate, remarks?, clientRequestId?, lines: [{itemId, qty, remarks?}]}
-- Only lines with a quantity are sent by the client; an empty or zero line is refused here.
create function public.store_create_demand(p_actor_id uuid, p_actor_name text, p_input jsonb) returns jsonb
  language plpgsql as $$
  declare
    v_store   public.store_departments%rowtype := app.store_the_store();
    v_today   date := app.karachi_business_date();
    v_req     uuid := nullif(p_input->>'clientRequestId', '')::uuid;
    v_reqd    date := nullif(p_input->>'requiredDate', '')::date;
    v_lines   jsonb := p_input->'lines';
    v_demand  public.store_demands%rowtype;
    v_item    public.store_items%rowtype;
    v_code    text;
    v_found   uuid;
    v_qty     numeric;
    r         record;
  begin
    if v_req is not null then
      select id into v_found from public.store_demands where client_request_id = v_req;
      if found then return app.store_demand_json(v_found); end if;
    end if;
    if v_reqd is null or v_reqd < v_today then raise exception 'The required date must be today or later.' using errcode = '22023'; end if;
    if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
      raise exception 'Add at least one item with a quantity.' using errcode = '22023';
    end if;
    select user_code into v_code from public.users where id = p_actor_id;

    insert into public.store_demands (store_id, demand_date, required_date, requested_by, requested_by_name, production_code, remarks, client_request_id)
    values (v_store.id, v_today, v_reqd, p_actor_id, p_actor_name, v_code, nullif(btrim(coalesce(p_input->>'remarks', '')), ''), v_req)
    returning * into v_demand;

    for r in select x.value as l, x.ordinality as n from jsonb_array_elements(v_lines) with ordinality x loop
      select * into v_item from public.store_items where id = nullif(r.l->>'itemId', '')::uuid;
      if not found then raise exception 'Line %: select a dry item.', r.n using errcode = '22023'; end if;
      if v_item.status <> 'active' then raise exception '% is inactive.', v_item.name using errcode = 'P0001'; end if;
      v_qty := nullif(r.l->>'qty', '')::numeric;
      if v_qty is null or v_qty <= 0 then raise exception '%: enter a quantity above 0.', v_item.name using errcode = '22023'; end if;
      if not app.store_unit_allows_fraction(v_item.base_unit) and v_qty <> trunc(v_qty) then
        raise exception '%: whole % only.', v_item.name, lower(v_item.base_unit) using errcode = '22023';
      end if;
      if exists (select 1 from public.store_demand_items where demand_id = v_demand.id and item_id = v_item.id) then
        raise exception '% is already on this demand.', v_item.name using errcode = '22023';
      end if;
      insert into public.store_demand_items (demand_id, line_no, item_id, item_name, unit, requested_qty, remarks)
      values (v_demand.id, r.n, v_item.id, v_item.name, v_item.base_unit, v_qty, nullif(btrim(coalesce(r.l->>'remarks', '')), ''));
    end loop;
    perform app.store_audit('demand', v_demand.id, v_demand.demand_no, 'created',
      format('%s line(s), needed by %s', jsonb_array_length(v_lines), v_reqd), p_actor_id, p_actor_name);
    return app.store_demand_json(v_demand.id);
  end;
  $$;

create function public.store_cancel_demand(p_actor_id uuid, p_actor_name text, p_actor_role text, p_id uuid) returns jsonb
  language plpgsql as $$
  declare v public.store_demands%rowtype;
  begin
    select * into v from public.store_demands where id = p_id for update;
    if not found then raise exception 'Demand not found.' using errcode = 'P0002'; end if;
    if p_actor_role <> 'super_admin' and v.requested_by is distinct from p_actor_id then
      raise exception 'Only the person who raised % can cancel it.', v.demand_no using errcode = 'P0001';
    end if;
    if v.cancelled_at is not null then raise exception '% is already cancelled.', v.demand_no using errcode = 'P0001'; end if;
    if exists (select 1 from public.store_demand_items where demand_id = p_id and status <> 'pending') then
      raise exception 'Store has already decided lines on %. It can no longer be cancelled.', v.demand_no using errcode = 'P0001';
    end if;
    update public.store_demands set cancelled_at = now(), cancelled_by = p_actor_id, cancelled_by_name = p_actor_name where id = p_id;
    perform app.store_refresh_demand(p_id);
    perform app.store_audit('demand', p_id, v.demand_no, 'cancelled', null, p_actor_id, p_actor_name, null, null, p_actor_role);
    return app.store_demand_json(p_id);
  end;
  $$;

-- Approve (p_qty: the full quantity when null, or less = a partial approval),
-- reject (p_reason required) or undo an approval nothing has been issued against.
-- An approval must fit in FREE stock: in store minus what is already approved.
create function public.store_decide_line(
  p_actor_id uuid, p_actor_name text, p_line_id uuid, p_decision text, p_qty numeric, p_reason text
) returns jsonb
  language plpgsql as $$
  declare
    v_line   public.store_demand_items%rowtype;
    v_dem    public.store_demands%rowtype;
    v_item   public.store_items%rowtype;
    v_qty    numeric;
    v_free   numeric;
    v_note   text := nullif(btrim(coalesce(p_reason, '')), '');
  begin
    select d.* into v_dem from public.store_demands d
      join public.store_demand_items l on l.demand_id = d.id where l.id = p_line_id
      for update of d;
    if not found then raise exception 'Demand line not found.' using errcode = 'P0002'; end if;
    if v_dem.cancelled_at is not null then raise exception '% was cancelled by Production.', v_dem.demand_no using errcode = 'P0001'; end if;
    select * into v_line from public.store_demand_items where id = p_line_id for update;
    select * into v_item from public.store_items where id = v_line.item_id for update;

    if p_decision = 'approve' then
      if v_line.status <> 'pending' then raise exception '% on % is already %.', v_line.item_name, v_dem.demand_no, v_line.status using errcode = 'P0001'; end if;
      v_qty := coalesce(p_qty, v_line.requested_qty);
      if v_qty <= 0 or v_qty > v_line.requested_qty then
        raise exception 'Approve between 0 and % %.', v_line.requested_qty, v_line.unit using errcode = '22023';
      end if;
      if not app.store_unit_allows_fraction(v_item.base_unit) and v_qty <> trunc(v_qty) then
        raise exception 'Whole % only.', lower(v_item.base_unit) using errcode = '22023';
      end if;
      v_free := v_item.available_qty - app.store_committed(v_item.id);
      if v_qty > v_free then
        raise exception 'Only % % of % is free (in store % minus % already approved). Approve less, reject it, or wait for receiving.',
          greatest(v_free, 0), v_item.base_unit, v_item.name, v_item.available_qty, v_item.available_qty - v_free using errcode = 'P0001';
      end if;
      if v_qty < v_line.requested_qty and v_note is null then
        raise exception 'Give Production a reason for approving less than requested.' using errcode = '22023';
      end if;
      update public.store_demand_items set
        status = 'approved', approved_qty = v_qty,
        unit_price = app.store_unit_price(v_item.id, app.karachi_business_date()),
        decision_note = v_note, decided_by = p_actor_id, decided_by_name = p_actor_name, decided_at = now()
       where id = p_line_id;
    elsif p_decision = 'reject' then
      if v_line.status <> 'pending' then raise exception '% on % is already %.', v_line.item_name, v_dem.demand_no, v_line.status using errcode = 'P0001'; end if;
      if v_note is null then raise exception 'Give Production a reason.' using errcode = '22023'; end if;
      update public.store_demand_items set
        status = 'rejected', approved_qty = 0, unit_price = null,
        decision_note = v_note, decided_by = p_actor_id, decided_by_name = p_actor_name, decided_at = now()
       where id = p_line_id;
    elsif p_decision = 'undo' then
      if v_line.status <> 'approved' or v_line.issued_qty > 0 then
        raise exception 'Only an approval with nothing issued yet can be undone.' using errcode = 'P0001';
      end if;
      update public.store_demand_items set
        status = 'pending', approved_qty = null, unit_price = null, decision_note = null,
        decided_by = null, decided_by_name = null, decided_at = null
       where id = p_line_id;
    else
      raise exception 'Unknown decision %.', p_decision using errcode = '22023';
    end if;
    perform app.store_refresh_demand(v_dem.id);
    perform app.store_audit('demand', v_dem.id, v_dem.demand_no, p_decision,
      format('%s%s%s', v_line.item_name, case when p_decision = 'approve' then format(' %s %s', v_qty, v_line.unit) else '' end,
             coalesce(' · ' || v_note, '')), p_actor_id, p_actor_name);
    return app.store_demand_json(v_dem.id);
  end;
  $$;

-- Approve, in full, every pending line free stock covers; leave the rest.
create function public.store_approve_all(p_actor_id uuid, p_actor_name text, p_demand_id uuid) returns jsonb
  language plpgsql as $$
  declare
    v_dem  public.store_demands%rowtype;
    l      record;
    v_item public.store_items%rowtype;
    v_ok   integer := 0;
    v_skip integer := 0;
    v_up   numeric;
  begin
    select * into v_dem from public.store_demands where id = p_demand_id for update;
    if not found then raise exception 'Demand not found.' using errcode = 'P0002'; end if;
    if v_dem.cancelled_at is not null then raise exception '% was cancelled by Production.', v_dem.demand_no using errcode = 'P0001'; end if;
    perform 1 from public.store_items
     where id in (select item_id from public.store_demand_items where demand_id = p_demand_id and status = 'pending')
     order by id for update;
    for l in select * from public.store_demand_items where demand_id = p_demand_id and status = 'pending' order by line_no loop
      select * into v_item from public.store_items where id = l.item_id;
      if l.requested_qty <= v_item.available_qty - app.store_committed(v_item.id) then
        v_up := app.store_unit_price(v_item.id, app.karachi_business_date());
        update public.store_demand_items set status = 'approved', approved_qty = l.requested_qty, unit_price = v_up,
          decided_by = p_actor_id, decided_by_name = p_actor_name, decided_at = now()
         where id = l.id;
        v_ok := v_ok + 1;
      else
        v_skip := v_skip + 1;
      end if;
    end loop;
    perform app.store_refresh_demand(p_demand_id);
    if v_ok > 0 then
      perform app.store_audit('demand', p_demand_id, v_dem.demand_no, 'approve all', format('%s approved, %s left', v_ok, v_skip), p_actor_id, p_actor_name);
    end if;
    return jsonb_build_object('demand', app.store_demand_json(p_demand_id), 'approved', v_ok, 'skipped', v_skip);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Issuing
-- ---------------------------------------------------------------------------

-- p_input: {demandId, receivedBy, remarks?, clientRequestId?, lines?: [{lineId, qty}]}
-- Without `lines`, every approved line is issued for what is left of its
-- approval. With them, a line may be issued in part. Batches drain FIFO.
create function public.store_issue_stock(p_actor_id uuid, p_actor_name text, p_input jsonb) returns jsonb
  language plpgsql as $$
  declare
    v_store   public.store_departments%rowtype := app.store_the_store();
    v_today   date := app.karachi_business_date();
    v_req     uuid := nullif(p_input->>'clientRequestId', '')::uuid;
    v_recv    text := nullif(btrim(coalesce(p_input->>'receivedBy', '')), '');
    v_dem     public.store_demands%rowtype;
    v_issue   public.store_issues%rowtype;
    v_line    public.store_demand_items%rowtype;
    v_item    public.store_items%rowtype;
    v_ii      public.store_issue_items%rowtype;
    v_found   uuid;
    v_plan    jsonb;
    r         record;
    v_qty     numeric;
    v_cost    numeric(14,2);
    v_total   numeric(14,2) := 0;
  begin
    if v_req is not null then
      select id into v_found from public.store_issues where client_request_id = v_req;
      if found then return app.store_issue_json(v_found); end if;
    end if;
    if v_recv is null then raise exception 'Enter who in Production received the items.' using errcode = '22023'; end if;
    select * into v_dem from public.store_demands where id = nullif(p_input->>'demandId', '')::uuid for update;
    if not found then raise exception 'Demand not found.' using errcode = 'P0002'; end if;
    if v_dem.cancelled_at is not null then raise exception '% was cancelled by Production.', v_dem.demand_no using errcode = 'P0001'; end if;

    if jsonb_typeof(p_input->'lines') = 'array' and jsonb_array_length(p_input->'lines') > 0 then
      v_plan := p_input->'lines';
    else
      select coalesce(jsonb_agg(jsonb_build_object('lineId', id, 'qty', approved_qty - issued_qty) order by line_no), '[]'::jsonb)
        into v_plan from public.store_demand_items
       where demand_id = v_dem.id and status = 'approved' and approved_qty > issued_qty;
    end if;
    if jsonb_array_length(v_plan) = 0 then raise exception 'Nothing on % is approved to issue.', v_dem.demand_no using errcode = 'P0001'; end if;

    perform 1 from public.store_items
     where id in (select l.item_id from public.store_demand_items l
                   where l.id in (select (x->>'lineId')::uuid from jsonb_array_elements(v_plan) x))
     order by id for update;

    insert into public.store_issues (demand_id, store_id, issue_date, issued_by, issued_by_name, received_by_name, remarks, client_request_id)
    values (v_dem.id, v_store.id, v_today, p_actor_id, p_actor_name, v_recv, nullif(btrim(coalesce(p_input->>'remarks', '')), ''), v_req)
    returning * into v_issue;

    for r in select x.value as p from jsonb_array_elements(v_plan) x loop
      select * into v_line from public.store_demand_items where id = nullif(r.p->>'lineId', '')::uuid and demand_id = v_dem.id for update;
      if not found then raise exception 'A line is not on %.', v_dem.demand_no using errcode = '22023'; end if;
      if v_line.status <> 'approved' then
        raise exception '% is % and can''t be issued. Only approved quantities are issued.', v_line.item_name, v_line.status using errcode = 'P0001';
      end if;
      v_qty := nullif(r.p->>'qty', '')::numeric;
      if v_qty is null or v_qty <= 0 or v_qty > v_line.approved_qty - v_line.issued_qty then
        raise exception '%: issue between 0 and % %.', v_line.item_name, v_line.approved_qty - v_line.issued_qty, v_line.unit using errcode = '22023';
      end if;
      select * into v_item from public.store_items where id = v_line.item_id;
      if v_qty > v_item.available_qty then
        raise exception 'Stock changed: % has only % % in store. Undo the approval and decide again.',
          v_item.name, v_item.available_qty, v_item.base_unit using errcode = 'P0001';
      end if;
      insert into public.store_issue_items (issue_id, demand_item_id, item_id, item_name, unit, issued_qty, unit_price)
      values (v_issue.id, v_line.id, v_item.id, v_item.name, v_item.base_unit, v_qty, v_line.unit_price)
      returning * into v_ii;
      v_cost := app.store_drain_fifo(v_item.id, v_qty, v_ii.id, null);
      update public.store_issue_items set cost_amount = v_cost where id = v_ii.id;
      perform app.store_move(v_item.id, -v_qty, 'issue', v_today, v_issue.issue_no,
        format('To Production for %s · received by %s', v_dem.demand_no, v_recv),
        -v_cost, null, null, v_issue.id, v_dem.id, null, p_actor_id, p_actor_name);
      update public.store_demand_items set
        issued_qty = issued_qty + v_qty,
        status = case when issued_qty + v_qty >= approved_qty then 'issued' else 'approved' end
       where id = v_line.id;
      v_total := v_total + v_cost;
    end loop;

    update public.store_issues set total_cost = v_total where id = v_issue.id;
    perform app.store_refresh_demand(v_dem.id);
    perform app.store_audit('issue', v_issue.id, v_issue.issue_no, 'issued',
      format('%s · %s line(s) · received by %s', v_dem.demand_no, jsonb_array_length(v_plan), v_recv), p_actor_id, p_actor_name);
    return app.store_issue_json(v_issue.id);
  end;
  $$;

-- Production confirms what arrived. p_lines: [{issueItemId, receivedQty}];
-- a line left out is taken as received in full. Any difference needs a note
-- and stays visible to Admin.
create function public.store_confirm_issue(p_actor_id uuid, p_actor_name text, p_issue_id uuid, p_lines jsonb, p_note text) returns jsonb
  language plpgsql as $$
  declare
    v_issue  public.store_issues%rowtype;
    l        record;
    v_rq     numeric;
    v_diff   boolean := false;
    v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  begin
    select * into v_issue from public.store_issues where id = p_issue_id for update;
    if not found then raise exception 'Issue not found.' using errcode = 'P0002'; end if;
    if v_issue.status <> 'issued' then raise exception '% is already confirmed.', v_issue.issue_no using errcode = 'P0001'; end if;
    for l in select * from public.store_issue_items where issue_id = p_issue_id for update loop
      select nullif(x->>'receivedQty', '')::numeric into v_rq
        from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x where (x->>'issueItemId')::uuid = l.id;
      v_rq := coalesce(v_rq, l.issued_qty);
      if v_rq < 0 or v_rq > l.issued_qty then
        raise exception '%: received must be between 0 and % %.', l.item_name, l.issued_qty, l.unit using errcode = '22023';
      end if;
      if v_rq <> l.issued_qty then v_diff := true; end if;
      update public.store_issue_items set received_qty = v_rq where id = l.id;
      update public.store_demand_items set received_qty = received_qty + v_rq where id = l.demand_item_id;
    end loop;
    if v_diff and v_note is null then raise exception 'Explain the difference between issued and received.' using errcode = '22023'; end if;
    update public.store_issues set
      status = case when v_diff then 'received_with_difference' else 'received' end,
      confirmed_by = p_actor_id, confirmed_by_name = p_actor_name, confirmed_at = now(), confirm_note = v_note
     where id = p_issue_id;
    perform app.store_refresh_demand(v_issue.demand_id);
    perform app.store_audit('issue', p_issue_id, v_issue.issue_no, case when v_diff then 'received with difference' else 'received' end,
      v_note, p_actor_id, p_actor_name);
    return app.store_issue_json(p_issue_id);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Read models: stock summary, item ledger, dashboard, reports
-- ---------------------------------------------------------------------------

-- Per item over [p_from, p_to]: Opening + Received + Returned − Issued ± Adjusted = Closing.
-- Opening is the balance before p_from plus any opening count inside the range.
create function public.store_stock_summary(p_from date, p_to date) returns jsonb
  language sql stable as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.name), '[]'::jsonb) from (
    select i.id, i.item_no, i.item_code, i.name, i.category, i.base_unit, i.purchase_unit, i.conversion_qty,
           i.min_stock, i.status, i.available_qty,
           coalesce(m.opening, 0) as opening, coalesce(m.received, 0) as received, coalesce(m.issued, 0) as issued,
           coalesce(m.adjusted, 0) as adjusted, coalesce(m.returned, 0) as returned,
           coalesce(m.opening, 0) + coalesce(m.received, 0) + coalesce(m.returned, 0) - coalesce(m.issued, 0) + coalesce(m.adjusted, 0) as closing,
           app.store_committed(i.id) as committed,
           (select count(*) from public.store_batches b where b.item_id = i.id and b.remaining_qty > 0) as active_batches,
           (select max(b.received_at) from public.store_batches b where b.item_id = i.id and b.source = 'receipt') as last_received,
           (select coalesce(sum(round(b.remaining_qty * b.unit_cost, 2)), 0) from public.store_batches b where b.item_id = i.id) as stock_value,
           app.store_unit_price(i.id, app.karachi_business_date()) as unit_price
      from public.store_items i
      left join lateral (
        select sum(mv.qty_delta) filter (where mv.business_date < p_from or (mv.type = 'opening' and mv.business_date >= p_from)) as opening,
               sum(mv.qty_delta) filter (where mv.type = 'receipt' and mv.business_date >= p_from) as received,
               -sum(mv.qty_delta) filter (where mv.type = 'issue' and mv.business_date >= p_from) as issued,
               sum(mv.qty_delta) filter (where mv.type = 'adjustment' and mv.business_date >= p_from) as adjusted,
               sum(mv.qty_delta) filter (where mv.type = 'return' and mv.business_date >= p_from) as returned
          from public.store_movements mv
         where mv.item_id = i.id and mv.business_date <= p_to
      ) m on true
  ) t;
  $$;

-- One item's movements over a range with a running balance in date order.
create function public.store_item_ledger(p_item uuid, p_from date, p_to date) returns jsonb
  language sql stable as $$
  with o as (
    select coalesce(sum(qty_delta), 0) as opening from public.store_movements where item_id = p_item and business_date < p_from
  ), r as (
    select mv.*, o.opening + sum(mv.qty_delta) over (order by mv.business_date, mv.created_at, mv.id) as running
      from public.store_movements mv cross join o
     where mv.item_id = p_item and mv.business_date between p_from and p_to
  )
  select jsonb_build_object(
    'opening', (select opening from o),
    'closing', (select opening from o) + coalesce((select sum(qty_delta) from r), 0),
    'total_in', coalesce((select sum(qty_delta) from r where qty_delta > 0), 0),
    'total_out', coalesce((select -sum(qty_delta) from r where qty_delta < 0), 0),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'business_date', business_date, 'type', type, 'ref_no', ref_no, 'detail', detail,
        'qty_delta', qty_delta, 'balance', running, 'value', value, 'created_by_name', created_by_name, 'created_at', created_at)
        order by business_date, created_at, id) from r), '[]'::jsonb));
  $$;

-- The dashboard in one call. p_period: 'day' | 'week' | 'month' (movement table grouping).
create function public.store_dashboard(p_from date, p_to date, p_period text) returns jsonb
  language sql stable as $$
  with today as (select app.karachi_business_date() as d),
  items as (
    select i.*, app.store_committed(i.id) as committed,
           (select coalesce(sum(round(b.remaining_qty * b.unit_cost, 2)), 0) from public.store_batches b where b.item_id = i.id) as value,
           app.store_unit_price(i.id, (select d from today)) as unit_price
      from public.store_items i
  ),
  lines as (
    select l.*, d.demand_no, d.required_date from public.store_demand_items l
      join public.store_demands d on d.id = l.demand_id where d.cancelled_at is null
  ),
  grp as (
    select case p_period when 'month' then date_trunc('month', x.business_date)::date
                         when 'week'  then date_trunc('week', x.business_date)::date
                         else x.business_date end as k, x.*
      from public.store_movements x where x.business_date between p_from and p_to
  )
  select jsonb_build_object(
    'business_date', (select d from today),
    'items_active', (select count(*) from items where status = 'active'),
    'items_inactive', (select count(*) from items where status = 'inactive'),
    'items_in_stock', (select count(*) from items where available_qty > 0),
    'stock_value', (select coalesce(sum(value), 0) from items),
    'committed_value', (select coalesce(sum(round(committed * coalesce(unit_price, 0), 2)), 0) from items),
    'received_today', (select jsonb_build_object('amount', coalesce(sum(r.total_amount), 0), 'receipts', count(*),
                         'lines', coalesce(sum((select count(*) from public.store_batches b where b.receipt_id = r.id)), 0))
                         from public.store_receipts r where r.receipt_date = (select d from today)),
    'issued_today', (select jsonb_build_object('value', coalesce(sum(si.cost_amount), 0), 'lines', count(si.*))
                       from public.store_issue_items si join public.store_issues s on s.id = si.issue_id
                      where s.issue_date = (select d from today)),
    'pending', (select jsonb_build_object('lines', count(*), 'demands', count(distinct demand_id)) from lines where status = 'pending'),
    'approved', (select jsonb_build_object('lines', count(*), 'demands', count(distinct demand_id)) from lines where status = 'approved'),
    'rejected', (select jsonb_build_object('lines', count(*), 'demands', count(distinct demand_id)) from lines l
                  where l.status = 'rejected' and l.decided_at::date between p_from and p_to),
    'low', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'item_no', item_no, 'name', name, 'base_unit', base_unit,
                       'min_stock', min_stock, 'available_qty', available_qty) order by available_qty / nullif(min_stock, 0), name)
                       from items where status = 'active' and available_qty <= min_stock and available_qty > 0), '[]'::jsonb),
    'out_of_stock', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'item_no', item_no, 'name', name, 'base_unit', base_unit,
                       'min_stock', min_stock, 'available_qty', available_qty) order by name)
                       from items where status = 'active' and available_qty <= 0), '[]'::jsonb),
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'demand_no', d.demand_no, 'status', d.status,
                       'required_date', d.required_date, 'lines', (select count(*) from public.store_demand_items l where l.demand_id = d.id))
                       order by d.required_date, d.demand_no)
                       from public.store_demands d where d.status in ('pending_review', 'ready_to_issue')), '[]'::jsonb),
    'movement', coalesce((select jsonb_agg(row_to_json(m)::jsonb order by m.k desc) from (
                       select k,
                              coalesce(sum(value) filter (where type = 'receipt'), 0) as received,
                              count(*) filter (where type = 'receipt') as received_lines,
                              coalesce(-sum(value) filter (where type = 'issue'), 0) as issued,
                              count(*) filter (where type = 'issue') as issued_lines,
                              coalesce(sum(value) filter (where type in ('adjustment', 'opening', 'return')), 0) as adjusted
                         from grp group by k) m), '[]'::jsonb),
    'consumption', coalesce((select jsonb_agg(row_to_json(c)::jsonb order by c.value desc, c.name) from (
                       select i.id, i.item_no, i.name, i.base_unit,
                              sum(si.issued_qty) as qty, count(distinct s.issue_date) as days,
                              max(s.issue_date) as last_issued, sum(si.cost_amount) as value
                         from public.store_issue_items si
                         join public.store_issues s on s.id = si.issue_id
                         join public.store_items i on i.id = si.item_id
                        where s.issue_date between p_from and p_to
                        group by i.id) c), '[]'::jsonb)
  );
  $$;

-- Operational reports (never Finance). Each returns {rows: [...]}; the API
-- names the columns. p_item narrows to one item where it applies.
create function public.store_report(p_type text, p_from date, p_to date, p_item uuid) returns jsonb
  language plpgsql stable as $$
  declare v jsonb;
  begin
    if p_type in ('daily_receiving', 'purchase_price_history') then
      select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.receipt_date, t.receipt_no, t.line_no), '[]'::jsonb) into v from (
        select r.receipt_date, r.receipt_no, r.supplier_name, r.invoice_no, b.line_no, i.item_no, i.item_code, i.name as item_name,
               b.package_name, b.package_qty, b.packages, b.received_qty, i.base_unit, b.list_price, b.price_per_package,
               b.unit_cost, b.amount, b.override_reason, b.batch_no, b.supplier_batch_no, b.expiry_date, b.remaining_qty, r.received_by_name
          from public.store_batches b join public.store_receipts r on r.id = b.receipt_id join public.store_items i on i.id = b.item_id
         where r.receipt_date between p_from and p_to and (p_item is null or b.item_id = p_item)) t;
    elsif p_type = 'monthly_receiving' then
      select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.month, t.item_name), '[]'::jsonb) into v from (
        select to_char(r.receipt_date, 'YYYY-MM') as month, i.item_no, i.name as item_name, i.base_unit,
               count(distinct r.id) as receipts, sum(b.received_qty) as received_qty, sum(b.amount) as amount,
               round(sum(b.amount) / nullif(sum(b.received_qty), 0), 4) as avg_unit_cost
          from public.store_batches b join public.store_receipts r on r.id = b.receipt_id join public.store_items i on i.id = b.item_id
         where r.receipt_date between p_from and p_to and (p_item is null or b.item_id = p_item)
         group by 1, i.id) t;
    elsif p_type in ('item_stock', 'stock_valuation') then
      select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v
        from jsonb_array_elements(public.store_stock_summary(p_from, p_to)) x
       where p_item is null or (x->>'id')::uuid = p_item;
    elsif p_type in ('production_demand', 'approved_demand') then
      select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.demand_date, t.demand_no, t.line_no), '[]'::jsonb) into v from (
        select d.demand_date, d.demand_no, d.required_date, d.production_code, d.requested_by_name, d.status as demand_status,
               l.line_no, i.item_no, l.item_name, l.unit, l.requested_qty, l.status,
               coalesce(l.approved_qty, 0) as approved_qty,
               case when l.status = 'pending' then 0 else l.requested_qty - coalesce(l.approved_qty, 0) end as rejected_qty,
               l.issued_qty, l.received_qty, coalesce(l.approved_qty, 0) - l.issued_qty as remaining_qty,
               coalesce(l.unit_price, app.store_unit_price(l.item_id, d.demand_date)) as unit_price,
               round(coalesce(case when l.status = 'pending' then l.requested_qty else l.approved_qty end, 0)
                     * coalesce(l.unit_price, app.store_unit_price(l.item_id, d.demand_date), 0), 2) as demand_amount,
               l.decision_note, l.decided_by_name
          from public.store_demand_items l join public.store_demands d on d.id = l.demand_id join public.store_items i on i.id = l.item_id
         where d.demand_date between p_from and p_to and (p_item is null or l.item_id = p_item)
           and (p_type = 'production_demand' or coalesce(l.approved_qty, 0) > 0)) t;
    elsif p_type = 'stock_issuance' then
      select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.issue_date, t.issue_no, t.item_name), '[]'::jsonb) into v from (
        select s.issue_date, s.issue_no, d.demand_no, d.production_code, i.item_no, si.item_name, si.unit,
               l.approved_qty, si.issued_qty, si.received_qty, si.received_qty - si.issued_qty as difference_qty,
               si.cost_amount, round(si.issued_qty * coalesce(si.unit_price, 0), 2) as demand_value,
               (select string_agg(b.batch_no || ' (' || a.qty || ')', ', ' order by b.received_at, b.created_at)
                  from public.store_batch_allocations a join public.store_batches b on b.id = a.batch_id where a.issue_item_id = si.id) as batches,
               s.issued_by_name, s.received_by_name, s.status, s.confirmed_by_name, s.confirm_note
          from public.store_issue_items si join public.store_issues s on s.id = si.issue_id
          join public.store_demands d on d.id = s.demand_id join public.store_demand_items l on l.id = si.demand_item_id
          join public.store_items i on i.id = si.item_id
         where s.issue_date between p_from and p_to and (p_item is null or si.item_id = p_item)) t;
    elsif p_type = 'remaining_stock' then
      select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.item_name, t.received_at), '[]'::jsonb) into v from (
        select i.item_no, i.name as item_name, i.base_unit, b.batch_no, b.source, b.received_at, b.supplier_batch_no, b.expiry_date,
               b.received_qty, b.remaining_qty, b.unit_cost, round(b.remaining_qty * b.unit_cost, 2) as value
          from public.store_batches b join public.store_items i on i.id = b.item_id
         where b.remaining_qty > 0 and (p_item is null or b.item_id = p_item)) t;
    elsif p_type = 'stock_adjustment' then
      select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.business_date, t.adj_no), '[]'::jsonb) into v from (
        select a.business_date, a.adj_no, i.item_no, i.name as item_name, i.base_unit, a.kind, a.direction,
               case when a.direction = 'in' then a.qty else -a.qty end as qty, a.reason, a.note, a.value, a.created_by_name
          from public.store_adjustments a join public.store_items i on i.id = a.item_id
         where a.business_date between p_from and p_to and (p_item is null or a.item_id = p_item)) t;
    else
      raise exception 'Unknown report %.', p_type using errcode = '22023';
    end if;
    return jsonb_build_object('rows', v);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Grants (the API connects as mb_api, a member of service_role)
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.store_departments, public.store_accounts, public.store_lookups, public.store_audit_events,
                 public.store_items, public.store_item_prices, public.store_receipts, public.store_batches,
                 public.store_demands, public.store_demand_items, public.store_issues, public.store_issue_items,
                 public.store_adjustments, public.store_batch_allocations, public.store_movements,
                 public.store_queries, public.store_query_messages
      to service_role;
  end if;
end; $$;
