-- 18: enable Supabase Realtime on the notifications feed.
--
-- Migration 07 documents `notifications` as "the table the client subscribes to
-- via Supabase Realtime", and the RealtimeProvider now does exactly that. For
-- the server to broadcast row changes, the table must belong to the
-- `supabase_realtime` publication.
--
-- RLS (migration 09) still governs which rows each subscriber receives — a user
-- only gets changes to notifications addressed to them personally or broadcast
-- to their role/branch.
--
-- Idempotent: if the table was already added via the Studio dashboard, the
-- guard skips the ALTER instead of erroring on "already a member".

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table notifications;
  end if;
end $$;

-- UPDATE/DELETE realtime payloads need the full old row to evaluate RLS and to
-- carry changed columns; default replica identity only ships the primary key.
alter table notifications replica identity full;
