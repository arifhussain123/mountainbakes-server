import { getPrisma } from '../db';
import {
  businessDateStr,
  type EmployeeProfile,
  type EmployeeResignation,
  type FinanceAccount,
  type FinanceDocStatus,
  type LedgerCell,
  type LedgerExclusion,
  type LedgerYearOption,
  type PartnerLedger,
  type PartnerLedgerQueryInput,
  type PartnerLedgerRow,
  type PartnerLedgerTransaction,
  type PartnerLedgerTransactions,
  type PartnerLedgerTransactionsQueryInput,
  type PartnerTxnKind,
  type SalaryLedger,
  type SalaryLedgerPayment,
  type SalaryLedgerPayments,
  type SalaryLedgerPaymentsQueryInput,
  type SalaryLedgerQueryInput,
  type SalaryLedgerRow,
} from '../shared';
import { listEmployees } from './finance-payroll.service';
import { listResignations, liveResignations, resignationMonth } from './finance-resignations.service';

/**
 * The two read-only year ledgers.
 *
 *   Salary Ledger                 employee × month, from salary_payments
 *   Company Transaction Details   partner × month, from partner_expenses
 *
 * NOTHING HERE WRITES. Every function is a select, and the routes that call
 * them are GET only. A ledger figure cannot be typed in, edited or removed: it
 * changes when — and only when — a source record is approved, corrected or
 * deleted through that record's own workflow.
 *
 * WHAT COUNTS is decided in one place, the views `salary_ledger_payments` and
 * `partner_ledger_transactions` (see the migration): posted or locked, not
 * deleted, voucher still in the book. The totals and the drill-down both read
 * those views, so a month's figure is always the sum of the list behind it.
 *
 * ARITHMETIC. Postgres does the summing, on `numeric`. Amounts cross into
 * JavaScript as text and are carried as whole paisa from there, so adding
 * twelve months and forty employees cannot pick up a float error.
 */

const prisma = () => getPrisma();

const paisa = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
const rupees = (p: number): number => p / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** `%` and `_` are literals in something a person typed into a search box. */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * The years offered by the selector: every year from the earliest record to
 * next year, newest first. Next year is always there and simply empty until
 * something for it is approved — a new year starts blank, never as a copy of
 * the one before.
 */
function yearOptions(rows: { year: number; has_counted: boolean }[], currentYear: number): LedgerYearOption[] {
  const counted = new Set(rows.filter((r) => r.has_counted).map((r) => r.year));
  const known = rows.map((r) => r.year);
  const first = Math.min(currentYear, ...known);
  const last = Math.max(currentYear + 1, ...known);
  const out: LedgerYearOption[] = [];
  for (let y = last; y >= first; y--) out.push({ year: y, hasRecords: counted.has(y) });
  return out;
}

function exclusionOf(status: FinanceDocStatus, counted: boolean): LedgerExclusion | null {
  if (counted) return null;
  switch (status) {
    case 'draft':
      return 'draft';
    case 'pending_approval':
      return 'pending';
    case 'approved':
      return 'approved_not_posted';
    case 'rejected':
      return 'rejected';
    default:
      // Posted or locked, and still not counted: its voucher is gone.
      return 'voucher_removed';
  }
}

interface MonthAggregate {
  amount: number;
  count: number;
  flagged: boolean;
  pending: number;
}

function paginate<T>(rows: T[], page: number, pageSize: number): { rows: T[]; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  return { rows: rows.slice((current - 1) * pageSize, current * pageSize), page: current };
}

// ---------------------------------------------------------------------------
// Salary Ledger
// ---------------------------------------------------------------------------

interface EmployeeRow {
  id: string;
  employee_code: string;
  name: string;
  department: string;
  designation: string;
  joined_on: string | null;
  is_active: boolean;
  created_on: string;
}

/**
 * One row per employee for one year.
 *
 * WHO IS ON THE LEDGER FOR A YEAR: anyone with a payslip for it, plus anyone
 * who was on the payroll during it — active employees who had joined by its
 * end, and resigned ones whose resignation falls in it or later. An employee
 * who resigned in 2026 keeps their 2026 row for good and does not reappear as
 * an empty row in 2027.
 *
 * WHAT A MONTH WITH NO SALARY MEANS depends on the employee, and the three
 * answers are kept apart (see LedgerCellState): closed after a resignation,
 * unpaid if they were on the payroll and the month is over, otherwise nothing.
 * "Unpaid" is a prompt to look, never an amount — no figure is invented for it.
 */
