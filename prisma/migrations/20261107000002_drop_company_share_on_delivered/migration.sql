-- Undo 20261107000001_company_share_on_delivered (owner's call, 2026-11-07).
--
-- The Company-Share-on-Delivered rule is withdrawn: every demand is back on
-- (Delivered − Return − Discount) × %, as before. The column held only the
-- rule's start date; nothing was ever posted from it, so dropping it restores
-- every figure. 20261107000001 stays in the history because it was applied.

alter table public.finance_settings drop column if exists share_on_delivered_from;
