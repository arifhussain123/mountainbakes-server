-- 10: Supabase Storage buckets, replacing the legacy object storage.
--
-- The legacy object storage was used in exactly one place: the company logo upload in
-- settings.routes.ts. It saved the file with a randomUUID() download token and
-- hand-built a permanent URL of the form
--   https://<legacy-storage-host>/v0/b/<bucket>/o/<path>?alt=media&token=<uuid>
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

-- NOTE: the old code never deleted the previous logo on re-upload, so files
-- accumulated in the legacy object storage indefinitely. The port should delete the file
-- at settings.logo_path before writing the replacement. Carry the bug over
-- knowingly or fix it — but don't leave it unnoticed.
