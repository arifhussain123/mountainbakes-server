# Mountain Bakes ERP: Dry Items Store to Full Inventory & Stock System
## Agentic master prompt (hand this to Claude Code at the repo root)

---

## 0. Your role and mission

You are a senior full-stack engineer and product designer working inside the Mountain Bakes ERP codebase. Your job is to upgrade the existing **Dry Items Store** module into a complete, production-grade **Inventory & Stock Management** system for a multi-branch bakery, without breaking anything that already works.

Work in phases. Finish each phase fully (code, migrations, tests, UI) before starting the next. After every phase, write a short report in `docs/inventory-upgrade/PHASE-<n>-REPORT.md` with what changed, what was tested, and anything left open.

Do not guess when the codebase can tell you. Read first, then plan, then build.

---

## 1. What exists today (reviewed live on 17 Nov 2026)

Live app: `https://mountainbakes-dfc2c.firebaseapp.com/` (role: Store User, store `DRY-STORE-001`).
Frontend appears to be a Next.js static export on Firebase Hosting (trailing-slash routes like `/store-stock/`). Backend is `mountain-bakes-server` (REST) on Railway with PostgreSQL. Confirm all of this in Phase 0.

### Current Store navigation and routes

| Menu | Route | What it does now |
|---|---|---|
| Dashboard | `/store-dashboard/` | 10 KPI cards (total items, available stock value, today received, today issued, pending demand, approved demand, rejected demand, low stock, out of stock, today's remaining stock). Low stock list, "Production demand waiting" panel, and a tabbed table: Stock movement / Consumption by item / Item-wise balance with Today, Yesterday, Last 7 days, This month, Custom range and Daily/Weekly/Monthly grouping. Buttons: Receive Stock, Review demand. |
| Store Items | `/store-items/` | Master list. Columns: Item ID (DRY-001), Item Code, Name, Category, Base Unit, Purchase Unit, Conversion (1 Bag = 50 KG), Low-stock Level, In Store, Status, Actions (View, Edit, Deactivate). Filters: category, unit, status. "New Store Item" modal: name, code, category, base unit, purchase unit, conversion qty, low-stock level, remarks. |
| Price Control | `/store-prices/` | View-only for Store (Finance/Admin set prices). Price per purchase package with effective date, per-unit price, status. "Current & scheduled" and "Full history" tabs. Warning banner: "No active price, so these can't be received: EGG, oil". |
| New Stock Receiving | `/store-receiving/` | Receipt header (auto ID RCV-xxxxxx, store, date, supplier dropdown with "Other (type name)", invoice no., received by). Multi-line items: item, purchase package, number of packages, total received (computed), price per package (from Price Control, read-only), amount, batch no., expiry date. Remarks. Recent receipts table. |
| Store Stock | `/store-stock/` | Ledger-derived balances: Opening, Received, Issued, Returned, Adjusted, Available, Committed, Free now, Unit, Batches, Last Received, Status. Date range filter, category filter, "Low stock only", Export. Stock Adjustment modal (item, remove/add, qty in base unit, reason, note). Recent adjustments table. Footer: stock value at cost. |
| Approval & Issue | `/store-approval/` | Production demand (DRD-xxxxxx) review. Tabs: Pending review, Ready to issue, Issued, Rejected, All. Per line: requested, in store, free, approve / approve less with reason / reject with reason. Issue moves stock out oldest batch first (FIFO). |
| Stock Ledger | `/store-ledger/` | Per-item header (in store, committed, free, low-stock level, unit price now, stock value). Tabs: Stock movements (opening, running balance, closing), Batches (FIFO: batch, source, receipt, date, supplier batch, expiry, received qty, remaining, unit cost, value), Item & price history (item changes, price history, demand references). |
| Reports | `/store-reports/` | 10 reports with item filter, date range and "Export to Excel": Daily Stock Receiving, Monthly Stock Receiving, Item-wise Stock, Item-wise Purchase Price History, Production Demand, Approved Demand, Stock Issuance, Remaining Stock (batches), Stock Adjustment, Stock Valuation. Tables only, no charts. |
| Queries | `/store-queries/` (confirm) | Store raises queries to Admin. Tabs: All, Open, In review, Responded, Resolved, Rejected. |

Global shell: dark brown sidebar with logo, cream content area, orange primary (`#F26B2A`-ish, confirm from tokens), top bar with page title, Refresh, Cmd+K search, theme palette, dark mode, notifications bell, avatar. Phone viewport is portrait-only ("Please rotate your device").

### Business rules already in place (keep them)
- Balances are never typed in. Available = Opening + Received - Issued +/- Adjustments, all from stock transactions.
- Committed = approved production demand not yet issued. Free = Available - Committed.
- Prices are per purchase package, effective-dated, and a new price never changes old prices or past receipts. Receipts snapshot the price.
- Store users cannot set prices.
- Issuing consumes oldest batch first.
- Approving less than requested needs a reason. Rejecting needs a reason.

### Problems found during review (fix these in Phase 1)
1. **KPI contradiction:** Dashboard says "Low stock items: 0 (All above reorder level)" while two items are out of stock and Store Stock shows "Low stock only (2)". Out-of-stock must count as low stock (or the card must clearly say "low but not zero"). Pick one definition, put it in one shared function, use it everywhere.
2. **Committed shows "-" in Store Stock but "0 Piece" in Ledger.** Use one zero format everywhere (show `0`, muted colour).
3. **Receiving is hard-blocked when an item has no active price** (EGG, oil). Keep the rule that Store cannot set prices, but add a "Request price" action that notifies Finance/Admin, shows on their dashboard, and links back to the blocked receipt. Optionally allow Finance to approve a "receive now, price later" receipt that stays in `PRICE_PENDING` and is excluded from valuation until priced.
4. **Categories are hard-coded** and data is mis-filed (EGG sits in "Sugar & Sweeteners"). Make categories a managed master (CRUD by Admin) and add a data-cleanup migration note, not an automatic re-categorisation.
5. **Unit list mismatch:** "Carton" is used as a purchase unit but is missing from the Units filter. Make units a managed master with a type (weight, volume, count, pack) and allowed conversions.
6. **Name casing is inconsistent** ("EGG", "oil", "Sugar"). Add display normalisation (Title Case on display) and a uniqueness check on name + code, case-insensitive.
7. **Store Items rows are very tall** with a lot of empty space, and wide tables (Items, Stock, Reports) need horizontal scrolling with no frozen columns. Fix density and add sticky first columns plus a column chooser.
8. **Dashboard has two near-duplicate cards** (Total Available Stock vs Today's Remaining Stock). Merge into one card with a secondary line.
9. **Returned column exists but there is no return flow.** Build it (Phase 3).
10. **Supplier is a free dropdown + "Other (type name)"** which will create duplicate suppliers. Replace with a supplier master (Phase 2).

---

## 2. Design references and what to take from each

The owner shared 14 reference screens. Do not copy any product's branding. Take the patterns below and render them in the existing Mountain Bakes look (brown sidebar, cream canvas, orange accent, rounded cards, Inter/existing font).

| Pattern | Seen in reference | Where it goes in Mountain Bakes |
|---|---|---|
| Coloured KPI tiles with icon, big number, one-line context | Warehouse dashboard, WooCommerce stock summary, Axacute | Store Dashboard top row |
| Tiles split into **Completed today / Due today / Past due** | Axacute general dashboard | Demand, Purchase Orders, Transfers, Stock counts tiles |
| Inventory summary: **Qty in hand vs Qty to be received** | Zoho POS dashboard | Dashboard + Item detail |
| Product details block: low stock, item groups, all items, active-items donut | Zoho POS | Dashboard "Catalogue health" card |
| Top moving items with image and qty | Zoho POS "Top selling items" | Dashboard "Top consumed items" (by Production) |
| Value strip: items, total qty, **cost value**, (retail value, margin where relevant) | Stockpile | Store Stock footer and Items page header |
| Item thumbnail in table, Import items, Download CSV | Stockpile | Store Items |
| **Status chips** in list rows (Draft, Sent, Partial, Received, Invoiced, Paid) | Workhorse, Rank Next, Zoho Inventory | PO list, Receipts, Demands, Transfers |
| Status tab bar with counts (All, Draft, Sent to supplier, Open, Partial, Received, Archive) | Warehouse open POs | Purchase Orders page |
| Fulfilment dots per row (invoice / packed / shipped) | Zoho Inventory sales orders | Demand list: Approved / Picked / Issued / Returned dots |
| **Availability matrix** cells coloured by state (In stock, Expected <date>, Not available) and inline status dropdown | Katana | Approval & Issue: per-line availability against demand |
| Grid / List toggle and "pending / date-wise / all" radio filter | Rank Next indent list | Demand and PO lists |
| Item stock card as a **timeline grouped by month**, with closing stock per month | Invoice Manager (mobile) | Stock Ledger, especially on mobile |
| **Physical stocktake** entry: calculated vs physical, difference in red, comment | Invoice Manager | New Stock Count module |
| Negative stock warning banner | Invoice Manager | Ledger and valuation when any balance would go below 0 |
| Recent purchase invoices + top purchased products tables | WooCommerce inventory | Dashboard lower section |
| Charts: **Items below reorder level (Top 5)**, **Short allocation by item**, **Outstanding PO items** | Axacute | Dashboard analytics row |
| **ABC item classification** with donut + bar + ranked table | ABC dashboard | Reports > ABC Analysis |
| Budget vs actual horizontal bars by category, spend by category donut, week vs last week vs last year table | TouchBistro / MarginEdge | Reports > Purchasing & Cost, Dashboard for Finance/Admin |
| Simple CRUD list with Edit/Delete chips | Basic customer list | Use only for small masters (units, categories, reasons) |

---

## 3. Ground rules (non-negotiable)

1. **Phase 0 first.** Map the repo before writing code (see section 4).
2. **Additive and backward compatible.** Existing routes, IDs (DRY-, RCV-, DRD-, PRC-, BAT-), API responses and reports keep working. New fields are optional or defaulted. Version any breaking API change (`/v2/...`).
3. **Ledger is the single source of truth.** Every quantity change is an immutable row in `stock_transactions`. No UPDATE of quantities anywhere. Corrections are reversing entries.
4. **Money and quantity precision:** store money as integer paisa or `NUMERIC(14,2)`, quantities as `NUMERIC(14,3)` in base unit. Never floats. Currency PKR, display "Rs." with thousands separators.
5. **Time:** business date in `Asia/Karachi`. Store timestamps in UTC.
6. **Idempotency:** every create/post endpoint accepts an `Idempotency-Key` header (the mobile app is offline-first with a sync queue).
7. **Concurrency:** issuing, adjusting and stock counts must lock per item + location (`SELECT ... FOR UPDATE` or advisory locks) so two issues can't oversell a batch.
8. **Permissions enforced on the server**, not only hidden in the UI.
9. **Migrations** are reversible, small, and named by phase. Seed scripts for demo data.
10. **No new heavy dependencies** without writing the reason in the phase report. Reuse the existing UI kit, table component, date-range picker and Excel export.
11. **Feature flags** for each new module so it can ship dark and be enabled per store.
12. **Tests:** unit tests for every stock calculation, integration tests for every endpoint that moves stock, and Playwright (or the existing e2e tool) happy paths for each screen.
13. Keep copy short, plain and in the same voice as today ("Approve less only with a reason.").

---

## 4. Phase 0: Discovery (no code changes)

Produce `docs/inventory-upgrade/PHASE-0-DISCOVERY.md` containing:
- Repo map: web client, server, mobile client (if present), shared packages.
- Exact stack and versions (Next.js, React, UI kit, state/query libs, ORM or query builder, auth).
- Current DB schema for every store table (items, prices, receipts, receipt lines, batches, stock transactions, demands, demand lines, adjustments, queries, users/roles). Include an ER diagram in Mermaid.
- Every store API endpoint with method, path, request, response, role checks.
- How balances, committed, free and FIFO issue are calculated today (file + function names).
- Design tokens in use (colours, radius, spacing, fonts), and the shared components available.
- Roles that exist (Store User, Production User, Finance, Admin, Super Admin, others) and what each can do.
- A gap list mapping each item in sections 1 and 6 to "exists / partial / missing".
- Risks and open questions. **Stop and ask** if the data model blocks multi-location or if a change would rewrite historical data.

---

## 5. Target information architecture

```
Store (per store / branch)
├── Dashboard
├── Items
│   ├── Item list (grid / list)
│   ├── Item detail (overview, stock by location, batches, ledger, prices, suppliers, demand)
│   ├── Categories        (Admin)
│   └── Units & conversions (Admin)
├── Purchasing
│   ├── Suppliers
│   ├── Purchase Orders
│   └── Reorder suggestions
├── Receiving (GRN)
├── Stock
│   ├── Stock on hand
│   ├── Adjustments
│   ├── Stock counts (stocktake)
│   ├── Transfers (store ↔ store / branch)
│   └── Expiry & aging
├── Production demand
│   ├── Approval & Issue
│   └── Returns from Production
├── Price Control      (view for Store, edit for Finance/Admin)
├── Stock Ledger
├── Reports & Analytics
├── Queries
└── Settings (store profile, numbering, costing method, thresholds, notifications)
```

Keep the current menu labels where they already exist so users don't get lost. Group new items under collapsible sidebar sections. Respect feature flags.

---

## 6. Functional scope by module

### 6.1 Dashboard v2
Top row KPI tiles (coloured, icon, number, context line, click-through to filtered list):
- Stock value at cost (with change vs last month)
- Items in stock / low / out of stock / near expiry (single tile with 4 mini counts, or 4 tiles)
- Production demand: Pending / Approved not issued / Issued today / Past due
- Purchase orders: Open / Partially received / Due today / Past due
- Today received (value, receipts, lines) and Today issued (value, lines)
- Qty in hand vs Qty to be received (from open POs)

Second row cards:
- Low stock and out of stock list with "Create PO" action per item and a bulk "Raise PO for selected".
- Production demand waiting (existing panel, now with availability dots).
- Near expiry (next 7 / 30 days) with batch, qty, value.
- Price requests pending (for Finance/Admin).

Analytics row (charts, lazy-loaded):
- Items below reorder level, Top 5 (bar, % of reorder level)
- Short allocation by item (approved demand vs free stock, grouped bars)
- Outstanding PO items (bar)
- Top consumed items this period (with thumbnails)
- Spend by category (donut) and Received vs Issued trend (line, daily/weekly/monthly)

Keep the existing Stock movement / Consumption by item / Item-wise balance table under the charts.

### 6.2 Items v2
- New fields: image, barcode (EAN/QR, multiple), description, managed category, sub-category, storage type (dry, chilled, frozen), shelf life days, costing per item (FIFO default, FEFO allowed when expiry tracked), track batches (bool), track expiry (bool), reorder level, reorder quantity, max level, safety stock, lead time days, preferred supplier, default location/bin, allergens tags, notes, status.
- Multiple purchase packages per item (Bag 50 KG, Bag 25 KG) each with its own conversion.
- List: grid/list toggle, thumbnails, sticky first column, column chooser, saved filters, bulk actions (activate, deactivate, change category, print labels), Import (CSV/Excel template with validation preview) and Export.
- Item detail page with tabs: Overview (KPIs: in hand, committed, free, on order, avg daily use, days of cover, last cost, avg cost), Stock by location, Batches, Ledger timeline, Prices, Suppliers, Demand history, Changes (audit).
- Barcode label printing (item and batch labels, PDF).

### 6.3 Suppliers (new)
- Supplier master: code (SUP-0001), name, contact person, phone, email, address, NTN/STRN (optional), payment terms, lead time, status, notes.
- Supplier items: item, supplier SKU, package, last price, min order qty.
- Supplier detail: open POs, receipts, returns, price history, on-time %, quantity accuracy %.
- Migrate existing free-text supplier names from receipts into the master (dedupe by normalised name, keep a mapping table, never rewrite old receipt text).

### 6.4 Purchase Orders (new)
- PO header: PO-000001, store, supplier, order date, expected date, status, notes, created by, approved by.
- Lines: item, package, qty in packages, expected price (from Price Control, editable only by Finance/Admin), line total.
- Status flow: `DRAFT → PENDING_APPROVAL → APPROVED → SENT → PARTIALLY_RECEIVED → RECEIVED → CLOSED`, plus `CANCELLED`. Short-close with reason.
- Tabs with counts per status, status chips in rows, received % progress bar per PO.
- Actions: duplicate, print/PDF, share via WhatsApp/email (generate PDF, user sends), cancel, short-close.
- Reorder suggestions screen: items where (free + on order) <= reorder level. Suggested qty = max(reorder qty, max level - (free + on order)), rounded up to whole packages. One click to create draft POs grouped by preferred supplier.

### 6.5 Receiving (GRN) v2
- Receive **against a PO** (default) or **without PO** (needs reason, flagged in reports).
- Pre-fill lines from PO remaining qty. Show ordered / previously received / receiving now / remaining.
- Per line: batch no. (auto BAT- if blank), supplier batch, manufacture date, expiry date (required when item tracks expiry), accepted qty, rejected qty with reason (damaged, expired, wrong item, short), location/bin.
- Price: snapshot from Price Control. If the invoice price differs, Store records the invoice price; system shows **price variance** (amount and %) and routes variance above a threshold to Finance for approval. Receipt valuation uses the approved price.
- "Request price" flow for items with no active price (see Problem 3).
- Attach invoice photo/PDF.
- Barcode scan to add lines (camera on mobile, USB scanner on web).
- After save: print GRN, optional batch labels.

### 6.6 Stock on hand v2
- Columns: Item, Category, Location, Opening, Received, Issued, Returned, Transferred in/out, Adjusted, Available, Committed, Free, On order, Days of cover, Unit cost, Value, Batches, Nearest expiry, Last received, Status.
- Status chips: OK, Low, Out of stock, Near expiry, Expired, Negative (should never happen; show red banner if it does).
- Group by category or location. Totals strip: items, total value at cost, low count, out count, near-expiry value.
- Export keeps the same columns as the screen.

### 6.7 Adjustments v2
- Reason master (Damaged, Expired, Spillage, Pest/contamination, Found extra, Count correction, Sample/QA, Other). Reasons carry a direction (in/out) and whether they need approval.
- Batch-level adjustments (pick which batch is damaged/expired).
- Adjustments above a value threshold go to `PENDING_APPROVAL` for Admin. Photo attachment optional.

### 6.8 Stock counts / stocktake (new)
- Create count: full store, by category, by location, or cycle count (ABC-driven: A monthly, B quarterly, C half-yearly, configurable).
- Freeze option: block issues for counted items while count is `IN_PROGRESS`, or record snapshot qty and reconcile movements during the count.
- Count sheet (web and mobile): item, batch, expected (hidden by default for blind count, toggle in settings), counted, difference, difference value, comment.
- Review screen: variances sorted by value, approve to post adjustment entries (reason "Count correction"), or send for recount.
- Statuses: `DRAFT → IN_PROGRESS → SUBMITTED → APPROVED/RECOUNT → POSTED`.

### 6.9 Transfers (new, behind flag)
- Store-to-store and store-to-branch transfers: TRF-000001, from, to, lines with batches, statuses `DRAFT → DISPATCHED → IN_TRANSIT → RECEIVED` (with short/over receipt reasons).
- Stock leaves source on dispatch and lands at destination on receipt; in-transit stock is visible in reports.

### 6.10 Approval & Issue v2 (production demand)
- Keep current tabs and rules. Add:
  - **Availability matrix** per line: coloured cell for In stock / Partial (x of y) / Expected on <PO date> / Not available.
  - Fulfilment dots per demand: Approved, Picked, Issued, Returned.
  - Approve all lines that are fully available in one click; approve less / reject still need reasons.
  - **Pick list** generated on approval: batch and location to pick, FIFO or FEFO per item, printable and mobile-friendly with scan-to-confirm.
  - **Partial issue** with remaining qty staying committed until issued or cancelled.
  - Needed-by date and **Past due** flag.
  - Issue slip PDF with signature fields (issued by, received by).
- Grid/list toggle and date-wise filter like the reference indent list.

### 6.11 Returns from Production (new)
- Production returns unused stock against an issue (RTN-000001). Store accepts into original batch (if sealed) or a new "returned" batch, or rejects as waste (posts adjustment out).
- Fills the existing **Returned** column.

### 6.12 Price Control v2
- Keep view-only for Store. For Finance/Admin: schedule future prices, bulk price update by supplier or category, price change approval if configured, and show which items have no active price at the top with a "Set price" shortcut.
- Price history chart per item (line).

### 6.13 Stock Ledger v2
- Keep the current item header and three tabs.
- Movement list becomes a **timeline grouped by month** with opening and closing per month (as in the mobile reference), with the table view as an option.
- Filter by type: Opening, Received, Issued, Returned, Adjusted, Transferred, Count.
- Each row links to its source document (RCV, DRD, ADJ, CNT, TRF, RTN).
- Batches tab: add expiry status chip and days to expiry.

### 6.14 Reports & Analytics v2
Keep all 10 current reports (same columns, same Excel export). Add:
- Stock valuation by date (as-of any date, FIFO cost)
- ABC analysis (by consumption value over a chosen period; A = top 80%, B = next 15%, C = last 5%, thresholds configurable) with donut, bar and ranked table
- Slow-moving and dead stock (no issue in N days)
- Expiry report (expired, expiring in 7/30/60 days, value at risk)
- Purchase price variance (PO/Price Control vs invoice)
- Supplier performance (on-time, fill rate, rejection rate, price change)
- Consumption vs production output (if production module exposes output; otherwise leave hook)
- Spend by category and by supplier with budget vs actual bars (budget per category per month, set by Finance)
- Stock count variance history
- Transfer register and in-transit
Every report: chart on top when it helps, table below, filters (date, item, category, supplier, location), saved views, Excel and PDF export, and the same column order on screen and in the file.

### 6.15 Alerts & notifications
- Low stock, out of stock, near expiry, expired, price missing, price variance pending, PO past due, demand past due, count pending approval, negative stock detected.
- In-app bell (exists) plus optional email/WhatsApp digest per role. Daily digest at a configurable time.
- Each alert links to the exact filtered screen.

### 6.16 Audit
- Every create/update/approve/reject/cancel on items, prices, POs, receipts, demands, adjustments, counts, transfers writes to `audit_log` (who, when, what, before/after JSON, IP/device). Show it in an "Activity" tab on each document.

---

## 7. Data model additions (adapt names to the existing schema found in Phase 0)

```
locations(id, store_id, code, name, type[store|bin|shelf|chiller|freezer], parent_id, status)
categories(id, name, parent_id, status)
units(id, code, name, type[weight|volume|count|pack], base_factor)
item_packages(id, item_id, unit_id, qty_in_base, is_default_purchase, status)
item_barcodes(id, item_id, package_id, code, type)
items + (image_url, storage_type, shelf_life_days, costing_method, track_batches, track_expiry,
         reorder_level, reorder_qty, max_level, safety_stock, lead_time_days,
         preferred_supplier_id, default_location_id, allergens[])
suppliers(id, code, name, contact, phone, email, address, tax_ids, payment_terms, lead_time_days, status)
supplier_items(id, supplier_id, item_id, package_id, supplier_sku, last_price, min_order_qty)
purchase_orders(id, number, store_id, supplier_id, order_date, expected_date, status, notes, created_by, approved_by, ...)
purchase_order_lines(id, po_id, item_id, package_id, qty_packages, expected_price, received_qty_base, status)
receipts + (po_id nullable, without_po_reason, invoice_attachment_url, status incl. PRICE_PENDING)
receipt_lines + (po_line_id, accepted_qty, rejected_qty, reject_reason, invoice_price, approved_price, variance, location_id, mfg_date)
batches + (location_id, supplier_batch, mfg_date, expiry_date, status)
stock_transactions(id, store_id, location_id, item_id, batch_id, type, qty_base (+/-), unit_cost,
                   source_type, source_id, business_date, created_at, created_by, reversal_of)
adjustment_reasons(id, name, direction, needs_approval)
stock_counts(id, number, store_id, scope, blind, status, started_at, submitted_at, approved_by)
stock_count_lines(id, count_id, item_id, batch_id, location_id, expected_qty, counted_qty, diff_qty, diff_value, comment)
transfers(id, number, from_location_id, to_location_id, status, dispatched_at, received_at, ...)
transfer_lines(id, transfer_id, item_id, batch_id, qty_sent, qty_received, reason)
production_returns(id, number, demand_id, issue_id, status, ...)
production_return_lines(id, return_id, item_id, batch_id, qty, disposition[restock|new_batch|waste])
pick_lists(id, demand_id, status) / pick_list_lines(id, pick_list_id, item_id, batch_id, location_id, qty, picked_qty)
price_requests(id, item_id, requested_by, receipt_draft_id, status, resolved_by)
budgets(id, store_id, category_id, month, amount)
alerts(id, type, entity_type, entity_id, severity, status, created_at)
audit_log(id, actor_id, action, entity_type, entity_id, before, after, created_at, meta)
```

Indexes: `stock_transactions(item_id, location_id, business_date)`, `(source_type, source_id)`, `batches(item_id, expiry_date)`. Add a materialised view or summary table `stock_balances(item_id, location_id, batch_id, qty, value)` refreshed transactionally on every posting, and verify it nightly against a full ledger sum (log any mismatch as an alert).

Numbering: keep existing prefixes and add PO-, SUP-, ADJ-, CNT-, TRF-, RTN-, PCK-. Gap-free per store per year if the current system already does that; otherwise sequential.

---

## 8. Roles and permissions

| Action | Store User | Store Manager | Production User | Finance | Admin / Super Admin |
|---|---|---|---|---|---|
| View store screens | ✓ | ✓ | own demands | ✓ | ✓ |
| Create/edit items | request | ✓ | | | ✓ |
| Categories, units, reasons, locations | | | | | ✓ |
| Set / schedule prices | | | | ✓ | ✓ |
| Create PO | ✓ (draft) | ✓ | | | ✓ |
| Approve PO | | ✓ | | ✓ | ✓ |
| Receive (GRN) | ✓ | ✓ | | | ✓ |
| Approve price variance | | | | ✓ | ✓ |
| Adjust stock (under threshold) | ✓ | ✓ | | | ✓ |
| Approve adjustment (over threshold) | | ✓ | | | ✓ |
| Stock count: count / approve | ✓ / | ✓ / ✓ | | | ✓ / ✓ |
| Raise demand | | | ✓ | | ✓ |
| Approve & issue demand | ✓ | ✓ | | | ✓ |
| Return to store | | | ✓ | | ✓ |
| Transfers dispatch / receive | ✓ | ✓ | | | ✓ |
| Reports | store reports | all store | demand reports | cost & valuation | all |

Confirm the real role list in Phase 0 and adapt. Add Store Manager only if it doesn't exist and the owner agrees.

---

## 9. API (REST, follow existing conventions found in Phase 0)

```
GET/POST/PATCH  /store/:storeId/items, /items/:id, /items/:id/stock, /items/:id/ledger, /items/:id/batches
POST            /store/:storeId/items/import (validate) , /items/import/commit
GET/POST/PATCH  /suppliers, /suppliers/:id, /suppliers/:id/items
GET/POST/PATCH  /store/:storeId/purchase-orders, /:id, POST /:id/submit|approve|send|cancel|short-close
GET             /store/:storeId/reorder-suggestions ; POST /reorder-suggestions/create-pos
GET/POST        /store/:storeId/receipts, /receipts/:id ; POST /receipts/:id/approve-variance
POST            /price-requests ; PATCH /price-requests/:id
GET             /store/:storeId/stock?asOf=&locationId=&categoryId=&status=
GET/POST        /store/:storeId/adjustments ; POST /adjustments/:id/approve|reject
GET/POST        /store/:storeId/stock-counts ; PATCH lines ; POST /:id/submit|approve|recount|post
GET/POST        /transfers ; POST /:id/dispatch|receive
GET             /store/:storeId/demands?status= ; POST /demands/:id/lines/:lineId/approve|approve-less|reject
POST            /demands/:id/pick-list ; POST /pick-lists/:id/confirm ; POST /demands/:id/issue (partial allowed)
GET/POST        /production-returns ; POST /:id/accept|reject
GET             /store/:storeId/reports/:reportKey?from=&to=&...&format=json|xlsx|pdf
GET             /store/:storeId/dashboard?from=&to=
GET             /alerts ; PATCH /alerts/:id
```

Every stock-moving POST: idempotency key, server-side permission check, single DB transaction, writes `stock_transactions` + `audit_log`, returns the updated balance.

---

## 10. UX and design system rules

- Keep the brand: dark brown sidebar, cream background, orange primary, existing logo and typography. Light and dark mode both must pass WCAG AA contrast.
- **Status colour language** (one map, shared by web and mobile):
  OK/Received/Issued = green, Low/Partial/Pending = amber, Out/Rejected/Expired/Past due = red, Approved/Committed/On order = blue, Draft/Inactive = grey.
- KPI tile component: icon, label, value, context line, optional delta, optional mini breakdown (Completed today / Due today / Past due), click-through.
- Table component: density toggle (comfortable/compact), sticky header and first column, column chooser, sort, saved filters, row selection with bulk bar, empty state with a primary action, skeleton loading, pagination size remembered.
- Forms: inline validation, unit shown next to every quantity, computed fields read-only and visually distinct, "Save" disabled until valid, unsaved changes warning.
- Every number shows its unit. Every money value shows "Rs.". Zero shows as `0` in muted colour, never "-".
- Every list has the same date-range control (Today, Yesterday, Last 7 days, This month, Custom).
- Cmd+K search covers items (name, code, barcode), POs, receipts, demands, batches, suppliers.
- Mobile (portrait): bottom tab bar for Dashboard, Receive, Issue, Count, More. Cards instead of wide tables. Camera barcode scanning for receive, pick and count. Ledger as month-grouped timeline.
- Print/PDF templates for PO, GRN, Issue slip, Pick list, Count sheet, Transfer note, all with logo, store, document no., date, signatures.

---

## 11. Delivery phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 | Discovery | Discovery doc approved by owner |
| 1 | Fix the 10 problems in section 1, design tokens, shared status map, table and KPI components | All existing flows still pass e2e; KPI counts agree across Dashboard, Stock, Ledger |
| 2 | Categories, units, item packages, barcodes, Items v2, Suppliers, supplier migration | Import 200 items from template without errors; supplier dedupe report generated |
| 3 | Purchase Orders, reorder suggestions, Receiving v2 (PO-based, variance, price requests), Returns from Production | PO → partial GRN → full GRN → close works end to end; variance routes to Finance |
| 4 | Locations/bins, Stock v2, Adjustments v2, Stock counts, FEFO option, Pick lists, Approval & Issue v2 | Blind count posts correct adjustments; FEFO issue picks earliest expiry; no negative stock under concurrent issue test |
| 5 | Dashboard v2 with charts, Reports v2 (incl. ABC, valuation as-of, expiry, variance, supplier performance, budget vs actual) | Every report matches ledger totals; Excel and screen columns identical |
| 6 | Transfers, alerts and digests, audit tab, mobile screens (receive, issue, count, ledger) | Offline receive and count sync without duplicates (idempotency verified) |
| 7 | Hardening: performance (10k items, 1M transactions), security review, docs, seed/demo data, user guide | p95 list API < 300 ms, dashboard < 1.5 s; security review has no high findings |

---

## 12. Acceptance tests you must write (minimum)

1. Receiving 2 bags of 50 KG Sugar at Rs. 8,000/bag creates one batch of 100 KG at Rs. 160/KG and value Rs. 16,000 (matches today's live data).
2. Item with no active price: receiving is blocked for Store, "Request price" creates a price request, Finance sets price, receipt can then be saved.
3. Approving 60 KG of a 100 KG free balance sets Committed 60, Free 40; a second demand cannot approve more than 40 without "approve less".
4. Issue consumes batches in FIFO (or FEFO when set) order, splitting across batches correctly, and values the issue at batch cost.
5. Two concurrent issues against the last 10 KG: exactly one succeeds.
6. Partial issue leaves the remainder committed; cancelling the remainder releases it.
7. Production return of a sealed bag restocks into the original batch at original cost.
8. Stock count with a difference of -3 KG posts one "Count correction" adjustment and the ledger closing balance matches the counted qty.
9. Out-of-stock items are counted in the low-stock KPI (or the KPI label says otherwise) and the number matches the Store Stock "Low stock only" filter.
10. Valuation as of a past date equals the sum of remaining batch qty x unit cost at that date.
11. ABC classification totals 100% of consumption value and is stable when re-run.
12. Excel export of every report has the same columns, order and totals as the screen.
13. Reversing a posted receipt creates reversing ledger rows and never deletes the original.
14. Idempotent POST: sending the same receive request twice with the same key creates one receipt.

---

## 13. How to work and report

- Start every phase with a short plan in the phase report (files to touch, migrations, risks). Then implement.
- Small commits with clear messages, one feature per PR, screenshots (light and dark, desktop and mobile) in each PR description.
- If something in this prompt conflicts with how the system really works, the live system wins: note the conflict, propose the fix, and continue with the safest option.
- Never delete or rewrite historical stock, price or receipt data. If a migration needs to touch history, stop and ask.
- At the end of each phase, list: what's done, what's tested, known gaps, and the exact steps for the owner to verify on staging.

Begin with Phase 0 now.
