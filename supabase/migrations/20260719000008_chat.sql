-- 08: chat and presence.
--
-- These collections (`chats`, `userPresence`) are NOT used by the Express API —
-- they were read and written directly from the browser via the Firestore client
-- SDK, and are currently broken because that path needs a Firebase Auth session
-- the app no longer creates.
--
-- They are included here because the frontend must migrate onto Supabase
-- Realtime, and that needs tables plus RLS. Unlike every other table in this
-- schema, these are written by the CLIENT under RLS rather than by the API under
-- the secret key — so their policies in migration 09 are load-bearing security,
-- not defence in depth.

-- ---------------------------------------------------------------------------
-- chats — a DM or a group conversation.
-- ---------------------------------------------------------------------------
create table chats (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text unique,
  type            chat_type not null,
  -- Only meaningful for type = 'group'.
  group_type      group_chat_type,
  name            text,
  branch_id       uuid references branches (id) on delete set null,
  created_by      uuid references users (id) on delete set null,
  last_message_at timestamptz,
  last_message    text,                  -- preview cache for the chat list
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chats_group_has_type check (type <> 'group' or group_type is not null)
);

create index chats_recent_idx on chats (last_message_at desc nulls last);

create trigger chats_touch before update on chats
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- chat_participants — membership. This table is what every chat RLS policy
-- pivots on, so keep the (chat_id, user_id) unique constraint.
-- ---------------------------------------------------------------------------
create table chat_participants (
  id           uuid primary key default gen_random_uuid(),
  chat_id      uuid not null references chats (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz,
  constraint chat_participants_key unique (chat_id, user_id)
);

create index chat_participants_user_idx on chat_participants (user_id);

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------
create table chat_messages (
  id           uuid primary key default gen_random_uuid(),
  legacy_id    text unique,
  chat_id      uuid not null references chats (id) on delete cascade,
  sender_id    uuid references users (id) on delete set null,
  sender_name  text,                    -- snapshot; survives user deletion
  type         message_type not null default 'text',
  body         text,
  -- Populated for type in ('image', 'file'); points at Supabase Storage.
  attachment_path text,
  attachment_name text,
  attachment_size integer,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  constraint chat_messages_text_has_body
    check (type <> 'text' or body is not null)
);

create index chat_messages_chat_idx on chat_messages (chat_id, created_at desc);

-- ---------------------------------------------------------------------------
-- user_presence — was the `userPresence` collection.
--
-- One row per user, heartbeat-updated. Consider driving the online/offline
-- indicator from Supabase Realtime Presence (which is ephemeral and needs no
-- table) instead of this table; it is modelled here so the existing behaviour
-- can be ported literally first, then simplified.
-- ---------------------------------------------------------------------------
create table user_presence (
  user_id   uuid primary key references users (id) on delete cascade,
  status    presence_status not null default 'offline',
  last_seen timestamptz not null default now()
);

create index user_presence_status_idx on user_presence (status) where status <> 'offline';
