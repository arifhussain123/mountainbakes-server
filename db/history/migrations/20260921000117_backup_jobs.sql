-- 117: database backup job ledger + distributed lock for the pg_dump → S3 system.
--
-- The backup system (src/services/backup/, run on a schedule as
-- `pnpm backup:daily|weekly|monthly` and by super admins from the Database
-- Backup screen) needs two things from Postgres that neither S3 nor a process
-- can give it:
--
--   1. A LOCK that works across processes and machines. A scheduled job can run
--      in its own process, and an admin can trigger a manual run from the API
--      at the same moment. An in-memory flag cannot see across
--      those; a transaction-scoped advisory lock cannot outlive one PostgREST
--      call, and a dump takes minutes. So the lock is a ROW: at most one
--      'running' row per backup_type, enforced by a partial unique index, and
--      claimed atomically by claim_backup_job() (the same shape as
--      claim_business_day_closure in migration 17).
--
--   2. A LEDGER the status screen, the health endpoint and the CLI can read
--      without listing S3. Every run — successful or not — is one row. The
--      authoritative copy of each successful backup's metadata is ALSO written
--      to S3 as an immutable manifest (database-backups/manifests/…), so a lost
--      database does not lose the record of its own backups; this table is the
--      fast, queryable mirror.
--
-- Statuses (text + check, not an enum, so this file and its first use can ship
-- in ONE `db push` — see DEPLOY.md on 55P04):
--   running   claimed, dump/upload in progress
--   success   dump uploaded and manifest written (transitional — the runner
--             immediately re-reads the objects and flips to 'verified')
--   verified  S3 HeadObject size + stored SHA-256 confirmed after upload
--   failed    any step failed; error_category/error_message say which
--   stale     a 'running' row older than the stale window when a newer claim
--             arrived (server was killed mid-run); treated as failed
--
-- Never stored here: the database URL, AWS keys, or any raw error text that
-- could contain them — the runner redacts before writing error_message.

create table public.backup_jobs (
  id                    uuid primary key default gen_random_uuid(),
  backup_id             text not null unique,
  backup_type           text not null check (backup_type in ('daily', 'weekly', 'monthly', 'manual')),
  status                text not null check (status in ('running', 'success', 'verified', 'failed', 'stale')),
  trigger               text not null check (trigger in ('scheduler', 'manual', 'api')),
  environment           text not null,
  app_version           text,
  database_version      text,
  pg_dump_version       text,
  started_at            timestamptz not null default now(),
  completed_at          timestamptz,
  duration_ms           integer,
  dump_ms               integer,
  upload_ms             integer,
  s3_bucket             text not null,
  s3_key                text,
  auth_s3_key           text,
  manifest_s3_key       text,
  file_size             bigint,
  auth_file_size        bigint,
  checksum_sha256       text,
  auth_checksum_sha256  text,
  retention_until       timestamptz,
  attempts              integer not null default 1,
  error_category        text,
  error_message         text,
  triggered_by          uuid references public.users (id) on delete set null,
  triggered_by_name     text,
  last_verified_at      timestamptz,
  created_at            timestamptz not null default now()
);

comment on table public.backup_jobs is
  'One row per pg_dump → S3 backup run (daily/weekly/monthly/manual). The partial unique index on (backup_type) where status = running is the cross-dyno lock. Service role only.';

-- THE lock: two 'running' rows for one type cannot coexist, whatever the caller does.
create unique index backup_jobs_one_running_per_type
  on public.backup_jobs (backup_type)
  where status = 'running';

-- Status screen / health: newest run per type, and "latest verified per type".
create index backup_jobs_type_started_idx on public.backup_jobs (backup_type, started_at desc);
create index backup_jobs_status_idx       on public.backup_jobs (status, started_at desc);

-- No policies on purpose: only the service-role client (which bypasses RLS)
-- may read or write this table. A browser JWT gets nothing.
alter table public.backup_jobs enable row level security;

-- ---------------------------------------------------------------------------
-- backup_restore_tests — the log of "we actually restored one and checked it".
-- A backup nobody has restored is a hope, not a backup; this is the evidence
-- the disaster-recovery doc's monthly restore drill writes to.
-- ---------------------------------------------------------------------------
create table public.backup_restore_tests (
  id                    uuid primary key default gen_random_uuid(),
  backup_job_id         uuid references public.backup_jobs (id) on delete cascade,
  backup_id             text not null,
  status                text not null check (status in ('running', 'success', 'failed')),
  started_at            timestamptz not null default now(),
  completed_at          timestamptz,
  duration_ms           integer,
  target_host_redacted  text,          -- host only, never the URL
  table_count           integer,
  row_counts            jsonb,         -- { "orders": 1234, ... }
  checks                jsonb,         -- [{ name, ok, detail }]
  error_message         text,
  run_by                text,
  created_at            timestamptz not null default now()
);

