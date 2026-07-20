-- Mountain Bakes — Postgres schema
-- 01: enum types, shared helper functions, common column conventions.
--
-- Conventions used throughout this schema:
--   * snake_case columns (the app layer maps to/from its camelCase TS types).
--   * All instants are `timestamptz`. The legacy system stored these inconsistently —
--     seed.ts wrote native timestamp objects while every route wrote ISO-8601
--     strings into the same field. The ETL normalises both into timestamptz.
--   * Business dates ('YYYY-MM-DD', Asia/Karachi, 2 AM rollover) are `date`.
--     Do NOT use now()::date for these — the business day boundary is 02:00
--     Karachi, so the app must keep computing them via shared/utils/timezone.ts
--     and pass them in explicitly.
--   * Money is `numeric(14,2)`, never float. The legacy system stored these as JS
--     numbers; customers.total_spent in particular was accumulating float drift.
--   * Quantities are `numeric(14,3)` and are allowed to go negative where the
--     old code allowed it (see comments on the individual stock tables).
--   * Every table carries `legacy_id text unique` — the original external
--     record ID. This is what lets the ETL rebuild relationships across
--     collections. It is intentionally kept after cutover so historical
--     references and support queries still resolve; drop it only once the
--     legacy system is decommissioned.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums. Values mirror the string unions in src/shared/types/*.ts exactly.
-- Keep both in sync — the Zod schemas validate against the TS unions, and a
-- drift here surfaces as a runtime 22P02 (invalid_text_representation).
-- ---------------------------------------------------------------------------

create type user_role         as enum ('super_admin', 'branch_manager', 'production_user');
create type user_status       as enum ('active', 'inactive', 'suspended');

create type order_status      as enum ('pending', 'preparing', 'ready', 'delivered', 'cancelled');
create type payment_method    as enum ('cash', 'easypaisa', 'foodpanda', 'bank_account');

-- Shop expenses accept a narrower set than orders do.
create type expense_payment_method            as enum ('cash', 'easypaisa');
create type production_expense_payment_method as enum ('cash', 'easypaisa', 'bank_account');

create type branch_production_order_status as enum ('pending', 'approved', 'rejected');
create type production_return_status       as enum ('pending', 'accepted', 'rejected');

create type stock_movement_type            as enum ('sale', 'production', 'return', 'adjustment');
create type production_stock_movement_type as enum ('prepare', 'transfer_out', 'return_in');

create type price_change_status as enum ('scheduled', 'active', 'superseded');
create type price_change_source as enum ('manual', 'import');

create type closure_status  as enum ('running', 'success', 'failed');
create type closure_trigger as enum ('scheduler', 'manual');

create type notification_type as enum (
  'order_created', 'order_ready', 'order_cancelled', 'low_stock',
  'new_user', 'branch_added', 'price_changed',
  'production_demand', 'production_reviewed', 'production_return'
);

create type chat_type       as enum ('dm', 'group');
create type group_chat_type as enum ('admin_only', 'production_team', 'all_branch_managers', 'custom');
create type message_type    as enum ('text', 'image', 'file', 'system');
create type presence_status as enum ('online', 'offline', 'away');

create type app_theme as enum ('light', 'dark');

-- ---------------------------------------------------------------------------
-- JWT claim accessors, used by the RLS policies in migration 09.
--
-- Role and branch live in the Supabase user's app_metadata (server-controlled,
-- embedded in the access token) — mirroring the old system's custom claims.
-- These are STABLE, not IMMUTABLE: they read per-statement request state.
-- ---------------------------------------------------------------------------

create schema if not exists app;

create or replace function app.jwt_role() returns user_role
  language sql stable
  as $$
    select nullif(
      current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role',
      ''
    )::user_role
  $$;

create or replace function app.jwt_branch_id() returns uuid
  language sql stable
  as $$
    select nullif(
      current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'branchId',
      ''
    )::uuid
  $$;

create or replace function app.is_super_admin() returns boolean
  language sql stable
  as $$ select app.jwt_role() = 'super_admin' $$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance. The legacy system had the app write updated_at by hand on
-- every mutation, which was easy to forget; a trigger makes it unconditional.
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at() returns trigger
  language plpgsql
  as $$
  begin
    new.updated_at := now();
    return new;
  end;
  $$;
