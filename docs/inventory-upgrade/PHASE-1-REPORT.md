# Phase 1 — Report: Fixes + shared foundation

**Status:** Code-complete, awaiting owner verification + deploy · **Date:** 2026-11-17

Phase 1 fixed the eight §1 problems that belong to this phase (the prompt assigns **#9 Returns → Phase 3** and **#10 Suppliers → Phase 2**) and laid the shared foundation later phases build on: one stock-status definition, the §10 status-colour language, a feature-flag mechanism, a unit-type master, and two reusable table affordances. Everything is **additive and backward compatible** — no existing route, ID, report, or API response changed shape except `/store/me`, which gained a `features` map.

---

## What changed, by problem

| # | Problem | Fix |
|---|---|---|
| 1 | Low-stock KPI contradicted out-of-stock | One shared definition `storeStockStatus` / `needsReorder` (`src/shared/utils/store-stock.ts`, both repos). Dashboard card is now **"Low Stock (not out)"** and never claims "all above reorder level" while items are out; Store Stock filter reads **"Low or out (n)"**. A unit test locks the rules. |
| 2 | Zero shown as `-` in places (Committed) | Store Stock renders every quantity (Committed, Returned, Adjusted, Opening, Issued) as a **muted `0`**, never a dash. |
| 3 | Receiving hard-blocked with no active price | **Request-price flow**: `store_price_requests` table; keeper taps **Request price** on a no-price item (Store Items); Finance/Admin see the queue on **Price Control** with a **Set price** shortcut; adding a price **auto-resolves** the request; Finance is notified (`store_price_request`). Store still cannot set prices. |
| 4 | Categories hard-coded / mis-filed | Categories were already a managed master (`store_lookups` + Settings CRUD); migration documents that re-filing is **manual** (no data rewrite). |
| 5 | Units had no type | `store_lookups.unit_type` (`weight/volume/count/pack`), seeded for shipped units; Settings shows a **type badge** and a **Type…** picker when adding a unit. |
| 6 | Inconsistent name casing | Display-only `titleCase()` on item names (Items, Stock, Dashboard lists). Stored data untouched; uniqueness stays case-insensitive. |
| 7 | Tall rows / wide tables, no frozen columns | `DataTable` gained opt-in **`stickyFirstColumn`** and a **`columnChooser`**; enabled on Items, Stock, Reports. Other tables (finance/sales) are unaffected. |
| 8 | Two near-duplicate dashboard cards | Merged "Total Available Stock" + "Today's Remaining Stock" into one hero card with a secondary "free after approved demand" line. |
| — | Feature flags (ground-rule 11, none existed) | `store_features` table + `GET/PUT /store/features` + `/me.features` + a **Modules (early access)** toggle list in Settings. Phase 2+ modules merge dark and enable per store. |

---

## Migrations to deploy (in order)

Apply with `pnpm exec prisma migrate deploy`, then `pnpm prisma:pull` && `pnpm db:catalog` (per `infra/railway/README.md`). All additive; none rewrites history.

1. `20261117000002_store_features` — feature-flag table.
2. `20261117000003_store_unit_types` — `unit_type` column + backfill of seeded units.
3. `20261117000004_store_price_requests` — price-request table + `notification_type` enum value `store_price_request`.

> Note: `20261117000004` adds an enum value with `ALTER TYPE ... ADD VALUE IF NOT EXISTS` (same pattern as `20261031000001_finance_loans`); the value is only used at runtime, so it is safe inside the migration transaction on PG12+.

---

## Files touched (high level)

- **Shared (both `src/shared`):** `utils/store-stock.ts` (new) + barrel; `types/store.types.ts` (feature keys, unit types, `StoreMe.features`, `StorePriceRequest`); `schemas/store.schemas.ts` (`StoreFeatureToggleSchema`, `unitType`, `StorePriceRequestInputSchema`).
- **Server:** `services/store/catalog.service.ts` (features, unit-type on lookups, price-requests + auto-resolve in `addPrice`); `routes/store.routes.ts` (`/features`, `/price-requests`, `/me.features`).
- **Web:** `components/shared/DataTable.tsx` (sticky column + chooser); `components/store/{StoreItemsPage,StoreStockPage,StoreDashboardPage,StorePricesPage,StoreSettingsPage}.tsx`, `components/store/parts.tsx` (`titleCase`, shared `stockTone`, muted-zero); `lib/store.ts` + `lib/queryKeys.ts` (feature + price-request hooks).

---

## Tested

- **Server `tsc --noEmit`: 0 errors** after every step.
- Frontend: the changed files typecheck clean (the local web `node_modules` is incomplete here — `vitest`/`next` types missing — so run `npm run test` and `npm run typecheck` in a full environment).
- **New unit test:** `src/shared/utils/store-stock.test.ts` pins the low/out/ok/inactive rules and the low→amber, out→red tones.

### Owner verification on staging (after deploy)
1. **KPI agreement:** Dashboard "Low Stock (not out)" + "Out of Stock" counts equal the Store Stock "Low or out (n)" filter.
2. **Zero format:** a zero Committed shows a muted `0`, not `-`.
3. **Request price:** as a Store keeper, an item with no price shows **Request price**; tapping it makes it appear on Price Control; as Finance, **Set price** prices it and the request disappears.
4. **Units:** add a unit in Settings with a type; it shows a badge.
5. **Table:** on Items/Stock/Reports, the first column stays put while scrolling sideways, and **Columns** hides/shows columns.
6. **Flags:** toggle a module in Settings → Modules; `/store/me` reflects it.

---

## Deferred / known gaps (by design)

- **"Receive now, price later"** `PRICE_PENDING` receipt — the prompt marks it optional; left for a later phase. The required *routing* half (request price) ships now.
- **§1 #9 Returns from Production → Phase 3**; **§1 #10 Suppliers master → Phase 2** (prompt's own phasing).
- `titleCase` is applied on the main item-name displays; remaining spots (ledger, pickers, approval) roll out as those screens are touched in later phases.
- Feature-flag **route enforcement** (`requireFeature`) lands with the first flagged module (Phase 2 Suppliers); today the mechanism + UI gating are in place and there is nothing to gate yet.
- Shared types are **duplicated** server↔web and were kept in sync by hand this phase — a standing drift risk to watch.

**Next:** Phase 2 — managed Categories/Units CRUD depth, item packages + barcodes, Items v2 fields, and the Suppliers master with free-text supplier migration (behind the `suppliers` flag).
