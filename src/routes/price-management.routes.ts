import { Router } from 'express';
import multer from 'multer';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { ImportCommitSchema } from '../shared';
import { resolveAdminName } from '../services/audit.service';
import { genericExcel, genericCSV } from '../services/production-export.service';
import {
  listPriceHistory,
  buildPriceListRows,
  buildPriceHistoryRows,
  parseImportWorkbook,
  commitPriceImport,
  PRICE_LIST_HEADERS,
  PRICE_HISTORY_HEADERS,
} from '../services/price.service';
import type { Response } from 'express';

// Mounted at /api/products/price. Super-admin only: price history, price-list
// export, and the bulk import preview/commit. (Distinct prefix from the products
// router so it never collides with GET /api/products/:id.)
export const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authenticate, requireRole('super_admin'));

/**
 * Send rows as an .xlsx or .csv attachment.
 *
 * The Content-Type values here are load-bearing: the web client (`apiCall`) only
 * returns a Blob for pdf / spreadsheet / text-csv responses, and otherwise tries
 * `response.json()` and throws. Keep them in sync with lib/api/client.ts.
 */
async function sendSpreadsheet(
  res: Response,
  opts: { type: string; sheet: string; headers: string[]; rows: (string | number)[][]; filename: string },
): Promise<void> {
  if (opts.type === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}.csv"`);
    res.send(genericCSV(opts.headers, opts.rows));
    return;
  }
  const buffer = await genericExcel(opts.sheet, opts.headers, opts.rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}.xlsx"`);
  res.send(buffer);
}

// GET /api/products/price/history?productId=&limit=
router.get('/history', async (req: AuthRequest, res, next) => {
  try {
    const productId = req.query['productId'] ? String(req.query['productId']) : undefined;
    const limit = Math.max(1, Math.min(1000, parseInt(String(req.query['limit'] ?? '300'), 10) || 300));
    const history = await listPriceHistory(productId, limit);
    res.json({ history, total: history.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/price/list/export?type=excel|csv&groupBy=category
// Also the re-import template — `groupBy` only reorders rows, columns are identical.
router.get('/list/export', async (req: AuthRequest, res, next) => {
  try {
    const type = String(req.query['type'] || 'excel');
    const byCategory = String(req.query['groupBy'] || '') === 'category';
    const rows = await buildPriceListRows(byCategory ? { groupBy: 'category' } : undefined);
    const today = new Date().toISOString().slice(0, 10);

    await sendSpreadsheet(res, {
      type,
      sheet: byCategory ? 'Products by Category' : 'Price List',
      headers: PRICE_LIST_HEADERS,
      rows,
      filename: `mountain-bakes-${byCategory ? 'products-by-category' : 'price-list'}-${today}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/price/history/export?type=excel|csv&productId=
router.get('/history/export', async (req: AuthRequest, res, next) => {
  try {
    const type = String(req.query['type'] || 'excel');
    const productId = req.query['productId'] ? String(req.query['productId']) : undefined;
    const rows = await buildPriceHistoryRows(productId);

    await sendSpreadsheet(res, {
      type,
      sheet: 'Price History',
      headers: PRICE_HISTORY_HEADERS,
      rows,
      filename: `mountain-bakes-price-history-${new Date().toISOString().slice(0, 10)}`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/price/import/preview — multipart 'file'; validates, never writes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
router.post('/import/preview', upload.single('file') as any, async (req: AuthRequest, res, next) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    const preview = await parseImportWorkbook(req.file.buffer);
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

// POST /api/products/price/import/commit — apply confirmed rows + one summary notification.
router.post('/import/commit', validate(ImportCommitSchema), async (req: AuthRequest, res, next) => {
  try {
    const { rows, effectiveDate, reason } = req.body as { rows: { productId: string; newPrice: number }[]; effectiveDate: string; reason: string };
    const changedByName = await resolveAdminName(req.user!.uid, req.user!.email);
    const result = await commitPriceImport({ rows, effectiveDate, reason, changedBy: req.user!.uid, changedByName });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
