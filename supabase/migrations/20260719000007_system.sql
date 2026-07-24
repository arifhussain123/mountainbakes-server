-- 07: settings, audit log, notifications, web-push subscriptions, and the
-- business-day closure archive.

-- ---------------------------------------------------------------------------
-- settings — a singleton. The legacy system used a fixed record id 'app'; the check
-- constraint below enforces that there can only ever be one row.
-- ---------------------------------------------------------------------------
create table settings (
  id                   boolean primary key default true,
  company_name         text,
  logo_url             text,
  logo_path            text,
  currency             text not null default 'PKR',
  currency_symbol      text not null default 'Rs',
  gst_rate             numeric(6,3) not null default 0,
  gst_enabled          boolean not null default false,
  receipt_footer       text,
  theme                app_theme not null default 'light',
  -- Clock times as 'HH:MM' strings. NOT timestamps: the order window is allowed
  -- to wrap past midnight, and these are compared by isWithinOrderWindow(), not
  -- by Postgres. Keep them text so the wrap logic stays in one place.
  business_start_time  text,
  business_closing_time text,
  order_start_time     text,
  order_end_time       text,
  auto_close_business  boolean not null default true,
  auto_stock_closing   boolean not null default true,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references users (id) on delete set null,
  constraint settings_singleton check (id)
);

create trigger settings_touch before update on settings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs — admin actions against users. Append-only.
-- ---------------------------------------------------------------------------
create table audit_logs (
  id                uuid primary key default gen_random_uuid(),
  legacy_id         text unique,
  action            text not null,
  admin_id          uuid references users (id) on delete set null,
  admin_name        text,
  target_user_id    uuid references users (id) on delete set null,
  target_user_name  text,
  target_user_role  user_role,
  details           jsonb,
  created_at        timestamptz not null default now()
);

create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_target_idx  on audit_logs (target_user_id) where target_user_id is not null;

-- ---------------------------------------------------------------------------
-- notifications — the durable in-app feed.
--
-- Targeting is either a specific user OR a role (optionally narrowed to a
-- branch). Exactly one of target_user_id / target_role must be set; the check
-- makes the old convention explicit.
--
-- This is the table the client subscribes to via Supabase Realtime, replacing
-- the legacy realtime listener. Realtime respects RLS, so the policies in
-- migration 09 are what scope each user's feed.
-- ---------------------------------------------------------------------------
create table notifications (
  id             uuid primary key default gen_random_uuid(),
  legacy_id      text unique,
  type           notification_type not null,
  title          text not null,
  message        text not null,
  is_read        boolean not null default false,
  target_user_id uuid references users (id) on delete cascade,
  target_role    user_role,
  branch_id      uuid references branches (id) on delete cascade,
  related_id     uuid,
  created_at     timestamptz not null default now(),
  constraint notifications_target_present
    check (target_user_id is not null or target_role is not null)
);

create index notifications_user_idx   on notifications (target_user_id, created_at desc)
  where target_user_id is not null;
create index notifications_role_idx   on notifications (target_role, branch_id, created_at desc)
  where target_role is not null;
create index notifications_unread_idx on notifications (target_user_id) where not is_read;

-- ---------------------------------------------------------------------------
-- push_subscriptions — REPLACES the legacy device-token collection.
--
-- The legacy push provider has no Supabase equivalent, so push moves to the Web
-- Push protocol (VAPID). The shape changes accordingly: the old provider identified a device
-- by a single opaque token string, whereas Web Push needs the full subscription
-- triple — endpoint URL plus the p256dh and auth keys used to encrypt the
-- payload. Existing device tokens CANNOT be converted; every client must re-subscribe
-- after the switch, so expect this table to start empty regardless of ETL.
--
-- endpoint is the natural unique key (one row per browser install).
--
-- Two behaviours from push.service.ts must be preserved in the port:
--   * Payloads stay DATA-ONLY. The service worker renders the notification
--     itself; including a display payload produces duplicate notifications.
--   * Dead subscriptions self-heal. The old provider pruned tokens on specific error codes;
--     Web Push signals the same with HTTP 404/410 from the push service, at
--     which point the row must be deleted.
-- ---------------------------------------------------------------------------
create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  role        user_role not null,      -- denormalised for role-fan-out queries
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

create index push_subscriptions_user_idx on push_subscriptions (user_id);
create index push_subscriptions_role_idx on push_subscriptions (role);

-- ---------------------------------------------------------------------------
-- business_day_closures — one row per closed business day. Doubles as the
-- distributed lock for the 02:00 closing job (see the lock notes in migration 06).
--
-- The four summary aggregates stay JSONB rather than being normalised into child
-- tables. This is deliberate: they are immutable archival snapshots, never
-- queried by their internal fields, and their shape (SalesSummary,
-- ExpenseSummary, ProductionSummary, StockSnapshotBranch[]) is already defined
-- and validated in src/shared/types/business-day.types.ts. Normalising them
-- would duplicate that contract in SQL for no read benefit.
-- ---------------------------------------------------------------------------
create table business_day_closures (
  business_date               date primary key,
  status                      closure_status not null,
  trigger                     closure_trigger not null,
  closed_by                   text,        -- 'System Scheduler' or an admin email
  auto_stock_closing          boolean not null default false,
  sales_summary               jsonb,
  expense_summary             jsonb,
  production_expense_summary  jsonb,
  production_summary          jsonb,
  stock_snapshot              jsonb,
  error                       text,
  started_at                  timestamptz not null default now(),
  closed_at                   timestamptz,
  duration_ms                 integer
);

-- The closure list previously loaded every document and filtered in memory.
create index business_day_closures_date_idx on business_day_closures (business_date desc);
create index business_day_closures_stale_idx on business_day_closures (started_at)
  where status = 'running';
