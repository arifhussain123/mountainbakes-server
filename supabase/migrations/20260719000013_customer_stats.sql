-- 13: atomic customer order statistics.
--
-- The legacy system updated these with a server-side increment operator, atomic on the
-- server and immune to the read-modify-write race two concurrent orders for the
-- same customer would otherwise hit.
--
-- supabase-js has no equivalent: `.update({ total_orders: n + 1 })` requires
-- reading n first, and PostgREST gives that read its own transaction. Two orders
-- placed at once would both read the same n and both write n+1, losing one.
--
-- A single UPDATE with the increment expressed in SQL is atomic under Postgres
-- row locking — the same reasoning as next_order_number() in migration 03.
--
-- updated_at is maintained by the customers_touch trigger — not set here.

create or replace function public.increment_customer_stats(
  p_customer_id uuid,
  p_amount      numeric
)
returns void
language sql
as $$
  update customers
     set total_orders = total_orders + 1,
         total_spent  = total_spent + p_amount
   where id = p_customer_id;
$$;

revoke all on function public.increment_customer_stats(uuid, numeric) from public, anon, authenticated;
grant execute on function public.increment_customer_stats(uuid, numeric) to service_role;
