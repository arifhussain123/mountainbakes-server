-- 21: add the ticket_* values to the notification_type enum.
--
-- Kept in its OWN migration on purpose. `ALTER TYPE ... ADD VALUE` cannot run
-- inside a transaction block alongside other statements — the Supabase SQL editor
-- wraps a multi-statement script in one transaction, so bundling these with the
-- ticket tables (migration 19) aborts and rolls the whole thing back. Run this
-- file on its own. If even this errors with "cannot run inside a transaction
-- block", execute the five lines one at a time.
--
-- Until this is applied, ticket notifications are simply skipped (the server
-- raises them best-effort via notifySafe); the ticket feature is otherwise fully
-- functional. Applying this lights up the in-app bell + realtime for tickets.
alter type notification_type add value if not exists 'ticket_created';
alter type notification_type add value if not exists 'ticket_replied';
alter type notification_type add value if not exists 'ticket_resolved';
alter type notification_type add value if not exists 'ticket_reopened';
alter type notification_type add value if not exists 'ticket_status_changed';
