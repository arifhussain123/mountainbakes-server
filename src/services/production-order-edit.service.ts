import { getPrisma } from '../db';

/**
 * The branch editing its own demand while it is still 'pending'.
 *
 * One transaction, and it starts by taking the order row `for update`. That is
 * the whole point: Production's review (`review_production_order`) flips the
 * same row out of 'pending' with an `update ... where status = 'pending'`, so
 * the two serialise on that lock. Either the edit lands first and the review
 * approves the edited lines, or the review lands first and the edit finds the
 * order no longer 'pending' and is refused. A read-then-write outside a
 * transaction would let an edit change lines Production had already approved
 * and sent stock against.
 *
 * What the branch may change:
 *  - its own product lines (`added_by_production = false`): quantity, or remove;
 *    and add products that are not on the demand yet;
 *  - the packing lines: quantity, remove, add.
 *
 * Lines Production added are left exactly as they are. Kept lines keep their
 * `unit_price` snapshot and their place in the order; only a NEW line is priced
 * from today's catalogue, as it would have been had it been on the demand from
 * the start (§18).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Tx = Pick<ReturnType<typeof getPrisma>, '$queryRawUnsafe' | '$executeRawUnsafe'>;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export interface EditDemandInput {
  orderId: string;
  /** From the token, never the body. */
  branchId: string;
  items: { productId: string; qty: number }[];
  packingItems: { packingMaterialId: string; qty: number }[];
}

export interface EditDemandResult {
  demandNumber: string;
  productLines: number;
  packingLines: number;
}

export async function editBranchDemand(input: EditDemandInput): Promise<EditDemandResult> {
  const { orderId, branchId, items, packingItems } = input;
  if (!UUID.test(orderId)) throw httpError(404, 'Production order not found');
  // An id that is not a uuid would otherwise reach a `::uuid` cast and come back
  // as a 500; it is a bad request.
  if (items.some((i) => !UUID.test(i.productId)) || packingItems.some((i) => !UUID.test(i.packingMaterialId))) {
    throw httpError(400, 'One of the selected items is not valid. Please refresh and try again.');
  }

  let result: EditDemandResult | undefined;
  await getPrisma().$transaction(async (tx) => {
    const [order] = await tx.$queryRawUnsafe<{ branch_id: string; status: string; demand_number: string }[]>(
      `select branch_id::text as branch_id, status::text as status, demand_number
         from public.production_orders where id = $1::uuid for update`,
      orderId,
    );
    if (!order) throw httpError(404, 'Production order not found');
    if (order.branch_id !== branchId) throw httpError(403, 'This demand belongs to a different branch');
    if (order.status !== 'pending') {
      throw httpError(
        409,
        order.status === 'cancelled'
          ? 'This demand has been deleted'
          : 'Production has already sent this demand for verification — it can no longer be edited',
      );
    }

    await editProducts(tx, orderId, items);
    await editPacking(tx, orderId, packingItems);

    // The slip Production may already have printed no longer matches the
    // demand, so it shows as not printed again. `updated_at` is set by the
    // production_orders_touch trigger.
    await tx.$executeRawUnsafe(
      'update public.production_orders set printed = false, printed_at = null where id = $1::uuid',
      orderId,
    );

    result = { demandNumber: order.demand_number, productLines: items.length, packingLines: packingItems.length };
  });
  return result!;
}

