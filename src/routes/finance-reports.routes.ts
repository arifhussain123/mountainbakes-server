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
      const buffer = await exportFinanceReportPDF(report, settings.companyName);
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
