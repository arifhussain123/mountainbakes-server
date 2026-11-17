-- Items v2 — reorder/planning + handling fields on the item master. All are
-- optional/defaulted, so existing items and the Excel import are unaffected;
-- min_stock stays the reorder TRIGGER, these add how much to order and how to
-- store it. Feeds Phase 3's reorder suggestions and Purchase Orders.
alter table public.store_items
  add column if not exists reorder_qty           numeric(14,3) not null default 0 check (reorder_qty >= 0),
  add column if not exists max_level             numeric(14,3) not null default 0 check (max_level >= 0),
  add column if not exists safety_stock          numeric(14,3) not null default 0 check (safety_stock >= 0),
  add column if not exists lead_time_days        integer check (lead_time_days is null or lead_time_days >= 0),
  add column if not exists preferred_supplier_id uuid references public.suppliers (id) on delete set null,
  add column if not exists storage_type          text not null default 'dry' check (storage_type in ('dry', 'chilled', 'frozen')),
  add column if not exists track_expiry          boolean not null default false,
  add column if not exists description           text;

-- Extend store_save_item to read and persist the new fields. The existing logic
-- (codes, uniqueness, base-unit lock, audit diff) is unchanged — only the new
-- columns are threaded through.
create or replace function public.store_save_item(p_actor_id uuid, p_actor_name text, p_id uuid, p_input jsonb) returns jsonb
  language plpgsql as $$
  declare
    v_old   public.store_items%rowtype;
    v_new   public.store_items%rowtype;
    v_code  text := upper(btrim(coalesce(p_input->>'itemCode', '')));
    v_name  text := btrim(coalesce(p_input->>'name', ''));
    v_cat   text := app.store_assert_lookup('category', p_input->>'category', 'Category');
    v_base  text := app.store_assert_lookup('base_unit', p_input->>'baseUnit', 'Base unit');
    v_pur   text := app.store_assert_lookup('purchase_unit', p_input->>'purchaseUnit', 'Purchase unit');
    v_conv  numeric := nullif(p_input->>'conversionQty', '')::numeric;
    v_min   numeric := coalesce(nullif(p_input->>'minStock', '')::numeric, 0);
    v_rem   text := nullif(btrim(coalesce(p_input->>'remarks', '')), '');
    v_link  uuid := nullif(p_input->>'purchaseItemId', '')::uuid;
    -- Items v2 (all optional; coalesce to the column default when absent).
    v_reord numeric := coalesce(nullif(p_input->>'reorderQty', '')::numeric, 0);
    v_maxl  numeric := coalesce(nullif(p_input->>'maxLevel', '')::numeric, 0);
    v_safe  numeric := coalesce(nullif(p_input->>'safetyStock', '')::numeric, 0);
    v_lead  integer := nullif(p_input->>'leadTimeDays', '')::integer;
    v_psup  uuid := nullif(p_input->>'preferredSupplierId', '')::uuid;
    v_stor  text := coalesce(nullif(btrim(coalesce(p_input->>'storageType', '')), ''), 'dry');
    v_texp  boolean := coalesce((p_input->>'trackExpiry')::boolean, false);
    v_desc  text := nullif(btrim(coalesce(p_input->>'description', '')), '');
    v_diff  text[] := '{}';
  begin
    if v_name = '' then raise exception 'Enter the item name.' using errcode = '22023'; end if;
    if v_code !~ '^[A-Z0-9-]{2,12}$' then raise exception 'Item code: use 2–12 letters, numbers or dashes.' using errcode = '22023'; end if;
    if v_conv is null or v_conv <= 0 then raise exception 'Conversion quantity must be above 0.' using errcode = '22023'; end if;
    if v_min < 0 then raise exception 'Low-stock level must be 0 or more.' using errcode = '22023'; end if;
    if v_stor not in ('dry', 'chilled', 'frozen') then raise exception 'Storage type must be dry, chilled or frozen.' using errcode = '22023'; end if;
    if exists (select 1 from public.store_items where lower(name) = lower(v_name) and id is distinct from p_id) then
      raise exception 'An item named "%" already exists.', v_name using errcode = 'P0001';
    end if;
    if exists (select 1 from public.store_items where item_code = v_code and id is distinct from p_id) then
      raise exception 'Item code % is already used.', v_code using errcode = 'P0001';
    end if;

    if p_id is null then
      insert into public.store_items (
        item_code, name, category, base_unit, purchase_unit, conversion_qty, min_stock, remarks, purchase_item_id,
        reorder_qty, max_level, safety_stock, lead_time_days, preferred_supplier_id, storage_type, track_expiry, description,
        created_by, created_by_name)
      values (
        v_code, v_name, v_cat, v_base, v_pur, v_conv, v_min, v_rem, v_link,
        v_reord, v_maxl, v_safe, v_lead, v_psup, v_stor, v_texp, v_desc,
        p_actor_id, p_actor_name)
      returning * into v_new;
      perform app.store_audit('item', v_new.id, v_new.item_no, 'created', null, p_actor_id, p_actor_name, null, to_jsonb(v_new));
      return to_jsonb(v_new);
    end if;

    select * into v_old from public.store_items where id = p_id for update;
    if not found then raise exception 'Store item not found.' using errcode = 'P0002'; end if;
    if v_old.base_unit <> v_base and exists (select 1 from public.store_movements where item_id = p_id) then
      raise exception 'Stock has already moved in %. Create a new item instead of changing the base unit.', v_old.base_unit using errcode = 'P0001';
    end if;
    update public.store_items set
      item_code = v_code, name = v_name, category = v_cat, base_unit = v_base, purchase_unit = v_pur,
      conversion_qty = v_conv, min_stock = v_min, remarks = v_rem, purchase_item_id = v_link,
      reorder_qty = v_reord, max_level = v_maxl, safety_stock = v_safe, lead_time_days = v_lead,
      preferred_supplier_id = v_psup, storage_type = v_stor, track_expiry = v_texp, description = v_desc
     where id = p_id
     returning * into v_new;
    if v_old.item_code <> v_new.item_code then v_diff := v_diff || format('Code: %s → %s', v_old.item_code, v_new.item_code); end if;
    if v_old.name <> v_new.name then v_diff := v_diff || format('Name: %s → %s', v_old.name, v_new.name); end if;
    if v_old.category <> v_new.category then v_diff := v_diff || format('Category: %s → %s', v_old.category, v_new.category); end if;
    if v_old.base_unit <> v_new.base_unit then v_diff := v_diff || format('Base unit: %s → %s', v_old.base_unit, v_new.base_unit); end if;
    if v_old.purchase_unit <> v_new.purchase_unit then v_diff := v_diff || format('Purchase unit: %s → %s', v_old.purchase_unit, v_new.purchase_unit); end if;
    if v_old.conversion_qty <> v_new.conversion_qty then v_diff := v_diff || format('Conversion: %s → %s', v_old.conversion_qty, v_new.conversion_qty); end if;
    if v_old.min_stock <> v_new.min_stock then v_diff := v_diff || format('Low-stock level: %s → %s', v_old.min_stock, v_new.min_stock); end if;
    if v_old.reorder_qty <> v_new.reorder_qty then v_diff := v_diff || format('Reorder qty: %s → %s', v_old.reorder_qty, v_new.reorder_qty); end if;
    if v_old.max_level <> v_new.max_level then v_diff := v_diff || format('Max level: %s → %s', v_old.max_level, v_new.max_level); end if;
    if v_old.safety_stock <> v_new.safety_stock then v_diff := v_diff || format('Safety stock: %s → %s', v_old.safety_stock, v_new.safety_stock); end if;
    if v_old.lead_time_days is distinct from v_new.lead_time_days then v_diff := v_diff || format('Lead time: %s → %s', coalesce(v_old.lead_time_days::text, '—'), coalesce(v_new.lead_time_days::text, '—')); end if;
    if v_old.preferred_supplier_id is distinct from v_new.preferred_supplier_id then v_diff := v_diff || 'Preferred supplier changed'::text; end if;
    if v_old.storage_type <> v_new.storage_type then v_diff := v_diff || format('Storage: %s → %s', v_old.storage_type, v_new.storage_type); end if;
    if v_old.track_expiry <> v_new.track_expiry then v_diff := v_diff || format('Track expiry: %s → %s', v_old.track_expiry, v_new.track_expiry); end if;
    if v_old.remarks is distinct from v_new.remarks then v_diff := v_diff || format('Remarks: %s → %s', coalesce(v_old.remarks, '—'), coalesce(v_new.remarks, '—')); end if;
    if v_old.description is distinct from v_new.description then v_diff := v_diff || 'Description changed'::text; end if;
    if v_old.purchase_item_id is distinct from v_new.purchase_item_id then v_diff := v_diff || 'Purchasing link changed'::text; end if;
    perform app.store_audit('item', p_id, v_new.item_no, 'edited',
      coalesce(nullif(array_to_string(v_diff, '; '), ''), 'No changes'), p_actor_id, p_actor_name, to_jsonb(v_old), to_jsonb(v_new));
    return to_jsonb(v_new);
  end;
  $$;
