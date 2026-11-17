# Phase 2 — Report: Masters, Items v2, Suppliers

**Status:** Code-complete, awaiting owner verification + deploy · **Date:** 2026-11-17

Phase 2 turned the item master into an Items-v2 catalogue and added the Suppliers master. Everything is **additive and backward compatible** — existing items, receipts and the Excel import keep working; new fields are optional/defaulted, and the two new modules (Suppliers, Barcodes) ship **behind feature flags**, so nothing is visible until an Admin enables it.

---

## What shipped

| Area | What | Flag |
|---|---|---|
| **Suppliers master** | Reuse the shared `public.suppliers` as one list for Store + WhatsApp Purchasing. `whatsapp_number` made optional (WhatsApp module still requires it in its own schema); added `email`, `ntn`, `strn`, `lead_time_days`. `saveSupplier` (create/edit), full-record `listSuppliers`, a flag-gated **Suppliers page** (list + add/edit). | `suppliers` |
| **Supplier dedupe** | `store_supplier_name_map` + `store-supplier-dedupe.ts` (dry-run/apply): links each receipt's free-text `supplier_name` into the master by normalised name, **never rewriting `supplier_name`**; idempotent, with a printed report. | — |
| **Item packages** | `store_item_packages` — multiple purchase packages per item, each with its own base-unit conversion; every item's current `purchase_unit`/`conversion_qty` backfilled as the default. List/add/delete + a **Packages** section in the item view. | — |
| **Items v2 fields** | `store_items` + `reorder_qty, max_level, safety_stock, lead_time_days, preferred_supplier_id, storage_type, track_expiry, description`; `store_save_item` extended to persist + audit them. New fields in the item form. | — |
| **Barcodes** | `store_item_barcodes` (code unique store-wide); list/add/delete + a **Barcodes** section in the item view. | `barcodes` |
| **Grid/list + bulk** | Store Items **List⇄Grid** toggle + grid cards; row selection + bulk **activate / deactivate / change-category** via `POST /items/bulk`. | — |
| **Managed units** (Phase 1 carry-over) | `store_lookups.unit_type` (weight/volume/count/pack) + Settings picker. | — |

---

## Migrations to deploy (in order)

`pnpm exec prisma migrate deploy` then `pnpm prisma:pull && pnpm db:catalog`. All additive; none rewrites history.

- `20261117000005_store_suppliers_master` — suppliers: whatsapp optional + email/ntn/strn/lead_time.
- `20261117000006_store_supplier_name_map` — dedupe mapping table.
- `20261117000007_store_item_packages` — packages + backfill of each item's default.
- `20261117000008_store_items_v2_fields` — item reorder/handling columns + `store_save_item` replacement.
- `20261117000009_store_item_barcodes` — barcodes.

(These stack on Phase 1's `002–004`. Running `migrate deploy` applies whatever is pending.)

---

## Endpoints added

- `POST/PUT /store/suppliers` (requireFeature `suppliers` + receive/accounts); `GET /store/suppliers?includeInactive=`.
- `GET/POST /store/items/:id/packages`, `DELETE /store/item-packages/:id`.
- `GET/POST /store/items/:id/barcodes`, `DELETE /store/item-barcodes/:id` (POST/DELETE requireFeature `barcodes`).
- `POST /store/items/bulk` (activate/deactivate/set_category).

`requireFeature(key)` was added to `store.routes.ts` — a 404 gate for flagged modules; this is its first use.

---

## Tested

- **Server `tsc --noEmit`: 0 errors** after every step.
- **Frontend full `tsc --noEmit`: 0 errors** (the web toolchain is now installed, so these are complete, not filtered, checks).
- **Unit test** `store-stock.test.ts` passes (8/8).

### Owner verification on staging (after deploy)
1. **Enable Suppliers** in Settings → Modules → open the Suppliers tab → add a supplier (WhatsApp optional).
2. **Dedupe:** `pnpm store:supplier-dedupe` (read the report) → `-- --apply`; receipts' `supplier_name` text is unchanged, `supplier_id` filled.
3. **Packages:** on an item, View → add a second package (e.g. Bag of 25) → it appears; default can't be removed here.
4. **Items v2:** edit an item → set Reorder qty / Max level / Lead time / Storage / Preferred supplier / Track expiry → reopen and confirm saved.
5. **Barcodes:** enable the `barcodes` module → item View shows a Barcodes section → add one.
6. **Grid/bulk:** toggle Grid; select several items → Activate/Deactivate/Change category.

### Phase 2 exit criteria
- *Import 200 items from template without errors* → the Phase 1 Excel import (preview + commit) handles this; new Items-v2 fields are optional so old templates still import.
- *Supplier dedupe report generated* → `store-supplier-dedupe.ts` prints matched/created/linked counts (dry-run by default).

---

## Deferred (noted, not blocking)

- **Items-v2 extras not yet built:** item image upload, allergens tags, sub-category, per-item costing method (FIFO/FEFO toggle). Columns can be added the same additive way when needed.
- **Item detail *page*** (tabs: overview/stock-by-location/batches/ledger/prices/suppliers) — the view **dialog** now carries packages + barcodes; a full detail page is a later polish.
- **Supplier-items** (`supplier_items`: supplier SKU, last price, min order qty) and supplier performance — deferred to Phase 3, where POs make them useful.
- **Item packages ↔ prices/batches:** prices/receipts still carry free-text `(package_name, package_qty)`; tying them to the package list is Phase 3.
- **Shared types remain hand-mirrored** server↔web — a standing drift risk.

**Next:** Phase 3 — Suppliers detail + supplier-items, **Purchase Orders** (PO- numbering, status flow, reorder suggestions), **Receiving v2** (PO-based, price variance, price-pending), and **Returns from Production** (fills the `Returned` column).
