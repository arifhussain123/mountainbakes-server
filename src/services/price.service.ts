import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { adminDb } from '../config/firebase';
import {
  businessDateStr,
  type PriceHistoryDoc,
  type ImportPreviewResult,
  type ImportValidRow,
  type ImportUnchangedRow,
  type ImportErrorRow,
  type ImportCommitResult,
} from '../shared';
import { invalidate } from '../utils/cache';
import { notify } from './push.service';

/**
 * Product price changes with an effective date. `products.price` always holds the
 * currently-active price; every change appends an immutable `product_price_history`
 * doc. A change effective today/past applies immediately in one transaction; a
 * future-dated change is stored `scheduled` and flipped to `active` by
 * `activateDuePrices()` at the 2 AM business-day rollover (idempotent, locked —
 * mirrors daily-closing.service.ts). Historical sales are never touched: orders
 * snapshot `unitPrice` at sale time, so this layer is purely about the live price.
 */

const HISTORY = 'product_price_history';
const LOCKS = 'price_activation_locks';
const RUNNING_TTL_MS = 10 * 60 * 1000; // a 'running' lock older than this is treated as crashed

type ProductDoc = { name: string; sku: string; price: number; categoryName: string; isActive?: boolean; createdAt?: string };

/** 'YYYY-MM-DD' → 'DD-MM-YYYY' for human-facing messages/exports. */
function formatDMY(d: string): string {
  const [y, m, dd] = String(d).split('-');
  return dd && m && y ? `${dd}-${m}-${y}` : String(d);
}

/** Retry an async op with linear backoff — for transient Firestore blips. */
async function withRetry<T>(op: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw lastErr;
}

export interface ApplyPriceChangeInput {
  productId: string;
  newPrice: number;
  effectiveDate: string; // 'YYYY-MM-DD'
  reason: string;
  source: 'manual' | 'import';
  changedBy: string;
  changedByName: string;
  batchId?: string | null;
}

export interface ApplyPriceChangeResult {
  status: 'active' | 'scheduled' | 'skipped';
  reason?: string;
  historyId?: string;
  versionNumber?: number;
  productName?: string;
  oldPrice?: number;
  newPrice?: number;
}

/**
 * Record a single price change (manual or one import row). One transaction:
 * read product + latest version + any scheduled rows, then supersede stale
 * scheduled rows, append the history doc, and (if effective today/past) update
 * `products.price`. Callers send notifications, so a bulk import fires exactly one.
 */
export async function applyPriceChange(input: ApplyPriceChangeInput): Promise<ApplyPriceChangeResult> {
  const { productId, newPrice, effectiveDate, reason, source, changedBy, changedByName } = input;
  const batchId = input.batchId ?? null;
  const productRef = adminDb.collection('products').doc(productId);
  const isImmediate = effectiveDate <= businessDateStr();

  const result = await adminDb.runTransaction(async (tx): Promise<ApplyPriceChangeResult> => {
    // ── Reads (all before writes) ──
    const prodSnap = await tx.get(productRef);
    if (!prodSnap.exists) throw Object.assign(new Error('Product not found'), { status: 404 });
    const prod = prodSnap.data() as ProductDoc;
    const oldPrice = Number(prod.price ?? 0);

    // No-op: an immediate change to the same price does nothing.
    if (isImmediate && oldPrice === newPrice) return { status: 'skipped', reason: 'unchanged' };

    const latestSnap = await tx.get(
      adminDb.collection(HISTORY).where('productId', '==', productId).orderBy('versionNumber', 'desc').limit(1),
    );
    const nextVersion = latestSnap.empty
      ? 1
      : Number((latestSnap.docs[0]!.data() as PriceHistoryDoc).versionNumber ?? 0) + 1;

    const scheduledSnap = await tx.get(
      adminDb.collection(HISTORY).where('productId', '==', productId).where('status', '==', 'scheduled'),
    );

    // ── Writes ──
    for (const doc of scheduledSnap.docs) tx.update(doc.ref, { status: 'superseded' });

    const now = new Date().toISOString();
    const histRef = adminDb.collection(HISTORY).doc();
    const doc: Omit<PriceHistoryDoc, 'id'> = {
      productId,
      productCode: prod.sku ?? '',
      productName: prod.name ?? '',
      categoryName: prod.categoryName ?? '',
      oldPrice,
      newPrice,
      effectiveDate,
      reason,
      source,
      status: isImmediate ? 'active' : 'scheduled',
      versionNumber: nextVersion,
      changedBy,
      changedByName,
      changedOn: now,
      activatedOn: isImmediate ? now : null,
      batchId,
    };
    tx.set(histRef, doc);
    if (isImmediate) tx.update(productRef, { price: newPrice, updatedAt: now });

    return {
      status: isImmediate ? 'active' : 'scheduled',
      historyId: histRef.id,
      versionNumber: nextVersion,
      productName: prod.name ?? '',
      oldPrice,
      newPrice,
    };
  });

  if (result.status === 'active') invalidate('products');
  return result;
}

