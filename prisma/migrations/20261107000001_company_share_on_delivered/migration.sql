-- Company Share on Delivered (owner's rule, 2026-11-07).
--
-- From this date (each demand's required date, else its business date) a
-- demand's Company Share is its Delivered value × the share %, and its Return
-- and Discount are recorded as figures of their own: neither is subtracted
-- from the share, and no net "G. Total" is worked out. Demands dated before it
-- keep the old rule: (Delivered − Return − Discount) × %.
--
-- Nothing is posted or rewritten: the Demand Record, the Collections sheet,
-- the Finance Dashboard and the collection slip read this date and compute.
-- Rollback: set the column to null (every demand back on the old rule), then
-- drop it.

alter table public.finance_settings
  add column share_on_delivered_from date;

comment on column public.finance_settings.share_on_delivered_from is
  'From this date, Company Share = Delivered × %; Return and Discount are not subtracted. Null: the old net rule everywhere.';

update public.finance_settings set share_on_delivered_from = date '2026-11-01';
