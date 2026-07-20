-- 11: pricing transaction functions.
--
-- Why these exist as database functions rather than app code:
--
-- price.service.ts ran its price changes inside legacy transactions
-- (read product + latest version, then write history + product atomically).
-- supabase-js talks to PostgREST over HTTP, where every call is its own
-- implicit transaction — there is no way to hold `select ... for update`
-- across two client calls. Attempting the same read-then-write from Node
-- would let two concurrent price changes for one product read the same
-- version_number and race.
--
-- So the transactional core lives here, called via supabaseAdmin.rpc(). The
-- app keeps everything non-transactional: business-date arithmetic (Karachi,
-- 2 AM rollover — see shared/utils/timezone.ts), spreadsheet parsing, and
-- notifications.
--
-- `p_today` is always supplied by the caller for exactly that reason: the
-- business date is not "now()::date", it is the Karachi date shifted back by
-- the 2 AM business-day start. Keeping that definition in one place (TS) beats
-- reimplementing it in SQL and letting the two drift.
--
-- SECURITY: these are SECURITY INVOKER (the default) — they do NOT bypass RLS.
-- They are called with the service_role key, which already bypasses RLS on its
-- own. Postgres grants EXECUTE to PUBLIC on every new function, which would
-- make them callable by anon/authenticated through the Data API, so each one is
-- explicitly revoked and re-granted to service_role at the bottom of this file.

-- ---------------------------------------------------------------------------
-- apply_price_change — record one price change (manual, or one import row).
--
-- Returns exactly one row. status is 'active' (applied now), 'scheduled'
-- (future-dated), or 'skipped' (immediate change to the price it already has).
--
-- Invariant 1 (gapless version_number per product) is held by the `for update`
-- row lock on products: concurrent changes to the SAME product serialise behind
-- it, so the max(version_number) read cannot be stale. The unique constraint
-- product_price_history_version_key is the backstop if that ever regresses.
--
-- Invariant 2 (at most one scheduled row per product) is held by superseding
-- any existing scheduled row in the same statement sequence, inside this
-- function's transaction. The partial unique index makes a bug here fail loudly.
-- ---------------------------------------------------------------------------
create or replace function public.apply_price_change(
  p_product_id      uuid,
  p_new_price       numeric,
  p_effective_date  date,
  p_reason          text,
  p_source          price_change_source,
  p_changed_by      uuid,
  p_changed_by_name text,
  p_batch_id        uuid,
  p_today           date
)
returns table (
  status         text,
  skip_reason    text,
  history_id     uuid,
  version_number integer,
  product_name   text,
  old_price      numeric,
  new_price      numeric
)
language plpgsql
as $$
declare
  v_product      products%rowtype;
  v_immediate    boolean;
  v_next_version integer;
  v_history_id   uuid;
  v_now          timestamptz := now();
begin
  select * into v_product from products where id = p_product_id for update;
  if not found then
    -- Mapped to a 404 by the caller. P0002 = no_data_found.
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  v_immediate := p_effective_date <= p_today;

  -- No-op: an immediate change to the price it already holds.
  if v_immediate and coalesce(v_product.price, 0) = p_new_price then
    return query select
      'skipped'::text, 'unchanged'::text, null::uuid, null::integer,
      v_product.name, v_product.price, p_new_price;
    return;
  end if;

  select coalesce(max(h.version_number), 0) + 1
    into v_next_version
    from product_price_history h
   where h.product_id = p_product_id;

  -- The table MUST be aliased here. This function is `returns table (status ...)`,
  -- which puts `status` in scope as a PL/pgSQL variable, so an unqualified
  -- `status` in the WHERE is ambiguous and Postgres refuses it outright
  -- ("column reference \"status\" is ambiguous"). Qualifying via the alias
  -- resolves it to the column. The SET target stays unqualified — Postgres does
  -- not accept a table-qualified name on the left of SET.
  update product_price_history h
     set status = 'superseded'
   where h.product_id = p_product_id
     and h.status = 'scheduled';

  insert into product_price_history (
    product_id, product_code, product_name, category_name,
    old_price, new_price, effective_date, reason, source, status,
    version_number, changed_by, changed_by_name, changed_on, activated_on, batch_id
  ) values (
    p_product_id, v_product.sku, v_product.name, v_product.category_name,
    v_product.price, p_new_price, p_effective_date, p_reason, p_source,
    (case when v_immediate then 'active' else 'scheduled' end)::price_change_status,
    v_next_version, p_changed_by, p_changed_by_name, v_now,
    (case when v_immediate then v_now else null end), p_batch_id
  )
  returning id into v_history_id;

  -- updated_at is maintained by the products_touch trigger — do not set it here.
  if v_immediate then
    update products set price = p_new_price where id = p_product_id;
  end if;

  return query select
    (case when v_immediate then 'active' else 'scheduled' end)::text,
    null::text, v_history_id, v_next_version,
    v_product.name, v_product.price, p_new_price;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_price_activation — take the per-business-date job lock.
