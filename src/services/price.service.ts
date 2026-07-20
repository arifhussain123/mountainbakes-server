import ExcelJS from 'exceljs';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { supabaseAdmin } from '../config/supabase';
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
import { rowToApi } from '../utils/case';
import { notify } from './push.service';

/**
 * Product price changes with an effective date. `products.price` always holds the
 * currently-active price; every change appends an immutable `product_price_history`
 * row. A change effective today/past applies immediately in one transaction; a
 * future-dated change is stored `scheduled` and flipped to `active` by
 * `activateDuePrices()` at the 2 AM business-day rollover (idempotent, locked —
 * mirrors daily-closing.service.ts). Historical sales are never touched: orders
 * snapshot `unitPrice` at sale time, so this layer is purely about the live price.
 *
 * ─── Where the transactions live ─────────────────────────────────────────────
 * The atomic parts — read product + version then write history + product under a
 * row lock — are Postgres functions (migration 11), called via .rpc(). PostgREST
 * gives every HTTP call its own transaction, so a read-then-write split across
 * two supabase-js calls could not hold `select ... for update` between them and
 * would race on version_number. This module keeps the non-transactional work:
 * business-date arithmetic, spreadsheet parsing, and notifications.
 */

const HISTORY = 'product_price_history';

/** 'YYYY-MM-DD' → 'DD-MM-YYYY' for human-facing messages/exports. */
function formatDMY(d: string): string {
  const [y, m, dd] = String(d).split('-');
  return dd && m && y ? `${dd}-${m}-${y}` : String(d);
}

/** Retry an async op with linear backoff — for transient network blips. */
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

/** One row of public.apply_price_change's result set. */
interface ApplyPriceChangeRow {
  status: 'active' | 'scheduled' | 'skipped';
  skip_reason: string | null;
  history_id: string | null;
  version_number: number | null;
  product_name: string;
  old_price: number | null;
  new_price: number;
}

/**
 * Record a single price change (manual or one import row). The whole read-modify-
 * write runs inside public.apply_price_change (migration 11) under a `for update`
 * lock on the product row, which is what serialises concurrent changes and keeps
 * version_number gapless. Callers send notifications, so a bulk import fires
 * exactly one.
 */
export async function applyPriceChange(input: ApplyPriceChangeInput): Promise<ApplyPriceChangeResult> {
  const { productId, newPrice, effectiveDate, reason, source, changedBy, changedByName } = input;

  const { data, error } = await supabaseAdmin.rpc('apply_price_change', {
    p_product_id: productId,
    p_new_price: newPrice,
    p_effective_date: effectiveDate,
    p_reason: reason,
    p_source: source,
    p_changed_by: changedBy,
    p_changed_by_name: changedByName,
    p_batch_id: input.batchId ?? null,
    // The business date is Karachi-local shifted back by the 2 AM rollover — not
    // now()::date. Computed here so the definition stays in one place.
    p_today: businessDateStr(),
  });

  if (error) {
    // P0002 (no_data_found) is the function's "Product not found" — keep the 404
    // the route handler and the import loop both expect.
    if (error.code === 'P0002') throw Object.assign(new Error('Product not found'), { status: 404 });
    throw error;
  }

  // A `returns table` function comes back as an array of rows; it always emits
  // exactly one.
  const row = (Array.isArray(data) ? data[0] : data) as ApplyPriceChangeRow | undefined;
  if (!row) throw new Error('apply_price_change returned no row');

  if (row.status === 'skipped') {
    return { status: 'skipped', reason: row.skip_reason ?? 'unchanged' };
  }

  if (row.status === 'active') invalidate('products');

  return {
    status: row.status,
    historyId: row.history_id ?? undefined,
    versionNumber: row.version_number ?? undefined,
    productName: row.product_name,
    // numeric(14,2) arrives as a string over PostgREST when it exceeds JS-safe
    // precision handling; Number() normalises both cases.
    oldPrice: row.old_price === null ? undefined : Number(row.old_price),
    newPrice: Number(row.new_price),
  };
}

export interface ActivateResult {
  status: 'success' | 'failed' | 'skipped';
  activated: number;
  reason?: string;
}

/**
 * Flip every scheduled price whose effective date has arrived to the live price.
 * Idempotent via a `price_activation_locks` row keyed by business date
 * (running/success + 10-min crash TTL). Runs on the 2 AM cron.
 */
