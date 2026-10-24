-- 84: replay protection for client-supplied Idempotency-Key headers.
--
-- WHY THIS EXISTS. The mobile app writes offline: a sale, an expense or a demand
-- is committed to SQLite and queued, then sent when the signal comes back. Every
-- queued send can be retried — after a timeout, after a server restart, after the
-- app is killed mid-request — and until now a retry of a request the server had
-- ALREADY PROCESSED applied it a second time. That is a duplicate sale with real
-- money against it, and it is the single reason the web client's own write queue
-- has been left disabled since it was written.
--
-- WHAT ALREADY EXISTED, AND WHY IT IS NOT THIS. `stock_history` and
-- `production_stock_history` carry unique (ref_id, product_id, type) and every
-- stock RPC inserts `on conflict do nothing`, applying the balance delta only if
-- the insert landed. That dedupe is real but SERVER-INTERNAL: `ref_id` is minted
-- inside the request (an order id, a fresh uuid), so two deliveries of the same
-- HTTP request mint two ref_ids and both apply. Nothing upstream of the RPC knew
-- the two requests were the same request. This table is that missing layer, and
-- it is deliberately the same claim-or-noop shape as the rest of the codebase.
--
-- ── SCOPED PER USER ────────────────────────────────────────────────────────
--
-- The primary key is (user_id, key), not key alone. Keys are UUIDv7 minted on a
-- device, so a collision between two people is not a practical worry — but the
-- stored response body is returned verbatim on replay, and a key-only PK would
-- mean anyone who guessed or captured another account's key could read that
-- account's response. Scoping makes that impossible rather than improbable.
--
-- ── WHAT IS STORED, AND WHAT IS NOT ────────────────────────────────────────
--
-- Only responses the API layer decides to keep are recorded, which in practice
-- means the successful ones plus the narrow class of failures that still moved
-- something (a partial branch return, which reports what it committed before it
-- hit a shortfall). A rejected request has no side effect to protect, so its
-- claim is RELEASED — that is what lets a 409 'stock has changed' be genuinely
-- re-attempted later instead of replaying its own refusal forever.
--
-- ── THE STALE CLAIM, AND WHY IT IS NOT RETRIED AUTOMATICALLY ───────────────
--
-- A claim sits `in_progress` between the request arriving and its response being
-- recorded. If the process dies in that window the row is left behind, and there
-- is no way to know from here whether the transaction committed. The tempting
-- fix — expire the claim and let the retry through — is exactly the double-apply
-- this table exists to prevent, so it is NOT what happens: a fresh claim asks the
-- caller to retry shortly (503) and a stale one is reported as a conflict for a
-- human to check. An operation stuck for a person to look at is recoverable; a
-- second sale nobody notices is not.
-- ---------------------------------------------------------------------------

