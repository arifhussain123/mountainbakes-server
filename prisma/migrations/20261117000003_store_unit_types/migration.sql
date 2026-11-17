-- Units become a managed master with a TYPE (weight / volume / count / pack),
-- so a pick-list unit carries meaning and a later phase can validate conversions
-- (problem 5). The value is optional and only classifies unit rows; categories
-- and adjustment reasons stay null.
--
-- Categories are ALREADY a managed master (store_lookups + Store Settings CRUD,
-- problem 4). Any mis-filed item (e.g. EGG under "Sugar & Sweeteners") is
-- re-categorised BY HAND in Store Settings — this migration deliberately does
-- NOT rewrite item data.
alter table public.store_lookups
  add column unit_type text check (unit_type in ('weight', 'volume', 'count', 'pack'));

-- Classify the units shipped with the store so the field isn't empty on day one.
update public.store_lookups set unit_type = 'weight'
  where kind in ('base_unit', 'purchase_unit') and lower(value) in ('kg', 'gram');
update public.store_lookups set unit_type = 'volume'
  where kind in ('base_unit', 'purchase_unit') and lower(value) in ('litre', 'liter');
update public.store_lookups set unit_type = 'count'
  where kind in ('base_unit', 'purchase_unit') and lower(value) in ('piece');
update public.store_lookups set unit_type = 'pack'
  where kind in ('base_unit', 'purchase_unit') and lower(value) in ('packet', 'box', 'case', 'bag', 'tin', 'carton');
