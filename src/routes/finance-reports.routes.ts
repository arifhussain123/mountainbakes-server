import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { FinanceReportQuerySchema, type FinanceExportFormat } from '../shared';
import { buildFinanceReport } from '../services/finance-reports.service';
import {
  exportFinanceReportCSV,
  exportFinanceReportExcel,
  exportFinanceReportPDF,
} from '../services/finance-export.service';
import { getAppSettings } from '../services/settings.service';
import { AccountingWorkbookQuerySchema, loadAccountingBooks } from '../services/finance-accounting.service';
import { accountingWorkbookFilename, exportAccountingWorkbook } from '../services/finance-accounting-export.service';
import { fileStore, LOGO_PATH_PATTERN } from '../services/file-store';

/**
 * /api/finance/reports — the ten reports, on screen and as files.
 *
 * ONE report builder feeds both endpoints. `/` returns the descriptor as JSON
 * for the screen; `/export` renders the SAME descriptor to PDF, Excel or CSV.
 * That is what guarantees the printed copy and the screen agree — they are not
 * two code paths that happen to produce similar numbers.
 *
 * Reports are `view`-level, which is what makes a Read Only Auditor useful and
 * what the brief means by Admin being able to see reports without being able to
 * touch the records behind them.
 */

export const router = Router();

router.use(authenticate);

/**
 * Query strings arrive as strings; the schema is shared with nothing else, so it
 * is parsed here rather than through `validate()` (which reads req.body).
 * Unknown keys are dropped by Zod, so a stray `?_=169…` cache-buster is harmless.
 */
function parseQuery(req: AuthRequest) {
  const parsed = FinanceReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw Object.assign(new Error(parsed.error.errors[0]?.message ?? 'Invalid report request'), { status: 400 });
  }
  return parsed.data;
}

/** The uploaded company logo's bytes for a PDF letterhead, or null — a missing logo never fails an export. */
async function brandingLogo(path: string | undefined): Promise<Buffer | null> {
  if (!path || !LOGO_PATH_PATTERN.test(path) || !/\.(png|jpg)$/.test(path)) return null;
  try {
    return (await fileStore().download?.('branding', path)) ?? null;
  } catch {
    return null;
  }
}

router.get('/', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const report = await buildFinanceReport(parseQuery(req), req.user!.email, { paginate: true });
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

router.get('/export', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const query = parseQuery(req);
    const format = (String(req.query['format'] || 'excel').toLowerCase() as FinanceExportFormat);

    const [report, settings] = await Promise.all([
      // paginate: false — an export is the document of record and must hold
      // every row the filters matched, not just the page the screen is on.
      buildFinanceReport(query, req.user!.email, { paginate: false }),
      // The company name on the letterhead comes from app settings, so a rename
      // reaches every finance PDF without touching this module.
      getAppSettings().catch(() => ({ companyName: 'Mountain Bakes' })),
    ]);

    // Slugged from the report type + period so a folder of exports is sortable
    // and self-describing rather than twelve files called "report".
    const filename = `mountain-bakes-${query.type.replace(/_/g, '-')}-${report.periodFrom}_${report.periodTo}`;

    if (format === 'pdf') {
      // The loan ledger's PDF carries the logo (its spec asks for it); the
      // other reports keep their text letterhead unchanged.
      const logo = query.type === 'loan_ledger' ? await brandingLogo((settings as { logoPath?: string }).logoPath) : null;
      const buffer = await exportFinanceReportPDF(report, settings.companyName, { logo });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
      res.send(buffer);
      return;
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(exportFinanceReportCSV(report));
      return;
    }

    const buffer = await exportFinanceReportExcel(report, settings.companyName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * The Daily Ledger's Excel button: the Daily Cash Book sheet it always gave,
 * then General Entries, Ledger, Trial Balance, Income Statement and Balance
 * Sheet in the same workbook (finance-accounting.service.ts).
 *
 * Read-only — it derives the double entry from the posted vouchers and writes
 * nothing, so pressing the button twice cannot post anything twice. Only the
 * period and branch apply: a statement narrowed by head or account cannot
 * balance. The validation result travels in a header as well as inside the
 * file, for whoever calls this without opening it.
 */
router.get('/accounting-workbook', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const parsed = AccountingWorkbookQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.errors[0]?.message ?? 'Invalid workbook request'), { status: 400 });
    }
    const q = parsed.data;
    const [books, cashBook, settings] = await Promise.all([
      loadAccountingBooks(q),
      // The same cash book the /export route writes, for the same period and
      // branch — the sheet the Excel button produced before these were added.
      buildFinanceReport(
        { type: 'daily_cash_book', from: q.from, to: q.to, branchId: q.branchId },
        req.user!.email,
        { paginate: false },
      ),
      getAppSettings().catch(() => ({ companyName: 'Mountain Bakes' })),
    ]);
    const buffer = await exportAccountingWorkbook(books, {
      companyName: settings.companyName,
      generatedBy: req.user!.email,
      cashBook,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${accountingWorkbookFilename(books)}"`);
    res.setHeader('X-Accounting-Status', books.status.level);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});
