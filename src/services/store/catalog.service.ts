import type {
  StoreAccount,
  StoreAccountFlagsInput,
  StoreAuditEvent,
  StoreBatch,
  StoreDepartment,
  StoreItem,
  StoreItemHistory,
  StoreItemInput,
  StoreLookup,
  StoreLookupInput,
  StorePrice,
  StorePriceInput,
  StoreSettingsInput,
} from '../../shared';
import { api, businessDate, call, clientError, db, httpError, readAll, type StoreActor } from './common';

/**
 * The Store's master data: the department, Store keeper accounts, pick-lists,
 * the item master and Price Control. Every item and price write is a database
 * function that also writes the audit trail; nothing here moves stock.
 */

// ── Department and settings ─────────────────────────────────────────────────

export async function getStore(): Promise<StoreDepartment> {
  const { data, error } = await db.from('store_departments').select('id, store_code, name, opening_date, is_active')
    .eq('is_active', true).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw httpError(409, 'The Dry Items Store is not set up.');
  return api<StoreDepartment>(data);
}

export async function updateSettings(input: StoreSettingsInput, actor: StoreActor): Promise<StoreDepartment> {
  const store = await getStore();
  const { data, error } = await db.from('store_departments')
    .update({ name: input.name.trim(), opening_date: input.openingDate ?? null })
    .eq('id', store.id).select('id, store_code, name, opening_date, is_active').single();
  if (error) throw clientError(error);
  await audit('settings', store.id, store.storeCode, 'edited',
    `Name: ${store.name} → ${input.name.trim()}; go-live date: ${store.openingDate ?? '—'} → ${input.openingDate ?? '—'}`, actor);
  return api<StoreDepartment>(data);
}

export async function listLookups(includeInactive = false): Promise<StoreLookup[]> {
  let q = db.from('store_lookups').select('id, kind, value, sort_order, is_active');
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q.order('kind').order('sort_order').order('value');
  if (error) throw clientError(error);
  return api<StoreLookup[]>(data ?? []);
}

export async function addLookup(input: StoreLookupInput, actor: StoreActor): Promise<StoreLookup> {
  const { data, error } = await db.from('store_lookups')
    .insert({ kind: input.kind, value: input.value.trim(), sort_order: input.sortOrder ?? 500 })
    .select('id, kind, value, sort_order, is_active').single();
  if (error) {
    if ((error as { code?: string }).code === '23505') throw httpError(409, `"${input.value.trim()}" is already in the list.`);
    throw clientError(error);
  }
  await audit('settings', data['id'] as string, input.kind, 'added', input.value.trim(), actor);
  return api<StoreLookup>(data);
}

export async function setLookupActive(id: string, active: boolean, actor: StoreActor): Promise<StoreLookup> {
  const { data, error } = await db.from('store_lookups').update({ is_active: active }).eq('id', id)
    .select('id, kind, value, sort_order, is_active').maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw httpError(404, 'Not found');
  await audit('settings', id, data['kind'] as string, active ? 'enabled' : 'disabled', data['value'] as string, actor);
  return api<StoreLookup>(data);
}

// ── Store keeper accounts ───────────────────────────────────────────────────

/** Every store_user, with their switches (defaults where Admin has set none). */
export async function listAccounts(): Promise<StoreAccount[]> {
  const store = await getStore();
  const users = await readAll<Record<string, unknown>>((from, to) =>
    db.from('users').select('id, email, display_name, username, phone, user_code, status, last_login_at, created_at')
      .eq('role', 'store_user').order('display_name').range(from, to));
  const { data: accounts, error } = await db.from('store_accounts').select('*');
  if (error) throw clientError(error);
  const byUser = new Map((api<Array<Record<string, unknown>>>(accounts ?? [])).map((a) => [a['userId'] as string, a]));
  return users.map((u) => {
    const a = byUser.get(u['id'] as string);
    return {
      id: (a?.['id'] as string | undefined) ?? null,
      userId: u['id'] as string,
      storeId: (a?.['storeId'] as string | undefined) ?? store.id,
      canManageItems: (a?.['canManageItems'] as boolean | undefined) ?? true,
      canEditPrices: (a?.['canEditPrices'] as boolean | undefined) ?? false,
      canAdjustStock: (a?.['canAdjustStock'] as boolean | undefined) ?? true,
      canIssue: (a?.['canIssue'] as boolean | undefined) ?? true,
      notes: (a?.['notes'] as string | null | undefined) ?? null,
      email: u['email'] as string,
      displayName: u['displayName'] as string,
      username: (u['username'] as string | null) ?? null,
      phone: (u['phone'] as string | null) ?? null,
      userCode: (u['userCode'] as string | null) ?? null,
      status: u['status'] as string,
      lastLoginAt: (u['lastLoginAt'] as string | null) ?? null,
      createdAt: u['createdAt'] as string,
    };
  });
}

