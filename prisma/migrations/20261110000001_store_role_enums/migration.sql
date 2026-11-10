-- Dry Items Store: the role and the notification types it needs.
--
-- On a migration of its own because an enum value added in a transaction
-- cannot be used in that same transaction, and the next migration
-- (20261110000002_dry_items_store) seeds and checks against them.
--
-- Additive only. `store_user` is the Store keeper's account: not a branch role
-- (not branch-scoped) and not a finance role (the finance helpers fail closed
-- on any role they do not list).

alter type public.user_role add value if not exists 'store_user';

alter type public.notification_type add value if not exists 'store_demand';          -- Production raised a dry-items demand → Store
alter type public.notification_type add value if not exists 'store_demand_reviewed'; -- Store approved/rejected lines → the requester
alter type public.notification_type add value if not exists 'store_issue';           -- Store issued stock → the requester
alter type public.notification_type add value if not exists 'store_issue_received';  -- Production confirmed receipt → Store (and Admin on a difference)
alter type public.notification_type add value if not exists 'store_query';           -- Store/Production raised a store query → Admin
alter type public.notification_type add value if not exists 'store_query_reply';     -- either side answered or moved a query → the other side
