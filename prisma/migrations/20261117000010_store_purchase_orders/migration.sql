-- Phase 3 — Purchase Orders (behind the `purchase_orders` feature). A PO does
-- NOT move stock (Receiving does, against the PO), so these are plain tables;
-- the status machine and totals live in the service layer. Numbering: PO-000001.
--
-- Status flow: draft → pending_approval → approved → sent → partially_received
-- → received → closed, plus cancelled. partially_received/received are set by
-- Receiving v2; short_close closes a sent/partly-received PO early with a reason.
create table public.store_purchase_orders (
  id                 uuid primary key default gen_random_uuid(),
  po_no              text not null unique default app.next_store_number('store_po', 'PO'),
  store_id           uuid not null references public.store_departments (id) on delete restrict,
  supplier_id        uuid not null references public.suppliers (id) on delete restrict,
  order_date         date not null,
  expected_date      date,
  status             text not null default 'draft' check (status in (
                       'draft', 'pending_approval', 'approved', 'sent',
                       'partially_received', 'received', 'closed', 'cancelled')),
  notes              text,
  total_amount       numeric(14,2) not null default 0,
  cancel_reason      text,
  short_close_reason text,
  created_by         uuid references public.users (id) on delete set null,
  created_by_name    text,
  approved_by        uuid references public.users (id) on delete set null,
  approved_by_name   text,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger store_purchase_orders_touch before update on public.store_purchase_orders
  for each row execute function app.touch_updated_at();
create index store_purchase_orders_status_idx on public.store_purchase_orders (status, order_date desc);
create index store_purchase_orders_supplier_idx on public.store_purchase_orders (supplier_id);

create table public.store_purchase_order_lines (
  id                 uuid primary key default gen_random_uuid(),
  po_id              uuid not null references public.store_purchase_orders (id) on delete cascade,
  line_no            integer not null,
  item_id            uuid not null references public.store_items (id) on delete restrict,
  item_name          text not null,
  package_name       text not null,
  package_qty        numeric(14,3) not null check (package_qty > 0),
  qty_packages       numeric(14,3) not null check (qty_packages > 0),
  -- Expected price of ONE package (from Price Control / supplier), editable by Finance/Admin.
  expected_price     numeric(14,2) not null default 0,
  -- How many BASE units have been received against this line (Receiving updates it).
  received_qty_base  numeric(14,3) not null default 0 check (received_qty_base >= 0),
  line_total         numeric(14,2) not null default 0,
  unique (po_id, line_no)
);
create index store_po_lines_po_idx on public.store_purchase_order_lines (po_id);
create index store_po_lines_item_idx on public.store_purchase_order_lines (item_id);
