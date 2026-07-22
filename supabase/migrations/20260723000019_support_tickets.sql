-- 19: Support / Query ticket system.
--
-- Branch and Production users raise support tickets to the Admin. Each ticket
-- has a unique per-day number (MBQ-YYYYMMDD-000001), a threaded message log, an
-- audit history, and optional attachments (stored in the support-attachments
-- bucket, migration 20). Authorization is enforced in application code
-- (requireRole + per-handler branch/role scoping) exactly like the rest of the
-- API; RLS here is default-deny defence-in-depth — the client reads tickets
-- through the API and receives live updates via the notifications channel, so it
-- never subscribes to these tables directly.

-- ---------------------------------------------------------------------------
-- Enums. Values mirror the TS unions in
-- src/shared/types/support-ticket.types.ts exactly (a drift surfaces as 22P02).
-- ---------------------------------------------------------------------------
create type ticket_status   as enum ('open', 'in_progress', 'waiting_user', 'resolved', 'closed', 'reopened');
create type ticket_priority as enum ('low', 'medium', 'high', 'urgent');

-- NOTE: the `ticket_*` notification_type values are added in a SEPARATE migration
-- (20260723000021_ticket_notification_enum.sql). `ALTER TYPE ... ADD VALUE` cannot
-- run in the same transaction block as the rest of this migration (and the Supabase
-- SQL editor wraps a multi-statement script in one transaction), so keeping it here
-- would abort and roll back the whole file. The app raises ticket notifications
-- best-effort (notifySafe), so this migration is fully functional without them.
--
-- Ticket numbers (MBQ-YYYYMMDD-000001) are allocated in application code
-- (src/utils/ticketNumber.ts) with an insert-retry on the ticket_no UNIQUE
-- constraint — no Postgres function is required.

-- ---------------------------------------------------------------------------
-- support_ticket_categories
--
-- Admin-editable reference list (mirrors the product `categories` table). Seeded
-- with the standard set below; the Admin category-management UI (Phase 3) will
-- add/deactivate rows. Deactivating (is_active=false) rather than deleting keeps
-- historical tickets' category_name intact.
-- ---------------------------------------------------------------------------
create table support_ticket_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index support_ticket_categories_active_idx
  on support_ticket_categories (sort_order, name) where is_active;

create trigger support_ticket_categories_touch before update on support_ticket_categories
  for each row execute function app.touch_updated_at();

insert into support_ticket_categories (name, slug, sort_order) values
  ('Product',         'product',         10),
  ('Stock',           'stock',           20),
  ('Sale',            'sale',            30),
  ('Expense',         'expense',         40),
  ('Production',      'production',      50),
  ('Delivery',        'delivery',        60),
  ('Payment',         'payment',         70),
  ('User Account',    'user-account',    80),
  ('Printer',         'printer',         90),
  ('Software Bug',    'software-bug',    100),
  ('Feature Request', 'feature-request', 110),
  ('Other',           'other',           120);

-- ---------------------------------------------------------------------------
-- support_tickets
--
-- created_by_* / branch / category_name are denormalised at creation time so the
-- list and reports never need to join back to users/branches/categories. branch_id
-- is null for production users (a central role with no branch, like elsewhere).
-- deleted_at is a soft-delete tombstone (Phase 2); the list filters it out.
-- ---------------------------------------------------------------------------
create table support_tickets (
  id               uuid primary key default gen_random_uuid(),
  ticket_no        text not null unique,
  created_by       uuid references users (id) on delete set null,
  created_by_name  text,
  created_by_role  user_role,
  branch_id        uuid references branches (id) on delete set null,
  department       text,
  category_id      uuid references support_ticket_categories (id) on delete set null,
  category_name    text,
  subject          text not null,
  description      text not null,
  priority         ticket_priority not null default 'medium',
  status           ticket_status not null default 'open',
  assigned_to      uuid references users (id) on delete set null,
  assigned_to_name text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  deleted_at       timestamptz
);

create index support_tickets_status_idx  on support_tickets (status)     where deleted_at is null;
create index support_tickets_branch_idx   on support_tickets (branch_id, created_at desc) where deleted_at is null;
create index support_tickets_creator_idx  on support_tickets (created_by, created_at desc);
create index support_tickets_recent_idx   on support_tickets (created_at desc) where deleted_at is null;

create trigger support_tickets_touch before update on support_tickets
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- support_ticket_messages — the threaded conversation (requester ⇄ admin).
-- ---------------------------------------------------------------------------
create table support_ticket_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references support_tickets (id) on delete cascade,
  sender_id   uuid references users (id) on delete set null,
  sender_name text,
  sender_role user_role,
  message     text not null,
  created_at  timestamptz not null default now()
);

create index support_ticket_messages_thread_idx
  on support_ticket_messages (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- support_ticket_attachments — metadata for files in the (private)
-- support-attachments bucket. The file is served via a server-minted signed URL,
-- never a public URL, so only storage_path is persisted.
-- ---------------------------------------------------------------------------
create table support_ticket_attachments (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references support_tickets (id) on delete cascade,
  message_id   uuid references support_ticket_messages (id) on delete cascade,
  storage_path text not null,
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index support_ticket_attachments_ticket_idx
  on support_ticket_attachments (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- support_ticket_history — the audit trail. Every mutation appends a row
-- (created, reply_added, priority_changed, status_changed, assigned, resolved,
-- reopened, deleted) with the before/after value.
-- ---------------------------------------------------------------------------
create table support_ticket_history (
  id                uuid primary key default gen_random_uuid(),
  ticket_id         uuid not null references support_tickets (id) on delete cascade,
  action            text not null,
  old_value         text,
  new_value         text,
  performed_by      uuid references users (id) on delete set null,
  performed_by_name text,
  performed_at      timestamptz not null default now()
);

create index support_ticket_history_ticket_idx
  on support_ticket_history (ticket_id, performed_at);

-- ---------------------------------------------------------------------------
-- RLS. The API uses the service-role client (bypasses RLS); these are
-- default-deny defence-in-depth. Categories are harmless read-only reference
-- data, so authenticated users may SELECT them directly if ever needed.
-- ---------------------------------------------------------------------------
alter table support_tickets            enable row level security;
alter table support_ticket_messages    enable row level security;
alter table support_ticket_attachments enable row level security;
alter table support_ticket_history     enable row level security;
alter table support_ticket_categories  enable row level security;

create policy support_ticket_categories_read on support_ticket_categories
  for select to authenticated using (true);
