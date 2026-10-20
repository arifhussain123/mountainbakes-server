-- WhatsApp Purchasing: Production buys ingredients and supplies from outside
-- suppliers over the one authorized Production WhatsApp Business number.
--
--   demand ──► supplier quotation (versioned) ──► Production approves ONE version
--          ──► supplier bill ──► Production approves the bill
--          ──► delivery (Bykea / inDrive / Yango / other / self pickup)
--          ──► goods receipt ──► ingredient stock
--          ──► payments (Finance approves, posts a PV) and supplier credit
--
-- THE RULES THIS SCHEMA HOLDS, whatever the API does:
--
--   * A demand is not a purchase, an approved quotation is not a delivery, a
--     supplier bill is not a payment, and a recorded payment is not a receipt.
--     Each is its own table with its own status, and nothing moves stock or
--     money until the step that owns it runs.
--   * Every quotation is a new VERSION; nothing a supplier sent is overwritten.
--     An approval names one version. A newer version supersedes it and the
--     demand needs approving again.
--   * Ingredient stock moves only from a goods receipt (or a reasoned manual
--     adjustment), one movement per receipt line, held unique so a retried
--     receipt cannot count twice.
--   * Money reaches the Finance ledger only when Finance approves a payment:
--     public.post_finance_ledger_entry, source 'vendor_payment', the same path
--     every other finance document posts through. A reversal is a second,
--     opposite entry, never an edit or a delete.
--   * WhatsApp calls never happen inside a transaction. A function that needs a
--     message sent writes a whatsapp_messages row and a whatsapp_outbox row in
--     the same transaction as the business change; a worker sends it after
--     commit (src/services/whatsapp/outbox.ts).
--   * Supplier links carry a random token; only its SHA-256 is stored.
--
-- Status columns are text with CHECK constraints rather than enums, so a later
-- state can be added in the same migration that uses it.
--
-- Every function that changes a demand locks its row first (`for update`), so
-- two approvals, or a supplier revision racing an approval, serialise on it.
-- ---------------------------------------------------------------------------

-- The ledger source for supplier payments. Not used by anything else in this
-- file: an enum value added in a transaction cannot be used in that same
-- transaction, and the functions below only reference it at run time.
alter type public.finance_ledger_source add value if not exists 'vendor_payment';

alter type public.notification_type add value if not exists 'purchase_quotation';
alter type public.notification_type add value if not exists 'purchase_bill';
alter type public.notification_type add value if not exists 'purchase_message';
alter type public.notification_type add value if not exists 'purchase_payment';
alter type public.notification_type add value if not exists 'purchase_payment_reviewed';

-- Document numbers (app.next_finance_number refuses a missing counter).
insert into public.counters (id, count) values
  ('supplier',               0),
  ('purchase_item',          0),
  ('purchase_receipt',       0),
  ('supplier_payment',       0),
  ('supplier_credit',        0),
  ('ingredient_stock_move',  0)
on conflict (id) do nothing;

-- The head a supplier payment posts under unless Finance picks another.
-- Already in the live book (seeded with the finance module); here for a fresh
-- database.
insert into public.ledger_heads (code, name, type, group_name, is_system, sort_order)
values ('EXP-RAW-MATERIALS', 'Raw Materials', 'expense', 'Operations', false, 170)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Suppliers and the ingredient catalog
-- ---------------------------------------------------------------------------

create table public.suppliers (
  id                      uuid primary key default gen_random_uuid(),
  supplier_code           text not null unique default app.next_finance_number('supplier', 'SPL'),
  name                    text not null check (btrim(name) <> ''),
  contact_person          text,
  -- E.164 (+923001234567). Normalised by the API; the CHECK is the backstop.
  whatsapp_number         text not null check (whatsapp_number ~ '^\+[1-9][0-9]{7,14}$'),
  phone                   text,
  category                text,
  address                 text,
  payment_terms           text,
  notes                   text,
  is_active               boolean not null default true,
  -- WhatsApp requires the business to hold the recipient's opt-in before it
  -- starts a conversation. Recorded when the supplier is registered.
  whatsapp_opt_in_at      timestamptz,
  whatsapp_opt_in_source  text,
  created_by              uuid references public.users (id) on delete set null,
  created_by_name         text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  deleted_by              uuid references public.users (id) on delete set null,
  deleted_by_name         text,
  delete_reason           text
);
create trigger suppliers_touch before update on public.suppliers
  for each row execute function app.touch_updated_at();
-- One live supplier per WhatsApp number: an inbound message must map to one.
create unique index suppliers_whatsapp_live on public.suppliers (whatsapp_number) where deleted_at is null;
create index suppliers_name_idx on public.suppliers (lower(name)) where deleted_at is null;

