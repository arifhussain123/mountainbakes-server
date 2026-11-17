import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import type {
  StoreAccount,
  StoreAccountFlagsInput,
  StoreAuditEvent,
  StoreBatch,
  StoreDepartment,
  StoreFeature,
  StoreFeatureKey,
  StoreItem,
  StoreItemHistory,
  StoreItemImportError,
  StoreItemImportFields,
  StoreItemImportPreview,
  StoreItemImportResult,
  StoreItemImportRow,
  StoreItemInput,
  StoreLookup,
  StoreLookupInput,
  StorePrice,
  StorePriceInput,
  StorePriceRequest,
  StorePriceRequestInput,
  StorePriceRequestStatus,
  StoreSettingsInput,
  StoreSupplier,
  StoreSupplierInput,
} from '../../shared';
import {
  STORE_FEATURE_DESCRIPTIONS,
  STORE_FEATURE_KEYS,
  STORE_FEATURE_LABELS,
  STORE_ITEM_EXPORT_HEADERS,
  StoreItemInputSchema,
} from '../../shared';
import { api, businessDate, call, clientError, db, httpError, readAll, tell, type StoreActor } from './common';

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

// ── Feature flags ───────────────────────────────────────────────────────────
// The known key list lives in shared code; this table only stores which ones
// are on. A missing row = off, so a new feature needs no migration.

export async function listFeatures(): Promise<StoreFeature[]> {
  const store = await getStore();
  const { data, error } = await db.from('store_features').select('feature_key, enabled').eq('store_id', store.id);
  if (error) throw clientError(error);
  const on = new Map((data ?? []).map((r) => [r['feature_key'] as string, Boolean(r['enabled'])]));
  return STORE_FEATURE_KEYS.map((key) => ({
    key,
    label: STORE_FEATURE_LABELS[key],
    description: STORE_FEATURE_DESCRIPTIONS[key],
    enabled: on.get(key) ?? false,
  }));
}

/** `{ purchase_orders: true, … }` — for GET /me and for route feature gates. */
export async function featureMap(): Promise<Record<StoreFeatureKey, boolean>> {
  try {
    const list = await listFeatures();
    return Object.fromEntries(list.map((f) => [f.key, f.enabled])) as Record<StoreFeatureKey, boolean>;
  } catch (err) {
    // /me backs every store page, so a missing store_features table (the
    // migration not yet applied) must never take it down — treat every optional
    // module as off until the table exists.
    console.error('[store] feature map unavailable, defaulting all modules off:', err instanceof Error ? err.message : err);
    return Object.fromEntries(STORE_FEATURE_KEYS.map((k) => [k, false])) as Record<StoreFeatureKey, boolean>;
  }
}

export async function setFeature(key: string, enabled: boolean, actor: StoreActor): Promise<StoreFeature> {
  if (!(STORE_FEATURE_KEYS as readonly string[]).includes(key)) throw httpError(404, 'Unknown feature');
  const k = key as StoreFeatureKey;
  const store = await getStore();
  const { data: existing } = await db.from('store_features').select('id').eq('store_id', store.id).eq('feature_key', k).maybeSingle();
  const row = { enabled, updated_by: actor.uid, updated_by_name: actor.name, updated_at: new Date().toISOString() };
  const { error } = existing
    ? await db.from('store_features').update(row).eq('id', existing['id'] as string)
    : await db.from('store_features').insert({ ...row, store_id: store.id, feature_key: k });
  if (error) throw clientError(error);
  await audit('settings', store.id, 'feature', enabled ? 'enabled' : 'disabled', STORE_FEATURE_LABELS[k], actor);
  return { key: k, label: STORE_FEATURE_LABELS[k], description: STORE_FEATURE_DESCRIPTIONS[k], enabled };
}

export async function listLookups(includeInactive = false): Promise<StoreLookup[]> {
  let q = db.from('store_lookups').select('id, kind, value, sort_order, is_active, unit_type');
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q.order('kind').order('sort_order').order('value');
  if (error) throw clientError(error);
  return api<StoreLookup[]>(data ?? []);
}

export async function addLookup(input: StoreLookupInput, actor: StoreActor): Promise<StoreLookup> {
  const isUnit = input.kind === 'base_unit' || input.kind === 'purchase_unit';
  const { data, error } = await db.from('store_lookups')
    .insert({ kind: input.kind, value: input.value.trim(), sort_order: input.sortOrder ?? 500, unit_type: isUnit ? input.unitType ?? null : null })
    .select('id, kind, value, sort_order, is_active, unit_type').single();
  if (error) {
    if ((error as { code?: string }).code === '23505') throw httpError(409, `"${input.value.trim()}" is already in the list.`);
    throw clientError(error);
  }
  await audit('settings', data['id'] as string, input.kind, 'added', input.value.trim(), actor);
  return api<StoreLookup>(data);
}

