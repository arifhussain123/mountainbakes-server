import { toE164 } from '../../utils/phone';
import type {
  IngredientStockMovement,
  PurchaseItem,
  PurchaseItemInput,
  Supplier,
  SupplierBalance,
  SupplierInput,
} from '../../shared';
import { api, call, clientError, db, notFound, type Actor } from './common';

/**
 * Suppliers (the people Production buys from) and the ingredient catalog
 * (what it buys, with stock on hand). A supplier's WhatsApp number is stored
 * E.164 and is the ONLY thing an inbound message is matched on, so it is
 * normalised here and unique among live suppliers in the database.
 */

const searchTerm = (s?: string) => s?.replace(/[(),*%]/g, ' ').trim() || '';

export function normaliseWhatsApp(raw: string): string {
  const e164 = toE164(raw);
  if (!e164) {
    throw Object.assign(new Error('Enter a valid WhatsApp number, e.g. 0300 1234567 or +92 300 1234567'), { status: 400 });
  }
  return e164;
}

export async function listSuppliers(opts: { search?: string; includeInactive?: boolean; limit?: number; offset?: number }): Promise<{ suppliers: Supplier[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = db.from('suppliers').select('*', { count: 'exact' }).is('deleted_at', null);
  if (!opts.includeInactive) q = q.eq('is_active', true);
  const term = searchTerm(opts.search);
  if (term) {
    const digits = term.replace(/\D/g, '');
    q = q.or(
      [`name.ilike.%${term}%`, `contact_person.ilike.%${term}%`, `supplier_code.ilike.%${term}%`, `category.ilike.%${term}%`]
        .concat(digits.length >= 4 ? [`whatsapp_number.ilike.%${digits.slice(-9)}%`] : [])
        .join(','),
    );
  }
  const { data, error, count } = await q.order('name', { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  return { suppliers: api<Supplier[]>(data ?? []), total: count ?? 0 };
}

export async function getSupplier(id: string): Promise<Supplier | null> {
  const { data, error } = await db.from('suppliers').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw clientError(error);
  return data ? api<Supplier>(data) : null;
}

function supplierRow(input: SupplierInput) {
  return {
    name: input.name.trim(),
    contact_person: input.contactPerson?.trim() || null,
    whatsapp_number: normaliseWhatsApp(input.whatsappNumber),
    phone: input.phone?.trim() || null,
    category: input.category?.trim() || null,
    address: input.address?.trim() || null,
    payment_terms: input.paymentTerms?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

async function assertNumberFree(whatsapp: string, exceptId?: string): Promise<void> {
  let q = db.from('suppliers').select('id, name').eq('whatsapp_number', whatsapp).is('deleted_at', null);
  if (exceptId) q = q.neq('id', exceptId);
  const { data, error } = await q.limit(1);
  if (error) throw clientError(error);
  if (data && data.length > 0) {
    throw Object.assign(new Error(`${whatsapp} is already the WhatsApp number of ${String(data[0].name)}.`), { status: 409 });
  }
}

export async function createSupplier(input: SupplierInput, actor: Actor): Promise<Supplier> {
  const row = supplierRow(input);
  if (!input.whatsappOptIn) {
    throw Object.assign(new Error('Confirm the supplier agreed to receive WhatsApp messages from Mountain Bakes.'), { status: 400 });
  }
  await assertNumberFree(row.whatsapp_number);
  const { data, error } = await db
    .from('suppliers')
    .insert({
      ...row,
      is_active: input.isActive ?? true,
      whatsapp_opt_in_at: new Date().toISOString(),
      whatsapp_opt_in_source: input.whatsappOptInSource?.trim() || `Confirmed by ${actor.name} when registering`,
      created_by: actor.uid,
      created_by_name: actor.name,
    })
    .select('*')
    .single();
  if (error) throw clientError(error);
  return api<Supplier>(data);
}

export async function updateSupplier(id: string, input: SupplierInput, actor: Actor): Promise<Supplier> {
  const existing = await getSupplier(id);
  if (!existing) throw notFound('Supplier');
  const row = supplierRow(input);
  await assertNumberFree(row.whatsapp_number, id);
  const numberChanged = row.whatsapp_number !== existing.whatsappNumber;
  if (numberChanged && !input.whatsappOptIn) {
    throw Object.assign(new Error('A new WhatsApp number needs the supplier\'s consent: confirm it to save.'), { status: 400 });
  }
  const { data, error } = await db
    .from('suppliers')
    .update({
      ...row,
      ...(input.isActive === undefined ? {} : { is_active: input.isActive }),
      ...(numberChanged
        ? {
            whatsapp_opt_in_at: new Date().toISOString(),
            whatsapp_opt_in_source: input.whatsappOptInSource?.trim() || `Confirmed by ${actor.name} when changing the number`,
          }
        : {}),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw clientError(error);
  return api<Supplier>(data);
}

/** Soft delete: the supplier stays on every demand, bill and payment it is named on. */
export async function deleteSupplier(id: string, reason: string, actor: Actor): Promise<void> {
  const { data: open, error: openErr } = await db
    .from('purchase_demands')
    .select('demand_no')
    .eq('supplier_id', id)
    .not('status', 'in', '(draft,received,cancelled,rejected)')
    .limit(1);
  if (openErr) throw clientError(openErr);
  if (open && open.length > 0) {
    throw Object.assign(new Error(`Demand ${String(open[0].demand_no)} with this supplier is still open.`), { status: 409 });
  }
  const { error } = await db
    .from('suppliers')
    .update({ deleted_at: new Date().toISOString(), deleted_by: actor.uid, deleted_by_name: actor.name, delete_reason: reason, is_active: false })
    .eq('id', id)
    .is('deleted_at', null);
  if (error) throw clientError(error);
}

export async function supplierBalances(supplierId?: string): Promise<SupplierBalance[]> {
  const rows = await call<Array<Record<string, unknown>>>('supplier_balances', supplierId ? { p_supplier_id: supplierId } : {});
  return api<SupplierBalance[]>(rows ?? []);
}

// ── Ingredient catalog and stock ────────────────────────────────────────────

export async function listItems(opts: { search?: string; includeInactive?: boolean }): Promise<PurchaseItem[]> {
  let q = db.from('purchase_items').select('*, stock:ingredient_stock(balance)');
  if (!opts.includeInactive) q = q.eq('is_active', true);
  const term = searchTerm(opts.search);
  if (term) q = q.or(`name.ilike.%${term}%,item_code.ilike.%${term}%,category.ilike.%${term}%`);
  const { data, error } = await q.order('name', { ascending: true }).limit(500);
  if (error) throw clientError(error);
  return (data ?? []).map((r: Record<string, unknown>) => {
    const stock = r['stock'] as { balance?: number } | Array<{ balance?: number }> | null;
    const balance = Array.isArray(stock) ? stock[0]?.balance : stock?.balance;
    const { stock: _s, ...rest } = r;
    return { ...api<Omit<PurchaseItem, 'balance'>>(rest), balance: Number(balance ?? 0) };
  });
}

export async function createItem(input: PurchaseItemInput, actor: Actor): Promise<PurchaseItem> {
  const { data, error } = await db
    .from('purchase_items')
    .insert({
      name: input.name.trim(),
      unit: input.unit,
      category: input.category?.trim() || null,
      is_active: input.isActive ?? true,
      created_by: actor.uid,
      created_by_name: actor.name,
    })
    .select('*')
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw Object.assign(new Error(`${input.name.trim()} (${input.unit}) is already in the list.`), { status: 409 });
    }
    throw clientError(error);
  }
  return { ...api<Omit<PurchaseItem, 'balance'>>(data), balance: 0 };
}

export async function updateItem(id: string, input: PurchaseItemInput): Promise<PurchaseItem> {
  const { data, error } = await db
    .from('purchase_items')
    .update({ name: input.name.trim(), unit: input.unit, category: input.category?.trim() || null, ...(input.isActive === undefined ? {} : { is_active: input.isActive }) })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw clientError(error);
  if (!data) throw notFound('Item');
  const items = await listItems({ includeInactive: true });
  return items.find((i) => i.id === id) ?? { ...api<Omit<PurchaseItem, 'balance'>>(data), balance: 0 };
}

export async function listMovements(opts: { itemId?: string; limit?: number; offset?: number }): Promise<{ movements: IngredientStockMovement[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = db.from('ingredient_stock_movements').select('*', { count: 'exact' });
  if (opts.itemId) q = q.eq('item_id', opts.itemId);
  const { data, error, count } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw clientError(error);
  return { movements: api<IngredientStockMovement[]>(data ?? []), total: count ?? 0 };
}

export async function adjustStock(input: { itemId: string; delta: number; reason: string }, businessDate: string, actor: Actor): Promise<IngredientStockMovement> {
  const row = await call<Record<string, unknown>>('ingredient_stock_adjust', {
    p_item_id: input.itemId,
    p_delta: input.delta,
    p_reason: input.reason,
    p_business_date: businessDate,
    p_actor_id: actor.uid,
    p_actor_name: actor.name,
  });
  return api<IngredientStockMovement>(row);
}