export async function activateDuePrices(
  opts: { trigger: 'scheduler' | 'startup' | 'manual'; today?: string } = { trigger: 'manual' },
): Promise<ActivateResult> {
  const today = opts.today ?? businessDateStr();

  // The closure_trigger enum is ('scheduler','manual') — it has no 'startup'
  // member. A startup catch-up is recorded as 'manual'; the distinction was only
  // ever diagnostic, and nothing currently calls with 'startup'.
  const trigger = opts.trigger === 'startup' ? 'manual' : opts.trigger;

  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc('claim_price_activation', {
    p_date: today,
    p_trigger: trigger,
  });
  if (claimErr) throw claimErr;

  // The function returns true on a successful claim and NULL when the lock is
  // held by a live run (or already succeeded today).
  if (!claimed) return { status: 'skipped', activated: 0, reason: 'already run or in progress' };

  try {
    const activated = await withRetry(async () => {
      const { data, error } = await supabaseAdmin.rpc('activate_due_prices', { p_today: today });
      if (error) throw error;
      return Number(data ?? 0);
    }, 3);

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

    await supabaseAdmin.rpc('close_price_activation', {
      p_date: today,
      p_status: 'success',
      p_activated: activated,
      p_error: null,
    });
    return { status: 'success', activated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: the run already failed, so a failure to record that must not
    // mask the original error.
    await supabaseAdmin
      .rpc('close_price_activation', { p_date: today, p_status: 'failed', p_activated: 0, p_error: message })
      .then(undefined, () => undefined);
    console.error(`[price-activation] FAILED for ${today}:`, message);
    return { status: 'failed', activated: 0, reason: message };
  }
}

/** History rows for the Price History page (most recent first). */
export async function listPriceHistory(productId?: string, limit = 300): Promise<PriceHistoryDoc[]> {
  // Ordering and limiting now happen in Postgres (indexed by changed_on desc)
  // rather than by fetching the whole collection and sorting in memory.
  let query = supabaseAdmin.from(HISTORY).select('*').order('changed_on', { ascending: false }).limit(limit);
  if (productId) query = query.eq('product_id', productId);

  const { data, error } = await query;
  if (error) throw error;
  return rowToApi<PriceHistoryDoc[]>(data ?? []);
}

// ─── Export ─────────────────────────────────────────────────────────────────

export const PRICE_LIST_HEADERS = ['Product Code', 'Product Name', 'Category', 'Current Price', 'Effective Date', 'Status'];

interface ProductRow {
  id: string;
  name: string | null;
  sku: string | null;
  price: number | string | null;
  category_name: string | null;
  is_active: boolean | null;
  created_at: string | null;
}

/**
 * Rows for the price-list export (also the re-import template).
 *
 * `groupBy: 'category'` keeps the identical column layout — so the file is still a
 * valid re-import template — and only changes the row order to (Category, Name),
 * which is what the category-wise export needs. A sheet-per-category workbook would
 * read better but `genericExcel` is single-sheet; not worth rewriting for this.
 */
export async function buildPriceListRows(opts?: { groupBy?: 'category' }): Promise<(string | number)[][]> {
  const orderBy: { column: string; ascending: boolean }[] =
    opts?.groupBy === 'category'
      ? [{ column: 'category_name', ascending: true }, { column: 'name', ascending: true }]
      : [{ column: 'name', ascending: true }];

  let productQuery = supabaseAdmin.from('products').select('id, name, sku, price, category_name, is_active, created_at');
  for (const o of orderBy) productQuery = productQuery.order(o.column, { ascending: o.ascending });

  const [{ data: products, error: prodErr }, { data: history, error: histErr }] = await Promise.all([
    productQuery,
    supabaseAdmin
      .from(HISTORY)
      .select('product_id, effective_date, version_number')
      .eq('status', 'active')
      .order('version_number', { ascending: false }),
  ]);
  if (prodErr) throw prodErr;
  if (histErr) throw histErr;

  // Latest active history row per product → the effective date of the current
  // price. Rows arrive version-descending, so the first one seen per product wins.
  const latestActive = new Map<string, string>();
  for (const h of (history ?? []) as { product_id: string; effective_date: string }[]) {
    if (!latestActive.has(h.product_id)) latestActive.set(h.product_id, h.effective_date);
  }

  return ((products ?? []) as ProductRow[]).map((p) => {
    const eff = latestActive.get(p.id) ?? String(p.created_at ?? '').slice(0, 10);
    return [
      p.sku ?? '',
      p.name ?? '',
      p.category_name ?? '',
      Number(p.price ?? 0),
      formatDMY(eff),
      p.is_active ? 'Active' : 'Inactive',
    ];
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

  const { data: products, error } = await supabaseAdmin
    .from('products')
    .select('id, name, sku, price, category_name');
  if (error) throw error;

  const bySku = new Map<string, { id: string; name: string; price: number; category_name: string | null }>();
  for (const p of (products ?? []) as ProductRow[]) {
    if (p.sku) {
      bySku.set(String(p.sku).trim().toLowerCase(), {
        id: p.id,
        name: p.name ?? '',
        price: Number(p.price ?? 0),
        category_name: p.category_name,
      });
    }
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

    if (rounded === product.price) {
      unchangedRows.push({ productCode: codeRaw, productName: product.name, price: rounded });
      return;
    }
    validRows.push({
      productId: product.id,
      productCode: codeRaw,
      productName: product.name,
      categoryName: product.category_name ?? '',
      currentPrice: product.price,
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
  // batch_id is a uuid column, minted client-side with randomUUID()
  // (migration 06 notes the same).
  const batchId = randomUUID();
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