export async function setLookupActive(id: string, active: boolean, actor: StoreActor): Promise<StoreLookup> {
  const { data, error } = await db.from('store_lookups').update({ is_active: active }).eq('id', id)
    .select('id, kind, value, sort_order, is_active, unit_type').maybeSingle();
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
  const price = api<StorePrice>(row);
  // Setting a price answers any open "please price this" request for the item.
  const { error } = await db.from('store_price_requests')
    .update({ status: 'resolved', resolved_by: actor.uid, resolved_by_name: actor.name, resolved_price_id: price.id, resolved_at: new Date().toISOString() })
    .eq('item_id', price.itemId).eq('status', 'open');
  if (error) console.error('[store] price request resolve failed', error.message);
  return price;
}

export async function deactivatePrice(id: string, actor: StoreActor): Promise<StorePrice> {
  return api<StorePrice>(await call('store_deactivate_price', { p_actor_id: actor.uid, p_actor_name: actor.name, p_actor_role: actor.role, p_id: id }));
}

// ── Price requests ──────────────────────────────────────────────────────────
// A keeper asks Finance/Admin to price an item that has none, instead of being
// silently blocked from receiving it. Store still cannot set prices; this only
// routes the ask. addPrice() resolves the open request when the price lands.

export async function listPriceRequests(status: StorePriceRequestStatus = 'open'): Promise<StorePriceRequest[]> {
  const { data, error } = await db
    .from('store_price_requests')
    .select('id, item_id, note, status, requested_by_name, resolved_by_name, created_at, resolved_at, item:store_items(item_no, name, base_unit)')
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (error) throw clientError(error);
  return (data ?? []).map((r) => {
    const it = r['item'] as { item_no?: string; name?: string; base_unit?: string } | null;
    return {
      id: r['id'] as string,
      itemId: r['item_id'] as string,
      itemNo: it?.item_no ?? '',
      itemName: it?.name ?? '',
      baseUnit: it?.base_unit ?? '',
      note: (r['note'] as string | null) ?? null,
      status: r['status'] as StorePriceRequestStatus,
      requestedByName: (r['requested_by_name'] as string | null) ?? null,
      resolvedByName: (r['resolved_by_name'] as string | null) ?? null,
      createdAt: r['created_at'] as string,
      resolvedAt: (r['resolved_at'] as string | null) ?? null,
    };
  });
}

export async function requestPrice(input: StorePriceRequestInput, actor: StoreActor): Promise<StorePriceRequest> {
  const item = await getItem(input.itemId); // 404s if the item is gone
  const store = await getStore();
  // One open request per item — a second ask just returns the standing one.
  const { data: open } = await db.from('store_price_requests')
    .select('id').eq('item_id', item.id).eq('status', 'open').maybeSingle();
  if (!open) {
    const { error } = await db.from('store_price_requests').insert({
      item_id: item.id, store_id: store.id, note: input.note ?? null,
      requested_by: actor.uid, requested_by_name: actor.name,
    });
    if (error) throw clientError(error);
    await audit('price', item.id, item.itemNo, 'price requested', input.note || `Price requested for ${item.name}`, actor);
    await tell({
      type: 'store_price_request',
      title: `Price needed: ${item.name}`,
      message: `${actor.name} asked Finance to set a price for ${item.itemNo} (${item.name}) so it can be received.`,
      targetRole: 'finance_admin',
      relatedId: item.id,
    });
  }
  const list = await listPriceRequests('open');
  return list.find((r) => r.itemId === item.id) ?? list[0]!;
}

// ── Suppliers (shared master; behind the `suppliers` feature) ────────────────

const SUPPLIER_COLS =
  'id, supplier_code, name, contact_person, phone, whatsapp_number, email, category, address, ntn, strn, payment_terms, lead_time_days, notes, is_active';