export interface ActivateResult {
  status: 'success' | 'failed' | 'skipped';
  activated: number;
  reason?: string;
}

/**
 * Flip every scheduled price whose effective date has arrived to the live price.
 * Idempotent via a `price_activation_locks/{businessDate}` lock (running/success +
 * 10-min crash TTL). Runs on the 2 AM cron and once on server startup (catch-up).
 */
export async function activateDuePrices(
  opts: { trigger: 'scheduler' | 'startup' | 'manual'; today?: string } = { trigger: 'manual' },
): Promise<ActivateResult> {
  const today = opts.today ?? businessDateStr();
  const lockRef = adminDb.collection(LOCKS).doc(today);
  const startedAt = new Date().toISOString();

  const claim = await adminDb.runTransaction(async (tx) => {
    const doc = await tx.get(lockRef);
    if (doc.exists) {
      const d = doc.data() as { status: string; startedAt: string };
      if (d.status === 'success') return { ok: false, reason: 'already run' };
      if (d.status === 'running' && Date.now() - new Date(d.startedAt).getTime() < RUNNING_TTL_MS) {
        return { ok: false, reason: 'in progress' };
      }
    }
    tx.set(lockRef, { date: today, status: 'running', trigger: opts.trigger, startedAt, activated: 0, closedAt: null, error: null });
    return { ok: true };
  });
  if (!claim.ok) return { status: 'skipped', activated: 0, reason: claim.reason };

  try {
    const dueSnap = await adminDb
      .collection(HISTORY)
      .where('status', '==', 'scheduled')
      .where('effectiveDate', '<=', today)
      .get();

    // Highest version per product wins; older due rows for the same product lose.
    type Snap = FirebaseFirestore.QueryDocumentSnapshot;
    const byProduct = new Map<string, { winner: Snap; losers: Snap[] }>();
    for (const d of dueSnap.docs) {
      const row = d.data() as PriceHistoryDoc;
      const cur = byProduct.get(row.productId);
      if (!cur) { byProduct.set(row.productId, { winner: d, losers: [] }); continue; }
      if (Number(row.versionNumber ?? 0) > Number((cur.winner.data() as PriceHistoryDoc).versionNumber ?? 0)) {
        cur.losers.push(cur.winner);
        cur.winner = d;
      } else {
        cur.losers.push(d);
      }
    }

    let activated = 0;
    for (const { winner, losers } of byProduct.values()) {
      const didActivate = await withRetry(
        () =>
          adminDb.runTransaction(async (tx) => {
            const w = winner.data() as PriceHistoryDoc;
            const prodRef = adminDb.collection('products').doc(w.productId);
            const prodSnap = await tx.get(prodRef);
            const now = new Date().toISOString();
            if (prodSnap.exists) {
              const curPrice = Number((prodSnap.data() as ProductDoc).price ?? 0);
              tx.update(prodRef, { price: w.newPrice, updatedAt: now });
              tx.update(winner.ref, { status: 'active', activatedOn: now, oldPrice: curPrice });
            } else {
              tx.update(winner.ref, { status: 'superseded' }); // product gone — don't leave it scheduled
            }
            for (const l of losers) tx.update(l.ref, { status: 'superseded' });
            return prodSnap.exists;
          }),
        3,
      );
      if (didActivate) activated += 1;
    }

    invalidate('products');

    if (activated > 0) {
      await notify({
        type: 'price_changed',
        title: 'Product Prices Updated',
        message: `${activated} product price${activated === 1 ? '' : 's'} updated, effective ${formatDMY(today)}`,
        targetRole: 'branch_manager',
        relatedId: null,
      });
    }

    await lockRef.set({ status: 'success', activated, closedAt: new Date().toISOString() }, { merge: true });
    return { status: 'success', activated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await lockRef.set({ status: 'failed', error: message, closedAt: new Date().toISOString() }, { merge: true }).catch(() => undefined);
    console.error(`[price-activation] FAILED for ${today}:`, message);
    return { status: 'failed', activated: 0, reason: message };
  }
}

/** History rows for the Price History page (most recent first). */
export async function listPriceHistory(productId?: string, limit = 300): Promise<PriceHistoryDoc[]> {
  let query = adminDb.collection(HISTORY) as FirebaseFirestore.Query;
  if (productId) query = query.where('productId', '==', productId);
  const snap = await query.get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<PriceHistoryDoc, 'id'>) }))
    .sort((a, b) => String(b.changedOn).localeCompare(String(a.changedOn)))
    .slice(0, limit);
}