export async function getSalaryLedger(q: SalaryLedgerQueryInput): Promise<SalaryLedger> {
  const today = businessDateStr();
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = today.slice(0, 7);
  const year = q.year ?? currentYear;

  const aggregates = await prisma().$queryRawUnsafe<
    { employee_id: string; month_no: number; amount: string; n: number; flagged: boolean; pending: number }[]
  >(
    `select employee_id::text as employee_id,
            month_no,
            coalesce(sum(counted_amount) filter (where counted), 0)::text       as amount,
            (count(*) filter (where counted))::int                               as n,
            coalesce(bool_or(counted and after_resignation), false)              as flagged,
            (count(*) filter (where status in ('draft', 'pending_approval')))::int as pending
       from public.salary_ledger_payments
      where salary_year = $1
      group by employee_id, month_no`,
    year,
  );

  const employees = await prisma().$queryRawUnsafe<EmployeeRow[]>(
    `select id::text as id, employee_code, name, department, designation,
            to_char(joined_on, 'YYYY-MM-DD') as joined_on,
            is_active,
            to_char((created_at at time zone 'Asia/Karachi')::date, 'YYYY-MM-DD') as created_on
       from public.finance_employees`,
  );

  const yearRows = await prisma().$queryRawUnsafe<{ year: number; has_counted: boolean }[]>(
    `select salary_year as year, coalesce(bool_or(counted), false) as has_counted
       from public.salary_ledger_payments group by salary_year`,
  );

  const resignations = await liveResignations();

  const byEmployee = new Map<string, Map<number, MonthAggregate>>();
  for (const a of aggregates) {
    const months = byEmployee.get(a.employee_id) ?? new Map<number, MonthAggregate>();
    months.set(a.month_no, { amount: paisa(a.amount), count: a.n, flagged: a.flagged, pending: a.pending });
    byEmployee.set(a.employee_id, months);
  }

  const firstMonth = `${year}-01`;
  const lastMonth = `${year}-12`;
  // Totals in paisa alongside each row, so nothing is re-derived from a rounded figure.
  const all: { row: SalaryLedgerRow; cellPaisa: number[]; totalPaisa: number }[] = [];

  for (const e of employees) {
    const months = byEmployee.get(e.id);
    const resignation = resignations.get(e.id) ?? null;
    const resignedIn = resignation ? resignationMonth(resignation) : null;
    // No joining date on record: the day they were added to the payroll is the
    // earliest thing known about them. Nothing is assumed before it.
    const since = (e.joined_on ?? e.created_on).slice(0, 7);

    const onPayroll =
      year <= currentYear && since <= lastMonth && (resignedIn ? resignedIn >= firstMonth : e.is_active);
    if (!months && !onPayroll) continue;

    const cells: LedgerCell[] = [];
    const cellPaisa: number[] = [];
    let totalPaisa = 0;
    let unpaidMonths = 0;
    let flaggedMonths = 0;
    let hasPending = false;

    for (let m = 1; m <= 12; m++) {
      const period = `${year}-${pad(m)}`;
      const agg = months?.get(m);
      const pendingCount = agg?.pending ?? 0;
      if (pendingCount > 0) hasPending = true;

      let state: LedgerCell['state'] = 'none';
      let amount = 0;
      let flagged = false;

      if (agg && agg.count > 0) {
        state = 'paid';
        amount = agg.amount;
        flagged = agg.flagged;
        totalPaisa += amount;
        if (flagged) flaggedMonths++;
      } else if (resignedIn && period > resignedIn) {
        state = 'closed';
      } else if ((e.is_active || resignedIn) && period >= since && period < currentMonth) {
        state = 'unpaid';
        unpaidMonths++;
      }

      cellPaisa.push(amount);
      cells.push({ month: m, amount: rupees(amount), count: agg?.count ?? 0, state, flagged, pendingCount });
    }

    all.push({
      cellPaisa,
      totalPaisa,
      row: {
        employeeId: e.id,
        employeeCode: e.employee_code,
        employeeName: e.name,
        department: e.department,
        designation: e.designation,
        joinedOn: e.joined_on,
        isActive: e.is_active,
        resignation,
        cells,
        total: rupees(totalPaisa),
        unpaidMonths,
        flaggedMonths,
        hasPending,
      },
    });
  }

  const summary = {
    totalApproved: rupees(all.reduce((t, r) => t + r.totalPaisa, 0)),
    paymentCount: all.reduce((t, r) => t + r.row.cells.reduce((c, cell) => c + cell.count, 0), 0),
    employees: all.length,
    activeEmployees: all.filter((r) => !r.row.resignation && r.row.isActive).length,
    resignedEmployees: all.filter((r) => r.row.resignation).length,
    unpaidEmployeeMonths: all.reduce((t, r) => t + r.row.unpaidMonths, 0),
    flaggedMonths: all.reduce((t, r) => t + r.row.flaggedMonths, 0),
  };

  const departments = uniqueCaseInsensitive(all.map((r) => r.row.department));

  const term = q.search?.toLowerCase();
  const department = q.department?.toLowerCase();
  const filtered = all.filter(({ row }) => {
    if (term && !row.employeeCode.toLowerCase().includes(term) && !row.employeeName.toLowerCase().includes(term)) {
      return false;
    }
    if (department && row.department.trim().toLowerCase() !== department) return false;
    switch (q.status) {
      case 'active':
        return row.isActive && !row.resignation;
      case 'resigned':
        return Boolean(row.resignation);
      case 'unpaid':
        return row.unpaidMonths > 0;
      case 'pending':
        return row.hasPending;
      default:
        return true;
    }
  });

  filtered.sort((a, b) => {
    if (q.sort === 'name') return a.row.employeeName.localeCompare(b.row.employeeName) || byCode(a.row, b.row);
    if (q.sort === 'total') return b.totalPaisa - a.totalPaisa || byCode(a.row, b.row);
    return byCode(a.row, b.row);
  });

  const monthPaisa = Array.from({ length: 12 }, (_, i) => filtered.reduce((t, r) => t + r.cellPaisa[i]!, 0));
  const { rows, page } = paginate(filtered, q.page, q.pageSize);

  return {
    year,
    currentMonth,
    years: yearOptions(yearRows, currentYear),
    departments,
    summary,
    rows: rows.map((r) => r.row),
    total: filtered.length,
    page,
    pageSize: q.pageSize,
    monthTotals: monthPaisa.map(rupees),
    yearTotal: rupees(monthPaisa.reduce((t, v) => t + v, 0)),
  };
}