export async function saveSupplier(id: string | null, input: StoreSupplierInput, actor: StoreActor): Promise<StoreSupplier> {
  const row = {
    name: input.name.trim(),
    contact_person: input.contactPerson ?? null,
    phone: input.phone ?? null,
    whatsapp_number: input.whatsappNumber ?? null,
    email: input.email ?? null,
    category: input.category ?? null,
    address: input.address ?? null,
    ntn: input.ntn ?? null,
    strn: input.strn ?? null,
    payment_terms: input.paymentTerms ?? null,
    lead_time_days: input.leadTimeDays ?? null,
    notes: input.notes ?? null,
  };
  const dup = (error: unknown) =>
    (error as { code?: string }).code === '23505' ? httpError(409, `"${input.name.trim()}" is already a supplier.`) : clientError(error);

  if (id) {
    const { data, error } = await db.from('suppliers').update(row).eq('id', id).is('deleted_at', null).select(SUPPLIER_COLS).maybeSingle();
    if (error) throw dup(error);
    if (!data) throw httpError(404, 'Supplier not found');
    await audit('settings', id, data['supplier_code'] as string, 'supplier updated', input.name.trim(), actor);
    return api<StoreSupplier>(data);
  }
  const { data, error } = await db.from('suppliers').insert({ ...row, created_by: actor.uid, created_by_name: actor.name }).select(SUPPLIER_COLS).single();
  if (error) throw dup(error);
  await audit('settings', data['id'] as string, data['supplier_code'] as string, 'supplier added', input.name.trim(), actor);
  return api<StoreSupplier>(data);
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

// ── Items: Excel import / export ──────────────────────────────────────────────
//
// Export builds the full item master as spreadsheet rows (the route turns them
// into .xlsx/.csv). Import is two-phase: parse+validate into a preview that
// never writes, then commit the confirmed rows through saveItem — the same
// database function (and audit trail) a single New Item uses.

const HTTP_BAD = (msg: string) => Object.assign(new Error(msg), { status: 400 });

/** Collapse a header to letters+digits so "Low-stock Level" and "lowstocklevel" match. */
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Read an ExcelJS cell as a raw string, tolerant of numbers, formulas and rich text. */
function cellRaw(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as { result?: unknown; text?: unknown };
    if (o.result != null) return String(o.result);
    if (o.text != null) return String(o.text);
    return String(cell.text ?? '');
  }
  return String(v);
}

/** XLSX (OOXML) is a ZIP — it starts with "PK\x03\x04". Anything else goes through the CSV reader. */
function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** The full item master as spreadsheet rows, ordered by name. Also the import template. */
export async function buildItemExportRows(): Promise<{ headers: string[]; rows: (string | number)[][] }> {
  const items = await listItems({ includeInactive: true });
  const rows = items.map((i) => [
    i.itemNo,
    i.itemCode,
    i.name,
    i.category,
    i.baseUnit,
    i.purchaseUnit,
    i.conversionQty,
    i.minStock,
    i.remarks ?? '',
    i.status === 'active' ? 'Active' : 'Inactive',
  ]);
  return { headers: [...STORE_ITEM_EXPORT_HEADERS], rows };
}

