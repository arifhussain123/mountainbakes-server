-- Items v2 — item barcodes (behind the `barcodes` feature). A barcode maps to
-- one item (optionally a specific package) so a scan on Receiving/Issue resolves
-- the line. `code` is unique across the store so a scan is unambiguous.
create table public.store_item_barcodes (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.store_items (id) on delete cascade,
  package_id  uuid references public.store_item_packages (id) on delete set null,
  code        text not null check (btrim(code) <> ''),
  type        text not null default 'ean' check (type in ('ean', 'upc', 'qr', 'code128', 'other')),
  created_at  timestamptz not null default now(),
  unique (code)
);
create index store_item_barcodes_item_idx on public.store_item_barcodes (item_id);
