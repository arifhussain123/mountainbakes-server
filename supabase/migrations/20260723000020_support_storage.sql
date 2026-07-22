-- 20: Storage bucket for support-ticket attachments.
--
-- Private bucket, modelled on chat-attachments (migration 10). Tickets can carry
-- sensitive photos/documents, so files are NEVER public: uploads and downloads
-- both go through the API with the service-role key (which bypasses storage RLS),
-- and the client only ever receives short-lived signed URLs minted server-side.
--
-- Path convention: support-attachments/{ticket_id}/{timestamp}-{filename}
--
-- No storage.objects policies are added: every access path is the service-role
-- client via the API, so there is nothing for `authenticated`/`anon` to be
-- granted. RLS stays default-deny for direct client access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'support-attachments',
  'support-attachments',
  false,
  10485760,  -- 10 MB
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/pdf',
    'application/vnd.ms-excel',                                                -- .xls
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',        -- .xlsx
    'application/msword',                                                       -- .doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'   -- .docx
  ]
)
on conflict (id) do nothing;
