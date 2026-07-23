-- 27: Automatic end-of-day closing summaries + WhatsApp/SMS delivery.
--
-- After the 2 AM daily closing archives the day into business_day_closures
-- (migration 07 + services/daily-closing.service.ts), a dispatcher fans the
-- archive out into per-branch / production / company reports, then sends each
-- recipient ONLY their own summary over WhatsApp or SMS and logs every attempt.
--
-- Three API-owned tables. Like the rest of the API (and support_tickets in
-- migration 25), the service-role client bypasses RLS, so authorization lives in
-- application code: branch users are scoped to their own branch_id and production
-- users to production reports inside the route handlers. RLS is enabled here with
-- NO policy purely as default-deny defence-in-depth — nothing reaches these tables
-- except the service role.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type notification_channel        as enum ('whatsapp', 'sms', 'both');
create type notification_delivery_status as enum ('pending', 'sent', 'failed');
create type closing_report_scope        as enum ('branch', 'production', 'company');

-- ---------------------------------------------------------------------------
-- notification_recipients — who receives which summary, and over what channel.
--
-- branch_id set  → a branch recipient (gets that branch's report only).
-- department set → 'production' or 'admin' (branch_id null; a central role).
-- Primary/secondary numbers are just two active rows for the same scope.
-- ---------------------------------------------------------------------------
create table notification_recipients (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid references branches (id) on delete cascade,
  department     text,                              -- 'production' | 'admin' | null (branch)
  recipient_name text not null,
  mobile_number  text not null,                     -- E.164 preferred, e.g. +923001234567
  channel        notification_channel not null default 'whatsapp',
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Exactly one of branch_id / department identifies the scope.
  constraint notification_recipients_scope_ck
    check ((branch_id is not null) <> (department is not null))
);

create index notification_recipients_branch_idx on notification_recipients (branch_id) where active;
create index notification_recipients_dept_idx   on notification_recipients (department) where active;

create trigger notification_recipients_touch before update on notification_recipients
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- daily_closing_reports — the per-scope report fanned out from the day's archive.
--
-- report_json holds the structured summary the UI renders and the formatter turns
-- into WhatsApp/SMS text. One branch report per (date, branch); one production and
-- one company report per date. The dispatcher clears a date's rows before
-- re-inserting, so a re-run is idempotent.
-- ---------------------------------------------------------------------------
create table daily_closing_reports (
  id            uuid primary key default gen_random_uuid(),
  business_date date not null,
  scope         closing_report_scope not null,
  branch_id     uuid references branches (id) on delete cascade,
  department    text,
  report_json   jsonb not null,
  generated_at  timestamptz not null default now()
);

-- One report per (date, scope, branch): coalesce keeps production/company (null
-- branch) unique per date while allowing one row per branch.
create unique index daily_closing_reports_key
  on daily_closing_reports (business_date, scope, coalesce(branch_id::text, ''));
create index daily_closing_reports_branch_idx on daily_closing_reports (branch_id, business_date desc);

-- ---------------------------------------------------------------------------
-- notification_logs — one row per (report, recipient, channel) delivery attempt.
-- retry_count is bumped in place; status ends 'sent' or 'failed'.
-- ---------------------------------------------------------------------------
create table notification_logs (
  id                  uuid primary key default gen_random_uuid(),
  report_id           uuid references daily_closing_reports (id) on delete set null,
  recipient_id        uuid references notification_recipients (id) on delete set null,
  business_date       date,
  channel             text not null,                 -- 'whatsapp' | 'sms'
  status              notification_delivery_status not null default 'pending',
  provider            text,                          -- 'log' | 'twilio' | ...
  provider_message_id text,
  error_message       text,
  retry_count         integer not null default 0,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);

create index notification_logs_report_idx    on notification_logs (report_id);
create index notification_logs_recipient_idx on notification_logs (recipient_id, created_at desc);
create index notification_logs_status_idx    on notification_logs (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Default-deny RLS (service role bypasses; authz is in application code).
-- ---------------------------------------------------------------------------
alter table notification_recipients enable row level security;
alter table daily_closing_reports   enable row level security;
alter table notification_logs       enable row level security;

-- ---------------------------------------------------------------------------
-- Admin toggle for the whole feature (mirrors auto_close_business). Provider
-- credentials + retry policy live in server env, not here — secrets never belong
-- in a client-readable settings row.
-- ---------------------------------------------------------------------------
alter table settings
  add column if not exists closing_notifications_enabled boolean not null default false;
