-- 14: add 'password_reset' to notification_type.
--
-- users.routes.ts raises a notification when an admin resets someone's password
-- (notify({ type: 'password_reset', ... })), but that value was never in the
-- enum — migration 01 lists only the order/stock/production types. Under
-- In the legacy system `type` was a free-text string so this went unnoticed; in Postgres it
-- is a real enum and the insert fails with 22P02, taking the whole reset request
-- down with it.
--
-- ALTER rather than editing migration 01, because 01 is already applied to the
-- live database. On a fresh run of schema_bundle.sql this still works: adding a
-- value to an enum created earlier in the same transaction is permitted.
--
-- Note PG 12+ allows ADD VALUE inside a transaction block as long as the new
-- value is not USED in that same transaction — which it is not here.

alter type notification_type add value if not exists 'password_reset';