// ─── Export ─────────────────────────────────────────────────────────────────

export const PRICE_LIST_HEADERS = ['Product Code', 'Product Name', 'Category', 'Current Price', 'Effective Date', 'Status'];

/**
 * Rows for the price-list export (also the re-import template).
 *
 * `groupBy: 'category'` keeps the identical column layout — so the file is still a
 * valid re-import template — and only changes the row order to (Category, Name),
 * which is what the category-wise export needs. A sheet-per-category workbook would
 * read better but `genericExcel` is single-sheet; not worth rewriting for this.
 */
export async function buildPriceListRows(opts?: { groupBy?: 'category' }): Promise<(string | number)[][]> {
  const [prodSnap, histSnap] = await Promise.all([
    adminDb.collection('products').get(),
    adminDb.collection(HISTORY).where('status', '==', 'active').get(),
  ]);

  // Latest active history row per product → the effective date of the current price.
  const latestActive = new Map<string, PriceHistoryDoc>();
  for (const d of histSnap.docs) {
    const h = d.data() as PriceHistoryDoc;
    const cur = latestActive.get(h.productId);
    if (!cur || Number(h.versionNumber ?? 0) > Number(cur.versionNumber ?? 0)) latestActive.set(h.productId, h);
  }

  const byName = (a: ProductDoc, b: ProductDoc) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
  const byCategoryThenName = (a: ProductDoc, b: ProductDoc) =>
    String(a.categoryName ?? '').localeCompare(String(b.categoryName ?? '')) || byName(a, b);

  return prodSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as ProductDoc) }))
    .sort(opts?.groupBy === 'category' ? byCategoryThenName : byName)
    .map((p) => {
      const eff = latestActive.get(p.id)?.effectiveDate ?? String(p.createdAt ?? '').slice(0, 10);
      return [p.sku ?? '', p.name ?? '', p.categoryName ?? '', Number(p.price ?? 0), formatDMY(eff), p.isActive ? 'Active' : 'Inactive'];
    });
}

export const PRICE_HISTORY_HEADERS = [
  'Product Code',
  'Product Name',
  'Category',
  'Old Price',
  'New Price',
  'Effective Date',
  'Status',
  'Version',
  'Source',
  'Reason',
  'Changed By',
  'Changed On',
];

/** Rows for the price-history export. Mirrors the Price History page's columns. */
export async function buildPriceHistoryRows(productId?: string): Promise<(string | number)[][]> {
  // Same 300-row default as the page; the export is an audit aid, not a bulk dump.
  const history = await listPriceHistory(productId, 1000);
  return history.map((h) => [
    h.productCode ?? '',
    h.productName ?? '',
    h.categoryName ?? '',
    Number(h.oldPrice ?? 0),
    Number(h.newPrice ?? 0),
    formatDMY(h.effectiveDate),
    h.status ?? '',
    Number(h.versionNumber ?? 0),
    h.source ?? '',
    h.reason ?? '',
    h.changedByName ?? '',
    String(h.changedOn ?? '').slice(0, 19).replace('T', ' '),
  ]);
}

// ─── Import ─────────────────────────────────────────────────────────────────

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Read an ExcelJS cell as a raw string/number, tolerant of formulas/rich text. */
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

/** XLSX (like all OOXML) is a ZIP archive — it begins with the "PK\x03\x04" signature.
 *  Anything else (a real CSV, or an old binary .xls) is handled via the CSV reader. */