export async function saveAccountFlags(userId: string, input: StoreAccountFlagsInput, actor: StoreActor): Promise<StoreAccount> {
  const { data: u, error: uErr } = await db.from('users').select('id, role, display_name').eq('id', userId).maybeSingle();
  if (uErr) throw clientError(uErr);
  if (!u || u['role'] !== 'store_user') throw httpError(404, 'Store account not found');
  const store = await getStore();
  const row = {
    can_manage_items: input.canManageItems,
    can_edit_prices: input.canEditPrices,
    can_adjust_stock: input.canAdjustStock,
    can_issue: input.canIssue,
    notes: input.notes?.trim() || null,
  };
  const { data: existing } = await db.from('store_accounts').select('id').eq('user_id', userId).maybeSingle();
  const { error } = existing
    ? await db.from('store_accounts').update(row).eq('user_id', userId)
    : await db.from('store_accounts').insert({ ...row, user_id: userId, store_id: store.id, created_by: actor.uid, created_by_name: actor.name });
  if (error) throw clientError(error);
  const on = (b: boolean) => (b ? 'on' : 'off');
  await audit('account', userId, u['display_name'] as string, 'permissions',
    `Items ${on(input.canManageItems)} · Prices ${on(input.canEditPrices)} · Adjust ${on(input.canAdjustStock)} · Issue ${on(input.canIssue)}`, actor);
  const all = await listAccounts();
  return all.find((a) => a.userId === userId)!;
}

// ── Items ───────────────────────────────────────────────────────────────────

export async function listItems(opts: { includeInactive?: boolean } = {}): Promise<StoreItem[]> {
  // The stock summary carries committed and unit price; join them on.
  const today = await businessDate();
  const [items, summary] = await Promise.all([
    readAll<StoreItem>((from, to) => {
      let q = db.from('store_items').select('*');
      if (!opts.includeInactive) q = q.eq('status', 'active');
      return q.order('name').range(from, to);
    }),
    call<Array<Record<string, unknown>>>('store_stock_summary', { p_from: today, p_to: today }),
  ]);
  const extra = new Map(summary.map((s) => [s['id'] as string, s]));
  return items.map((i) => ({
    ...i,
    committedQty: Number(extra.get(i.id)?.['committed'] ?? 0),
    unitPrice: (extra.get(i.id)?.['unit_price'] as number | null | undefined) ?? null,
  }));
}

export async function getItem(id: string): Promise<StoreItem> {
  const { data, error } = await db.from('store_items').select('*').eq('id', id).maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw httpError(404, 'Store item not found');
  return api<StoreItem>(data);
}

export async function saveItem(id: string | null, input: StoreItemInput, actor: StoreActor): Promise<StoreItem> {
  return api<StoreItem>(await call('store_save_item', { p_actor_id: actor.uid, p_actor_name: actor.name, p_id: id, p_input: input }));
}

export async function setItemStatus(id: string, active: boolean, actor: StoreActor): Promise<StoreItem> {
  return api<StoreItem>(await call('store_set_item_status', { p_actor_id: actor.uid, p_actor_name: actor.name, p_id: id, p_active: active }));
}

/** Admin only, and only an item nothing has ever happened to. */
export async function deleteItem(id: string, actor: StoreActor): Promise<void> {
  const item = await getItem(id);
  for (const [table, what] of [['store_movements', 'stock movements'], ['store_item_prices', 'prices'], ['store_demand_items', 'demand lines'], ['store_batches', 'batches']] as const) {
    const { count, error } = await db.from(table).select('id', { count: 'exact', head: true }).eq('item_id', id);
    if (error) throw clientError(error);
    if ((count ?? 0) > 0) throw httpError(409, `${item.name} has ${what}. Deactivate it instead; its history stays.`);
  }
  const { error } = await db.from('store_items').delete().eq('id', id);
  if (error) throw clientError(error);
  await audit('item', id, item.itemNo, 'deleted', item.name, actor);
}

