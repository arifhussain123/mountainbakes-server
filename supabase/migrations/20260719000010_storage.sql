-- 10: Supabase Storage buckets, replacing Firebase Storage.
--
-- Firebase Storage was used in exactly one place: the company logo upload in
-- settings.routes.ts. It saved the file with a randomUUID() download token and
-- hand-built a permanent URL of the form
--   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=<uuid>
--
-- That URL never expires and is persisted in settings.logo_url for anonymous
-- public reads (it renders on the login page and on printed receipts, where
-- there is no session).
--
-- The correct Supabase equivalent is therefore a PUBLIC bucket, NOT a signed
-- URL. Signed URLs expire, which would silently break every stored logo_url and
-- every previously printed receipt after the TTL elapsed.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding',
  'branding',
  true,
  2097152,  -- 2 MB, matching the existing multer limit
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;

-- Chat attachments are private: readable only by participants of the chat the
-- attachment belongs to. Path convention: chat-attachments/{chat_id}/{filename}
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-attachments', 'chat-attachments', false, 10485760)  -- 10 MB
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Branding bucket policies.
--
-- Public read is granted to `anon` as well as `authenticated` — the logo must
-- render pre-login. Writes are super-admin only and, in practice, go through the
-- API with the secret key.
-- ---------------------------------------------------------------------------
create policy branding_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'branding');

create policy branding_admin_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'branding' and app.is_super_admin());

create policy branding_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'branding' and app.is_super_admin());

create policy branding_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'branding' and app.is_super_admin());

-- ---------------------------------------------------------------------------
-- Chat attachment policies. The first path segment is the chat id, so
-- membership is checked against chat_participants.
-- ---------------------------------------------------------------------------
-- Goes through app.is_chat_participant (SECURITY DEFINER, see migration 09) for
-- the same reason the table policies do. The path segment is cast defensively:
-- a non-UUID first segment would otherwise raise 22P02 instead of denying.
create policy chat_attachments_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-attachments'
    and app.is_chat_participant(
      nullif((storage.foldername(name))[1], '')::uuid
    )
  );

create policy chat_attachments_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and app.is_chat_participant(
      nullif((storage.foldername(name))[1], '')::uuid
    )
  );

-- NOTE: the old code never deleted the previous logo on re-upload, so files
-- accumulated in Firebase Storage indefinitely. The port should delete the file
-- at settings.logo_path before writing the replacement. Carry the bug over
-- knowingly or fix it — but don't leave it unnoticed.