const byCode = (a: { employeeCode: string }, b: { employeeCode: string }) =>
  a.employeeCode.localeCompare(b.employeeCode, undefined, { numeric: true });

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    const trimmed = v.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

interface PaymentRow {
  id: string;
  salary_no: string;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  salary_month: string;
  salary_year: number;
  month_no: number;
  status: FinanceDocStatus;
  gross_salary: string;
  bonus: string;
  deductions: string;
  net_salary: string;
  payment_date: string | null;
  payment_method: string;
  account: FinanceAccount;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  approved_by_name: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  voucher_no: string | null;
  counted: boolean;
  counted_amount: string;
  after_resignation: boolean;
}

/**
 * The payslips behind the ledger — one cell's, one employee's, or a year's.
 *
 * Pending, draft and rejected payslips are returned too, marked as excluded
 * with the reason, because "why is this month empty" is usually answered by a
 * payslip that is still waiting. They contribute nothing to `countedTotal`.
 *
 * The employee's code and name come from the master record, not from the
 * payslip's snapshot, so a row here always matches its row in the ledger.
 */
export async function getSalaryLedgerPayments(q: SalaryLedgerPaymentsQueryInput): Promise<SalaryLedgerPayments> {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => `$${params.push(value)}`;

  if (q.year !== undefined) where.push(`v.salary_year = ${bind(q.year)}`);
  if (q.month !== undefined) where.push(`v.month_no = ${bind(q.month)}`);
  if (q.employeeId) where.push(`v.employee_id = ${bind(q.employeeId)}::uuid`);
  if (q.search) {
    const p = bind(likePattern(q.search));
    where.push(`(e.name ilike ${p} or e.employee_code ilike ${p} or v.salary_no ilike ${p})`);
  }
  const filter = where.length > 0 ? `where ${where.join(' and ')}` : '';
  const from = `from public.salary_ledger_payments v join public.finance_employees e on e.id = v.employee_id ${filter}`;

  const [totals] = await prisma().$queryRawUnsafe<{ total: number; counted_count: number; counted_total: string }[]>(
    `select count(*)::int as total,
            (count(*) filter (where v.counted))::int as counted_count,
            coalesce(sum(v.counted_amount) filter (where v.counted), 0)::text as counted_total
       ${from}`,
    ...params,
  );

  const rows = await prisma().$queryRawUnsafe<PaymentRow[]>(
    `select v.id::text as id, v.salary_no, v.employee_id::text as employee_id,
            e.employee_code, e.name as employee_name,
            v.salary_month, v.salary_year, v.month_no, v.status::text as status,
            v.gross_salary::text as gross_salary, v.bonus::text as bonus,
            v.deductions::text as deductions, v.net_salary::text as net_salary,
            to_char(v.payment_date, 'YYYY-MM-DD') as payment_date,
            v.payment_method, v.account::text as account, v.notes,
            v.created_by_name, ${stamp('v.created_at')} as created_at,
            v.approved_by_name, ${stamp('v.approved_at')} as approved_at,
            v.rejection_reason, v.voucher_no, v.counted,
            v.counted_amount::text as counted_amount, v.after_resignation
       ${from}
      order by v.salary_month desc, v.salary_no desc
      limit ${bind(q.limit)} offset ${bind(q.offset)}`,
    ...params,
  );

  return {
    payments: rows.map(toSalaryPayment),
    total: totals?.total ?? 0,
    countedTotal: Number(totals?.counted_total ?? 0),
    countedCount: totals?.counted_count ?? 0,
  };
}

