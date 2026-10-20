-- One photo per returned product.
--
-- A branch return is one `production_returns` row per product, and since
-- migration 148 every row of a submission cited the SAME photo — one picture of
-- the whole tray. From now on each row carries its own photo, bound to that row
-- (`attachments.entity_id = production_returns.id`), and POST /api/stock/return
-- refuses a line without one.
--
-- WHAT COUNTS AS LEGACY. Only the rows whose photo is shared with another row:
-- those are the "one photo for all items" returns, and the screens say so next
-- to the picture. A single-product return from before this already has a photo
-- of exactly its one line, so it is not flagged. Rows that have no photo at all
-- (returns from before 148, and Production-recorded ones) stay unflagged and
-- null: nothing is backfilled, and no line is given a photo it never had.
--
-- The partial unique index is the rule itself, held by the database: outside
-- the legacy rows, one photo belongs to one line. A client that sends the same
-- photo id for two products is refused by the API first; this is the backstop.
-- ---------------------------------------------------------------------------

alter table public.production_returns
  add column if not exists legacy_single_photo boolean not null default false;

update public.production_returns r
   set legacy_single_photo = true
 where r.photo_attachment_id is not null
   and exists (
     select 1
       from public.production_returns o
      where o.photo_attachment_id = r.photo_attachment_id
        and o.id <> r.id
   );

create unique index if not exists production_returns_photo_one_line
  on public.production_returns (photo_attachment_id)
  where photo_attachment_id is not null and not legacy_single_photo;