function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** Parse an uploaded price-list workbook (.xlsx or .csv) into a validated preview. Never writes. */
export async function parseImportWorkbook(buffer: Buffer): Promise<ImportPreviewResult> {
  const wb = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet | undefined;
  try {
    if (looksLikeXlsx(buffer)) {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      sheet = wb.worksheets[0];
    } else {
      // CSV / plain text. ExcelJS's CSV reader needs a stream, so feed it the whole
      // buffer as one chunk. The identity `map` keeps every cell as a raw string, so
      // codes like "007" aren't coerced to numbers or misread as dates — the row
      // logic below already parses prices out of strings.
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);
      sheet = await wb.csv.read(stream, { map: (value: string) => value });
    }
  } catch {
    throw Object.assign(
      new Error("Could not read the file. Please upload a valid Excel (.xlsx) or CSV file — old .xls files aren't supported."),
      { status: 400 },
    );
  }
  if (!sheet) throw Object.assign(new Error('The uploaded file has no worksheet'), { status: 400 });

  // Map header names → column index (tolerant of the exported template's labels).
  const colIndex: Record<string, number> = {};
  sheet.getRow(1).eachCell((cell, col) => { colIndex[normalize(String(cell.value ?? ''))] = col; });
  const codeCol = colIndex['productcode'] ?? colIndex['code'] ?? colIndex['sku'];
  const priceCol = colIndex['currentprice'] ?? colIndex['price'] ?? colIndex['newprice'];
  if (!codeCol || !priceCol) {
    throw Object.assign(new Error('File must have a "Product Code" column and a "Current Price" (or Price) column'), { status: 400 });
  }

  const prodSnap = await adminDb.collection('products').get();
  const bySku = new Map<string, { id: string } & ProductDoc>();
  for (const d of prodSnap.docs) {
    const p = d.data() as ProductDoc;
    if (p.sku) bySku.set(String(p.sku).trim().toLowerCase(), { id: d.id, ...p });
  }

  const validRows: ImportValidRow[] = [];
  const unchangedRows: ImportUnchangedRow[] = [];
  const errorRows: ImportErrorRow[] = [];
  const seen = new Set<string>();
  let total = 0;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const codeRaw = cellRaw(row.getCell(codeCol)).trim();
    const priceRaw = cellRaw(row.getCell(priceCol)).trim();
    if (!codeRaw && !priceRaw) return; // blank row
    total += 1;

    if (!codeRaw) {
      errorRows.push({ rowNumber, productCode: '', rawPrice: priceRaw, error: 'MISSING_FIELD', message: 'Missing product code' });
      return;
    }
    const key = codeRaw.toLowerCase();
    if (seen.has(key)) {
      errorRows.push({ rowNumber, productCode: codeRaw, rawPrice: priceRaw, error: 'DUPLICATE_IN_FILE', message: 'Duplicate product code in file' });
      return;
    }
    seen.add(key);

    const product = bySku.get(key);
    if (!product) {
      errorRows.push({ rowNumber, productCode: codeRaw, rawPrice: priceRaw, error: 'UNKNOWN_SKU', message: 'No product with this code' });
      return;
    }

    // Prefer the numeric cell value (preserves sign); fall back to parsing a string
    // cell, keeping the minus so negatives are rejected rather than silently flipped.
    const priceVal = row.getCell(priceCol).value;
    const price = typeof priceVal === 'number' ? priceVal : Number(priceRaw.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(price) || price <= 0) {
      errorRows.push({ rowNumber, productCode: codeRaw, rawPrice: priceRaw, error: 'INVALID_PRICE', message: 'Price must be a positive number' });
      return;
    }
    const rounded = Math.round(price * 100) / 100;

    if (rounded === Number(product.price ?? 0)) {
      unchangedRows.push({ productCode: codeRaw, productName: product.name, price: rounded });
      return;
    }
    validRows.push({
      productId: product.id,
      productCode: codeRaw,
      productName: product.name,
      categoryName: product.categoryName ?? '',
      currentPrice: Number(product.price ?? 0),
      newPrice: rounded,
    });
  });

  return {
    summary: { total, valid: validRows.length, unchanged: unchangedRows.length, errors: errorRows.length },
    validRows,
    unchangedRows,
    errorRows,
  };
}

/** Apply confirmed import rows, then send ONE summary notification. */
export async function commitPriceImport(input: {
  rows: { productId: string; newPrice: number }[];
  effectiveDate: string;
  reason: string;
  changedBy: string;
  changedByName: string;
}): Promise<ImportCommitResult> {
  const batchId = adminDb.collection(HISTORY).doc().id;
  let appliedImmediate = 0;
  let scheduled = 0;
  let skipped = 0;
  const errors: { productId: string; message: string }[] = [];

  for (const r of input.rows) {
    try {
      const res = await applyPriceChange({
        productId: r.productId,
        newPrice: r.newPrice,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        source: 'import',
        changedBy: input.changedBy,
        changedByName: input.changedByName,
        batchId,
      });
      if (res.status === 'active') appliedImmediate += 1;
      else if (res.status === 'scheduled') scheduled += 1;
      else skipped += 1;
    } catch (err) {
      errors.push({ productId: r.productId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Notify branches only for prices that went live now; scheduled ones are announced
  // when they activate (avoids double-notifying for the same change).
  if (appliedImmediate > 0) {
    await notify({
      type: 'price_changed',
      title: 'Product Prices Updated',
      message: `${appliedImmediate} product price${appliedImmediate === 1 ? '' : 's'} updated, effective ${formatDMY(input.effectiveDate)}`,
      targetRole: 'branch_manager',
      relatedId: null,
    });
  }

  return { batchId, appliedImmediate, scheduled, skipped, errors };
}
