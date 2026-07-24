-- 25: Support tickets — the Help Desk → Support Center query queue.
--
-- Branches and the production kitchen raise a query against a specific reference
-- ID (a sale MB-######, an expense EXP-######, or a product's stock STK-######).
-- The query, plus a snapshot of that reference's figures at submit time, lands in
-- support_tickets. Admins resolve, reject, or correct the figures from the Support
-- Center; the raising side keeps seeing the ticket until it is resolved/rejected.
--
-- API-owned table (see migration 09's taxonomy): RLS is enabled with NO policy so
-- the service-role API is the only reader/writer. Authorization is in app code.

-- ---------------------------------------------------------------------------
-- Ticket numbers: SUP-000001. Same gapless counter-row pattern as order numbers
-- (migration 03) and the entity id numbers (migration 24) — a sequence is
-- deliberately avoided because it leaves gaps on rollback.
-- ---------------------------------------------------------------------------
insert into counters (id, count) values ('support', 0) on conflict (id) do nothing;

create or replace function next_ticket_number() returns text
  language plpgsql as $$
  declare next_count bigint;
  begin
    update counters set count = count + 1 where id = 'support' returning count into next_count;
    if not found then raise exception 'counters row "support" is missing'; end if;
    return 'SUP-' || lpad(next_count::text, 6, '0');
  end;
  $$;

-- ---------------------------------------------------------------------------
-- support_tickets
-- ---------------------------------------------------------------------------
create table support_tickets (
  id                 uuid primary key default gen_random_uuid(),
  ticket_number      text not null unique default next_ticket_number(),
  reference_type     text not null,              -- 'sale' | 'expense' | 'stock'
  reference_id       text not null,              -- MB-###### / EXP-###### / STK-######
  reference_snapshot jsonb,                      -- detail auto-captured at submit time
  message            text not null,
  status             text not null default 'open',   -- 'open' | 'resolved' | 'rejected'
  resolution_note    text,
  branch_id          uuid references branches (id) on delete set null,
  branch_name        text,
  raised_by          uuid references users (id) on delete set null,
  raised_by_name     text,
  raised_by_role     text,
  resolved_by        uuid references users (id) on delete set null,
  resolved_by_name   text,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Support Center reads the open queue newest-first; the raiser reads their own.
create index support_tickets_status_idx on support_tickets (status, created_at desc);
create index support_tickets_raised_idx on support_tickets (raised_by, created_at desc);
create index support_tickets_branch_idx on support_tickets (branch_id, created_at desc);

create trigger support_tickets_touch before update on support_tickets
  for each row execute function app.touch_updated_at();

alter table support_tickets enable row level security;

-- ---------------------------------------------------------------------------
-- Notification types for the Help Desk ↔ Support Center round-trip. ADD VALUE is
-- safe here: the new values are not referenced within this migration, only by
-- runtime notify() calls in later transactions (same approach as migration 14).
-- ---------------------------------------------------------------------------
alter type notification_type add value if not exists 'support_query';
alter type notification_type add value if not exists 'support_resolved';
