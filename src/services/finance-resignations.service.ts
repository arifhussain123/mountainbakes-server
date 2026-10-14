import { getPrisma } from '../db';
import { toDbError } from '../db/errors';
import {
  karachiDateStr,
  type CancelResignationInput,
  type EmployeeResignation,
  type RecordResignationInput,
  type ResignationImpact,
} from '../shared';
import { rowToApi } from '../utils/case';

/**
 * Employee resignation.
 *
 * A resignation is a record of its own (`employee_resignations`), never a
 * deleted employee and never an edited payslip. Recording one does three
 * things, in one transaction: writes the record, marks the employee inactive,
 * and nothing else. Every salary payment the employee already has stays exactly
 * as it is.
 *
 * WHAT IT CHANGES FROM THEN ON is the rule in `resignationMonth`: ordinary
 * salary may be raised and approved up to and including the month of the
 * resignation date, and not after. That rule is applied where payslips are
 * created and approved (finance-payroll.service) and again by a trigger on
 * salary_payments, which is what decides when an approval and a resignation
 * arrive together.
 *
 * A payslip ALREADY approved for a later month is not touched. The Salary
 * Ledger shows it flagged for review, and `recordResignation` returns the list
 * so the person recording it is told at once.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stamp = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Every column as text, so a row reads the same on any driver. */
const RESIGNATION_COLUMNS = `
  r.id::text                                  as id,
  r.employee_id::text                         as employee_id,
  r.employee_code,
  r.employee_name,
  to_char(r.resignation_date, 'YYYY-MM-DD')   as resignation_date,
  to_char(r.resignation_time, 'HH24:MI')      as resignation_time,
  r.reason,
  r.remarks,
  r.status,
  r.submitted_by::text                        as submitted_by,
  r.submitted_by_name,
  r.cancelled_by::text                        as cancelled_by,
  r.cancelled_by_name,
  ${stamp('r.cancelled_at')}                  as cancelled_at,
  r.cancel_reason,
  ${stamp('r.created_at')}                    as created_at,
  ${stamp('r.updated_at')}                    as updated_at`;

type Tx = Pick<ReturnType<typeof getPrisma>, '$queryRawUnsafe' | '$executeRawUnsafe'>;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** 'YYYY-MM' — the last month ordinary salary may be paid for. */
export function resignationMonth(r: Pick<EmployeeResignation, 'resignationDate'>): string {
  return r.resignationDate.slice(0, 7);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-09-15' → '15 Sep 2026'. For messages people read. */
export function niceDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Every live resignation, by employee. A payroll is small; this is one short query. */
export async function liveResignations(): Promise<Map<string, EmployeeResignation>> {
  const rows = await getPrisma().$queryRawUnsafe<Record<string, unknown>[]>(
    `select ${RESIGNATION_COLUMNS} from public.employee_resignations r where r.status = 'recorded'`,
  );
  return new Map(rowToApi<EmployeeResignation[]>(rows).map((r) => [r.employeeId, r]));
}

export async function getLiveResignation(employeeId: string): Promise<EmployeeResignation | null> {
  if (!UUID.test(employeeId)) return null;
  const rows = await getPrisma().$queryRawUnsafe<Record<string, unknown>[]>(
    `select ${RESIGNATION_COLUMNS} from public.employee_resignations r
      where r.employee_id = $1::uuid and r.status = 'recorded'`,
    employeeId,
  );
  return rows[0] ? rowToApi<EmployeeResignation>(rows[0]) : null;
}

/** One employee's resignation history, newest first, cancelled ones included. */
export async function listResignations(employeeId: string): Promise<EmployeeResignation[]> {
  if (!UUID.test(employeeId)) return [];
  const rows = await getPrisma().$queryRawUnsafe<Record<string, unknown>[]>(
    `select ${RESIGNATION_COLUMNS} from public.employee_resignations r
      where r.employee_id = $1::uuid
      order by r.created_at desc`,
    employeeId,
  );
  return rowToApi<EmployeeResignation[]>(rows);
}

interface LockedEmployee {
  id: string;
  employee_code: string;
  name: string;
  joined_on: string | null;
}

async function lockEmployee(tx: Tx, employeeId: string): Promise<LockedEmployee> {
  // `for update`: a second request for the same employee waits here, then finds
  // the first one's row and is refused.
  const [employee] = await tx.$queryRawUnsafe<LockedEmployee[]>(
    `select id::text as id, employee_code, name, to_char(joined_on, 'YYYY-MM-DD') as joined_on
       from public.finance_employees where id = $1::uuid for update`,
    employeeId,
  );
  if (!employee) throw httpError(404, 'Employee not found');
  return employee;
}

/**
 * Record a resignation.
 *
 * Who recorded it is `actor` — the signed-in user — and when is the database's
 * clock. Neither can be sent by the browser. The date and time the employee
 * resigned ARE entered by a person and are stored as entered.
 *
 * Sending the same request twice records one resignation: the second finds the
 * first and gets a 409, and if two arrive at the same instant the unique index
 * on (employee_id) where status = 'recorded' refuses one of them.
 */
export async function recordResignation(
  employeeId: string,
  input: RecordResignationInput,
  actor: { uid: string; name: string },
): Promise<{ resignation: EmployeeResignation; impact: ResignationImpact }> {
  if (!UUID.test(employeeId)) throw httpError(404, 'Employee not found');

  // The calendar date in Karachi, not the business date: someone who resigns at
  // 00:30 has resigned today, although the trading day is still yesterday's.
  const today = karachiDateStr();
  if (input.resignationDate > today) {
    throw httpError(400, 'The resignation date cannot be in the future. Record it on the day it takes effect.');
  }

  let row: Record<string, unknown> | undefined;
  try {
    await getPrisma().$transaction(async (tx) => {
      const employee = await lockEmployee(tx, employeeId);

      const [live] = await tx.$queryRawUnsafe<{ resignation_date: string }[]>(
        `select to_char(resignation_date, 'YYYY-MM-DD') as resignation_date
           from public.employee_resignations
          where employee_id = $1::uuid and status = 'recorded'`,
        employeeId,
      );
      if (live) throw httpError(409, alreadyResigned(employee.name, live.resignation_date));

      if (employee.joined_on && input.resignationDate < employee.joined_on) {
        throw httpError(
          400,
          `The resignation date cannot be before ${employee.name}'s joining date (${niceDate(employee.joined_on)}).`,
        );
      }

      [row] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `insert into public.employee_resignations as r
           (employee_id, employee_code, employee_name, resignation_date, resignation_time,
            reason, remarks, submitted_by, submitted_by_name)
         values ($1::uuid, $2, $3, $4::date, $5::time, $6, $7, $8::uuid, $9)
         returning ${RESIGNATION_COLUMNS}`,
        employeeId,
        employee.employee_code,
        employee.name,
        input.resignationDate,
        input.resignationTime,
        input.reason,
        input.remarks?.trim() || null,
        actor.uid,
        actor.name,
      );

      // The existing employment model has one status: active or not.
      await tx.$executeRawUnsafe(
        'update public.finance_employees set is_active = false where id = $1::uuid',
        employeeId,
      );
    });
  } catch (err) {
    if ((err as { status?: number }).status) throw err;
    if (toDbError(err).code === '23505' || /23505|employee_resignations_one_live_idx/.test(String((err as Error)?.message))) {
      throw httpError(409, 'A resignation is already recorded for this employee.');
    }
    throw err;
  }

  const resignation = rowToApi<EmployeeResignation>(row!);
  return { resignation, impact: await resignationImpact(employeeId, resignationMonth(resignation)) };
}