/** Parse an uploaded item workbook (.xlsx or .csv) into a validated preview. Never writes. */
export async function parseItemImport(buffer: Buffer): Promise<StoreItemImportPreview> {
  const wb = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet | undefined;
  try {
    if (looksLikeXlsx(buffer)) {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      sheet = wb.worksheets[0];
    } else {
      // ExcelJS's CSV reader needs a stream; the identity map keeps every cell a
      // raw string so codes like "007" aren't coerced to numbers or dates.
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);
      sheet = await wb.csv.read(stream, { map: (value: string) => value });
    }
  } catch {
    throw HTTP_BAD("Could not read the file. Upload a valid Excel (.xlsx) or CSV file — old .xls files aren't supported.");
  }
  if (!sheet) throw HTTP_BAD('The uploaded file has no worksheet');

  const colIndex: Record<string, number> = {};
  sheet.getRow(1).eachCell((cell, col) => { colIndex[normKey(String(cell.value ?? ''))] = col; });
  const codeCol = colIndex['itemcode'] ?? colIndex['code'];
  const nameCol = colIndex['itemname'] ?? colIndex['name'];
  const catCol = colIndex['category'];
  const baseCol = colIndex['baseunit'];
  const purCol = colIndex['purchaseunit'];
  const convCol = colIndex['conversionqty'] ?? colIndex['conversion'];
  const minCol = colIndex['lowstocklevel'] ?? colIndex['lowstock'] ?? colIndex['minstock'] ?? colIndex['minimumstock'];
  const remarksCol = colIndex['remarks'] ?? colIndex['remark'] ?? colIndex['notes'];

  const missing = [
    [codeCol, 'Item Code'], [nameCol, 'Item Name'], [catCol, 'Category'], [baseCol, 'Base Unit'],
    [purCol, 'Purchase Unit'], [convCol, 'Conversion Qty'], [minCol, 'Low-stock Level'],
  ].filter(([c]) => !c).map(([, label]) => label);
  if (missing.length) throw HTTP_BAD(`The file is missing these columns: ${missing.join(', ')}. Download the template to see the expected headers.`);

  // Active pick-lists and the current item master — the preview rejects anything
  // the New Item form would also reject, and matches existing items by code.
  const [lookups, items] = await Promise.all([listLookups(), listItems({ includeInactive: true })]);
  const set = (kind: StoreLookup['kind']) => new Set(lookups.filter((l) => l.kind === kind && l.isActive).map((l) => l.value));
  const categories = set('category');
  const baseUnits = set('base_unit');
  const purchaseUnits = set('purchase_unit');
  const byCode = new Map(items.map((i) => [i.itemCode.toUpperCase(), i]));

  const rows: StoreItemImportRow[] = [];
  const errors: StoreItemImportError[] = [];
  const seen = new Set<string>();
  let total = 0;
  let unchanged = 0;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const code = cellRaw(row.getCell(codeCol!)).trim().toUpperCase();
    const name = cellRaw(row.getCell(nameCol!)).trim();
    const category = cellRaw(row.getCell(catCol!)).trim();
    const baseUnit = cellRaw(row.getCell(baseCol!)).trim();
    const purchaseUnit = cellRaw(row.getCell(purCol!)).trim();
    const convRaw = cellRaw(row.getCell(convCol!)).trim();
    const minRaw = cellRaw(row.getCell(minCol!)).trim();
    const remarksRaw = remarksCol ? cellRaw(row.getCell(remarksCol)).trim() : '';

    // A fully blank row is skipped, not counted.
    if (!code && !name && !category && !baseUnit && !purchaseUnit && !convRaw && !minRaw && !remarksRaw) return;
    total += 1;

    const fail = (message: string) => errors.push({ rowNumber, itemCode: code, message });

    if (!code) { fail('Missing Item Code'); return; }
    if (seen.has(code)) { fail(`Item Code "${code}" appears more than once in the file`); return; }
    seen.add(code);

    const fields: StoreItemImportFields = {
      itemCode: code,
      name,
      category,
      baseUnit,
      purchaseUnit,
      conversionQty: Number(convRaw),
      minStock: minRaw === '' ? NaN : Number(minRaw),
      remarks: remarksRaw || null,
    };

    const parsed = StoreItemInputSchema.safeParse(fields);
    if (!parsed.success) { fail(parsed.error.issues[0]?.message ?? 'Invalid row'); return; }

    if (!categories.has(category)) { fail(`Unknown category "${category}" — add it under Store settings first`); return; }
    if (!baseUnits.has(baseUnit)) { fail(`Unknown base unit "${baseUnit}"`); return; }
    if (!purchaseUnits.has(purchaseUnit)) { fail(`Unknown purchase unit "${purchaseUnit}"`); return; }

    const existing = byCode.get(code);
    if (!existing) {
      rows.push({ ...fields, rowNumber, action: 'create', id: null, changes: [] });
      return;
    }

    const changes = diffItem(existing, fields);
    if (changes.length === 0) { unchanged += 1; return; }
    rows.push({ ...fields, rowNumber, action: 'update', id: existing.id, changes });
  });

  const create = rows.filter((r) => r.action === 'create').length;
  return {
    summary: { total, create, update: rows.length - create, unchanged, errors: errors.length },
    rows,
    errors,
  };
}

/** Human-readable list of what an update changes; empty when the row matches the item as stored. */
function diffItem(existing: StoreItem, next: StoreItemImportFields): string[] {
  const out: string[] = [];
  if (existing.name !== next.name) out.push(`Name "${existing.name}" → "${next.name}"`);
  if (existing.category !== next.category) out.push(`Category ${existing.category} → ${next.category}`);
  if (existing.baseUnit !== next.baseUnit) out.push(`Base unit ${existing.baseUnit} → ${next.baseUnit}`);
  if (existing.purchaseUnit !== next.purchaseUnit) out.push(`Purchase unit ${existing.purchaseUnit} → ${next.purchaseUnit}`);
  if (existing.conversionQty !== next.conversionQty) out.push(`Conversion ${existing.conversionQty} → ${next.conversionQty}`);
  if (existing.minStock !== next.minStock) out.push(`Low-stock ${existing.minStock} → ${next.minStock}`);
  if ((existing.remarks ?? '') !== (next.remarks ?? '')) out.push('Remarks changed');
  return out;
}

/** Apply confirmed import rows through saveItem (create when id is null, else update). */
export async function commitItemImport(
  rows: (StoreItemInput & { id: string | null })[],
  actor: StoreActor,
): Promise<StoreItemImportResult> {
  let created = 0;
  let updated = 0;
  const failed: { itemCode: string; message: string }[] = [];

  for (const row of rows) {
    const { id, ...input } = row;
    try {
      await saveItem(id, input, actor);
      if (id) updated += 1;
      else created += 1;
    } catch (err) {
      failed.push({ itemCode: row.itemCode, message: err instanceof Error ? err.message : 'Could not save this item' });
    }
  }
  return { created, updated, failed };
}
