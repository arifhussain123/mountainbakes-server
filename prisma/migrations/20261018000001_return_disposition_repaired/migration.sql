-- Returned goods that Production repaired.
--
-- `production_returns.disposition` records the goods' condition when a return is
-- accepted (saleable | damaged | expired). Nothing recorded a repair, so the
-- Production Dashboard's Repaired Stock section had no source. This adds the one
-- value. Accepting a return as 'repaired' does exactly what every other
-- disposition does since migration 139: the goods land in Branch Return Stock,
-- and only an explicit transfer moves them on to Production Stock.
--
-- Additive only: no row changes, and every existing value keeps its meaning.
-- ADD VALUE may run inside the migration's transaction because nothing below
-- uses the new value in that same transaction.
-- ---------------------------------------------------------------------------

alter type public.production_return_disposition add value if not exists 'repaired';
