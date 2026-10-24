import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateExpenseSchema, businessDaysAgoStr, businessDateStr, BRANCH_ROLES, isBranchRole } from '../shared';
import { idempotent } from '../middleware/idempotency';
import { resolveClientBusinessDate } from '../utils/clientBusinessDate';
import { rowToApi } from '../utils/case';
// Generic tabular exporters — they live in production-export.service only because
// that is where the first non-order-shaped report needed them; nothing in them is
// production-specific.
import { genericExcel, genericCSV } from '../services/production-export.service';
import { buildExpenseSheet } from '../services/expense-export.service';

const db = dbFor('expenses');

export const router = Router();

router.use(authenticate);

// GET /api/expenses — last 7 business days, branch-scoped
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    // The 7-day cutoff is a real indexed predicate now (expenses_branch_date_idx);
    // it used to fetch every expense for the branch and filter in memory.
    let query = db
      .from('expenses')
      .select('*')
      .gte('business_date', businessDaysAgoStr(6)) // inclusive last 7 business days
      .order('created_at', { ascending: false });

    if (isBranchRole(req.user!.role) && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    // DB column is business_date; the API contract (Expense) exposes it as `date`.
    // rowToApi only camelCases keys, so remap businessDate → date here (mirrors the
    // production-orders route). expense_number → expenseNumber flows automatically.
    const rows = rowToApi<Record<string, unknown>[]>(data ?? []);
    const expenses = rows.map(({ businessDate, ...rest }) => ({ ...rest, date: businessDate }));
    res.json({ expenses, total: expenses.length });
  } catch (err) {
    next(err);
  }
});

/**
 * Ceiling on one export. Well above any real window — a busy branch books a
 * handful of expenses a day, so this is years of them — but it stops an
 * open-ended range from pulling the whole table into the server's memory.
 */
const EXPORT_ROW_CAP = 20_000;

/**
 * The from/to window, as YYYY-MM-DD business dates.
 *
 * Defaults to the same last-7-business-days the list route serves, so an export
 * taken with no dates matches what the page is showing rather than silently
 * covering something else. A reversed pair is swapped rather than returning an
 * empty sheet that looks like "no expenses".
 */
function exportRange(from: unknown, to: unknown): { fromStr: string; toStr: string } {
  const clean = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const a = clean(from) || businessDaysAgoStr(6);
  const b = clean(to) || businessDateStr();
  return a <= b ? { fromStr: a, toStr: b } : { fromStr: b, toStr: a };
}

// GET /api/expenses/export — the same rows the list shows, over an explicit
// window, as a spreadsheet. Branch scoping is identical to GET / : an export
// must never be a way to read a branch the caller cannot see on screen.
router.get('/export', async (req: AuthRequest, res, next) => {
  try {
    const exportType = String(req.query['type'] || 'excel');
    const { fromStr, toStr } = exportRange(req.query['from'], req.query['to']);

    let query = db
      .from('expenses')
      .select('*')
      .gte('business_date', fromStr)
      .lte('business_date', toStr)
      .order('business_date', { ascending: true })
      .order('created_at', { ascending: true })
      // One over the cap, so a full page is distinguishable from an overflowing
      // one. Truncating an export silently is worse than refusing it — the
      // totals would look authoritative and be wrong.
      .limit(EXPORT_ROW_CAP + 1);

    const branchScoped = isBranchRole(req.user!.role) && !!req.user!.branchId;
    if (branchScoped) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    const { data, error } = await query;
    if (error) throw error;

    if ((data?.length ?? 0) > EXPORT_ROW_CAP) {
      res.status(400).json({ error: `That range holds more than ${EXPORT_ROW_CAP.toLocaleString()} expenses. Export it in smaller windows.` });
      return;
    }

    // Layout (including the trailing total row) lives in the service, so it can
    // be exercised without a request. Branch is dead weight for a branch account
    // — every row is their own shop — and the whole point for an admin.
    const { headers, rows } = buildExpenseSheet(data ?? [], branchScoped);

    const scope = fromStr === toStr ? fromStr : `${fromStr}_to_${toStr}`;
    const filename = `mountain-bakes-expenses-${scope}`;
    const title = 'Shop Expenses';

    if (exportType === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(genericCSV(headers, rows));
    } else {
      const buffer = await genericExcel(title, headers, rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/expenses — record a shop expense for the acting branch
// `idempotent` sits after the role check and before validation: authorization is
// re-decided on every attempt, but a replay must not need the body re-parsed.
router.post('/', requireRole('super_admin', ...BRANCH_ROLES), idempotent('expense.create'), validate(CreateExpenseSchema), async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.user!.branchId;
    if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }

    const { category, description, paymentMethod, amount, remarks, date } = req.body;
    // A shop expense is entered on the day it is paid. A branch account may not
    // back-date one (product owner, 2026-09-08): the form shows today's date
    // read-only, and this is the check behind it — a client that sends another
    // day is refused in words rather than silently re-dated. Super Admin keeps
    // the bounded back-date window for corrections, as everywhere else.
    if (isBranchRole(req.user!.role) && date && date !== businessDateStr()) {
      res.status(400).json({
        error: 'A shop expense can only be entered for today. Back-dated expenses are not allowed.',
      });
      return;
    }
    // `date` is the day the expense was incurred as captured by the client —
    // bounded and closure-checked here rather than trusted.
    const businessDate = await resolveClientBusinessDate(date, req.user!.role);

    // created_at comes from the column default — do not set it here.
    const { data, error } = await db
      .from('expenses')
      .insert({
        branch_id: branchId,
        branch_name: req.user!.branchName || '',
        business_date: businessDate,
        category,
        description,
        payment_method: paymentMethod,
        amount,
        remarks: remarks || '',
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('id')
      .single();
    if (error) throw error;

    res.status(201).json({ id: data.id });
  } catch (err) {
    next(err);
  }
});
