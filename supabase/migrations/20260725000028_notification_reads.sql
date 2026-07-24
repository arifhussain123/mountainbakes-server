-- 26: per-recipient notification read-state (cross-device).
--
-- Problem: `notifications.is_read` is a SINGLE flag per row, and RLS
-- (`notifications_update_own`, migration 09) only lets a user persist it on
-- notifications addressed to them personally. A ROLE/BRANCH broadcast row is one
-- shared row for many recipients, so no recipient can mark it read in the DB — it
-- re-appears unread on every reload, and read-state can't sync across devices.
--
-- Fix: a join table recording "user U has seen notification N". Read-state is now
-- per (notification, user), works for broadcasts, and syncs across devices via
-- Supabase Realtime. The legacy `is_read` column is left in place; the client
-- treats a notification as read if `is_read` OR a matching row exists here.

create table notification_reads (
  notification_id uuid not null references notifications (id) on delete cascade,
  user_id         uuid not null references users (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

-- The hot lookup is "all rows this user has read", to overlay onto their feed.
create index notification_reads_user_idx on notification_reads (user_id);

-- ---------------------------------------------------------------------------
-- RLS: this is a CLIENT-OWNED table (migration 09 taxonomy) — the browser reads
-- and writes it directly with the user's JWT, and Realtime is filtered by these
-- policies. A user may only ever see or create/remove their OWN read rows.
-- ---------------------------------------------------------------------------
alter table notification_reads enable row level security;

create policy notification_reads_select_own on notification_reads
  for select to authenticated
  using (user_id = auth.uid());

create policy notification_reads_insert_own on notification_reads
  for insert to authenticated
  with check (user_id = auth.uid());

-- Allow removing one's own read row (supports a future "mark unread").
create policy notification_reads_delete_own on notification_reads
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime: the client subscribes to its own read rows so a read on one device
-- clears the badge on another. Mirror migration 18's guarded add + full replica
-- identity (needed so DELETE payloads carry the old row for RLS/state sync).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notification_reads'
  ) then
    alter publication supabase_realtime add table notification_reads;
  end if;
end $$;

alter table notification_reads replica identity full;
