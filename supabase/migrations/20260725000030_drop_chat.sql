-- 30: Drop the chat / presence module.
--
-- The in-app chat and presence feature was removed from the client (frontend
-- 49a0b21) and from the server's shared types (ac03340). This migration removes
-- what those commits could not: the database objects themselves.
--
-- This is the correct counterpart to migration 08, which CREATED these objects.
-- Migration 08 and the chat DDL in 01/09/10 are deliberately left intact as
-- history (restored in f8d7720) — migrations are an append-only ledger of what
-- ran, not a description of the current schema. Editing them would not drop
-- anything from an already-migrated database, and it broke replay from scratch.
-- Replaying the full chain now creates chat and then drops it here, converging on
-- the same schema as the live database.
--
-- Verified empty before writing this: chats, chat_participants, chat_messages and
-- user_presence all held 0 rows, and the chat-attachments bucket held no objects.
-- Nothing is being discarded.

-- ---------------------------------------------------------------------------
-- Storage: drop the chat-attachment policies (they call app.is_chat_participant,
-- so they must go before the function below).
--
-- The BUCKET itself is not removed here. Supabase rejects direct DML on both
-- storage.objects and storage.buckets ("Direct deletion from storage tables is
-- not allowed. Use the Storage API instead", SQLSTATE 42501), which aborts and
-- rolls back the entire migration. The `chat-attachments` bucket is therefore
-- removed out-of-band via the Storage API:
--
--   supabaseAdmin.storage.deleteBucket('chat-attachments')
--
-- It was verified empty (0 objects) beforehand. Consequence for a from-scratch
-- replay: migration 10 recreates the bucket and nothing here removes it, so a
-- freshly built database keeps one empty, unused, policy-less bucket. That is
-- cosmetic — no policies and no code reference it.
-- ---------------------------------------------------------------------------
drop policy if exists chat_attachments_read  on storage.objects;
drop policy if exists chat_attachments_write on storage.objects;

-- ---------------------------------------------------------------------------
-- Tables. CASCADE clears the RLS policies, indexes, triggers and FKs that hang
-- off them; order still runs child → parent so the intent stays readable.
-- ---------------------------------------------------------------------------
drop table if exists chat_messages     cascade;
drop table if exists chat_participants cascade;
drop table if exists chats             cascade;
drop table if exists user_presence     cascade;

-- ---------------------------------------------------------------------------
-- The membership helper (migration 09). Dropped after the policies that call it.
-- ---------------------------------------------------------------------------
drop function if exists app.is_chat_participant(uuid);

-- ---------------------------------------------------------------------------
-- Enums (migration 01). Safe only once every column using them is gone, which
-- the table drops above guarantee.
-- ---------------------------------------------------------------------------
drop type if exists message_type;
drop type if exists group_chat_type;
drop type if exists chat_type;
drop type if exists presence_status;
