-- Request price (problem 3). A Store keeper cannot set prices, and today an item
-- with no active price silently blocks receiving. This lets the keeper ASK
-- Finance/Admin to set one: it records the request, notifies them, and shows on
-- the Price Control screen. Adding a price for the item resolves its open
-- request automatically. (A "receive now, price later" PRICE_PENDING receipt is
-- left for a later phase — this is the routing half the prompt marks required.)

-- The notifications.type column is an enum; add the new kind (used only at
-- runtime, never inside this migration — safe in a transaction on PG12+).
alter type public.notification_type add value if not exists 'store_price_request';

create table public.store_price_requests (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references public.store_items (id) on delete cascade,
  store_id           uuid not null references public.store_departments (id) on delete restrict,
  note               text,
  status             text not null default 'open' check (status in ('open', 'resolved', 'cancelled')),
  requested_by       uuid references public.users (id) on delete set null,
  requested_by_name  text,
  resolved_by        uuid references public.users (id) on delete set null,
  resolved_by_name   text,
  -- The price row that satisfied the request, when one was added.
  resolved_price_id  uuid references public.store_item_prices (id) on delete set null,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);
-- At most one OPEN request per item; resolved/cancelled ones are history.
create unique index store_price_requests_one_open on public.store_price_requests (item_id) where status = 'open';
create index store_price_requests_status_idx on public.store_price_requests (status, created_at desc);