comment on table public.backup_restore_tests is
  'Restore drills run by `pnpm backup:restore:test` against an isolated, non-production database. Service role only.';

create index backup_restore_tests_backup_idx on public.backup_restore_tests (backup_id, started_at desc);

alter table public.backup_restore_tests enable row level security;

-- ---------------------------------------------------------------------------
-- claim_backup_job — the atomic claim. Returns one of:
--   'claimed'            a fresh 'running' row exists for p_backup_id; go.
--   'already_completed'  this backup_id already succeeded (a re-run of the same
--                        day's job). The caller re-checks S3 before trusting it.
--   'in_progress'        another run of this TYPE is still inside its stale
--                        window — do not start a second dump.
--
-- A 'running' row older than p_stale_ms is a run whose server died: it is marked
-- 'stale' (never silently deleted — the failure must stay visible) and the new
-- claim proceeds. The advisory lock serialises two simultaneous claims for the
-- same type so both cannot pass the "no running row" check; the partial unique
-- index is the belt to that brace.
-- ---------------------------------------------------------------------------
create or replace function public.claim_backup_job(
  p_backup_id         text,
  p_backup_type       text,
  p_trigger           text,
  p_triggered_by      uuid,
  p_triggered_by_name text,
  p_s3_bucket         text,
  p_environment       text,
  p_stale_ms          integer
) returns text
  language plpgsql
  as $$
  declare
    existing public.backup_jobs%rowtype;
    running  public.backup_jobs%rowtype;
  begin
    perform pg_advisory_xact_lock(hashtext('backup_jobs:' || p_backup_type));

    select * into existing
      from public.backup_jobs
      where backup_id = p_backup_id
      for update;

    if found and existing.status in ('success', 'verified') then
      return 'already_completed';
    end if;

    select * into running
      from public.backup_jobs
      where backup_type = p_backup_type
        and status = 'running'
      for update;

    if found then
      if running.started_at > now() - make_interval(secs => p_stale_ms / 1000.0) then
        return 'in_progress';
      end if;
      update public.backup_jobs
         set status         = 'stale',
             error_category = 'stale',
             error_message  = 'superseded by a newer claim after exceeding the stale window',
             completed_at   = now()
       where id = running.id;
    end if;

    insert into public.backup_jobs (
      backup_id, backup_type, status, trigger, triggered_by, triggered_by_name,
      s3_bucket, environment, started_at, attempts
    ) values (
      p_backup_id, p_backup_type, 'running', p_trigger, p_triggered_by, p_triggered_by_name,
      p_s3_bucket, p_environment, now(), 1
    )
    on conflict (backup_id) do update set
      status               = 'running',
      trigger              = excluded.trigger,
      triggered_by         = excluded.triggered_by,
      triggered_by_name    = excluded.triggered_by_name,
      s3_bucket            = excluded.s3_bucket,
      environment          = excluded.environment,
      started_at           = now(),
      completed_at         = null,
      duration_ms          = null,
      dump_ms              = null,
      upload_ms            = null,
      error_category       = null,
      error_message        = null,
      attempts             = public.backup_jobs.attempts + 1;

    return 'claimed';
  end;
  $$;

comment on function public.claim_backup_job(text, text, text, uuid, text, text, text, integer) is
  'Atomically claims the per-type backup lock. Returns claimed | already_completed | in_progress. Service role only.';

-- Postgres grants EXECUTE to PUBLIC on every new function; only the service
-- role (the backup CLI and the API) may call this.
revoke all on function public.claim_backup_job(text, text, text, uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_backup_job(text, text, text, uuid, text, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- backup_database_info — the server version and database size, for the backup
-- manifest and the status screen. pg_dump reports neither on success, and the
-- runner deliberately has no direct SQL connection of its own (it only spawns
-- pg_dump), so PostgREST is the one place to ask. Read-only; service role only.
-- ---------------------------------------------------------------------------
create or replace function public.backup_database_info()
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = public
  as $$
    select jsonb_build_object(
      'server_version', current_setting('server_version'),
      'database_name',  current_database(),
      'size_bytes',     pg_database_size(current_database()),
      'public_table_count', (
        select count(*) from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
      )
    );
  $$;

comment on function public.backup_database_info() is
  'Server version, database name, size and public table count for backup manifests and the Database Backup screen. Service role only.';

revoke all on function public.backup_database_info() from public, anon, authenticated;
grant execute on function public.backup_database_info() to service_role;
