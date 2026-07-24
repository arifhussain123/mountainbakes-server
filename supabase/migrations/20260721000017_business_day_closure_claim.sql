-- 17: atomic claim for the daily-closing distributed lock.
--
-- The closing job's once-per-day lock was previously claimed inside a
-- read-modify-write transaction on the closures doc: read the row for the date,
-- bail if it is already 'success' or a still-fresh 'running', otherwise write a
-- 'running' row. PostgREST gives each call its own transaction, so that
-- read-check-write cannot be made atomic from the app layer. This function
-- reproduces it in one row-locked block (the same shape as
-- review_production_order in migration 16).
--
-- Returns one of: 'claimed' | 'already_closed' | 'in_progress'. On 'claimed' the
-- row is (re)initialised to a fresh 'running' state; the caller then fills in the
-- summaries and flips it to 'success'/'failed' with a plain update.

create or replace function claim_business_day_closure(
  p_business_date      date,
  p_trigger            closure_trigger,
  p_closed_by          text,
  p_auto_stock_closing boolean,
  p_stale_ms           integer
) returns text
  language plpgsql
  as $$
  declare
    existing business_day_closures%rowtype;
  begin
    -- Serialise concurrent claims for this date (a manual run overlapping the
    -- scheduler tick). FOR UPDATE on the existing row; the ON CONFLICT below
    -- covers the first-ever claim where no row exists yet.
    select * into existing
      from business_day_closures
      where business_date = p_business_date
      for update;

    if found then
      if existing.status = 'success' then
        return 'already_closed';
      end if;
      if existing.status = 'running'
         and existing.started_at > now() - make_interval(secs => p_stale_ms / 1000.0) then
        return 'in_progress';
      end if;
    end if;

    insert into business_day_closures (
      business_date, status, trigger, closed_by, auto_stock_closing, started_at
    ) values (
      p_business_date, 'running', p_trigger, p_closed_by, p_auto_stock_closing, now()
    )
    on conflict (business_date) do update set
      status                     = 'running',
      trigger                    = excluded.trigger,
      closed_by                  = excluded.closed_by,
      auto_stock_closing         = excluded.auto_stock_closing,
      started_at                 = now(),
      sales_summary              = null,
      expense_summary            = null,
      production_expense_summary = null,
      production_summary         = null,
      stock_snapshot             = null,
      error                      = null,
      closed_at                  = null,
      duration_ms                = null;

    return 'claimed';
  end;
  $$;

-- Postgres grants EXECUTE to PUBLIC on every new function; this one is only ever
-- called with the service_role key from the closing job, so lock it down (matches
-- the other transactional functions).
revoke all on function public.claim_business_day_closure(date, closure_trigger, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.claim_business_day_closure(date, closure_trigger, text, boolean, integer) to service_role;
