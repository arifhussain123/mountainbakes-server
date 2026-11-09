-- Production may correct a pending discount claim's amount from its Discount
-- Detail popup (owner's call, 2026-11-06) — typically to match the till's
-- Product breakdown before approving.
--
-- `amount` stays the one figure everything downstream reads. These columns only
-- record that Production changed it:
--   original_amount         the branch's own figure, kept from the FIRST change
--                           (null = the amount is still the branch's);
--   amount_changed_by/_name who at Production last changed it;
--   amount_changed_at       when.
-- The branch revising its own claim afterwards clears all four — the figure is
-- the branch's again.
--
-- No FK on amount_changed_by: it is an audit stamp beside its _name, and a user
-- deleted later must not block or rewrite the claim.

ALTER TABLE public.branch_discounts
  ADD COLUMN original_amount numeric(14,2),
  ADD COLUMN amount_changed_by uuid,
  ADD COLUMN amount_changed_by_name text,
  ADD COLUMN amount_changed_at timestamptz,
  ADD CONSTRAINT branch_discounts_original_amount_positive
    CHECK (original_amount IS NULL OR original_amount > 0);
