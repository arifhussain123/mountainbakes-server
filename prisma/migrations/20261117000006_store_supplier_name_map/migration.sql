-- The mapping Phase 2's supplier dedupe writes: each distinct free-text receipt
-- supplier name → the master supplier it resolved to. Kept so the pass is
-- auditable and reversible, and so re-running is idempotent. The receipts' own
-- supplier_name text is NEVER rewritten — the dedupe only fills a null
-- supplier_id (see src/scripts/store-supplier-dedupe.ts).
create table public.store_supplier_name_map (
  id               uuid primary key default gen_random_uuid(),
  normalized_name  text not null unique,
  raw_name         text not null,
  supplier_id      uuid not null references public.suppliers (id) on delete restrict,
  created_supplier boolean not null default false,
  receipts_linked  integer not null default 0,
  created_at       timestamptz not null default now()
);