create table if not exists idempotency_keys (
  user_id         uuid        not null,
  key             text        not null,
  -- Which handler claimed it. Two different endpoints must never share a key;
  -- checked rather than assumed, because the failure it catches (a payload
  -- posted to the wrong route replaying another route's result) is silent.
  endpoint        text        not null,
  -- sha256 of the canonicalised request body. Same key + different body is a
  -- client bug, and answering it with the first request's result would hide it.
  fingerprint     text        not null,
  status          text        not null default 'in_progress'
                    check (status in ('in_progress', 'completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  primary key (user_id, key)
);

-- Purge scans by age; nothing else reads this column as a predicate.
create index if not exists idempotency_keys_created_at_idx on idempotency_keys (created_at);

-- RLS on with NO policies, the same stance as finance_tickets and
-- branch_user_requests: the service-role API is the only reader and bypasses
-- RLS. No browser or device ever touches this table directly.
alter table idempotency_keys enable row level security;

comment on table idempotency_keys is
  'Replay protection for client-supplied Idempotency-Key headers on offline-capable writes. Claimed before the handler runs, completed with the response the handler produced, released when the request had no side effect to protect.';

-- ---------------------------------------------------------------------------
-- Claim the key, or report what the earlier request with it did.
--
-- One round trip and one atomic decision. The insert IS the lock: the primary
-- key makes exactly one of two concurrent claims land, and the loser reads the
-- winner's row rather than racing it.
-- ---------------------------------------------------------------------------
create or replace function public.claim_idempotency_key(
  p_user_id       uuid,
  p_key           text,
  p_endpoint      text,
  p_fingerprint   text,
  p_stale_seconds integer default 300
)
returns jsonb
language plpgsql
as $$
declare
  r record;
begin
  insert into idempotency_keys (user_id, key, endpoint, fingerprint)
  values (p_user_id, p_key, p_endpoint, p_fingerprint)
  on conflict (user_id, key) do nothing;

  -- FOUND is true only when the insert actually wrote a row, which is precisely
  -- "this caller owns the claim".
  if found then
    return jsonb_build_object('outcome', 'claimed');
  end if;

  select * into r from idempotency_keys where user_id = p_user_id and key = p_key;
  if not found then
    -- The row was purged between the insert and the read. Vanishingly rare, and
    -- reported rather than guessed at: the caller retries and claims cleanly.
    return jsonb_build_object('outcome', 'in_progress', 'stale', false);
  end if;

  if r.endpoint is distinct from p_endpoint or r.fingerprint is distinct from p_fingerprint then
    return jsonb_build_object('outcome', 'mismatch');
  end if;

  if r.status = 'completed' then
    return jsonb_build_object(
      'outcome',        'replay',
      'responseStatus', r.response_status,
      'responseBody',   r.response_body
    );
  end if;

  return jsonb_build_object(
    'outcome', 'in_progress',
    'stale',   r.created_at < now() - make_interval(secs => p_stale_seconds)
  );
end;
$$;

comment on function public.claim_idempotency_key is
  'Claim an Idempotency-Key or describe the earlier request that holds it: claimed | replay (with the stored response) | in_progress (with staleness) | mismatch (same key, different body).';

-- ---------------------------------------------------------------------------
-- Record the response. Only called for outcomes worth replaying.
-- ---------------------------------------------------------------------------
create or replace function public.complete_idempotency_key(
  p_user_id uuid,
  p_key     text,
  p_status  integer,
  p_body    jsonb
)
returns void
language plpgsql
as $$
begin
  update idempotency_keys
     set status          = 'completed',
         response_status = p_status,
         response_body   = p_body,
         completed_at    = now()
   where user_id = p_user_id
     and key     = p_key;
end;
$$;

-- ---------------------------------------------------------------------------
-- Give the key back. Called when the request changed nothing, so the same key
-- may legitimately be tried again later.
--
-- Guarded on status: a completed claim is never released, however it is called.
-- ---------------------------------------------------------------------------
create or replace function public.release_idempotency_key(
  p_user_id uuid,
  p_key     text
)
returns void
language plpgsql
as $$
begin
  delete from idempotency_keys
   where user_id = p_user_id
     and key     = p_key
     and status  = 'in_progress';
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention. Nothing calls this on a schedule — the node-cron jobs are all
-- commented out in server.ts — so it is run by hand from
-- `pnpm purge:idempotency-keys`, the same arrangement as the price-history purge.
--
-- The default of 30 days is far beyond any queue's useful life: a device that
-- has been offline for a month is rejected by the business-date window long
-- before its key is looked up.
-- ---------------------------------------------------------------------------
create or replace function public.purge_idempotency_keys(p_older_than_days integer default 30)
returns integer
language plpgsql
as $$
declare
  v_deleted integer;
begin
  delete from idempotency_keys
   where created_at < now() - make_interval(days => p_older_than_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC on every new function. These four are only
-- ever called with the service-role key from the API, so lock them down — the
-- same stance as claim_business_day_closure and the stock functions.
--
-- It matters more here than elsewhere: `claim_idempotency_key` returns the
-- stored response body, so a caller who could reach it with an anon key and a
-- guessed (user_id, key) pair would be reading someone else's transaction.
-- ---------------------------------------------------------------------------
revoke all on function public.claim_idempotency_key(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_idempotency_key(uuid, text, text, text, integer) to service_role;

revoke all on function public.complete_idempotency_key(uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.complete_idempotency_key(uuid, text, integer, jsonb) to service_role;

revoke all on function public.release_idempotency_key(uuid, text) from public, anon, authenticated;
grant execute on function public.release_idempotency_key(uuid, text) to service_role;

revoke all on function public.purge_idempotency_keys(integer) from public, anon, authenticated;
grant execute on function public.purge_idempotency_keys(integer) to service_role;
