-- Finance Admin may crop a photo that is already bound to a document.
--
-- A bound attachment is immutable (app.attachments_immutable, from migration
-- 67): it is part of its document's audit trail. Cropping opens ONE narrow,
-- logged exception to that rule:
--
--   * Only public.replace_attachment_file() can do it. It sets a
--     transaction-local flag that the trigger honours, so a plain UPDATE from
--     anywhere else is still refused exactly as before.
--   * Even with the flag, only the FILE columns may change (storage_path,
--     mime_type, size_bytes, width, height). What the photo belongs to, who
--     uploaded it and when stay fixed.
--   * Every replacement writes an attachment_revisions row naming the OLD file.
--     The API never deletes the old object from storage, so the uncropped
--     original can always be recovered from that path.
--
-- Additive only: a new table, a new function, and the trigger function
-- replaced with a superset of its old behaviour.

create table public.attachment_revisions (
  id uuid primary key default gen_random_uuid(),
  attachment_id uuid not null references public.attachments(id),
  action text not null default 'cropped' check (action in ('cropped')),
  old_storage_path text not null,
  old_mime_type text not null,
  old_size_bytes integer not null,
  old_width integer,
  old_height integer,
  new_storage_path text not null,
  new_mime_type text not null,
  new_size_bytes integer not null check (new_size_bytes > 0),
  new_width integer,
  new_height integer,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz not null default now()
);

create index attachment_revisions_attachment_idx
  on public.attachment_revisions (attachment_id, changed_at desc);

-- Revisions are history: never edited, never removed.
create function app.attachment_revisions_append_only() returns trigger
  language plpgsql as $$
  begin
    raise exception 'attachment_revisions is append-only.';
  end;
  $$;

create trigger attachment_revisions_append_only
  before update or delete on public.attachment_revisions
  for each row execute function app.attachment_revisions_append_only();

-- The old function, plus the one exception for replace_attachment_file().
create or replace function app.attachments_immutable() returns trigger
  language plpgsql as $$
  begin
    if tg_op = 'DELETE' then
      if old.entity_id is null then
        return old;
      end if;
      raise exception
        'attachment % cannot be deleted. A document''s supporting photo is part of '
        'its audit trail.', old.id;
    end if;

    if old.entity_id is not null then
      if coalesce(current_setting('app.allow_attachment_replace', true), 'off') = 'on'
         and (new.entity, new.entity_id, new.uploaded_by, new.uploaded_by_name, new.bound_at, new.created_at)
             is not distinct from
             (old.entity, old.entity_id, old.uploaded_by, old.uploaded_by_name, old.bound_at, old.created_at)
      then
        return new;
      end if;
      raise exception
        'attachment % is already bound to %/% and is immutable.',
        old.id, old.entity, old.entity_id;
    end if;

    if (new.entity, new.storage_path, new.mime_type, new.size_bytes, new.uploaded_by)
       is distinct from
       (old.entity, old.storage_path, old.mime_type, old.size_bytes, old.uploaded_by)
    then
      raise exception
        'attachment % may only have entity_id and bound_at set; the file itself is '
        'immutable.', old.id;
    end if;

    return new;
  end;
  $$;

-- Point a BOUND attachment at a new (cropped) file and record the old one.
-- Returns the revision id. Raises if the attachment is missing or not bound
-- (a staged photo is replaced by uploading another, not by this).
create function public.replace_attachment_file(
  p_attachment_id uuid,
  p_storage_path text,
  p_mime_type text,
  p_size_bytes integer,
  p_width integer,
  p_height integer,
  p_actor_id uuid,
  p_actor_name text
) returns uuid
  language plpgsql as $$
  declare
    v_old public.attachments%rowtype;
    v_revision uuid;
  begin
    select * into v_old from public.attachments where id = p_attachment_id for update;
    if not found then
      raise exception 'Picture not found.';
    end if;
    if v_old.entity_id is null then
      raise exception 'This picture is not saved on a record yet, so it cannot be cropped here.';
    end if;

    insert into public.attachment_revisions (
      attachment_id, old_storage_path, old_mime_type, old_size_bytes, old_width, old_height,
      new_storage_path, new_mime_type, new_size_bytes, new_width, new_height,
      changed_by, changed_by_name
    ) values (
      v_old.id, v_old.storage_path, v_old.mime_type, v_old.size_bytes, v_old.width, v_old.height,
      p_storage_path, p_mime_type, p_size_bytes, p_width, p_height,
      p_actor_id, p_actor_name
    ) returning id into v_revision;

    perform set_config('app.allow_attachment_replace', 'on', true);
    update public.attachments
       set storage_path = p_storage_path,
           mime_type = p_mime_type,
           size_bytes = p_size_bytes,
           width = p_width,
           height = p_height
     where id = p_attachment_id;
    perform set_config('app.allow_attachment_replace', 'off', true);

    return v_revision;
  end;
  $$;