create table public.purchase_items (
  id               uuid primary key default gen_random_uuid(),
  item_code        text not null unique default app.next_finance_number('purchase_item', 'PIT'),
  name             text not null check (btrim(name) <> ''),
  unit             text not null check (unit in ('kg', 'g', 'l', 'ml', 'pcs', 'dozen', 'pack', 'box', 'bag', 'tray', 'bottle', 'can', 'carton')),
  category         text,
  is_active        boolean not null default true,
  created_by       uuid references public.users (id) on delete set null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger purchase_items_touch before update on public.purchase_items
  for each row execute function app.touch_updated_at();
create unique index purchase_items_name_unit on public.purchase_items (lower(name), unit);

-- Balance per item. Written only by app.apply_ingredient_movement.
create table public.ingredient_stock (
  item_id     uuid primary key references public.purchase_items (id) on delete restrict,
  balance     numeric(14,3) not null default 0,
  updated_at  timestamptz not null default now()
);

create table public.ingredient_stock_movements (
  id               uuid primary key default gen_random_uuid(),
  movement_no      text not null unique default app.next_finance_number('ingredient_stock_move', 'ISM'),
  item_id          uuid not null references public.purchase_items (id) on delete restrict,
  item_name        text not null,
  unit             text not null,
  type             text not null check (type in ('receipt', 'adjustment')),
  delta            numeric(14,3) not null check (delta <> 0),
  balance_after    numeric(14,3) not null,
  demand_id        uuid,
  receipt_id       uuid,
  -- One movement per receipt line, ever: the duplicate-receipt guard.
  receipt_item_id  uuid unique,
  reason           text,
  business_date    date not null,
  created_by       uuid references public.users (id) on delete set null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  check (type <> 'receipt' or receipt_item_id is not null),
  check (type <> 'adjustment' or nullif(btrim(coalesce(reason, '')), '') is not null)
);
create index ingredient_moves_item_idx on public.ingredient_stock_movements (item_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Demands
-- ---------------------------------------------------------------------------

create table public.purchase_demands (
  id                        uuid primary key default gen_random_uuid(),
  demand_no                 text not null unique,
  status                    text not null default 'draft' check (status in (
                              'draft', 'verified', 'awaiting_supplier', 'quotation_received',
                              'changes_requested', 'rejected', 'awaiting_supplier_bill',
                              'bill_submitted', 'awaiting_delivery', 'partially_received',
                              'received', 'cancelled')),
  priority                  text not null check (priority in ('urgent', 'normal')),
  required_date             date not null,
  supplier_id               uuid not null references public.suppliers (id) on delete restrict,
  supplier_name             text not null,
  supplier_whatsapp         text not null,
  notes                     text,
  delivery_instructions     text,
  -- What Production intends to pay with. A preference, not a payment.
  payment_preference        text not null default 'cash' check (payment_preference in ('cash', 'easypaisa', 'bank', 'credit')),
  credit_reference          text,
  credit_amount_requested   numeric(14,2) check (credit_amount_requested is null or credit_amount_requested >= 0),
  credit_terms              text,
  credit_due_date           date,
  credit_notes              text,
  -- Independent of `status`: money and delivery move on their own clocks.
  payment_status            text not null default 'unpaid' check (payment_status in ('unpaid', 'partially_paid', 'paid')),
  delivery_status           text not null default 'not_booked' check (delivery_status in ('not_booked', 'booked', 'dispatched', 'delivered')),
  current_quotation_id      uuid,
  approved_quotation_id     uuid,
  approved_bill_id          uuid,
  -- The client's id for the create call: a retried create returns the first.
  client_request_id         text unique,
  -- Bumped on every change to the demand or its items. Verify records the
  -- revision it checked; Send refuses a demand edited since.
  revision                  integer not null default 1,
  verified_revision         integer,
  verified_at               timestamptz,
  verified_by               uuid references public.users (id) on delete set null,
  verified_by_name          text,
  sent_at                   timestamptz,
  sent_by                   uuid references public.users (id) on delete set null,
  sent_by_name              text,
  closed_reason             text,
  closed_at                 timestamptz,
  closed_by                 uuid references public.users (id) on delete set null,
  closed_by_name            text,
  created_by                uuid references public.users (id) on delete set null,
  created_by_name           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create trigger purchase_demands_touch before update on public.purchase_demands
  for each row execute function app.touch_updated_at();
create index purchase_demands_status_idx on public.purchase_demands (status, created_at desc);
create index purchase_demands_supplier_idx on public.purchase_demands (supplier_id, created_at desc);
create index purchase_demands_created_idx on public.purchase_demands (created_at desc);

create table public.purchase_demand_items (
  id             uuid primary key default gen_random_uuid(),
  demand_id      uuid not null references public.purchase_demands (id) on delete cascade,
  line_no        integer not null,
  item_id        uuid references public.purchase_items (id) on delete restrict,
  item_name      text not null check (btrim(item_name) <> ''),
  item_code      text,
  requested_qty  numeric(14,3) not null check (requested_qty > 0),
  unit           text not null,
  note           text,
  unique (demand_id, line_no)
);

-- The demand's history: every transition, decision, note and message hook.
-- Append-only, like the finance audit tables.
create table public.purchase_demand_events (
  id            uuid primary key default gen_random_uuid(),
  demand_id     uuid not null references public.purchase_demands (id) on delete cascade,
  event         text not null,
  from_status   text,
  to_status     text,
  actor_type    text not null check (actor_type in ('staff', 'supplier', 'system')),
  actor_id      uuid,
  actor_name    text,
  quotation_id  uuid,
  bill_id       uuid,
  reason        text,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index purchase_demand_events_idx on public.purchase_demand_events (demand_id, created_at);

create function app.purchase_events_append_only() returns trigger
  language plpgsql as $$
  begin
    -- A demand is never deleted (it is cancelled), so the cascade never fires
    -- in practice; refusing it here keeps the history as permanent as the rest.
    raise exception '% rows are append-only', tg_table_name;
  end;
  $$;
create trigger purchase_demand_events_append_only before update or delete on public.purchase_demand_events
  for each row execute function app.purchase_events_append_only();
create trigger ingredient_stock_movements_append_only before update or delete on public.ingredient_stock_movements
  for each row execute function app.purchase_events_append_only();

-- ---------------------------------------------------------------------------
-- Quotations (versioned) and bills
-- ---------------------------------------------------------------------------

create table public.purchase_quotations (
  id                       uuid primary key default gen_random_uuid(),
  demand_id                uuid not null references public.purchase_demands (id) on delete restrict,
  version                  integer not null,
  status                   text not null default 'submitted' check (status in ('submitted', 'changes_requested', 'approved', 'rejected', 'superseded')),
  submitted_via            text not null check (submitted_via in ('portal', 'staff')),
  -- Staff who keyed in a quotation the supplier sent as a plain message.
  entered_by               uuid references public.users (id) on delete set null,
  entered_by_name          text,
  subtotal                 numeric(14,2) not null check (subtotal >= 0),
  delivery_charge          numeric(14,2) not null default 0 check (delivery_charge >= 0),
  total                    numeric(14,2) not null check (total >= 0),
  estimated_delivery_date  date,
  delivery_notes           text,
  notes                    text,
  submitted_at             timestamptz not null default now(),
  decided_by               uuid references public.users (id) on delete set null,
  decided_by_name          text,
  decided_at               timestamptz,
  decision_reason          text,
  client_request_id        text unique,
  unique (demand_id, version)
);
create index purchase_quotations_demand_idx on public.purchase_quotations (demand_id, version desc);

create table public.purchase_quotation_items (
  id                             uuid primary key default gen_random_uuid(),
  quotation_id                   uuid not null references public.purchase_quotations (id) on delete cascade,
  line_no                        integer not null,
  -- Null for an item the supplier proposed that was not asked for.
  demand_item_id                 uuid references public.purchase_demand_items (id) on delete restrict,
  substitute_for_demand_item_id  uuid references public.purchase_demand_items (id) on delete restrict,
  item_name                      text not null check (btrim(item_name) <> ''),
  unit                           text not null,
  requested_qty                  numeric(14,3),
  available_qty                  numeric(14,3) not null check (available_qty >= 0),
  unit_rate                      numeric(14,2) not null check (unit_rate >= 0),
  line_total                     numeric(14,2) not null check (line_total >= 0),
  availability                   text not null check (availability in ('available', 'partial', 'unavailable', 'substitute')),
  note                           text,
  unique (quotation_id, line_no),
  check (availability <> 'unavailable' or available_qty = 0),
  check (availability <> 'substitute' or demand_item_id is null)
);

create table public.purchase_bills (
  id                         uuid primary key default gen_random_uuid(),
  demand_id                  uuid not null references public.purchase_demands (id) on delete restrict,
  quotation_id               uuid not null references public.purchase_quotations (id) on delete restrict,
  quotation_version          integer not null,
  supplier_bill_no           text not null check (btrim(supplier_bill_no) <> ''),
  status                     text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  submitted_via              text not null check (submitted_via in ('portal', 'staff')),
  entered_by                 uuid references public.users (id) on delete set null,
  entered_by_name            text,
  invoice_date               date not null,
  delivery_date              date,
  subtotal                   numeric(14,2) not null check (subtotal >= 0),
  delivery_charge            numeric(14,2) not null default 0 check (delivery_charge >= 0),
  discount                   numeric(14,2) not null default 0 check (discount >= 0),
  other_charges              numeric(14,2) not null default 0 check (other_charges >= 0),
  other_charges_note         text,
  grand_total                numeric(14,2) not null check (grand_total >= 0),
  -- What the supplier SAYS about payment. A claim, shown as one; payments are
  -- supplier_payments, recorded by Mountain Bakes.
  supplier_payment_method    text,
  supplier_stated_paid       numeric(14,2) not null default 0 check (supplier_stated_paid >= 0),
  notes                      text,
  differs_from_quotation     boolean not null default false,
  differences                jsonb not null default '[]'::jsonb,
  accepted_differences       boolean not null default false,
  submitted_at               timestamptz not null default now(),
  decided_by                 uuid references public.users (id) on delete set null,
  decided_by_name            text,
  decided_at                 timestamptz,
  decision_reason            text,
  client_request_id          text unique,
  check (grand_total = subtotal + delivery_charge + other_charges - discount)
);
-- One bill under review and one approved bill per demand, at most.
create unique index purchase_bills_one_open on public.purchase_bills (demand_id) where status = 'submitted';
create unique index purchase_bills_one_approved on public.purchase_bills (demand_id) where status = 'approved';

create table public.purchase_bill_items (
  id                 uuid primary key default gen_random_uuid(),
  bill_id            uuid not null references public.purchase_bills (id) on delete cascade,
  line_no            integer not null,
  quotation_item_id  uuid references public.purchase_quotation_items (id) on delete restrict,
  item_name          text not null,
  unit               text not null,
  qty                numeric(14,3) not null check (qty > 0),
  unit_rate          numeric(14,2) not null check (unit_rate >= 0),
  line_total         numeric(14,2) not null check (line_total >= 0),
  unique (bill_id, line_no)
);

-- ---------------------------------------------------------------------------
-- Delivery, receipt
-- ---------------------------------------------------------------------------

create table public.purchase_deliveries (
  id                uuid primary key default gen_random_uuid(),
  demand_id         uuid not null unique references public.purchase_demands (id) on delete restrict,
  -- No booking API is called for any of these: the reference is typed in.
  provider          text not null check (provider in ('bykea', 'indrive', 'yango', 'other', 'self_pickup')),
  provider_name     text,
  booking_reference text,
  estimated_fee     numeric(14,2) check (estimated_fee is null or estimated_fee >= 0),
  actual_fee        numeric(14,2) check (actual_fee is null or actual_fee >= 0),
  fee_paid_by       text not null default 'mountain_bakes' check (fee_paid_by in ('mountain_bakes', 'supplier')),
  pickup_details    text,
  delivery_notes    text,
  status            text not null default 'booked' check (status in ('booked', 'dispatched', 'delivered')),
  dispatched_at     timestamptz,
  delivered_at      timestamptz,
  received_by_name  text,
  updated_by        uuid references public.users (id) on delete set null,
  updated_by_name   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger purchase_deliveries_touch before update on public.purchase_deliveries
  for each row execute function app.touch_updated_at();

create table public.purchase_receipts (
  id                 uuid primary key default gen_random_uuid(),
  receipt_no         text not null unique default app.next_finance_number('purchase_receipt', 'GRN'),
  demand_id          uuid not null references public.purchase_demands (id) on delete restrict,
  bill_id            uuid not null references public.purchase_bills (id) on delete restrict,
  business_date      date not null,
  is_final           boolean not null default false,
  received_by        uuid references public.users (id) on delete set null,
  received_by_name   text,
  received_at        timestamptz not null default now(),
  notes              text,
  client_request_id  text unique
);
create index purchase_receipts_demand_idx on public.purchase_receipts (demand_id);

create table public.purchase_receipt_items (
  id                uuid primary key default gen_random_uuid(),
  receipt_id        uuid not null references public.purchase_receipts (id) on delete cascade,
  bill_item_id      uuid not null references public.purchase_bill_items (id) on delete restrict,
  item_id           uuid not null references public.purchase_items (id) on delete restrict,
  item_name         text not null,
  unit              text not null,
  received_qty      numeric(14,3) not null check (received_qty >= 0),
  damaged_qty       numeric(14,3) not null default 0 check (damaged_qty >= 0),
  accepted_qty      numeric(14,3) generated always as (received_qty - damaged_qty) stored,
  note              text,
  check (damaged_qty <= received_qty),
  unique (receipt_id, bill_item_id)
);

-- ---------------------------------------------------------------------------
-- Payments and supplier credit
-- ---------------------------------------------------------------------------

create table public.supplier_credits (
  id                 uuid primary key default gen_random_uuid(),
  credit_no          text not null unique default app.next_finance_number('supplier_credit', 'SCR'),
  supplier_id        uuid not null references public.suppliers (id) on delete restrict,
  demand_id          uuid not null references public.purchase_demands (id) on delete restrict,
  bill_id            uuid not null references public.purchase_bills (id) on delete restrict,
  requested_amount   numeric(14,2) not null check (requested_amount > 0),
  approved_amount    numeric(14,2) check (approved_amount is null or approved_amount > 0),
  terms              text,
  due_date           date,
  reference          text,
  notes              text,
  -- pending_approval → active (Finance approved: now a liability) → settled;
  -- or rejected / cancelled. No liability exists before `active`.
  status             text not null default 'pending_approval' check (status in ('pending_approval', 'active', 'settled', 'rejected', 'cancelled')),
  requested_by       uuid references public.users (id) on delete set null,
  requested_by_name  text,
  requested_at       timestamptz not null default now(),
  decided_by         uuid references public.users (id) on delete set null,
  decided_by_name    text,
  decided_at         timestamptz,
  decision_reason    text,
  check (status not in ('active', 'settled') or approved_amount is not null)
);
create unique index supplier_credits_one_open on public.supplier_credits (bill_id) where status in ('pending_approval', 'active');
create index supplier_credits_supplier_idx on public.supplier_credits (supplier_id, status);

create table public.supplier_payments (
  id                  uuid primary key default gen_random_uuid(),
  payment_no          text not null unique default app.next_finance_number('supplier_payment', 'SPY'),
  supplier_id         uuid not null references public.suppliers (id) on delete restrict,
  demand_id           uuid not null references public.purchase_demands (id) on delete restrict,
  bill_id             uuid not null references public.purchase_bills (id) on delete restrict,
  -- Set when this payment repays an approved supplier credit.
  credit_id           uuid references public.supplier_credits (id) on delete restrict,
  method              text not null check (method in ('cash', 'easypaisa', 'bank')),
  account             public.finance_account not null,
  amount              numeric(14,2) not null check (amount > 0),
  reference_no        text,
  paid_on             date not null,
  notes               text,
  status              text not null default 'pending_approval' check (status in ('pending_approval', 'posted', 'rejected', 'reversed')),
  recorded_by         uuid references public.users (id) on delete set null,
  recorded_by_name    text,
  recorded_at         timestamptz not null default now(),
  ledger_head_id      uuid references public.ledger_heads (id) on delete restrict,
  ledger_entry_id     uuid,
  voucher_no          text,
  approved_by         uuid references public.users (id) on delete set null,
  approved_by_name    text,
  approved_at         timestamptz,
  rejection_reason    text,
  reversal_entry_id   uuid,
  reversal_voucher_no text,
  reversed_by         uuid references public.users (id) on delete set null,
  reversed_by_name    text,
  reversed_at         timestamptz,
  reversal_reason     text,
  client_request_id   text unique,
  -- Easypaisa and bank transfers are checked against their reference.
  check (method = 'cash' or nullif(btrim(coalesce(reference_no, '')), '') is not null)
);
create index supplier_payments_status_idx on public.supplier_payments (status, recorded_at desc);
create index supplier_payments_bill_idx on public.supplier_payments (bill_id);
create index supplier_payments_supplier_idx on public.supplier_payments (supplier_id);

-- ---------------------------------------------------------------------------
-- WhatsApp
-- ---------------------------------------------------------------------------

-- The business number(s) the API has seen, by Meta's phone-number id. Exactly
-- one is authorized for purchasing: the one in WHATSAPP_PHONE_NUMBER_ID. A
-- webhook for any other number is stored and not acted on.
create table public.whatsapp_business_numbers (
  phone_number_id       text primary key,
  display_phone_number  text,
  purpose               text not null default 'production' check (purpose in ('production', 'other')),
  is_authorized         boolean not null default false,
  last_webhook_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger whatsapp_business_numbers_touch before update on public.whatsapp_business_numbers
  for each row execute function app.touch_updated_at();

create table public.whatsapp_conversations (
  id               uuid primary key default gen_random_uuid(),
  -- The contact as WhatsApp names it: digits only, no '+'.
  wa_id            text not null unique,
  supplier_id      uuid references public.suppliers (id) on delete set null,
  profile_name     text,
  -- The 24-hour customer-service window opens with the contact's last message.
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  last_message_at  timestamptz,
  unread_count     integer not null default 0,
  created_at       timestamptz not null default now()
);
create index whatsapp_conversations_supplier_idx on public.whatsapp_conversations (supplier_id);

create table public.whatsapp_messages (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references public.whatsapp_conversations (id) on delete restrict,
  direction             text not null check (direction in ('inbound', 'outbound')),
  provider              text,
  provider_message_id   text unique,
  type                  text not null default 'text',
  template_name         text,
  -- What a person reads. A supplier link's token is masked here.
  body                  text,
  media                 jsonb,
  status                text not null check (status in ('queued', 'accepted', 'sent', 'delivered', 'read', 'failed', 'received')),
  error_code            text,
  error_title           text,
  error_detail          text,
  demand_id             uuid references public.purchase_demands (id) on delete set null,
  supplier_id           uuid references public.suppliers (id) on delete set null,
  reply_to_provider_id  text,
  -- Inbound only: could the message be tied to a supplier and a demand?
  match_status          text check (match_status in ('matched', 'unmatched', 'assigned', 'dismissed')),
  reviewed_by           uuid references public.users (id) on delete set null,
  reviewed_by_name      text,
  reviewed_at           timestamptz,
  created_by            uuid references public.users (id) on delete set null,
  created_by_name       text,
  phone_number_id       text,
  provider_timestamp    timestamptz,
  created_at            timestamptz not null default now(),
  accepted_at           timestamptz,
  sent_at               timestamptz,
  delivered_at          timestamptz,
  read_at               timestamptz,
  failed_at             timestamptz,
  check ((direction = 'inbound') = (status = 'received')),
  check (direction = 'outbound' or match_status is not null)
);
create index whatsapp_messages_conv_idx on public.whatsapp_messages (conversation_id, created_at desc);
create index whatsapp_messages_demand_idx on public.whatsapp_messages (demand_id, created_at) where demand_id is not null;
create index whatsapp_messages_unmatched_idx on public.whatsapp_messages (created_at desc) where match_status = 'unmatched';
create index whatsapp_messages_failed_idx on public.whatsapp_messages (created_at desc) where status = 'failed';

-- Messages waiting to go out. One row per message; `dedupe_key` makes the
-- business action that enqueued it unable to enqueue it twice.
create table public.whatsapp_outbox (
  id                 uuid primary key default gen_random_uuid(),
  dedupe_key         text not null unique,
  message_id         uuid not null unique references public.whatsapp_messages (id) on delete restrict,
  to_wa_id           text not null,
  -- Sent as free text inside the 24-hour window, as the template outside it.
  text_body          text,
  template_name      text,
  template_language  text not null default 'en',
  template_params    jsonb not null default '[]'::jsonb,
  -- Masked copies for after sending: the token leaves the database once used.
  masked_text_body   text,
  masked_params      jsonb,
  status             text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts           integer not null default 0,
  max_attempts       integer not null default 5,
  next_attempt_at    timestamptz not null default now(),
  locked_until       timestamptz,
  last_error         text,
  last_error_code    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (text_body is not null or template_name is not null)
);
create trigger whatsapp_outbox_touch before update on public.whatsapp_outbox
  for each row execute function app.touch_updated_at();
create index whatsapp_outbox_due_idx on public.whatsapp_outbox (next_attempt_at) where status in ('pending', 'processing');

-- Every webhook delivery, once. Meta retries a delivery it did not see a 200
-- for, and may send the same event twice regardless.
create table public.whatsapp_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  dedupe_key    text not null unique,
  kind          text not null check (kind in ('message', 'status', 'other')),
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  attempts      integer not null default 0,
  last_error    text
);
create index whatsapp_webhook_events_pending on public.whatsapp_webhook_events (received_at) where processed_at is null;

create table public.supplier_access_tokens (
  id              uuid primary key default gen_random_uuid(),
  demand_id       uuid not null references public.purchase_demands (id) on delete cascade,
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_reason  text,
  last_used_at    timestamptz,
  use_count       integer not null default 0,
  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index supplier_access_tokens_demand_idx on public.supplier_access_tokens (demand_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- MB-WA-20261020-0001: the business day's own sequence.
create function app.next_purchase_demand_no(p_day date) returns text
  language plpgsql as $$
  declare
    v_key  text := 'purchase_demand:' || to_char(p_day, 'YYYYMMDD');
    v_next bigint;
  begin
    insert into public.counters (id, count) values (v_key, 0) on conflict (id) do nothing;
    update public.counters set count = count + 1 where id = v_key returning count into v_next;
    return 'MB-WA-' || to_char(p_day, 'YYYYMMDD') || '-' || lpad(v_next::text, 4, '0');
  end;
  $$;

create function app.purchase_event(
  p_demand_id uuid, p_event text, p_from text, p_to text,
  p_actor_type text, p_actor_id uuid, p_actor_name text,
  p_quotation_id uuid default null, p_bill_id uuid default null,
  p_reason text default null, p_details jsonb default '{}'::jsonb
) returns void
  language sql as $$
  insert into public.purchase_demand_events
    (demand_id, event, from_status, to_status, actor_type, actor_id, actor_name, quotation_id, bill_id, reason, details)
  values
    (p_demand_id, p_event, p_from, p_to, p_actor_type, p_actor_id, p_actor_name, p_quotation_id, p_bill_id,
     nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_details, '{}'::jsonb));
  $$;

-- The demand row, locked, or P0002.
create function app.purchase_lock_demand(p_id uuid) returns public.purchase_demands
  language plpgsql as $$
  declare v public.purchase_demands%rowtype;
  begin
    select * into v from public.purchase_demands where id = p_id for update;
    if not found then
      raise exception 'Purchase demand % does not exist.', p_id using errcode = 'P0002';
    end if;
    return v;
  end;
  $$;

create function app.purchase_require_status(p_demand public.purchase_demands, p_allowed text[], p_action text) returns void
  language plpgsql as $$
  begin
    if not (p_demand.status = any (p_allowed)) then
      raise exception 'Cannot % demand %: it is %.', p_action, p_demand.demand_no, replace(p_demand.status, '_', ' ')
        using errcode = 'P0001';
    end if;
  end;
  $$;

-- Queue one outbound WhatsApp message in the caller's transaction. p_message:
--   { toWaId, text, template, language, params, maskedText, maskedParams,
--     dedupeKey, supplierId, demandId, display }
-- `display` is what the conversation shows (no token). Returns the message id,
-- or null when p_message is null (nothing to send).
create function app.enqueue_whatsapp(p_message jsonb, p_actor_id uuid, p_actor_name text) returns uuid
  language plpgsql as $$
  declare
    v_conv   uuid;
    v_msg    uuid;
    v_wa     text := p_message ->> 'toWaId';
  begin
    if p_message is null or p_message = 'null'::jsonb then return null; end if;
    if v_wa is null or v_wa !~ '^[1-9][0-9]{7,14}$' then
      raise exception 'WhatsApp recipient % is not a valid number.', coalesce(v_wa, '(none)') using errcode = '22023';
    end if;

    -- The same business action asking twice gets the first message back.
    select o.message_id into v_msg from public.whatsapp_outbox o where o.dedupe_key = p_message ->> 'dedupeKey';
    if found then return v_msg; end if;

    insert into public.whatsapp_conversations (wa_id, supplier_id)
    values (v_wa, nullif(p_message ->> 'supplierId', '')::uuid)
    on conflict (wa_id) do update
      set supplier_id = coalesce(public.whatsapp_conversations.supplier_id, excluded.supplier_id)
    returning id into v_conv;

    insert into public.whatsapp_messages
      (conversation_id, direction, type, template_name, body, status, demand_id, supplier_id, created_by, created_by_name)
    values
      (v_conv, 'outbound', case when p_message ->> 'text' is null then 'template' else 'text' end,
       p_message ->> 'template', p_message ->> 'display', 'queued',
       nullif(p_message ->> 'demandId', '')::uuid, nullif(p_message ->> 'supplierId', '')::uuid,
       p_actor_id, p_actor_name)
    returning id into v_msg;

    insert into public.whatsapp_outbox
      (dedupe_key, message_id, to_wa_id, text_body, template_name, template_language, template_params,
       masked_text_body, masked_params)
    values
      (p_message ->> 'dedupeKey', v_msg, v_wa, p_message ->> 'text', p_message ->> 'template',
       coalesce(p_message ->> 'language', 'en'), coalesce(p_message -> 'params', '[]'::jsonb),
       p_message ->> 'maskedText', p_message -> 'maskedParams');

    update public.whatsapp_conversations set last_message_at = now() where id = v_conv;
    return v_msg;
  end;
  $$;

-- Replace the demand's supplier link: every older token stops working.
create function app.purchase_issue_token(p_demand_id uuid, p_hash text, p_expires timestamptz, p_actor_id uuid) returns void
  language plpgsql as $$
  begin
    if p_hash is null then return; end if;
    update public.supplier_access_tokens
       set revoked_at = now(), revoked_reason = 'replaced by a newer link'
     where demand_id = p_demand_id and revoked_at is null;
    insert into public.supplier_access_tokens (demand_id, token_hash, expires_at, created_by)
    values (p_demand_id, p_hash, p_expires, p_actor_id);
  end;
  $$;

create function app.purchase_revoke_tokens(p_demand_id uuid, p_reason text) returns void
  language sql as $$
  update public.supplier_access_tokens
     set revoked_at = now(), revoked_reason = p_reason
   where demand_id = p_demand_id and revoked_at is null;
  $$;

-- Paid / partly paid / unpaid, from POSTED payments against the approved bill.
create function app.purchase_refresh_payment_status(p_demand_id uuid) returns text
  language plpgsql as $$
  declare
    v_total  numeric(14,2);
    v_paid   numeric(14,2);
    v_status text;
  begin
    select b.grand_total into v_total
      from public.purchase_demands d join public.purchase_bills b on b.id = d.approved_bill_id
     where d.id = p_demand_id;
    select coalesce(sum(amount), 0) into v_paid
      from public.supplier_payments where demand_id = p_demand_id and status = 'posted';
    v_status := case
      when v_paid <= 0 then 'unpaid'
      when v_total is not null and v_paid >= v_total then 'paid'
      else 'partially_paid'
    end;
    update public.purchase_demands set payment_status = v_status where id = p_demand_id and payment_status <> v_status;
    return v_status;
  end;
  $$;

-- Active credit is settled once posted repayments reach the approved amount.
create function app.purchase_refresh_credit(p_credit_id uuid) returns void
  language plpgsql as $$
  declare v_paid numeric(14,2);
  begin
    if p_credit_id is null then return; end if;
    select coalesce(sum(amount), 0) into v_paid
      from public.supplier_payments where credit_id = p_credit_id and status = 'posted';
    update public.supplier_credits
       set status = case when v_paid >= approved_amount then 'settled' else 'active' end
     where id = p_credit_id and status in ('active', 'settled');
  end;
  $$;

-- One stock movement and the balance it leaves, under the item's row lock.
create function app.apply_ingredient_movement(
  p_item_id uuid, p_delta numeric, p_type text, p_business_date date,
  p_demand_id uuid, p_receipt_id uuid, p_receipt_item_id uuid, p_reason text,
  p_actor_id uuid, p_actor_name text
) returns public.ingredient_stock_movements
  language plpgsql as $$
  declare
    v_item  public.purchase_items%rowtype;
    v_bal   numeric(14,3);
    v_move  public.ingredient_stock_movements%rowtype;
  begin
    select * into v_item from public.purchase_items where id = p_item_id;
    if not found then
      raise exception 'Purchase item % does not exist.', p_item_id using errcode = 'P0002';
    end if;
    insert into public.ingredient_stock (item_id, balance) values (p_item_id, 0) on conflict (item_id) do nothing;
    select balance into v_bal from public.ingredient_stock where item_id = p_item_id for update;
    v_bal := v_bal + p_delta;
    if v_bal < 0 then
      raise exception '% would go below zero (% %).', v_item.name, v_bal, v_item.unit using errcode = 'P0001';
    end if;
    update public.ingredient_stock set balance = v_bal, updated_at = now() where item_id = p_item_id;
    insert into public.ingredient_stock_movements
      (item_id, item_name, unit, type, delta, balance_after, demand_id, receipt_id, receipt_item_id,
       reason, business_date, created_by, created_by_name)
    values
      (p_item_id, v_item.name, v_item.unit, p_type, p_delta, v_bal, p_demand_id, p_receipt_id, p_receipt_item_id,
       p_reason, p_business_date, p_actor_id, p_actor_name)
    returning * into v_move;
    return v_move;
  end;
  $$;

-- Demand + items, the shape every write returns to the API.
create function app.purchase_demand_json(p_id uuid) returns jsonb
  language sql stable as $$
  select to_jsonb(d) || jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.line_no)
                         from public.purchase_demand_items i where i.demand_id = d.id), '[]'::jsonb))
    from public.purchase_demands d where d.id = p_id;
  $$;

-- Validate a demand's items (p_items: [{itemId?, itemName, itemCode?, requestedQty, unit, note?}])
-- and write them, replacing whatever the demand had.
create function app.purchase_write_items(p_demand_id uuid, p_items jsonb) returns void
  language plpgsql as $$
  declare
    r      record;
    v_line integer := 0;
  begin
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
      raise exception 'A demand needs at least one item.' using errcode = '22023';
    end if;
    delete from public.purchase_demand_items where demand_id = p_demand_id;
    for r in select * from jsonb_to_recordset(p_items)
               as x("itemId" uuid, "itemName" text, "itemCode" text, "requestedQty" numeric, unit text, note text)
    loop
      v_line := v_line + 1;
      if nullif(btrim(coalesce(r."itemName", '')), '') is null then
        raise exception 'Item % has no name.', v_line using errcode = '22023';
      end if;
      if r."requestedQty" is null or r."requestedQty" <= 0 then
        raise exception 'Item % (%) needs a quantity above zero.', v_line, r."itemName" using errcode = '22023';
      end if;
      insert into public.purchase_demand_items (demand_id, line_no, item_id, item_name, item_code, requested_qty, unit, note)
      values (p_demand_id, v_line, r."itemId", btrim(r."itemName"), nullif(btrim(coalesce(r."itemCode", '')), ''),
              r."requestedQty", r.unit, nullif(btrim(coalesce(r.note, '')), ''));
    end loop;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Demand lifecycle (called from src/services/purchasing/*.ts)
-- ---------------------------------------------------------------------------

-- Create a draft. p_demand: {supplierId, priority, requiredDate, notes,
-- deliveryInstructions, paymentPreference, credit*, clientRequestId}.
create function public.purchase_create_demand(
  p_demand jsonb, p_items jsonb, p_actor_id uuid, p_actor_name text, p_today date
) returns jsonb
  language plpgsql as $$
  declare
    v_sup  public.suppliers%rowtype;
    v_id   uuid;
  begin
    if nullif(p_demand ->> 'clientRequestId', '') is not null then
      select id into v_id from public.purchase_demands where client_request_id = p_demand ->> 'clientRequestId';
      if found then
        return app.purchase_demand_json(v_id) || jsonb_build_object('replayed', true);
      end if;
    end if;

    select * into v_sup from public.suppliers
     where id = (p_demand ->> 'supplierId')::uuid and deleted_at is null;
    if not found then
      raise exception 'Supplier not found.' using errcode = 'P0002';
    end if;
    if not v_sup.is_active then
      raise exception 'Supplier % is inactive.', v_sup.name using errcode = 'P0001';
    end if;

    insert into public.purchase_demands (
      demand_no, priority, required_date, supplier_id, supplier_name, supplier_whatsapp,
      notes, delivery_instructions, payment_preference,
      credit_reference, credit_amount_requested, credit_terms, credit_due_date, credit_notes,
      client_request_id, created_by, created_by_name
    ) values (
      app.next_purchase_demand_no(p_today), p_demand ->> 'priority', (p_demand ->> 'requiredDate')::date,
      v_sup.id, v_sup.name, v_sup.whatsapp_number,
      nullif(btrim(coalesce(p_demand ->> 'notes', '')), ''),
      nullif(btrim(coalesce(p_demand ->> 'deliveryInstructions', '')), ''),
      coalesce(p_demand ->> 'paymentPreference', 'cash'),
      nullif(btrim(coalesce(p_demand ->> 'creditReference', '')), ''),
      (p_demand ->> 'creditAmountRequested')::numeric,
      nullif(btrim(coalesce(p_demand ->> 'creditTerms', '')), ''),
      (p_demand ->> 'creditDueDate')::date,
      nullif(btrim(coalesce(p_demand ->> 'creditNotes', '')), ''),
      nullif(p_demand ->> 'clientRequestId', ''), p_actor_id, p_actor_name
    ) returning id into v_id;

    perform app.purchase_write_items(v_id, p_items);
    perform app.purchase_event(v_id, 'created', null, 'draft', 'staff', p_actor_id, p_actor_name);
    return app.purchase_demand_json(v_id) || jsonb_build_object('replayed', false);
  end;
  $$;

-- Edit a draft or verified demand. Any edit drops it back to draft: what was
-- verified is no longer what would be sent.
create function public.purchase_update_demand(
  p_id uuid, p_revision integer, p_demand jsonb, p_items jsonb, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v    public.purchase_demands%rowtype := app.purchase_lock_demand(p_id);
    v_sup public.suppliers%rowtype;
  begin
    perform app.purchase_require_status(v, array['draft', 'verified'], 'edit');
    if v.revision <> p_revision then
      raise exception 'Demand % was changed by someone else. Reload it and try again.', v.demand_no using errcode = 'P0001';
    end if;
    select * into v_sup from public.suppliers where id = (p_demand ->> 'supplierId')::uuid and deleted_at is null;
    if not found then raise exception 'Supplier not found.' using errcode = 'P0002'; end if;
    if not v_sup.is_active then raise exception 'Supplier % is inactive.', v_sup.name using errcode = 'P0001'; end if;

    update public.purchase_demands set
      status = 'draft', revision = revision + 1, verified_revision = null, verified_at = null,
      verified_by = null, verified_by_name = null,
      priority = p_demand ->> 'priority', required_date = (p_demand ->> 'requiredDate')::date,
      supplier_id = v_sup.id, supplier_name = v_sup.name, supplier_whatsapp = v_sup.whatsapp_number,
      notes = nullif(btrim(coalesce(p_demand ->> 'notes', '')), ''),
      delivery_instructions = nullif(btrim(coalesce(p_demand ->> 'deliveryInstructions', '')), ''),
      payment_preference = coalesce(p_demand ->> 'paymentPreference', 'cash'),
      credit_reference = nullif(btrim(coalesce(p_demand ->> 'creditReference', '')), ''),
      credit_amount_requested = (p_demand ->> 'creditAmountRequested')::numeric,
      credit_terms = nullif(btrim(coalesce(p_demand ->> 'creditTerms', '')), ''),
      credit_due_date = (p_demand ->> 'creditDueDate')::date,
      credit_notes = nullif(btrim(coalesce(p_demand ->> 'creditNotes', '')), '')
    where id = p_id;
    perform app.purchase_write_items(p_id, p_items);
    perform app.purchase_event(p_id, 'edited', v.status, 'draft', 'staff', p_actor_id, p_actor_name);
    return app.purchase_demand_json(p_id);
  end;
  $$;

-- The API ran the checks; this records that the revision it checked passed.
create function public.purchase_mark_verified(p_id uuid, p_revision integer, p_actor_id uuid, p_actor_name text)
returns jsonb
  language plpgsql as $$
  declare v public.purchase_demands%rowtype := app.purchase_lock_demand(p_id);
  begin
    perform app.purchase_require_status(v, array['draft', 'verified'], 'verify');
    if v.revision <> p_revision then
      raise exception 'Demand % was changed while it was being verified. Verify it again.', v.demand_no using errcode = 'P0001';
    end if;
    update public.purchase_demands
       set status = 'verified', verified_revision = revision, verified_at = now(),
           verified_by = p_actor_id, verified_by_name = p_actor_name
     where id = p_id;
    perform app.purchase_event(p_id, 'verified', v.status, 'verified', 'staff', p_actor_id, p_actor_name,
      p_details => jsonb_build_object('revision', p_revision));
    return app.purchase_demand_json(p_id);
  end;
  $$;

-- Send: the demand becomes the supplier's, a link is issued, and the message
-- is queued — all or nothing. Sending twice is refused (it is no longer
-- `verified`); the outbox's dedupe key holds even if that check is bypassed.
create function public.purchase_send_demand(
  p_id uuid, p_revision integer, p_token_hash text, p_token_expires timestamptz,
  p_message jsonb, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v      public.purchase_demands%rowtype := app.purchase_lock_demand(p_id);
    v_msg  uuid;
  begin
    perform app.purchase_require_status(v, array['verified'], 'send');
    if v.verified_revision is distinct from v.revision or v.revision <> p_revision then
      raise exception 'Demand % changed after it was verified. Verify it again before sending.', v.demand_no
        using errcode = 'P0001';
    end if;
    perform app.purchase_issue_token(p_id, p_token_hash, p_token_expires, p_actor_id);
    v_msg := app.enqueue_whatsapp(p_message, p_actor_id, p_actor_name);
    update public.purchase_demands
       set status = 'awaiting_supplier', sent_at = now(), sent_by = p_actor_id, sent_by_name = p_actor_name
     where id = p_id;
    perform app.purchase_event(p_id, 'sent', 'verified', 'awaiting_supplier', 'staff', p_actor_id, p_actor_name,
      p_details => jsonb_build_object('messageId', v_msg));
    return app.purchase_demand_json(p_id) || jsonb_build_object('messageId', v_msg);
  end;
  $$;

-- A fresh link (and message) for a supplier who lost theirs or whose link expired.
create function public.purchase_resend_link(
  p_id uuid, p_token_hash text, p_token_expires timestamptz, p_message jsonb, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v     public.purchase_demands%rowtype := app.purchase_lock_demand(p_id);
    v_msg uuid;
  begin
    perform app.purchase_require_status(v,
      array['awaiting_supplier', 'quotation_received', 'changes_requested', 'awaiting_supplier_bill', 'bill_submitted'],
      'resend the link for');
    perform app.purchase_issue_token(p_id, p_token_hash, p_token_expires, p_actor_id);
    v_msg := app.enqueue_whatsapp(p_message, p_actor_id, p_actor_name);
    perform app.purchase_event(p_id, 'link_resent', v.status, v.status, 'staff', p_actor_id, p_actor_name,
      p_details => jsonb_build_object('messageId', v_msg));
    return app.purchase_demand_json(p_id) || jsonb_build_object('messageId', v_msg);
  end;
  $$;

create function public.purchase_cancel_demand(
  p_id uuid, p_reason text, p_message jsonb, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v     public.purchase_demands%rowtype := app.purchase_lock_demand(p_id);
    v_msg uuid;
  begin
    perform app.purchase_require_status(v,
      array['draft', 'verified', 'awaiting_supplier', 'quotation_received', 'changes_requested',
            'awaiting_supplier_bill', 'bill_submitted'],
      'cancel');
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Give a reason for cancelling.' using errcode = '22023';
    end if;
    perform app.purchase_revoke_tokens(p_id, 'demand cancelled');
    -- Only a demand the supplier has seen gets told.
    if v.status not in ('draft', 'verified') then
      v_msg := app.enqueue_whatsapp(p_message, p_actor_id, p_actor_name);
    end if;
    update public.purchase_demands
       set status = 'cancelled', closed_reason = btrim(p_reason), closed_at = now(),
           closed_by = p_actor_id, closed_by_name = p_actor_name
     where id = p_id;
    perform app.purchase_event(p_id, 'cancelled', v.status, 'cancelled', 'staff', p_actor_id, p_actor_name, p_reason => p_reason);
    return app.purchase_demand_json(p_id);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Quotation
-- ---------------------------------------------------------------------------

-- A new quotation version. p_quotation: {deliveryCharge, estimatedDeliveryDate,
-- deliveryNotes, notes, clientRequestId}; p_items:
-- [{demandItemId?, substituteForDemandItemId?, itemName, unit, availableQty, unitRate, availability, note}].
-- Line totals and the total are computed HERE, whatever the client showed.
-- A version submitted while an earlier one stands approved withdraws that
-- approval: the demand needs approving again.
create function public.purchase_submit_quotation(
  p_demand_id uuid, p_via text, p_quotation jsonb, p_items jsonb, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v          public.purchase_demands%rowtype := app.purchase_lock_demand(p_demand_id);
    v_qid      uuid;
    v_version  integer;
    v_line     integer := 0;
    v_sub      numeric(14,2) := 0;
    v_total    numeric(14,2);
    v_deliv    numeric(14,2) := round(coalesce((p_quotation ->> 'deliveryCharge')::numeric, 0), 2);
    v_had_appr boolean := v.approved_quotation_id is not null;
    v_di       public.purchase_demand_items%rowtype;
    v_req      numeric;
    r          record;
  begin
    if nullif(p_quotation ->> 'clientRequestId', '') is not null then
      select id into v_qid from public.purchase_quotations
       where client_request_id = p_quotation ->> 'clientRequestId' and demand_id = p_demand_id;
      if found then
        return (select to_jsonb(q) from public.purchase_quotations q where q.id = v_qid) || jsonb_build_object('replayed', true);
      end if;
    end if;

    perform app.purchase_require_status(v,
      array['awaiting_supplier', 'quotation_received', 'changes_requested', 'awaiting_supplier_bill'],
      'submit a quotation for');
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
      raise exception 'A quotation needs at least one line.' using errcode = '22023';
    end if;
    if v_deliv < 0 then raise exception 'Delivery charge cannot be negative.' using errcode = '22023'; end if;

    select coalesce(max(version), 0) + 1 into v_version from public.purchase_quotations where demand_id = p_demand_id;

    -- Everything still open is overtaken by this version.
    update public.purchase_quotations
       set status = 'superseded'
     where demand_id = p_demand_id and status in ('submitted', 'changes_requested', 'approved');

    insert into public.purchase_quotations
      (demand_id, version, submitted_via, entered_by, entered_by_name, subtotal, delivery_charge, total,
       estimated_delivery_date, delivery_notes, notes, client_request_id)
    values
      (p_demand_id, v_version, p_via,
       case when p_via = 'staff' then p_actor_id end, case when p_via = 'staff' then p_actor_name end,
       0, v_deliv, 0,
       (p_quotation ->> 'estimatedDeliveryDate')::date,
       nullif(btrim(coalesce(p_quotation ->> 'deliveryNotes', '')), ''),
       nullif(btrim(coalesce(p_quotation ->> 'notes', '')), ''),
       nullif(p_quotation ->> 'clientRequestId', ''))
    returning id into v_qid;

    for r in select * from jsonb_to_recordset(p_items) as x(
               "demandItemId" uuid, "substituteForDemandItemId" uuid, "itemName" text, unit text,
               "availableQty" numeric, "unitRate" numeric, availability text, note text)
    loop
      v_line := v_line + 1;
      v_req := null;
      v_di := null;
      if r."demandItemId" is not null then
        select * into v_di from public.purchase_demand_items where id = r."demandItemId" and demand_id = p_demand_id;
        if not found then
          raise exception 'Line % refers to an item that is not on this demand.', v_line using errcode = '22023';
        end if;
        v_req := v_di.requested_qty;
      end if;
      if r."substituteForDemandItemId" is not null and not exists (
           select 1 from public.purchase_demand_items where id = r."substituteForDemandItemId" and demand_id = p_demand_id) then
        raise exception 'Line % substitutes an item that is not on this demand.', v_line using errcode = '22023';
      end if;
      if nullif(btrim(coalesce(r."itemName", '')), '') is null then
        raise exception 'Line % has no item name.', v_line using errcode = '22023';
      end if;
      if r."availableQty" is null or r."availableQty" < 0 or r."unitRate" is null or r."unitRate" < 0 then
        raise exception 'Line % (%) needs a quantity and a rate of zero or more.', v_line, r."itemName" using errcode = '22023';
      end if;
      if r.availability = 'unavailable' and r."availableQty" <> 0 then
        raise exception 'Line % (%) is marked unavailable but has a quantity.', v_line, r."itemName" using errcode = '22023';
      end if;
      if r.availability = 'substitute' and r."demandItemId" is not null then
        raise exception 'Line % (%) is a substitute, so it cannot also be a requested item.', v_line, r."itemName" using errcode = '22023';
      end if;
      if r.availability in ('available', 'partial', 'unavailable') and r."demandItemId" is null then
        raise exception 'Line % (%) was not on the demand: mark it as a substitute or a new item.', v_line, r."itemName"
          using errcode = '22023';
      end if;

      insert into public.purchase_quotation_items
        (quotation_id, line_no, demand_item_id, substitute_for_demand_item_id, item_name, unit, requested_qty,
         available_qty, unit_rate, line_total, availability, note)
      values
        (v_qid, v_line, r."demandItemId", r."substituteForDemandItemId", btrim(r."itemName"),
         coalesce(nullif(r.unit, ''), v_di.unit), v_req,
         r."availableQty", round(r."unitRate", 2), round(r."availableQty" * r."unitRate", 2),
         r.availability, nullif(btrim(coalesce(r.note, '')), ''));
      v_sub := v_sub + round(r."availableQty" * r."unitRate", 2);
    end loop;

    v_total := v_sub + v_deliv;
    update public.purchase_quotations set subtotal = v_sub, total = v_total where id = v_qid;

    update public.purchase_demands
       set status = 'quotation_received', current_quotation_id = v_qid, approved_quotation_id = null
     where id = p_demand_id;

    perform app.purchase_event(p_demand_id, 'quotation_submitted', v.status, 'quotation_received',
      case when p_via = 'portal' then 'supplier' else 'staff' end,
      case when p_via = 'staff' then p_actor_id end,
      case when p_via = 'staff' then p_actor_name else v.supplier_name end,
      p_quotation_id => v_qid,
      p_details => jsonb_build_object('version', v_version, 'total', v_total, 'via', p_via,
                                      'withdrewApproval', v_had_appr));
    if v_had_appr then
      perform app.purchase_event(p_demand_id, 'approval_withdrawn', v.status, 'quotation_received', 'system', null, null,
        p_quotation_id => v.approved_quotation_id,
        p_reason => 'The supplier sent a newer quotation (version ' || v_version || ').');
    end if;

    return (select to_jsonb(q) from public.purchase_quotations q where q.id = v_qid)
      || jsonb_build_object('replayed', false, 'withdrewApproval', v_had_appr);
  end;
  $$;

-- Approve / request changes / reject ONE version — the one the reviewer saw.
-- An approval also issues the supplier the link to send the bill.
create function public.purchase_decide_quotation(
  p_demand_id uuid, p_quotation_id uuid, p_version integer, p_decision text, p_reason text,
  p_token_hash text, p_token_expires timestamptz, p_message jsonb, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v        public.purchase_demands%rowtype := app.purchase_lock_demand(p_demand_id);
    v_q      public.purchase_quotations%rowtype;
    v_to     text;
    v_qs     text;
    v_msg    uuid;
  begin
    perform app.purchase_require_status(v, array['quotation_received'], 'review the quotation of');
    select * into v_q from public.purchase_quotations where id = p_quotation_id and demand_id = p_demand_id for update;
    if not found then raise exception 'Quotation not found.' using errcode = 'P0002'; end if;
    if v_q.version <> p_version or v_q.id is distinct from v.current_quotation_id or v_q.status <> 'submitted' then
      raise exception 'Quotation version % is no longer the current one. Review the latest version.', p_version
        using errcode = 'P0001';
    end if;
    if p_decision in ('reject', 'request_changes') and nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Give a reason.' using errcode = '22023';
    end if;
    if p_decision = 'approve' and v_q.total <= 0 then
      raise exception 'Nothing is available on this quotation: there is nothing to approve.' using errcode = 'P0001';
    end if;

    case p_decision
      when 'approve' then v_to := 'awaiting_supplier_bill'; v_qs := 'approved';
      when 'request_changes' then v_to := 'changes_requested'; v_qs := 'changes_requested';
      when 'reject' then v_to := 'rejected'; v_qs := 'rejected';
      else raise exception 'Unknown decision %.', p_decision using errcode = '22023';
    end case;

    update public.purchase_quotations
       set status = v_qs, decided_by = p_actor_id, decided_by_name = p_actor_name, decided_at = now(),
           decision_reason = nullif(btrim(coalesce(p_reason, '')), '')
     where id = p_quotation_id;

    -- Approve and Request changes both send the supplier a fresh link (to bill,
    -- or to revise); Reject closes every link.
    if p_decision = 'reject' then
      perform app.purchase_revoke_tokens(p_demand_id, 'quotation rejected');
    else
      perform app.purchase_issue_token(p_demand_id, p_token_hash, p_token_expires, p_actor_id);
    end if;
    v_msg := app.enqueue_whatsapp(p_message, p_actor_id, p_actor_name);

    update public.purchase_demands
       set status = v_to,
           approved_quotation_id = case when p_decision = 'approve' then p_quotation_id end,
           closed_reason = case when p_decision = 'reject' then btrim(p_reason) else closed_reason end,
           closed_at = case when p_decision = 'reject' then now() else closed_at end,
           closed_by = case when p_decision = 'reject' then p_actor_id else closed_by end,
           closed_by_name = case when p_decision = 'reject' then p_actor_name else closed_by_name end
     where id = p_demand_id;

    perform app.purchase_event(p_demand_id,
      case p_decision when 'approve' then 'quotation_approved' when 'reject' then 'quotation_rejected'
                      else 'changes_requested' end,
      v.status, v_to, 'staff', p_actor_id, p_actor_name, p_quotation_id => p_quotation_id, p_reason => p_reason,
      p_details => jsonb_build_object('version', p_version, 'total', v_q.total, 'messageId', v_msg));
    return app.purchase_demand_json(p_demand_id);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Bill
-- ---------------------------------------------------------------------------

-- The supplier's final bill against the APPROVED quotation. p_bill:
-- {supplierBillNo, invoiceDate, deliveryDate, deliveryCharge, discount,
--  otherCharges, otherChargesNote, supplierPaymentMethod, supplierStatedPaid,
--  notes, clientRequestId}; p_items: [{quotationItemId, qty, unitRate}].
-- Each line must be a line of the approved quotation. Any difference from it
-- (quantity, rate, a line dropped, delivery charge, extra charges) is listed
-- in `differences` and Production must accept it explicitly to approve.
create function public.purchase_submit_bill(
  p_demand_id uuid, p_via text, p_bill jsonb, p_items jsonb, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v        public.purchase_demands%rowtype := app.purchase_lock_demand(p_demand_id);
    v_q      public.purchase_quotations%rowtype;
    v_qi     public.purchase_quotation_items%rowtype;
    v_bid    uuid;
    v_line   integer := 0;
    v_sub    numeric(14,2) := 0;
    v_deliv  numeric(14,2) := round(coalesce((p_bill ->> 'deliveryCharge')::numeric, 0), 2);
    v_disc   numeric(14,2) := round(coalesce((p_bill ->> 'discount')::numeric, 0), 2);
    v_other  numeric(14,2) := round(coalesce((p_bill ->> 'otherCharges')::numeric, 0), 2);
    v_diffs  jsonb := '[]'::jsonb;
    v_seen   uuid[] := '{}';
    v_lines  jsonb := '[]'::jsonb;
    r        record;
  begin
    if nullif(p_bill ->> 'clientRequestId', '') is not null then
      select id into v_bid from public.purchase_bills
       where client_request_id = p_bill ->> 'clientRequestId' and demand_id = p_demand_id;
      if found then
        return (select to_jsonb(b) from public.purchase_bills b where b.id = v_bid) || jsonb_build_object('replayed', true);
      end if;
    end if;

    perform app.purchase_require_status(v, array['awaiting_supplier_bill'], 'submit a bill for');
    select * into v_q from public.purchase_quotations where id = v.approved_quotation_id;
    if not found then
      raise exception 'Demand % has no approved quotation to bill against.', v.demand_no using errcode = 'P0001';
    end if;
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
      raise exception 'A bill needs at least one line.' using errcode = '22023';
    end if;
    if nullif(btrim(coalesce(p_bill ->> 'supplierBillNo', '')), '') is null then
      raise exception 'Enter the supplier bill number.' using errcode = '22023';
    end if;
    if v_deliv < 0 or v_disc < 0 or v_other < 0 then
      raise exception 'Charges and discount cannot be negative.' using errcode = '22023';
    end if;

    -- Validate every line and work out the totals first: the bill's CHECK on
    -- its grand total holds from the first insert.
    for r in select * from jsonb_to_recordset(p_items) as x("quotationItemId" uuid, qty numeric, "unitRate" numeric)
    loop
      v_line := v_line + 1;
      select * into v_qi from public.purchase_quotation_items where id = r."quotationItemId" and quotation_id = v_q.id;
      if not found then
        raise exception 'Bill line % is not a line of the approved quotation.', v_line using errcode = '22023';
      end if;
      if r."quotationItemId" = any (v_seen) then
        raise exception 'Bill line % repeats %.', v_line, v_qi.item_name using errcode = '22023';
      end if;
      v_seen := v_seen || r."quotationItemId";
      if r.qty is null or r.qty <= 0 or r."unitRate" is null or r."unitRate" < 0 then
        raise exception 'Bill line % (%) needs a quantity above zero and a rate of zero or more.', v_line, v_qi.item_name
          using errcode = '22023';
      end if;
      v_lines := v_lines || jsonb_build_object('qi', v_qi.id, 'name', v_qi.item_name, 'unit', v_qi.unit,
                                               'qty', r.qty, 'rate', round(r."unitRate", 2),
                                               'total', round(r.qty * r."unitRate", 2));
      v_sub := v_sub + round(r.qty * r."unitRate", 2);

      if r.qty <> v_qi.available_qty then
        v_diffs := v_diffs || jsonb_build_object('item', v_qi.item_name, 'field', 'quantity',
                                                 'quoted', v_qi.available_qty, 'billed', r.qty);
      end if;
      if round(r."unitRate", 2) <> v_qi.unit_rate then
        v_diffs := v_diffs || jsonb_build_object('item', v_qi.item_name, 'field', 'rate',
                                                 'quoted', v_qi.unit_rate, 'billed', round(r."unitRate", 2));
      end if;
    end loop;

    for v_qi in select * from public.purchase_quotation_items
                  where quotation_id = v_q.id and available_qty > 0 and not (id = any (v_seen))
    loop
      v_diffs := v_diffs || jsonb_build_object('item', v_qi.item_name, 'field', 'quantity',
                                               'quoted', v_qi.available_qty, 'billed', 0);
    end loop;
    if v_deliv <> v_q.delivery_charge then
      v_diffs := v_diffs || jsonb_build_object('item', null, 'field', 'delivery_charge', 'quoted', v_q.delivery_charge, 'billed', v_deliv);
    end if;
    if v_other > 0 then
      v_diffs := v_diffs || jsonb_build_object('item', null, 'field', 'other_charges', 'quoted', 0, 'billed', v_other);
    end if;
    if v_sub + v_deliv + v_other - v_disc < 0 then
      raise exception 'The discount is larger than the bill.' using errcode = '22023';
    end if;

    insert into public.purchase_bills
      (demand_id, quotation_id, quotation_version, supplier_bill_no, submitted_via, entered_by, entered_by_name,
       invoice_date, delivery_date, subtotal, delivery_charge, discount, other_charges, other_charges_note,
       grand_total, supplier_payment_method, supplier_stated_paid, notes, differences, differs_from_quotation,
       client_request_id)
    values
      (p_demand_id, v_q.id, v_q.version, btrim(p_bill ->> 'supplierBillNo'), p_via,
       case when p_via = 'staff' then p_actor_id end, case when p_via = 'staff' then p_actor_name end,
       coalesce((p_bill ->> 'invoiceDate')::date, current_date), (p_bill ->> 'deliveryDate')::date,
       v_sub, v_deliv, v_disc, v_other, nullif(btrim(coalesce(p_bill ->> 'otherChargesNote', '')), ''),
       v_sub + v_deliv + v_other - v_disc, nullif(btrim(coalesce(p_bill ->> 'supplierPaymentMethod', '')), ''),
       round(coalesce((p_bill ->> 'supplierStatedPaid')::numeric, 0), 2),
       nullif(btrim(coalesce(p_bill ->> 'notes', '')), ''), v_diffs, jsonb_array_length(v_diffs) > 0,
       nullif(p_bill ->> 'clientRequestId', ''))
    returning id into v_bid;

    insert into public.purchase_bill_items (bill_id, line_no, quotation_item_id, item_name, unit, qty, unit_rate, line_total)
    select v_bid, l.ord::int, (l.v ->> 'qi')::uuid, l.v ->> 'name', l.v ->> 'unit',
           (l.v ->> 'qty')::numeric, (l.v ->> 'rate')::numeric, (l.v ->> 'total')::numeric
      from jsonb_array_elements(v_lines) with ordinality as l(v, ord);

    update public.purchase_demands set status = 'bill_submitted' where id = p_demand_id;
    perform app.purchase_event(p_demand_id, 'bill_submitted', v.status, 'bill_submitted',
      case when p_via = 'portal' then 'supplier' else 'staff' end,
      case when p_via = 'staff' then p_actor_id end,
      case when p_via = 'staff' then p_actor_name else v.supplier_name end,
      p_bill_id => v_bid,
      p_details => jsonb_build_object('supplierBillNo', p_bill ->> 'supplierBillNo',
                                      'grandTotal', v_sub + v_deliv + v_other - v_disc,
                                      'differences', jsonb_array_length(v_diffs)));
    return (select to_jsonb(b) from public.purchase_bills b where b.id = v_bid) || jsonb_build_object('replayed', false);
  end;
  $$;

-- A rejected bill goes back to the supplier with a fresh link to send a corrected one.
create function public.purchase_decide_bill(
  p_demand_id uuid, p_bill_id uuid, p_decision text, p_reason text, p_accept_differences boolean,
  p_token_hash text, p_token_expires timestamptz, p_message jsonb, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v     public.purchase_demands%rowtype := app.purchase_lock_demand(p_demand_id);
    v_b   public.purchase_bills%rowtype;
    v_to  text;
    v_msg uuid;
  begin
    perform app.purchase_require_status(v, array['bill_submitted'], 'review the bill of');
    select * into v_b from public.purchase_bills where id = p_bill_id and demand_id = p_demand_id for update;
    if not found then raise exception 'Bill not found.' using errcode = 'P0002'; end if;
    if v_b.status <> 'submitted' then
      raise exception 'Bill % is already %.', v_b.supplier_bill_no, v_b.status using errcode = 'P0001';
    end if;
    if p_decision = 'approve' and v_b.differs_from_quotation and not coalesce(p_accept_differences, false) then
      raise exception 'Bill % differs from the approved quotation. Review the differences and accept them to approve.',
        v_b.supplier_bill_no using errcode = 'P0001';
    end if;
    if (p_decision = 'reject' or (p_decision = 'approve' and v_b.differs_from_quotation))
       and nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Give a reason.' using errcode = '22023';
    end if;

    if p_decision = 'approve' then
      v_to := 'awaiting_delivery';
      update public.purchase_bills
         set status = 'approved', accepted_differences = v_b.differs_from_quotation,
             decided_by = p_actor_id, decided_by_name = p_actor_name, decided_at = now(),
             decision_reason = nullif(btrim(coalesce(p_reason, '')), '')
       where id = p_bill_id;
      update public.purchase_demands set status = v_to, approved_bill_id = p_bill_id where id = p_demand_id;
    elsif p_decision = 'reject' then
      v_to := 'awaiting_supplier_bill';
      update public.purchase_bills
         set status = 'rejected', decided_by = p_actor_id, decided_by_name = p_actor_name, decided_at = now(),
             decision_reason = btrim(p_reason)
       where id = p_bill_id;
      update public.purchase_demands set status = v_to where id = p_demand_id;
      perform app.purchase_issue_token(p_demand_id, p_token_hash, p_token_expires, p_actor_id);
    else
      raise exception 'Unknown decision %.', p_decision using errcode = '22023';
    end if;

    v_msg := app.enqueue_whatsapp(p_message, p_actor_id, p_actor_name);
    perform app.purchase_event(p_demand_id, case when p_decision = 'approve' then 'bill_approved' else 'bill_rejected' end,
      v.status, v_to, 'staff', p_actor_id, p_actor_name, p_bill_id => p_bill_id, p_reason => p_reason,
      p_details => jsonb_build_object('grandTotal', v_b.grand_total, 'acceptedDifferences',
                                      p_decision = 'approve' and v_b.differs_from_quotation, 'messageId', v_msg));
    return app.purchase_demand_json(p_demand_id);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Delivery and goods receipt
-- ---------------------------------------------------------------------------

create function public.purchase_save_delivery(p_demand_id uuid, p_delivery jsonb, p_actor_id uuid, p_actor_name text)
returns jsonb
  language plpgsql as $$
  declare
    v       public.purchase_demands%rowtype := app.purchase_lock_demand(p_demand_id);
    v_st    text := coalesce(p_delivery ->> 'status', 'booked');
    v_row   public.purchase_deliveries%rowtype;
  begin
    perform app.purchase_require_status(v,
      array['awaiting_supplier_bill', 'bill_submitted', 'awaiting_delivery', 'partially_received', 'received'],
      'record delivery for');
    if v_st = 'delivered' and nullif(btrim(coalesce(p_delivery ->> 'receivedByName', '')), '') is null then
      raise exception 'Enter who received the delivery.' using errcode = '22023';
    end if;

    insert into public.purchase_deliveries as d
      (demand_id, provider, provider_name, booking_reference, estimated_fee, actual_fee, fee_paid_by,
       pickup_details, delivery_notes, status, dispatched_at, delivered_at, received_by_name, updated_by, updated_by_name)
    values
      (p_demand_id, p_delivery ->> 'provider', nullif(btrim(coalesce(p_delivery ->> 'providerName', '')), ''),
       nullif(btrim(coalesce(p_delivery ->> 'bookingReference', '')), ''),
       (p_delivery ->> 'estimatedFee')::numeric, (p_delivery ->> 'actualFee')::numeric,
       coalesce(p_delivery ->> 'feePaidBy', 'mountain_bakes'),
       nullif(btrim(coalesce(p_delivery ->> 'pickupDetails', '')), ''),
       nullif(btrim(coalesce(p_delivery ->> 'deliveryNotes', '')), ''),
       v_st,
       case when v_st in ('dispatched', 'delivered') then now() end,
       case when v_st = 'delivered' then now() end,
       nullif(btrim(coalesce(p_delivery ->> 'receivedByName', '')), ''),
       p_actor_id, p_actor_name)
    on conflict (demand_id) do update set
      provider = excluded.provider, provider_name = excluded.provider_name,
      booking_reference = excluded.booking_reference, estimated_fee = excluded.estimated_fee,
      actual_fee = excluded.actual_fee, fee_paid_by = excluded.fee_paid_by,
      pickup_details = excluded.pickup_details, delivery_notes = excluded.delivery_notes,
      status = excluded.status,
      dispatched_at = coalesce(d.dispatched_at, excluded.dispatched_at),
      delivered_at = coalesce(d.delivered_at, excluded.delivered_at),
      received_by_name = excluded.received_by_name,
      updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name
    returning * into v_row;

    update public.purchase_demands set delivery_status = v_st where id = p_demand_id;
    perform app.purchase_event(p_demand_id, 'delivery_updated', v.status, v.status, 'staff', p_actor_id, p_actor_name,
      p_details => to_jsonb(v_row) - 'updated_by' - 'created_at' - 'updated_at');
    return to_jsonb(v_row);
  end;
  $$;

-- Goods received. p_receipt: {notes, clientRequestId}; p_items:
-- [{billItemId, itemId, receivedQty, damagedQty, note}]. The ACCEPTED quantity
-- (received − damaged) goes into ingredient stock, one movement per line.
-- Nothing may be received beyond what the approved bill lists. p_final closes
-- the receipt short: what did not arrive is recorded as a shortage.
create function public.purchase_record_receipt(
  p_demand_id uuid, p_receipt jsonb, p_items jsonb, p_final boolean, p_business_date date,
  p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v        public.purchase_demands%rowtype := app.purchase_lock_demand(p_demand_id);
    v_bi     public.purchase_bill_items%rowtype;
    v_rid    uuid;
    v_riid   uuid;
    v_prev   numeric;
    v_any    boolean := false;
    v_open   boolean;
    v_to     text;
    v_short  jsonb := '[]'::jsonb;
    r        record;
  begin
    if nullif(p_receipt ->> 'clientRequestId', '') is not null then
      select id into v_rid from public.purchase_receipts
       where client_request_id = p_receipt ->> 'clientRequestId' and demand_id = p_demand_id;
      if found then
        return (select to_jsonb(x) from public.purchase_receipts x where x.id = v_rid) || jsonb_build_object('replayed', true);
      end if;
    end if;
    perform app.purchase_require_status(v, array['awaiting_delivery', 'partially_received'], 'receive goods for');

    insert into public.purchase_receipts
      (demand_id, bill_id, business_date, is_final, received_by, received_by_name, notes, client_request_id)
    values
      (p_demand_id, v.approved_bill_id, p_business_date, coalesce(p_final, false), p_actor_id, p_actor_name,
       nullif(btrim(coalesce(p_receipt ->> 'notes', '')), ''), nullif(p_receipt ->> 'clientRequestId', ''))
    returning id into v_rid;

    for r in select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
               "billItemId" uuid, "itemId" uuid, "receivedQty" numeric, "damagedQty" numeric, note text)
    loop
      select * into v_bi from public.purchase_bill_items where id = r."billItemId" and bill_id = v.approved_bill_id;
      if not found then
        raise exception 'A received line is not on the approved bill.' using errcode = '22023';
      end if;
      if r."itemId" is null then
        raise exception 'Choose the stock item % is received as.', v_bi.item_name using errcode = '22023';
      end if;
      -- Stock is counted in the item's own unit, so a line can only go into an
      -- item measured the same way — and into the catalog item the demand
      -- named, when it named one (a substitute names none).
      if not exists (select 1 from public.purchase_items where id = r."itemId" and unit = v_bi.unit and is_active) then
        raise exception '% is billed in %; choose an active stock item measured in %.', v_bi.item_name, v_bi.unit, v_bi.unit
          using errcode = '22023';
      end if;
      if exists (
           select 1 from public.purchase_quotation_items qi
             join public.purchase_demand_items di on di.id = qi.demand_item_id
            where qi.id = v_bi.quotation_item_id and di.item_id is not null and di.item_id <> r."itemId") then
        raise exception '% was demanded as a catalog item; receive it into that item.', v_bi.item_name using errcode = '22023';
      end if;
      if coalesce(r."receivedQty", 0) < 0 or coalesce(r."damagedQty", 0) < 0
         or coalesce(r."damagedQty", 0) > coalesce(r."receivedQty", 0) then
        raise exception '%: received must be zero or more, and damaged no more than received.', v_bi.item_name
          using errcode = '22023';
      end if;
      if coalesce(r."receivedQty", 0) = 0 then continue; end if;

      select coalesce(sum(ri.received_qty), 0) into v_prev
        from public.purchase_receipt_items ri where ri.bill_item_id = v_bi.id;
      if v_prev + r."receivedQty" > v_bi.qty then
        raise exception '%: % % already received of % billed; % more is too many.',
          v_bi.item_name, v_prev, v_bi.unit, v_bi.qty, r."receivedQty" using errcode = 'P0001';
      end if;

      insert into public.purchase_receipt_items
        (receipt_id, bill_item_id, item_id, item_name, unit, received_qty, damaged_qty, note)
      values
        (v_rid, v_bi.id, r."itemId", v_bi.item_name, v_bi.unit, r."receivedQty", coalesce(r."damagedQty", 0),
         nullif(btrim(coalesce(r.note, '')), ''))
      returning id into v_riid;
      v_any := true;

      if r."receivedQty" - coalesce(r."damagedQty", 0) > 0 then
        perform app.apply_ingredient_movement(r."itemId", r."receivedQty" - coalesce(r."damagedQty", 0), 'receipt',
          p_business_date, p_demand_id, v_rid, v_riid,
          'Received ' || v.demand_no || ' (' || v_bi.item_name || ')', p_actor_id, p_actor_name);
      end if;
    end loop;

    if not v_any and not coalesce(p_final, false) then
      raise exception 'Enter at least one received quantity.' using errcode = '22023';
    end if;

    -- Still owed: billed minus everything received so far, per line.
    select coalesce(jsonb_agg(jsonb_build_object('item', b.item_name, 'unit', b.unit, 'billed', b.qty,
                                                 'received', coalesce(x.got, 0), 'short', b.qty - coalesce(x.got, 0))), '[]'::jsonb),
           bool_or(b.qty > coalesce(x.got, 0))
      into v_short, v_open
      from public.purchase_bill_items b
      left join (select bill_item_id, sum(received_qty) got from public.purchase_receipt_items group by bill_item_id) x
        on x.bill_item_id = b.id
     where b.bill_id = v.approved_bill_id and b.qty > coalesce(x.got, 0);

    v_to := case when coalesce(v_open, false) and not coalesce(p_final, false) then 'partially_received' else 'received' end;
    update public.purchase_demands
       set status = v_to,
           delivery_status = case when v_to = 'received' then 'delivered' else delivery_status end
     where id = p_demand_id;
    if v_to = 'received' then
      perform app.purchase_revoke_tokens(p_demand_id, 'goods received');
    end if;

    perform app.purchase_event(p_demand_id, 'goods_received', v.status, v_to, 'staff', p_actor_id, p_actor_name,
      p_details => jsonb_build_object('receiptId', v_rid, 'final', coalesce(p_final, false), 'shortages', v_short));
    return (select to_jsonb(x) from public.purchase_receipts x where x.id = v_rid)
      || jsonb_build_object('replayed', false, 'status', v_to, 'shortages', v_short);
  end;
  $$;

create function public.ingredient_stock_adjust(
  p_item_id uuid, p_delta numeric, p_reason text, p_business_date date, p_actor_id uuid, p_actor_name text
) returns public.ingredient_stock_movements
  language plpgsql as $$
  begin
    if p_delta is null or p_delta = 0 then
      raise exception 'Enter the quantity to add or remove.' using errcode = '22023';
    end if;
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Give a reason for the adjustment.' using errcode = '22023';
    end if;
    return app.apply_ingredient_movement(p_item_id, p_delta, 'adjustment', p_business_date, null, null, null,
      btrim(p_reason), p_actor_id, p_actor_name);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Payments and credit
-- ---------------------------------------------------------------------------

-- How much of a bill is spoken for. A bill is settled two ways, and the two
-- together may never exceed it:
--   direct  — payments with no credit, pending or posted
--   credit  — each credit not rejected or cancelled: its approved amount once
--             approved, its requested amount while it waits
-- A repayment (a payment with a credit_id) is not counted again: it settles a
-- share of the bill its credit already holds, and may not exceed that credit.
create function app.purchase_bill_committed(p_bill_id uuid, p_except_credit uuid default null)
returns table (direct numeric, credit numeric)
  language sql stable as $$
  select
    (select coalesce(sum(amount), 0) from public.supplier_payments
      where bill_id = p_bill_id and credit_id is null and status in ('pending_approval', 'posted')),
    (select coalesce(sum(case when status = 'pending_approval' then requested_amount else approved_amount end), 0)
       from public.supplier_credits
      where bill_id = p_bill_id and status in ('pending_approval', 'active', 'settled')
        and id is distinct from p_except_credit);
  $$;

-- Production records a payment; it waits for Finance. Under the demand's and
-- the bill's row locks: a direct payment may not exceed what is left of the
-- bill once credit is set aside, and a repayment may not exceed what is left
-- of its credit. A retried or doubled submission cannot overpay.
-- p_payment: {method, amount, referenceNo, paidOn, notes, creditId, clientRequestId}.
create function public.purchase_record_payment(p_demand_id uuid, p_payment jsonb, p_actor_id uuid, p_actor_name text)
returns jsonb
  language plpgsql as $$
  declare
    v         public.purchase_demands%rowtype := app.purchase_lock_demand(p_demand_id);
    v_b       public.purchase_bills%rowtype;
    v_c       public.supplier_credits%rowtype;
    v_amount  numeric(14,2) := round((p_payment ->> 'amount')::numeric, 2);
    v_method  text := p_payment ->> 'method';
    v_paid_on date := coalesce((p_payment ->> 'paidOn')::date, app.karachi_business_date());
    v_direct  numeric(14,2);
    v_credit  numeric(14,2);
    v_used    numeric(14,2);
    v_id      uuid;
  begin
    if nullif(p_payment ->> 'clientRequestId', '') is not null then
      select id into v_id from public.supplier_payments
       where client_request_id = p_payment ->> 'clientRequestId' and demand_id = p_demand_id;
      if found then
        return (select to_jsonb(p) from public.supplier_payments p where p.id = v_id) || jsonb_build_object('replayed', true);
      end if;
    end if;
    perform app.purchase_require_status(v, array['awaiting_delivery', 'partially_received', 'received'], 'record a payment for');
    select * into v_b from public.purchase_bills where id = v.approved_bill_id for update;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Enter an amount above zero.' using errcode = '22023';
    end if;
    -- The voucher is posted on this date, so it must be a real one: not ahead
    -- of today, and not before the demand existed.
    if v_paid_on > app.karachi_business_date() then
      raise exception 'The payment date cannot be in the future.' using errcode = '22023';
    end if;
    if v_paid_on < (v.created_at at time zone 'Asia/Karachi')::date then
      raise exception 'The payment date is before demand % was raised.', v.demand_no using errcode = '22023';
    end if;

    if nullif(p_payment ->> 'creditId', '') is null then
      select c.direct, c.credit into v_direct, v_credit from app.purchase_bill_committed(v_b.id) c;
      if v_direct + v_credit + v_amount > v_b.grand_total then
        raise exception 'That would pay Rs. % against bill % of Rs. % (Rs. % already recorded, Rs. % on credit).',
          v_direct + v_amount, v_b.supplier_bill_no, v_b.grand_total, v_direct, v_credit using errcode = 'P0001';
      end if;
    else
      select * into v_c from public.supplier_credits
       where id = (p_payment ->> 'creditId')::uuid and bill_id = v_b.id for update;
      if not found or v_c.status <> 'active' then
        raise exception 'That supplier credit is not active.' using errcode = 'P0001';
      end if;
      select coalesce(sum(amount), 0) into v_used
        from public.supplier_payments where credit_id = v_c.id and status in ('pending_approval', 'posted');
      if v_used + v_amount > v_c.approved_amount then
        raise exception 'That would repay Rs. % against credit % of Rs. % (Rs. % already recorded).',
          v_used + v_amount, v_c.credit_no, v_c.approved_amount, v_used using errcode = 'P0001';
      end if;
    end if;

    insert into public.supplier_payments
      (supplier_id, demand_id, bill_id, credit_id, method, account, amount, reference_no, paid_on, notes,
       recorded_by, recorded_by_name, client_request_id)
    values
      (v.supplier_id, p_demand_id, v_b.id, nullif(p_payment ->> 'creditId', '')::uuid, v_method,
       (case when v_method = 'cash' then 'cash' else 'bank' end)::public.finance_account,
       v_amount, nullif(btrim(coalesce(p_payment ->> 'referenceNo', '')), ''),
       v_paid_on,
       nullif(btrim(coalesce(p_payment ->> 'notes', '')), ''), p_actor_id, p_actor_name,
       nullif(p_payment ->> 'clientRequestId', ''))
    returning id into v_id;

    perform app.purchase_event(p_demand_id, 'payment_recorded', v.status, v.status, 'staff', p_actor_id, p_actor_name,
      p_bill_id => v_b.id, p_details => jsonb_build_object('paymentId', v_id, 'amount', v_amount, 'method', v_method));
    return (select to_jsonb(p) from public.supplier_payments p where p.id = v_id) || jsonb_build_object('replayed', false);
  end;
  $$;

-- Finance approves: one PV posted under the chosen head, and the payment
-- marked, in one transaction.
create function public.supplier_payment_approve(
  p_id uuid, p_ledger_head_id uuid, p_actor_id uuid, p_actor_name text, p_today date
) returns jsonb
  language plpgsql as $$
  declare
    v_p     public.supplier_payments%rowtype;
    v_d     public.purchase_demands%rowtype;
    v_head  uuid := p_ledger_head_id;
    v_date  date;
    v_entry public.ledger_entries%rowtype;
  begin
    select * into v_p from public.supplier_payments where id = p_id for update;
    if not found then raise exception 'Supplier payment not found.' using errcode = 'P0002'; end if;
    if v_p.status <> 'pending_approval' then
      raise exception 'Payment % is already %.', v_p.payment_no, replace(v_p.status, '_', ' ') using errcode = 'P0001';
    end if;
    if v_p.recorded_by is not distinct from p_actor_id then
      raise exception 'Payment % was recorded by you; another person must approve it.', v_p.payment_no using errcode = 'P0001';
    end if;
    select * into v_d from public.purchase_demands where id = v_p.demand_id;
    if v_head is null then
      select id into v_head from public.ledger_heads where code = 'EXP-RAW-MATERIALS';
    end if;
    if not exists (select 1 from public.ledger_heads where id = v_head and type = 'expense') then
      raise exception 'Choose an expense ledger head.' using errcode = '22023';
    end if;

    -- Dated the day the money moved, unless Finance has closed that day.
    v_date := v_p.paid_on;
    if exists (select 1 from public.finance_day_closings where business_date = v_date) then v_date := p_today; end if;

    select * into v_entry from public.post_finance_ledger_entry(
      p_entry_date       => v_date,
      p_ledger_head_id   => v_head,
      p_description      => 'Supplier payment ' || v_p.payment_no || ' — ' || v_d.supplier_name || ' — ' || v_d.demand_no
                            || coalesce(' (ref ' || v_p.reference_no || ')', ''),
      p_debit            => 0,
      p_credit           => v_p.amount,
      p_account          => v_p.account,
      p_source_type      => 'vendor_payment',
      p_source_id        => v_p.id,
      p_payment_method   => v_p.method,
      p_approved_by      => p_actor_id,
      p_approved_by_name => p_actor_name,
      p_created_by       => v_p.recorded_by,
      p_created_by_name  => v_p.recorded_by_name);

    update public.supplier_payments
       set status = 'posted', ledger_head_id = v_head, ledger_entry_id = v_entry.id, voucher_no = v_entry.voucher_no,
           approved_by = p_actor_id, approved_by_name = p_actor_name, approved_at = now()
     where id = p_id;
    perform app.purchase_refresh_payment_status(v_p.demand_id);
    perform app.purchase_refresh_credit(v_p.credit_id);
    perform app.purchase_event(v_p.demand_id, 'payment_posted', v_d.status, v_d.status, 'staff', p_actor_id, p_actor_name,
      p_bill_id => v_p.bill_id,
      p_details => jsonb_build_object('paymentId', v_p.id, 'amount', v_p.amount, 'voucherNo', v_entry.voucher_no));
    return (select to_jsonb(p) from public.supplier_payments p where p.id = p_id);
  end;
  $$;

create function public.supplier_payment_reject(p_id uuid, p_reason text, p_actor_id uuid, p_actor_name text)
returns jsonb
  language plpgsql as $$
  declare
    v_p public.supplier_payments%rowtype;
    v_d public.purchase_demands%rowtype;
  begin
    select * into v_p from public.supplier_payments where id = p_id for update;
    if not found then raise exception 'Supplier payment not found.' using errcode = 'P0002'; end if;
    if v_p.status <> 'pending_approval' then
      raise exception 'Payment % is already %.', v_p.payment_no, replace(v_p.status, '_', ' ') using errcode = 'P0001';
    end if;
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Give a reason.' using errcode = '22023';
    end if;
    select * into v_d from public.purchase_demands where id = v_p.demand_id;
    update public.supplier_payments
       set status = 'rejected', rejection_reason = btrim(p_reason), approved_by = p_actor_id,
           approved_by_name = p_actor_name, approved_at = now()
     where id = p_id;
    perform app.purchase_event(v_p.demand_id, 'payment_rejected', v_d.status, v_d.status, 'staff', p_actor_id, p_actor_name,
      p_bill_id => v_p.bill_id, p_reason => p_reason, p_details => jsonb_build_object('paymentId', v_p.id, 'amount', v_p.amount));
    return (select to_jsonb(p) from public.supplier_payments p where p.id = p_id);
  end;
  $$;

-- A posted payment that did not happen (bounced transfer, wrong supplier) is
-- reversed by an opposite RV entry. The PV stays in the book, marked reversed.
create function public.supplier_payment_reverse(p_id uuid, p_reason text, p_actor_id uuid, p_actor_name text, p_today date)
returns jsonb
  language plpgsql as $$
  declare
    v_p     public.supplier_payments%rowtype;
    v_d     public.purchase_demands%rowtype;
    v_orig  public.ledger_entries%rowtype;
    v_entry public.ledger_entries%rowtype;
  begin
    select * into v_p from public.supplier_payments where id = p_id for update;
    if not found then raise exception 'Supplier payment not found.' using errcode = 'P0002'; end if;
    if v_p.status <> 'posted' then
      raise exception 'Only a posted payment can be reversed; % is %.', v_p.payment_no, replace(v_p.status, '_', ' ')
        using errcode = 'P0001';
    end if;
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Give a reason.' using errcode = '22023';
    end if;
    select * into v_orig from public.ledger_entries where id = v_p.ledger_entry_id for update;
    -- The voucher may have been changed from the general ledger since it was
    -- posted. Reverse only a live, unreversed voucher, and by what it now says.
    if not found or v_orig.deleted_at is not null or v_orig.status = 'reversed' or v_orig.reversed_by_entry_id is not null then
      raise exception 'Voucher % for payment % is already reversed or deleted in the ledger. Check it there.',
        coalesce(v_orig.voucher_no, '?'), v_p.payment_no using errcode = 'P0001';
    end if;
    if v_orig.credit <> v_p.amount then
      raise exception 'Voucher % no longer matches payment % (Rs. % against Rs. %). Correct it in the ledger first.',
        v_orig.voucher_no, v_p.payment_no, v_orig.credit, v_p.amount using errcode = 'P0001';
    end if;
    select * into v_d from public.purchase_demands where id = v_p.demand_id;

    select * into v_entry from public.post_finance_ledger_entry(
      p_entry_date        => p_today,
      p_ledger_head_id    => v_orig.ledger_head_id,
      p_description       => 'Reversal of ' || v_orig.voucher_no || ' (' || v_p.payment_no || '): ' || btrim(p_reason),
      p_debit             => v_p.amount,
      p_credit            => 0,
      p_account           => v_p.account,
      p_source_type       => 'vendor_payment',
      p_source_id         => v_p.id,
      p_payment_method    => v_p.method,
      p_approved_by       => p_actor_id,
      p_approved_by_name  => p_actor_name,
      p_created_by        => p_actor_id,
      p_created_by_name   => p_actor_name,
      p_reverses_entry_id => v_orig.id);
    update public.ledger_entries set status = 'reversed', reversed_by_entry_id = v_entry.id where id = v_orig.id;

    update public.supplier_payments
       set status = 'reversed', reversal_entry_id = v_entry.id, reversal_voucher_no = v_entry.voucher_no,
           reversed_by = p_actor_id, reversed_by_name = p_actor_name, reversed_at = now(), reversal_reason = btrim(p_reason)
     where id = p_id;
    perform app.purchase_refresh_payment_status(v_p.demand_id);
    perform app.purchase_refresh_credit(v_p.credit_id);
    perform app.purchase_event(v_p.demand_id, 'payment_reversed', v_d.status, v_d.status, 'staff', p_actor_id, p_actor_name,
      p_bill_id => v_p.bill_id, p_reason => p_reason,
      p_details => jsonb_build_object('paymentId', v_p.id, 'amount', v_p.amount, 'voucherNo', v_entry.voucher_no));
    return (select to_jsonb(p) from public.supplier_payments p where p.id = p_id);
  end;
  $$;

-- Production asks to owe part of an approved bill. Not a liability until
-- Finance approves it.
create function public.purchase_request_credit(p_demand_id uuid, p_credit jsonb, p_actor_id uuid, p_actor_name text)
returns jsonb
  language plpgsql as $$
  declare
    v       public.purchase_demands%rowtype := app.purchase_lock_demand(p_demand_id);
    v_b     public.purchase_bills%rowtype;
    v_amt   numeric(14,2) := round((p_credit ->> 'amount')::numeric, 2);
    v_left  numeric(14,2);
    v_id    uuid;
  begin
    perform app.purchase_require_status(v, array['awaiting_delivery', 'partially_received', 'received'], 'request credit for');
    select * into v_b from public.purchase_bills where id = v.approved_bill_id for update;
    if v_amt is null or v_amt <= 0 then raise exception 'Enter an amount above zero.' using errcode = '22023'; end if;
    select v_b.grand_total - c.direct - c.credit into v_left from app.purchase_bill_committed(v_b.id) c;
    if v_amt > v_left then
      raise exception 'Credit of Rs. % is more than the Rs. % of bill % not already paid or on credit.',
        v_amt, greatest(v_left, 0), v_b.supplier_bill_no using errcode = 'P0001';
    end if;
    insert into public.supplier_credits
      (supplier_id, demand_id, bill_id, requested_amount, terms, due_date, reference, notes, requested_by, requested_by_name)
    values
      (v.supplier_id, p_demand_id, v_b.id, v_amt, nullif(btrim(coalesce(p_credit ->> 'terms', '')), ''),
       (p_credit ->> 'dueDate')::date, nullif(btrim(coalesce(p_credit ->> 'reference', '')), ''),
       nullif(btrim(coalesce(p_credit ->> 'notes', '')), ''), p_actor_id, p_actor_name)
    returning id into v_id;
    perform app.purchase_event(p_demand_id, 'credit_requested', v.status, v.status, 'staff', p_actor_id, p_actor_name,
      p_bill_id => v_b.id, p_details => jsonb_build_object('creditId', v_id, 'amount', v_amt));
    return (select to_jsonb(c) from public.supplier_credits c where c.id = v_id);
  end;
  $$;

create function public.supplier_credit_decide(
  p_id uuid, p_decision text, p_approved_amount numeric, p_reason text, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v_c  public.supplier_credits%rowtype;
    v_d  public.purchase_demands%rowtype;
    v_amt numeric(14,2);
  begin
    select * into v_c from public.supplier_credits where id = p_id for update;
    if not found then raise exception 'Supplier credit not found.' using errcode = 'P0002'; end if;
    if v_c.status <> 'pending_approval' then
      raise exception 'Credit % is already %.', v_c.credit_no, replace(v_c.status, '_', ' ') using errcode = 'P0001';
    end if;
    select * into v_d from public.purchase_demands where id = v_c.demand_id;
    if p_decision = 'approve' then
      v_amt := round(coalesce(p_approved_amount, v_c.requested_amount), 2);
      if v_amt <= 0 or v_amt > v_c.requested_amount then
        raise exception 'Approve between Rs. 0.01 and the Rs. % requested.', v_c.requested_amount using errcode = '22023';
      end if;
      update public.supplier_credits
         set status = 'active', approved_amount = v_amt, decided_by = p_actor_id, decided_by_name = p_actor_name,
             decided_at = now(), decision_reason = nullif(btrim(coalesce(p_reason, '')), '')
       where id = p_id;
    elsif p_decision = 'reject' then
      if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'Give a reason.' using errcode = '22023'; end if;
      update public.supplier_credits
         set status = 'rejected', decided_by = p_actor_id, decided_by_name = p_actor_name, decided_at = now(),
             decision_reason = btrim(p_reason)
       where id = p_id;
    else
      raise exception 'Unknown decision %.', p_decision using errcode = '22023';
    end if;
    perform app.purchase_event(v_c.demand_id, 'credit_' || case when p_decision = 'approve' then 'approved' else 'rejected' end,
      v_d.status, v_d.status, 'staff', p_actor_id, p_actor_name, p_bill_id => v_c.bill_id, p_reason => p_reason,
      p_details => jsonb_build_object('creditId', v_c.id, 'amount', coalesce(v_amt, v_c.requested_amount)));
    return (select to_jsonb(c) from public.supplier_credits c where c.id = p_id);
  end;
  $$;

-- ---------------------------------------------------------------------------
-- WhatsApp: outbox worker and webhook
-- ---------------------------------------------------------------------------

-- Lease due rows to one worker. `skip locked` lets two API processes share the
-- queue without sending a row twice; the lease returns a row whose worker
-- died mid-send to the queue once it lapses.
create function public.whatsapp_claim_outbox(p_limit integer, p_lease_seconds integer)
returns setof public.whatsapp_outbox
  language sql as $$
  update public.whatsapp_outbox o
     set status = 'processing', attempts = o.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds)
   where o.id in (
     select id from public.whatsapp_outbox
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and locked_until < now())
      order by next_attempt_at
      limit p_limit
      for update skip locked)
  returning o.*;
  $$;

-- The worker's answer for one leased row. On success the token-bearing text
-- is replaced by its masked copy; on a retryable failure the row goes back
-- with exponential backoff until max_attempts, then fails for good (a person
-- can retry it from the conversation).
create function public.whatsapp_complete_outbox(
  p_id uuid, p_ok boolean, p_provider text, p_provider_message_id text, p_used_template boolean,
  p_retryable boolean, p_error_code text, p_error text
) returns void
  language plpgsql as $$
  declare
    v_o public.whatsapp_outbox%rowtype;
  begin
    select * into v_o from public.whatsapp_outbox where id = p_id for update;
    if not found or v_o.status <> 'processing' then return; end if;

    if p_ok then
      update public.whatsapp_outbox
         set status = 'done', locked_until = null, last_error = null, last_error_code = null,
             text_body = coalesce(masked_text_body, text_body),
             template_params = coalesce(masked_params, template_params)
       where id = p_id;
      update public.whatsapp_messages
         set status = 'accepted', provider = p_provider, provider_message_id = p_provider_message_id,
             accepted_at = now(),
             type = case when p_used_template then 'template' else 'text' end,
             template_name = case when p_used_template then v_o.template_name end,
             error_code = null, error_title = null, error_detail = null, failed_at = null
       where id = v_o.message_id;
      update public.whatsapp_conversations c
         set last_outbound_at = now(), last_message_at = now()
        from public.whatsapp_messages m where m.id = v_o.message_id and c.id = m.conversation_id;
    elsif p_retryable and v_o.attempts < v_o.max_attempts then
      update public.whatsapp_outbox
         set status = 'pending', locked_until = null, last_error = p_error, last_error_code = p_error_code,
             next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, v_o.attempts - 1)::int))
       where id = p_id;
      update public.whatsapp_messages
         set provider = p_provider, error_code = p_error_code, error_detail = p_error
       where id = v_o.message_id;
    else
      update public.whatsapp_outbox
         set status = 'failed', locked_until = null, last_error = p_error, last_error_code = p_error_code
       where id = p_id;
      update public.whatsapp_messages
         set status = 'failed', provider = p_provider, error_code = p_error_code, error_detail = p_error, failed_at = now()
       where id = v_o.message_id;
    end if;
  end;
  $$;

-- A person retries a failed message: the SAME outbox row goes back to the
-- queue. Nothing about the demand is touched or created again.
create function public.whatsapp_retry_message(p_message_id uuid, p_actor_id uuid, p_actor_name text) returns jsonb
  language plpgsql as $$
  declare
    v_m public.whatsapp_messages%rowtype;
  begin
    select * into v_m from public.whatsapp_messages where id = p_message_id for update;
    if not found then raise exception 'Message not found.' using errcode = 'P0002'; end if;
    if v_m.direction <> 'outbound' or v_m.status <> 'failed' then
      raise exception 'Only a failed outgoing message can be retried.' using errcode = 'P0001';
    end if;
    -- Meta accepted it and reported the failure later, by webhook. By then the
    -- supplier link in it was masked (only its hash is kept), so resending the
    -- same row would deliver a dead link. A new link is a new message.
    if exists (select 1 from public.whatsapp_outbox
                where message_id = p_message_id and status = 'done' and masked_text_body is not null) then
      raise exception 'This message carried a supplier link, which is not kept once WhatsApp accepts it. Use "Resend link" on the demand to send a new one.'
        using errcode = 'P0001';
    end if;
    update public.whatsapp_outbox
       set status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = null
     where message_id = p_message_id;
    if not found then
      raise exception 'This message has nothing left to resend.' using errcode = 'P0001';
    end if;
    update public.whatsapp_messages
       set status = 'queued', failed_at = null
     where id = p_message_id;
    if v_m.demand_id is not null then
      perform app.purchase_event(v_m.demand_id, 'message_retried', null, null, 'staff', p_actor_id, p_actor_name,
        p_details => jsonb_build_object('messageId', p_message_id));
    end if;
    return (select to_jsonb(m) from public.whatsapp_messages m where m.id = p_message_id);
  end;
  $$;

-- A delivery receipt. Statuses only move forward (a late 'sent' does not undo
-- 'read'); 'failed' lands whenever it comes, since Meta reports it last.
create function public.whatsapp_apply_status(
  p_provider_message_id text, p_status text, p_at timestamptz, p_error_code text, p_error_title text, p_error_detail text
) returns boolean
  language plpgsql as $$
  declare
    v_rank_new int := case p_status when 'sent' then 2 when 'delivered' then 3 when 'read' then 4 else 0 end;
    v_m public.whatsapp_messages%rowtype;
  begin
    select * into v_m from public.whatsapp_messages where provider_message_id = p_provider_message_id for update;
    if not found then return false; end if;
    if p_status = 'failed' then
      update public.whatsapp_messages
         set status = 'failed', failed_at = p_at, error_code = p_error_code, error_title = p_error_title, error_detail = p_error_detail
       where id = v_m.id;
      return true;
    end if;
    if v_rank_new = 0 then return false; end if;
    update public.whatsapp_messages
       set status = case
                      when v_rank_new > (case status when 'accepted' then 1 when 'sent' then 2 when 'delivered' then 3
                                                     when 'read' then 4 else 0 end)
                      then p_status else status end,
           sent_at = coalesce(sent_at, case when v_rank_new >= 2 then p_at end),
           delivered_at = coalesce(delivered_at, case when v_rank_new >= 3 then p_at end),
           read_at = coalesce(read_at, case when v_rank_new >= 4 then p_at end)
     where id = v_m.id and status <> 'failed';
    return true;
  end;
  $$;

-- An inbound message. p: {providerMessageId, waId, profileName, type, body,
-- media, replyToProviderId, phoneNumberId, at}. Matched to a supplier by the
-- sender's number only; to a demand by the message it replies to, or else by
-- the supplier's one open demand. Anything less certain is left unmatched
-- for a person. Matching never changes a demand.
create function public.whatsapp_record_inbound(p jsonb) returns jsonb
  language plpgsql as $$
  declare
    v_conv    uuid;
    v_sup     uuid;
    v_demand  uuid;
    v_id      uuid;
    v_open    int;
    v_match   text;
  begin
    select id into v_id from public.whatsapp_messages where provider_message_id = p ->> 'providerMessageId';
    if found then return jsonb_build_object('id', v_id, 'duplicate', true); end if;

    select id into v_sup from public.suppliers
     where whatsapp_number = '+' || (p ->> 'waId') and deleted_at is null;

    insert into public.whatsapp_conversations (wa_id, supplier_id, profile_name)
    values (p ->> 'waId', v_sup, p ->> 'profileName')
    on conflict (wa_id) do update
      set supplier_id = coalesce(excluded.supplier_id, public.whatsapp_conversations.supplier_id),
          profile_name = coalesce(excluded.profile_name, public.whatsapp_conversations.profile_name)
    returning id, supplier_id into v_conv, v_sup;

    if p ->> 'replyToProviderId' is not null then
      select demand_id into v_demand from public.whatsapp_messages
       where provider_message_id = p ->> 'replyToProviderId' and conversation_id = v_conv;
    end if;
    if v_demand is null and v_sup is not null then
      select count(*), min(id::text)::uuid into v_open, v_demand
        from public.purchase_demands
       where supplier_id = v_sup
         and status in ('awaiting_supplier', 'quotation_received', 'changes_requested', 'awaiting_supplier_bill',
                        'bill_submitted', 'awaiting_delivery', 'partially_received');
      if v_open <> 1 then v_demand := null; end if;
    end if;
    v_match := case when v_sup is not null and v_demand is not null then 'matched' else 'unmatched' end;

    insert into public.whatsapp_messages
      (conversation_id, direction, provider, provider_message_id, type, body, media, status, demand_id, supplier_id,
       reply_to_provider_id, match_status, phone_number_id, provider_timestamp)
    values
      (v_conv, 'inbound', 'meta', p ->> 'providerMessageId', coalesce(p ->> 'type', 'text'), p ->> 'body', p -> 'media',
       'received', v_demand, v_sup, p ->> 'replyToProviderId', v_match, p ->> 'phoneNumberId',
       coalesce((p ->> 'at')::timestamptz, now()))
    returning id into v_id;

    update public.whatsapp_conversations
       set last_inbound_at = greatest(coalesce(last_inbound_at, '-infinity'), coalesce((p ->> 'at')::timestamptz, now())),
           last_message_at = now(), unread_count = unread_count + 1
     where id = v_conv;

    if v_demand is not null then
      perform app.purchase_event(v_demand, 'message_received', null, null, 'supplier', null,
        (select name from public.suppliers where id = v_sup), p_details => jsonb_build_object('messageId', v_id));
    end if;
    return jsonb_build_object('id', v_id, 'duplicate', false, 'matchStatus', v_match,
                              'supplierId', v_sup, 'demandId', v_demand);
  end;
  $$;

-- A person ties an unmatched message to a supplier and/or demand, or dismisses it.
create function public.whatsapp_review_message(
  p_message_id uuid, p_action text, p_supplier_id uuid, p_demand_id uuid, p_actor_id uuid, p_actor_name text
) returns jsonb
  language plpgsql as $$
  declare
    v_m   public.whatsapp_messages%rowtype;
    v_sup uuid;
  begin
    select * into v_m from public.whatsapp_messages where id = p_message_id for update;
    if not found or v_m.direction <> 'inbound' then raise exception 'Message not found.' using errcode = 'P0002'; end if;
    if p_action = 'assign' then
      if p_demand_id is null and p_supplier_id is null then
        raise exception 'Choose a supplier or a demand.' using errcode = '22023';
      end if;
      if p_demand_id is not null then
        select supplier_id into v_sup from public.purchase_demands where id = p_demand_id;
        if not found then raise exception 'Demand not found.' using errcode = 'P0002'; end if;
        if p_supplier_id is not null and p_supplier_id <> v_sup then
          raise exception 'That demand belongs to another supplier.' using errcode = '22023';
        end if;
      else
        v_sup := p_supplier_id;
      end if;
      -- The sender's number already names a supplier: what they wrote can only
      -- be filed under them. Only a message from an unknown number may be
      -- given a supplier by a person.
      if v_m.supplier_id is not null and v_m.supplier_id <> v_sup then
        raise exception 'This message came from another supplier''s number; it can only be assigned to that supplier''s demands.'
          using errcode = '22023';
      end if;
      update public.whatsapp_messages
         set match_status = 'assigned',
             demand_id = coalesce(p_demand_id, demand_id),
             supplier_id = v_sup,
             reviewed_by = p_actor_id, reviewed_by_name = p_actor_name, reviewed_at = now()
       where id = p_message_id;
      if p_demand_id is not null then
        perform app.purchase_event(p_demand_id, 'message_assigned', null, null, 'staff', p_actor_id, p_actor_name,
          p_details => jsonb_build_object('messageId', p_message_id));
      end if;
    elsif p_action = 'dismiss' then
      update public.whatsapp_messages
         set match_status = 'dismissed', reviewed_by = p_actor_id, reviewed_by_name = p_actor_name, reviewed_at = now()
       where id = p_message_id;
    else
      raise exception 'Unknown action %.', p_action using errcode = '22023';
    end if;
    return (select to_jsonb(m) from public.whatsapp_messages m where m.id = p_message_id);
  end;
  $$;

-- A staff reply in an open conversation (clarification, a nudge). Queued like
-- every other message; the worker decides text vs template at send time.
create function public.whatsapp_queue_reply(p_message jsonb, p_actor_id uuid, p_actor_name text) returns jsonb
  language plpgsql as $$
  declare v_id uuid;
  begin
    v_id := app.enqueue_whatsapp(p_message, p_actor_id, p_actor_name);
    if nullif(p_message ->> 'demandId', '') is not null then
      perform app.purchase_event((p_message ->> 'demandId')::uuid, 'message_sent', null, null, 'staff',
        p_actor_id, p_actor_name, p_details => jsonb_build_object('messageId', v_id));
    end if;
    return (select to_jsonb(m) from public.whatsapp_messages m where m.id = v_id);
  end;
  $$;

-- Supplier link → its demand, refusing anything revoked or expired; counts the use.
create function public.supplier_token_resolve(p_hash text) returns jsonb
  language plpgsql as $$
  declare v_t public.supplier_access_tokens%rowtype;
  begin
    select * into v_t from public.supplier_access_tokens where token_hash = p_hash for update;
    if not found then return jsonb_build_object('status', 'invalid'); end if;
    if v_t.revoked_at is not null then
      return jsonb_build_object('status', 'revoked', 'reason', v_t.revoked_reason);
    end if;
    if v_t.expires_at < now() then return jsonb_build_object('status', 'expired'); end if;
    update public.supplier_access_tokens set last_used_at = now(), use_count = use_count + 1 where id = v_t.id;
    return jsonb_build_object('status', 'ok', 'tokenId', v_t.id, 'demandId', v_t.demand_id, 'expiresAt', v_t.expires_at);
  end;
  $$;

-- What a supplier owes / is owed, computed on read: approved bills minus
-- posted payments, and active credit minus posted repayments.
create function public.supplier_balances(p_supplier_id uuid default null)
returns table (
  supplier_id uuid, supplier_name text, billed numeric, paid numeric, outstanding numeric,
  credit_approved numeric, credit_repaid numeric, credit_outstanding numeric, pending_payments numeric
)
  language sql stable as $$
  select s.id, s.name,
         coalesce(b.billed, 0), coalesce(p.paid, 0), coalesce(b.billed, 0) - coalesce(p.paid, 0),
         coalesce(c.approved, 0), coalesce(c.repaid, 0), coalesce(c.approved, 0) - coalesce(c.repaid, 0),
         coalesce(p.pending, 0)
    from public.suppliers s
    left join (
      select d.supplier_id, sum(bl.grand_total) billed
        from public.purchase_bills bl join public.purchase_demands d on d.id = bl.demand_id
       where bl.status = 'approved' group by d.supplier_id) b on b.supplier_id = s.id
    left join (
      select sp.supplier_id,
             sum(sp.amount) filter (where sp.status = 'posted') paid,
             sum(sp.amount) filter (where sp.status = 'pending_approval') pending
        from public.supplier_payments sp group by sp.supplier_id) p on p.supplier_id = s.id
    left join (
      select sc.supplier_id, sum(sc.approved_amount) approved,
             sum((select coalesce(sum(x.amount), 0) from public.supplier_payments x
                   where x.credit_id = sc.id and x.status = 'posted')) repaid
        from public.supplier_credits sc where sc.status in ('active', 'settled') group by sc.supplier_id) c
      on c.supplier_id = s.id
   where s.deleted_at is null and (p_supplier_id is null or s.id = p_supplier_id);
  $$;

-- Queue a message that is not part of a demand transition (Production alerts).
create function public.whatsapp_enqueue(p_message jsonb, p_actor_id uuid, p_actor_name text) returns uuid
  language sql as $$
  select app.enqueue_whatsapp(p_message, p_actor_id, p_actor_name);
  $$;

-- ---------------------------------------------------------------------------
-- Reads for the WhatsApp Purchasing page
-- ---------------------------------------------------------------------------

-- One row per demand with what the list shows beside it. A view, so the list
-- pages and filters in SQL instead of loading every demand into Node.
create view public.purchase_demand_list as
select d.*,
       (select count(*) from public.purchase_demand_items i where i.demand_id = d.id)::int as item_count,
       (select q.total from public.purchase_quotations q where q.id = d.current_quotation_id) as quoted_total,
       (select b.grand_total from public.purchase_bills b where b.id = d.approved_bill_id) as bill_total,
       coalesce((select sum(p.amount) from public.supplier_payments p
                  where p.demand_id = d.id and p.status = 'posted'), 0) as paid_total,
       (select m.status from public.whatsapp_messages m
         where m.demand_id = d.id and m.direction = 'outbound'
         order by m.created_at desc limit 1) as last_message_status
  from public.purchase_demands d;

-- The page's tab counts, in one statement. The bucket rules are the same ones
-- services/purchasing/buckets.ts filters the list with; change both together.
create function public.purchase_summary() returns jsonb
  language sql stable as $$
  with d as (
    select status, priority, payment_status, approved_bill_id,
           status not in ('received', 'cancelled', 'rejected') as open
      from public.purchase_demands
  )
  select jsonb_build_object(
    'buckets', jsonb_build_object(
      'all',                (select count(*) from d),
      'pending',            (select count(*) from d where open),
      'urgent',             (select count(*) from d where open and priority = 'urgent'),
      'normal',             (select count(*) from d where open and priority = 'normal'),
      'awaiting_supplier',  (select count(*) from d where status in ('awaiting_supplier', 'changes_requested')),
      'quotation_received', (select count(*) from d where status = 'quotation_received'),
      'awaiting_approval',  (select count(*) from d where status in ('quotation_received', 'bill_submitted')),
      'approved',           (select count(*) from d where status in ('awaiting_supplier_bill', 'bill_submitted',
                                                                    'awaiting_delivery', 'partially_received', 'received')),
      'awaiting_bill',      (select count(*) from d where status = 'awaiting_supplier_bill'),
      'awaiting_delivery',  (select count(*) from d where status in ('awaiting_delivery', 'partially_received')),
      'unpaid',             (select count(*) from d where approved_bill_id is not null and status <> 'cancelled'
                                                      and payment_status in ('unpaid', 'partially_paid')),
      'completed',          (select count(*) from d where status = 'received' and payment_status = 'paid'),
      'closed',             (select count(*) from d where status in ('cancelled', 'rejected'))
    ),
    'failedMessages',     (select count(*) from public.whatsapp_messages where status = 'failed'),
    'unmatchedMessages',  (select count(*) from public.whatsapp_messages where match_status = 'unmatched'),
    'outstandingSupplierCredit', coalesce((select sum(credit_outstanding) from public.supplier_balances()), 0),
    'pendingSupplierPayments',   (select count(*) from public.supplier_payments where status = 'pending_approval')
  );
  $$;