export async function itemHistory(id: string): Promise<StoreItemHistory> {
  const item = await getItem(id);
  const [batches, prices, events, lines] = await Promise.all([
    readAll<StoreBatch>((from, to) => db.from('store_batches').select('*, receipt:store_receipts(receipt_no)').eq('item_id', id)
      .order('received_at', { ascending: false }).order('created_at', { ascending: false }).range(from, to)),
    listPrices({ itemId: id, history: true }),
    readAll<StoreAuditEvent>((from, to) => db.from('store_audit_events').select('id, entity, entity_id, entity_ref, action, detail, actor_name, actor_role, created_at')
      .eq('entity', 'item').eq('entity_id', id).order('created_at', { ascending: false }).range(from, to)),
    readAll<Record<string, unknown>>((from, to) => db.from('store_demand_items')
      .select('id, demand_id, requested_qty, approved_qty, issued_qty, status, demand:store_demands(demand_no, demand_date)')
      .eq('item_id', id).order('id').range(from, to)),
  ]);
  return {
    item,
    batches: batches.map((b) => {
      const r = (b as unknown as { receipt?: { receiptNo?: string } | null }).receipt;
      const { receipt: _r, ...rest } = b as unknown as Record<string, unknown>;
      void _r;
      return { ...(rest as unknown as StoreBatch), receiptNo: r?.receiptNo ?? null };
    }),
    prices,
    events,
    demandLines: lines
      .map((l) => {
        const d = l['demand'] as { demandNo: string; demandDate: string } | null;
        return {
          id: l['id'] as string,
          demandId: l['demandId'] as string,
          demandNo: d?.demandNo ?? '',
          demandDate: d?.demandDate ?? '',
          requestedQty: Number(l['requestedQty']),
          approvedQty: l['approvedQty'] == null ? null : Number(l['approvedQty']),
          issuedQty: Number(l['issuedQty']),
          status: l['status'] as StoreItemHistory['demandLines'][number]['status'],
        };
      })
      .sort((a, b) => (a.demandNo < b.demandNo ? 1 : -1)),
  };
}

// ── Price Control ───────────────────────────────────────────────────────────

/** Current & scheduled prices (default), or the full history. */
export async function listPrices(opts: { itemId?: string; history?: boolean } = {}): Promise<StorePrice[]> {
  const today = await businessDate();
  const rows = await readAll<Record<string, unknown>>((from, to) => {
    let q = db.from('store_item_prices').select('*, item:store_items(item_no, name, base_unit)');
    if (opts.itemId) q = q.eq('item_id', opts.itemId);
    return q.order('effective_from', { ascending: false }).order('created_at', { ascending: false }).range(from, to);
  });
  const prices: StorePrice[] = rows.map((r) => {
    const item = r['item'] as { itemNo: string; name: string; baseUnit: string } | null;
    const { item: _i, ...rest } = r;
    void _i;
    return { ...(rest as unknown as StorePrice), itemNo: item?.itemNo ?? '', itemName: item?.name ?? '', baseUnit: item?.baseUnit ?? '', state: 'active' };
  });
  // State on today's date — the same rule as app.store_price_state.
  for (const p of prices) {
    if (p.status === 'inactive') p.state = 'inactive';
    else if (p.effectiveFrom > today) p.state = 'scheduled';
    else {
      const newer = prices.some((q) => q !== p && q.status === 'active' && q.itemId === p.itemId && q.packageName === p.packageName
        && Number(q.packageQty) === Number(p.packageQty) && q.effectiveFrom <= today
        && (q.effectiveFrom > p.effectiveFrom || (q.effectiveFrom === p.effectiveFrom && q.createdAt > p.createdAt)));
      p.state = newer ? 'superseded' : 'active';
    }
  }
  const shown = opts.history ? prices : prices.filter((p) => p.state === 'active' || p.state === 'scheduled');
  return shown.sort((a, b) => a.itemName.localeCompare(b.itemName) || a.packageQty - b.packageQty || (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
}

export async function addPrice(input: StorePriceInput, actor: StoreActor): Promise<StorePrice> {
  const row = await call('store_add_price', { p_actor_id: actor.uid, p_actor_name: actor.name, p_actor_role: actor.role, p_input: input });
  return api<StorePrice>(row);
}

export async function deactivatePrice(id: string, actor: StoreActor): Promise<StorePrice> {
  return api<StorePrice>(await call('store_deactivate_price', { p_actor_id: actor.uid, p_actor_name: actor.name, p_actor_role: actor.role, p_id: id }));
}

// ── Audit ───────────────────────────────────────────────────────────────────

export async function audit(entity: string, entityId: string | null, ref: string | null, action: string, detail: string | null, actor: StoreActor): Promise<void> {
  const { error } = await db.from('store_audit_events').insert({
    entity, entity_id: entityId, entity_ref: ref, action, detail, actor_id: actor.uid, actor_name: actor.name, actor_role: actor.role,
  });
  if (error) console.error('[store] audit write failed', error.message);
}

export async function listAudit(opts: { entity?: string; limit?: number; offset?: number }): Promise<{ rows: StoreAuditEvent[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = db.from('store_audit_events').select('id, entity, entity_id, entity_ref, action, detail, actor_name, actor_role, created_at', { count: 'exact' });
  if (opts.entity) q = q.eq('entity', opts.entity);
  const { data, error, count } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  return { rows: api<StoreAuditEvent[]>(data ?? []), total: count ?? 0 };
}