async function editProducts(tx: Tx, orderId: string, items: EditDemandInput['items']): Promise<void> {
  const existing = await tx.$queryRawUnsafe<{ id: string; product_id: string | null; qty: string }[]>(
    `select id::text as id, product_id::text as product_id, qty::text as qty
       from public.production_order_items
      where production_order_id = $1::uuid and not added_by_production and not is_special
      order by line_no`,
    orderId,
  );

  const wanted = new Map(items.map((i) => [i.productId.toLowerCase(), i.qty]));
  const kept = new Set<string>();
  for (const line of existing) {
    const productId = line.product_id?.toLowerCase();
    const qty = productId ? wanted.get(productId) : undefined;
    // A second line for a product already kept is folded away: the branch sees
    // and edits one quantity per product.
    if (productId && qty !== undefined && !kept.has(productId)) {
      kept.add(productId);
      if (Number(line.qty) !== qty) {
        await tx.$executeRawUnsafe(
          'update public.production_order_items set qty = $2::numeric where id = $1::uuid',
          line.id,
          qty,
        );
      }
    } else {
      await tx.$executeRawUnsafe('delete from public.production_order_items where id = $1::uuid', line.id);
    }
  }

  const added = items.filter((i) => !kept.has(i.productId.toLowerCase()));
  if (added.length === 0) return;

  // Active only, as the order form offers: a product switched off while the
  // dialog was open must not land on a demand.
  const products = await tx.$queryRawUnsafe<{ id: string; name: string; price: string | null }[]>(
    `select id::text as id, name, price::text as price
       from public.products where id = any($1::uuid[]) and is_active`,
    added.map((i) => i.productId),
  );
  const byId = new Map(products.map((p) => [p.id.toLowerCase(), p]));

  const [{ max }] = await tx.$queryRawUnsafe<{ max: number }[]>(
    'select coalesce(max(line_no), 0)::int as max from public.production_order_items where production_order_id = $1::uuid',
    orderId,
  );
  let lineNo = max;
  for (const it of added) {
    const product = byId.get(it.productId.toLowerCase());
    if (!product) throw httpError(400, 'One of the selected products is no longer available. Please refresh and try again.');
    lineNo += 1;
    await tx.$executeRawUnsafe(
      `insert into public.production_order_items
         (production_order_id, product_id, product_name, unit_price, qty, remarks, is_special, line_no)
       values ($1::uuid, $2::uuid, $3, $4::numeric, $5::numeric, '', false, $6)`,
      orderId,
      product.id,
      product.name,
      Number(product.price ?? 0),
      it.qty,
      lineNo,
    );
  }
}

async function editPacking(tx: Tx, orderId: string, packingItems: EditDemandInput['packingItems']): Promise<void> {
  const existing = await tx.$queryRawUnsafe<{ id: string; packing_material_id: string; qty: string }[]>(
    `select id::text as id, packing_material_id::text as packing_material_id, qty::text as qty
       from public.production_order_packing_items where production_order_id = $1::uuid`,
    orderId,
  );

  const wanted = new Map(packingItems.map((i) => [i.packingMaterialId.toLowerCase(), i.qty]));
  const kept = new Set<string>();
  for (const line of existing) {
    const materialId = line.packing_material_id.toLowerCase();
    const qty = wanted.get(materialId);
    if (qty === undefined) {
      await tx.$executeRawUnsafe('delete from public.production_order_packing_items where id = $1::uuid', line.id);
      continue;
    }
    kept.add(materialId);
    if (Number(line.qty) !== qty) {
      await tx.$executeRawUnsafe(
        'update public.production_order_packing_items set qty = $2::numeric where id = $1::uuid',
        line.id,
        qty,
      );
    }
  }

  const added = packingItems.filter((i) => !kept.has(i.packingMaterialId.toLowerCase()));
  if (added.length === 0) return;

  const materials = await tx.$queryRawUnsafe<{ id: string; material_name: string }[]>(
    `select id::text as id, material_name
       from public.packing_materials where id = any($1::uuid[]) and is_active`,
    added.map((i) => i.packingMaterialId),
  );
  const byId = new Map(materials.map((m) => [m.id.toLowerCase(), m]));

  const [{ max }] = await tx.$queryRawUnsafe<{ max: number }[]>(
    'select coalesce(max(line_no), 0)::int as max from public.production_order_packing_items where production_order_id = $1::uuid',
    orderId,
  );
  let lineNo = max;
  for (const it of added) {
    const material = byId.get(it.packingMaterialId.toLowerCase());
    if (!material) {
      throw httpError(400, 'One of the selected packing materials is no longer available. Please refresh and try again.');
    }
    lineNo += 1;
    await tx.$executeRawUnsafe(
      `insert into public.production_order_packing_items
         (production_order_id, packing_material_id, material_name, qty, line_no)
       values ($1::uuid, $2::uuid, $3, $4::numeric, $5)`,
      orderId,
      material.id,
      material.material_name,
      it.qty,
      lineNo,
    );
  }
}
