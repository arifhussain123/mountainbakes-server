-- 09: Row Level Security.
--
-- READ THIS BEFORE EDITING ANY POLICY BELOW.
--
-- There are two classes of table in this schema, and they need opposite levels
-- of paranoia:
--
--   A. API-OWNED tables (everything except chat/presence/notifications). The
--      Express API reaches these with the SECRET key, which BYPASSES RLS
--      entirely. Authorization for these is enforced in application code — e.g.
--      branch managers scoped to their own branch_id, production users limited
--      to active order statuses — exactly as it was under the Firebase Admin
--      SDK, which likewise bypassed Firestore rules. The policies here are
--      DEFENCE IN DEPTH: they matter only if a publishable-key client ever
--      reaches these tables directly. Do not delete the application-level checks
--      on the strength of these policies.
--
--   B. CLIENT-OWNED tables (chats, chat_participants, chat_messages,
--      user_presence, notifications). The browser talks to these directly with
--      the user's JWT, and Realtime subscriptions are filtered by exactly these
--      policies. Here RLS is the ONLY thing standing between one user and
--      another's messages. Treat changes to these as security changes.
--
-- Every table gets RLS enabled. A table with RLS on and no policy denies all
-- access to non-secret-key callers, which is the correct default — so tables
-- that the client should never touch simply get no policy at all.

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. Default-deny.
-- ---------------------------------------------------------------------------
alter table branches                enable row level security;
alter table users                   enable row level security;
alter table categories              enable row level security;
alter table products                enable row level security;
alter table customers               enable row level security;
alter table counters                enable row level security;
alter table orders                  enable row level security;
alter table order_items             enable row level security;
alter table expenses                enable row level security;
alter table production_expenses     enable row level security;
alter table production_orders       enable row level security;
alter table production_order_items  enable row level security;
alter table production_balances     enable row level security;
alter table production_returns      enable row level security;
alter table production_stock        enable row level security;
alter table production_stock_history enable row level security;
alter table stock                   enable row level security;
alter table stock_history           enable row level security;
alter table stock_audit_log         enable row level security;
alter table product_price_history   enable row level security;
alter table price_activation_locks  enable row level security;
alter table settings                enable row level security;
alter table audit_logs              enable row level security;
alter table notifications           enable row level security;
alter table push_subscriptions      enable row level security;
alter table business_day_closures   enable row level security;
alter table chats                   enable row level security;
alter table chat_participants       enable row level security;
alter table chat_messages           enable row level security;
alter table user_presence           enable row level security;

-- No policies are defined for: counters, price_activation_locks,
-- business_day_closures, audit_logs, stock_audit_log, production_balances,
-- production_stock_history, stock_history, product_price_history.
-- These are API/job-internal and must never be reachable with a user JWT.

-- ---------------------------------------------------------------------------
-- Chat membership lookup.
--
-- This MUST be SECURITY DEFINER. Every chat policy needs to ask "is the caller a
-- participant of this chat?", which means reading chat_participants — but
-- chat_participants itself has a SELECT policy, so a plain subquery there causes
-- Postgres to re-evaluate that policy while it is already evaluating it:
--   ERROR: infinite recursion detected in policy for relation "chat_participants"
--
-- SECURITY DEFINER runs the lookup as the function owner, which bypasses RLS on
-- the inner read and breaks the cycle. search_path is pinned so the definer
-- rights cannot be hijacked by a caller-controlled search_path.
--
-- Do not "simplify" this back into an inline EXISTS on chat_participants.
-- ---------------------------------------------------------------------------
create or replace function app.is_chat_participant(target_chat_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from chat_participants
      where chat_id = target_chat_id and user_id = auth.uid()
    )
  $$;

revoke execute on function app.is_chat_participant(uuid) from public;
grant execute on function app.is_chat_participant(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Class B — client-owned. These are the load-bearing ones.
-- ---------------------------------------------------------------------------

-- Notifications: a user sees notifications addressed to them personally, or
-- broadcast to their role. Role broadcasts that carry a branch_id are further
-- narrowed to that branch, which is how a branch manager avoids seeing another
-- branch's traffic.
create policy notifications_select_own on notifications
  for select to authenticated
  using (
    target_user_id = auth.uid()
    or (
      target_role = app.jwt_role()
      and (branch_id is null or branch_id = app.jwt_branch_id())
    )
  );

-- Marking as read is the only field a client may change. Postgres has no
-- column-level restriction in a policy, so the WITH CHECK re-asserts the same
-- visibility predicate; the API should still be the only writer of anything else.
create policy notifications_update_own on notifications
  for update to authenticated
  using (target_user_id = auth.uid())
  with check (target_user_id = auth.uid());

-- Chats: visible only to participants.
create policy chats_select_participant on chats
  for select to authenticated
  using (app.is_chat_participant(chats.id));

create policy chats_insert_own on chats
  for insert to authenticated
  with check (created_by = auth.uid());

-- A participant row is visible if it is yours, or if it belongs to a chat you
-- are in. The second arm goes through the SECURITY DEFINER helper above — an
-- inline EXISTS on this same table would recurse.
create policy chat_participants_select on chat_participants
  for select to authenticated
  using (
    user_id = auth.uid()
    or app.is_chat_participant(chat_participants.chat_id)
  );

-- Updating last_read_at is the caller's own bookkeeping.
create policy chat_participants_update_own on chat_participants
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Messages: readable by participants, writable only as yourself.
create policy chat_messages_select on chat_messages
  for select to authenticated
  using (app.is_chat_participant(chat_messages.chat_id));

create policy chat_messages_insert on chat_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and app.is_chat_participant(chat_messages.chat_id)
  );

create policy chat_messages_update_own on chat_messages
  for update to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

-- Presence: everyone signed in can see who is online; you may only write your own.
create policy user_presence_select_all on user_presence
  for select to authenticated using (true);

create policy user_presence_upsert_own on user_presence
  for insert to authenticated with check (user_id = auth.uid());

create policy user_presence_update_own on user_presence
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Push subscriptions: a client registers and revokes its own.
create policy push_subscriptions_select_own on push_subscriptions
  for select to authenticated using (user_id = auth.uid());

create policy push_subscriptions_insert_own on push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());

create policy push_subscriptions_delete_own on push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Class A — defence in depth. Read-only, scoped, and intentionally narrow.
-- The API does not rely on these; they exist so a stray publishable-key read
-- cannot exfiltrate the catalogue or another branch's numbers.
-- ---------------------------------------------------------------------------

-- Own profile, always. Super admins see everyone.
create policy users_select_self on users
  for select to authenticated
  using (id = auth.uid() or app.is_super_admin());

-- Reference data is readable by any signed-in user; it is not sensitive and the
-- whole app renders from it.
create policy branches_select on branches
  for select to authenticated using (true);

create policy categories_select on categories
  for select to authenticated using (is_active or app.is_super_admin());

create policy products_select on products
  for select to authenticated using (is_active or app.is_super_admin());

create policy settings_select on settings
  for select to authenticated using (true);

-- Branch-scoped reads. Super admins are unrestricted; a branch manager is
-- confined to their own branch; production users get nothing here (their access
-- runs through the API).
create policy customers_select_branch on customers
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy orders_select_branch on orders
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy order_items_select_branch on order_items
  for select to authenticated
  using (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and (app.is_super_admin() or o.branch_id = app.jwt_branch_id())
    )
  );

create policy stock_select_branch on stock
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy expenses_select_branch on expenses
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy production_orders_select_branch on production_orders
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());

create policy production_returns_select_branch on production_returns
  for select to authenticated
  using (app.is_super_admin() or branch_id = app.jwt_branch_id());
