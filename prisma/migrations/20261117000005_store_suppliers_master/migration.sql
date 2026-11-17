-- Suppliers master (Phase 2). The owner chose to REUSE the shared
-- public.suppliers table as the single supplier list for both the Store and
-- WhatsApp Purchasing, rather than a separate store_suppliers table.
--
-- WhatsApp Purchasing created this table WhatsApp-first (whatsapp_number NOT
-- NULL). A store supplier (a cash-paid flour mill) may have no WhatsApp, so the
-- column becomes optional. The WhatsApp module still requires it in its own
-- SupplierInputSchema (apps-layer), so its registration flow is unchanged. The
-- existing CHECK `whatsapp_number ~ '^\+...'` passes on NULL, so it stays.
alter table public.suppliers alter column whatsapp_number drop not null;

-- Fields the Store master needs beyond what WhatsApp Purchasing set
-- (it already has contact_person, phone, category, address, payment_terms, notes).
alter table public.suppliers
  add column if not exists email           text,
  add column if not exists ntn             text,
  add column if not exists strn            text,
  add column if not exists lead_time_days  integer check (lead_time_days is null or lead_time_days >= 0);