function toSalaryPayment(r: PaymentRow): SalaryLedgerPayment {
  return {
    id: r.id,
    salaryNo: r.salary_no,
    employeeId: r.employee_id,
    employeeCode: r.employee_code,
    employeeName: r.employee_name,
    salaryMonth: r.salary_month,
    year: r.salary_year,
    month: r.month_no,
    status: r.status,
    grossSalary: Number(r.gross_salary),
    bonus: Number(r.bonus),
    deductions: Number(r.deductions),
    netSalary: Number(r.net_salary),
    paymentDate: r.payment_date,
    paymentMethod: r.payment_method,
    account: r.account,
    notes: r.notes,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
    rejectionReason: r.rejection_reason,
    voucherNo: r.voucher_no,
    counted: r.counted,
    countedAmount: Number(r.counted_amount),
    exclusion: exclusionOf(r.status, r.counted),
    afterResignation: r.after_resignation,
  };
}

/**
 * One employee's biodata, as held — nothing is filled in that is not on record.
 * Used by the resignation form after an employee is picked, and by the detail
 * drawer.
 */
export async function getEmployeeProfile(employeeId: string): Promise<EmployeeProfile> {
  const employee = (await listEmployees({ includeInactive: true })).find((e) => e.id === employeeId);
  if (!employee) throw httpError(404, 'Employee not found');

  const resignations: EmployeeResignation[] = await listResignations(employeeId);

  const [last] = await prisma().$queryRawUnsafe<{ salary_no: string; salary_month: string; amount: string }[]>(
    `select salary_no, salary_month, counted_amount::text as amount
       from public.salary_ledger_payments
      where employee_id = $1::uuid and counted
      order by salary_month desc, salary_no desc
      limit 1`,
    employeeId,
  );
  const [sum] = await prisma().$queryRawUnsafe<{ total: string }[]>(
    `select coalesce(sum(counted_amount), 0)::text as total
       from public.salary_ledger_payments
      where employee_id = $1::uuid and counted`,
    employeeId,
  );

  return {
    employee,
    resignations,
    lastApprovedSalary: last
      ? { salaryNo: last.salary_no, salaryMonth: last.salary_month, amount: Number(last.amount) }
      : null,
    allTimeApproved: Number(sum?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Company Transaction Details
// ---------------------------------------------------------------------------

/**
 * One row per partner for one year: approved advances and draws, summed by the
 * month their voucher sits in.
 *
 * WHAT IS A "COMPANY TRANSACTION" HERE is the page's existing meaning — money
 * paid to a partner, as an advance against their share or a draw of it. Those
 * are the `partner_expenses` records and nothing else. Branch share payouts,
 * salaries, and ordinary company income and expenses are other documents and
 * are not summed into a partner's row.
 *
 * A partner appears for a year once they have a transaction in it, in any
 * state. A year with none shows as empty rather than as four rows of dashes.
 */
export async function getPartnerLedger(q: PartnerLedgerQueryInput): Promise<PartnerLedger> {
  const today = businessDateStr();
  const currentYear = Number(today.slice(0, 4));
  const year = q.year ?? currentYear;
  const kind: PartnerTxnKind | null = q.txnKind ?? null;

  const aggregates = await prisma().$queryRawUnsafe<
    { partner_id: string | null; month_no: number; amount: string; n: number; pending: number }[]
  >(
    `select partner_id::text as partner_id,
            month_no,
            coalesce(sum(counted_amount) filter (where counted), 0)::text         as amount,
            (count(*) filter (where counted))::int                                 as n,
            (count(*) filter (where status in ('draft', 'pending_approval')))::int as pending
       from public.partner_ledger_transactions
      where txn_year = $1 and ($2::text is null or txn_kind = $2::text)
      group by partner_id, month_no`,
    year,
    kind,
  );

  const partners = await prisma().$queryRawUnsafe<
    { id: string; partner_code: string; name: string; share_pct: string; is_active: boolean }[]
  >(
    `select id::text as id, partner_code, name, share_pct::text as share_pct, is_active
       from public.finance_partners`,
  );

  const yearRows = await prisma().$queryRawUnsafe<{ year: number; has_counted: boolean }[]>(
    `select txn_year as year, coalesce(bool_or(counted), false) as has_counted
       from public.partner_ledger_transactions group by txn_year`,
  );

  const byPartner = new Map<string, Map<number, MonthAggregate>>();
  const unassigned = { count: 0, paisa: 0 };
  for (const a of aggregates) {
    if (!a.partner_id) {
      unassigned.count += a.n;
      unassigned.paisa += paisa(a.amount);
      continue;
    }
    const months = byPartner.get(a.partner_id) ?? new Map<number, MonthAggregate>();
    months.set(a.month_no, { amount: paisa(a.amount), count: a.n, flagged: false, pending: a.pending });
    byPartner.set(a.partner_id, months);
  }

  const all: { row: PartnerLedgerRow; cellPaisa: number[]; totalPaisa: number }[] = [];
  for (const p of partners) {
    const months = byPartner.get(p.id);
    if (!months) continue;

    const cells: LedgerCell[] = [];
    const cellPaisa: number[] = [];
    let totalPaisa = 0;
    let hasPending = false;
    for (let m = 1; m <= 12; m++) {
      const agg = months.get(m);
      const counted = agg && agg.count > 0;
      const amount = counted ? agg.amount : 0;
      if ((agg?.pending ?? 0) > 0) hasPending = true;
      totalPaisa += amount;
      cellPaisa.push(amount);
      cells.push({
        month: m,
        amount: rupees(amount),
        count: agg?.count ?? 0,
        state: counted ? 'paid' : 'none',
        flagged: false,
        pendingCount: agg?.pending ?? 0,
      });
    }

    all.push({
      cellPaisa,
      totalPaisa,
      row: {
        partnerId: p.id,
        partnerCode: p.partner_code,
        partnerName: p.name,
        sharePct: Number(p.share_pct),
        isActive: p.is_active,
        cells,
        total: rupees(totalPaisa),
        hasPending,
      },
    });
  }

  const yearMonthPaisa = Array.from({ length: 12 }, (_, i) => all.reduce((t, r) => t + r.cellPaisa[i]!, 0));
  const top = Math.max(0, ...yearMonthPaisa);
  const summary = {
    yearTotal: rupees(yearMonthPaisa.reduce((t, v) => t + v, 0)),
    transactionCount: all.reduce((t, r) => t + r.row.cells.reduce((c, cell) => c + cell.count, 0), 0),
    partners: all.length,
    highestMonth: top > 0 ? { month: yearMonthPaisa.indexOf(top) + 1, amount: rupees(top) } : null,
    unassigned: { count: unassigned.count, amount: rupees(unassigned.paisa) },
  };

  const term = q.search?.toLowerCase();
  const filtered = all.filter(
    ({ row }) =>
      !term || row.partnerCode.toLowerCase().includes(term) || row.partnerName.toLowerCase().includes(term),
  );
  filtered.sort((a, b) => {
    const code = a.row.partnerCode.localeCompare(b.row.partnerCode, undefined, { numeric: true });
    if (q.sort === 'name') return a.row.partnerName.localeCompare(b.row.partnerName) || code;
    if (q.sort === 'total') return b.totalPaisa - a.totalPaisa || code;
    return code;
  });

  const monthPaisa = Array.from({ length: 12 }, (_, i) => filtered.reduce((t, r) => t + r.cellPaisa[i]!, 0));
  const { rows, page } = paginate(filtered, q.page, q.pageSize);

  return {
    year,
    years: yearOptions(yearRows, currentYear),
    txnKind: kind,
    summary,
    rows: rows.map((r) => r.row),
    total: filtered.length,
    page,
    pageSize: q.pageSize,
    monthTotals: monthPaisa.map(rupees),
    yearTotal: rupees(monthPaisa.reduce((t, v) => t + v, 0)),
  };
}

interface TransactionRow {
  id: string;
  expense_no: string;
  partner_id: string | null;
  partner_code: string | null;
  partner_name: string;
  txn_kind: PartnerTxnKind;
  description: string;
  amount: string;
  business_date: string;
  ledger_date: string;
  txn_year: number;
  month_no: number;
  status: FinanceDocStatus;
  payment_method: string;
  account: FinanceAccount;
  notes: string | null;
  requested_by_name: string;
  created_at: string;
  approved_by_name: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  voucher_no: string | null;
  counted: boolean;
  counted_amount: string;
}

/** The partner transactions behind the ledger — one cell's, one partner's, or a year's. */
export async function getPartnerLedgerTransactions(
  q: PartnerLedgerTransactionsQueryInput,
): Promise<PartnerLedgerTransactions> {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => `$${params.push(value)}`;

  if (q.year !== undefined) where.push(`v.txn_year = ${bind(q.year)}`);
  if (q.month !== undefined) where.push(`v.month_no = ${bind(q.month)}`);
  if (q.partnerId) where.push(`v.partner_id = ${bind(q.partnerId)}::uuid`);
  if (q.txnKind) where.push(`v.txn_kind = ${bind(q.txnKind)}`);
  if (q.search) {
    const p = bind(likePattern(q.search));
    where.push(`(coalesce(p.name, v.partner_name) ilike ${p} or p.partner_code ilike ${p} or v.expense_no ilike ${p})`);
  }
  const filter = where.length > 0 ? `where ${where.join(' and ')}` : '';
  const from = `from public.partner_ledger_transactions v left join public.finance_partners p on p.id = v.partner_id ${filter}`;

  const [totals] = await prisma().$queryRawUnsafe<{ total: number; counted_count: number; counted_total: string }[]>(
    `select count(*)::int as total,
            (count(*) filter (where v.counted))::int as counted_count,
            coalesce(sum(v.counted_amount) filter (where v.counted), 0)::text as counted_total
       ${from}`,
    ...params,
  );

  const rows = await prisma().$queryRawUnsafe<TransactionRow[]>(
    `select v.id::text as id, v.expense_no, v.partner_id::text as partner_id,
            p.partner_code, coalesce(p.name, v.partner_name) as partner_name,
            v.txn_kind, v.description, v.amount::text as amount,
            to_char(v.business_date, 'YYYY-MM-DD') as business_date,
            to_char(v.ledger_date, 'YYYY-MM-DD') as ledger_date,
            v.txn_year, v.month_no, v.status::text as status,
            v.payment_method, v.account::text as account, v.notes,
            v.requested_by_name, ${stamp('v.created_at')} as created_at,
            v.approved_by_name, ${stamp('v.approved_at')} as approved_at,
            v.rejection_reason, v.voucher_no, v.counted,
            v.counted_amount::text as counted_amount
       ${from}
      order by v.ledger_date desc, v.expense_no desc
      limit ${bind(q.limit)} offset ${bind(q.offset)}`,
    ...params,
  );

  return {
    transactions: rows.map(
      (r): PartnerLedgerTransaction => ({
        id: r.id,
        expenseNo: r.expense_no,
        partnerId: r.partner_id,
        partnerCode: r.partner_code,
        partnerName: r.partner_name,
        txnKind: r.txn_kind,
        description: r.description,
        amount: Number(r.amount),
        businessDate: r.business_date,
        ledgerDate: r.ledger_date,
        year: r.txn_year,
        month: r.month_no,
        status: r.status,
        paymentMethod: r.payment_method,
        account: r.account,
        notes: r.notes,
        requestedByName: r.requested_by_name,
        createdAt: r.created_at,
        approvedByName: r.approved_by_name,
        approvedAt: r.approved_at,
        rejectionReason: r.rejection_reason,
        voucherNo: r.voucher_no,
        counted: r.counted,
        countedAmount: Number(r.counted_amount),
        exclusion: exclusionOf(r.status, r.counted),
      }),
    ),
    total: totals?.total ?? 0,
    countedTotal: Number(totals?.counted_total ?? 0),
    countedCount: totals?.counted_count ?? 0,
  };
}