function alreadyResigned(name: string, date: string): string {
  return (
    `A resignation is already recorded for ${name} (${niceDate(date)}). ` +
    'Cancel it first if it is wrong; a second resignation cannot be added.'
  );
}

/**
 * The payslips a resignation leaves in question: already approved for a later
 * month (kept, flagged), or still waiting for approval for one (kept, and no
 * longer approvable). Read, never changed.
 */
export async function resignationImpact(employeeId: string, lastMonth: string): Promise<ResignationImpact> {
  const rows = await getPrisma().$queryRawUnsafe<
    { salary_no: string; salary_month: string; counted: boolean; counted_amount: string; net_salary: string }[]
  >(
    `select salary_no, salary_month, counted,
            counted_amount::text as counted_amount, net_salary::text as net_salary
       from public.salary_ledger_payments
      where employee_id = $1::uuid
        and salary_month > $2
        and (counted or status in ('draft', 'pending_approval'))
      order by salary_month, salary_no`,
    employeeId,
    lastMonth,
  );

  const impact: ResignationImpact = { approvedAfter: [], pendingAfter: [] };
  for (const r of rows) {
    if (r.counted) {
      impact.approvedAfter.push({ salaryNo: r.salary_no, salaryMonth: r.salary_month, amount: Number(r.counted_amount) });
    } else {
      impact.pendingAfter.push({ salaryNo: r.salary_no, salaryMonth: r.salary_month, amount: Number(r.net_salary) });
    }
  }
  return impact;
}

/**
 * Cancel a resignation that was recorded in error.
 *
 * The row is kept, marked cancelled with who, when and why, and the employee is
 * active again. Correcting a date or a reason is this followed by recording the
 * right one, which leaves both records in the history.
 */
export async function cancelResignation(
  employeeId: string,
  input: CancelResignationInput,
  actor: { uid: string; name: string },
): Promise<EmployeeResignation> {
  if (!UUID.test(employeeId)) throw httpError(404, 'Employee not found');

  let row: Record<string, unknown> | undefined;
  await getPrisma().$transaction(async (tx) => {
    await lockEmployee(tx, employeeId);

    [row] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `update public.employee_resignations as r
          set status = 'cancelled',
              cancelled_by = $2::uuid,
              cancelled_by_name = $3,
              cancelled_at = now(),
              cancel_reason = $4
        where r.employee_id = $1::uuid and r.status = 'recorded'
        returning ${RESIGNATION_COLUMNS}`,
      employeeId,
      actor.uid,
      actor.name,
      input.reason,
    );
    if (!row) throw httpError(409, 'This employee has no recorded resignation to cancel.');

    await tx.$executeRawUnsafe(
      'update public.finance_employees set is_active = true where id = $1::uuid',
      employeeId,
    );
  });

  return rowToApi<EmployeeResignation>(row!);
}