--
-- Returns true if this caller now holds the lock, NULL (falsy) if someone else
-- does. A 'running' lock older than 10 minutes is deliberately stealable so a
-- crashed dyno cannot wedge the job forever — same rule as the legacy
-- version and as daily-closing.
--
-- The WHERE on the DO UPDATE branch is what makes this atomic: a losing caller
-- updates zero rows and gets no RETURNING row back.
-- ---------------------------------------------------------------------------
create or replace function public.claim_price_activation(
  p_date    date,
  p_trigger closure_trigger
)
returns boolean
language sql
as $$
  insert into price_activation_locks (business_date, status, trigger, started_at, activated, closed_at, error)
  values (p_date, 'running', p_trigger, now(), 0, null, null)
  on conflict (business_date) do update
     set status     = 'running',
         trigger    = p_trigger,
         started_at = now(),
         activated  = 0,
         closed_at  = null,
         error      = null
   where price_activation_locks.status <> 'success'
     and (price_activation_locks.status <> 'running'
          or price_activation_locks.started_at < now() - interval '10 minutes')
  returning true;
$$;

-- ---------------------------------------------------------------------------
-- activate_due_prices — flip every scheduled price whose date has arrived.
--
-- Returns the number of products repriced.
--
-- The legacy version had to reconcile several due 'scheduled' rows per
-- product (highest version wins, the rest superseded) because nothing stopped
-- more than one from existing. Here the partial unique index
-- product_price_history_one_scheduled_key makes that impossible — at most one
-- scheduled row per product can exist at a time — so the winner/loser pass is
-- gone. That is a real simplification, not an omission.
--
-- Invariant 3: old_price is taken from the product row read inside this
-- transaction, NOT from whatever was captured when the change was scheduled, so
-- the audit trail stays truthful when changes stack up.
-- ---------------------------------------------------------------------------
create or replace function public.activate_due_prices(p_today date)
returns integer
language plpgsql
as $$
declare
  v_activated integer := 0;
  v_cur_price numeric;
  r           record;
begin
  for r in
    select h.id, h.product_id, h.new_price
      from product_price_history h
     where h.status = 'scheduled'
       and h.effective_date <= p_today
     order by h.product_id
  loop
    -- Lock the product for the same reason apply_price_change does: a manual
    -- change landing mid-job must not interleave with this read-then-write.
    select price into v_cur_price from products where id = r.product_id for update;

    if found then
      update products set price = r.new_price where id = r.product_id;
      update product_price_history
         set status = 'active', activated_on = now(), old_price = v_cur_price
       where id = r.id;
      v_activated := v_activated + 1;
    else
      -- Defensive only: product_id is FK ON DELETE CASCADE, so a missing
      -- product would have taken this history row with it.
      update product_price_history set status = 'superseded' where id = r.id;
    end if;
  end loop;

  return v_activated;
end;
$$;

-- ---------------------------------------------------------------------------
-- close_price_activation — record the job's outcome on the lock row.
-- ---------------------------------------------------------------------------
create or replace function public.close_price_activation(
  p_date      date,
  p_status    closure_status,
  p_activated integer,
  p_error     text
)
returns void
language sql
as $$
  update price_activation_locks
     set status    = p_status,
         activated = p_activated,
         closed_at = now(),
         error     = p_error
   where business_date = p_date;
$$;

-- ---------------------------------------------------------------------------
-- Lock these down. Postgres grants EXECUTE to PUBLIC by default, and anon /
-- authenticated inherit from PUBLIC — without this, every function above would
-- be a callable Data API endpoint. Only the API server (service_role) may run
-- them.
-- ---------------------------------------------------------------------------
revoke all on function public.apply_price_change(uuid, numeric, date, text, price_change_source, uuid, text, uuid, date) from public, anon, authenticated;
revoke all on function public.claim_price_activation(date, closure_trigger) from public, anon, authenticated;
revoke all on function public.activate_due_prices(date) from public, anon, authenticated;
revoke all on function public.close_price_activation(date, closure_status, integer, text) from public, anon, authenticated;

grant execute on function public.apply_price_change(uuid, numeric, date, text, price_change_source, uuid, text, uuid, date) to service_role;
grant execute on function public.claim_price_activation(date, closure_trigger) to service_role;
grant execute on function public.activate_due_prices(date) to service_role;
grant execute on function public.close_price_activation(date, closure_status, integer, text) to service_role;
