import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireFinance } from '../middleware/requireFinance';
import { validate } from '../middleware/validate';
import {
  ApproveSchema,
  CancelResignationSchema,
  CreateEmployeeAdvanceSchema,
  CreateEmployeeSchema,
  CreateSalaryPaymentSchema,
  CreateSalaryRevisionSchema,
  RecordResignationSchema,
  RejectSchema,
  SalaryLedgerPaymentsQuerySchema,
  SalaryLedgerQuerySchema,
  UpdateEmployeeAdvanceSchema,
  UpdateEmployeeSchema,
  UpdateSalaryPaymentSchema,
  type FinanceDocStatus,
} from '../shared';
import {
  approveEmployeeAdvance,
  approveSalaryPayment,
  createEmployee,
  createEmployeeAdvance,
  createSalaryPayment,
  getEmployeeAdvance,
  getEmployeeAdvanceSummary,
  getSalaryPayment,
  listEmployeeAdvances,
  listEmployees,
  listSalaryPayments,
  listSalaryRevisions,
  rejectEmployeeAdvance,
  rejectSalaryPayment,
  reviseEmployeeSalary,
  submitEmployeeAdvance,
  submitSalaryPayment,
  updateEmployee,
  updateEmployeeAdvance,
  updateSalaryPayment,
  type AdvanceQuery,
  type SalaryQuery,
} from '../services/finance-payroll.service';
import { auditSnapshot, logFinanceAudit } from '../services/finance-audit.service';
import { getEmployeeProfile, getSalaryLedger, getSalaryLedgerPayments } from '../services/finance-ledgers.service';
import { cancelResignation, recordResignation } from '../services/finance-resignations.service';

/**
 * /api/finance/payroll — the employee master and the salary ledger.
 *
 * Employees are `configure`-level: adding someone to the payroll master is a
 * standing commitment, not a per-transaction act, and it belongs with the other
 * things only a Finance Admin sets up. Individual payslips and advances are
 * `create` / `approve` like every other document.
 */

export const router = Router();

router.use(authenticate);

function actorOf(req: AuthRequest): { uid: string; name: string } {
  return { uid: req.user!.uid, name: req.user!.email };
}

// ---------------------------------------------------------------------------
// Salary Ledger — read only
//
// Two GETs and nothing else. There is no POST, PUT, PATCH or DELETE under
// /ledger: a figure on the ledger exists because a payslip was approved, and
// the only way to change it is through that payslip (/salaries, below).
// ---------------------------------------------------------------------------

/** GET /api/finance/payroll/ledger?year= — employee × month, approved salary only. */
router.get('/ledger', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json({ ledger: await getSalaryLedger(SalaryLedgerQuerySchema.parse(req.query)) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/finance/payroll/ledger/payments — the payslips behind a cell, an employee or a year. */
router.get('/ledger/payments', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json(await getSalaryLedgerPayments(SalaryLedgerPaymentsQuerySchema.parse(req.query)));
  } catch (err) {
    next(err);
  }
});

/**
 * Anything else aimed at the ledger — a POST, a PUT, a DELETE — is refused by
 * name rather than left to fall through to whichever route happens to match.
 */
router.all(['/ledger', '/ledger/*'], (_req, res) => {
  res.set('Allow', 'GET').status(405).json({
    error: 'This ledger is read-only. Create and approve records through their own page.',
  });
});

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

router.get('/employees', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const employees = await listEmployees({
      department: (req.query['department'] as string) || undefined,
      includeInactive: req.query['includeInactive'] === 'true',
      search: (req.query['search'] as string) || undefined,
    });
    res.json({ employees, total: employees.length });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/employees',
  requireFinance('configure'),
  validate(CreateEmployeeSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const employee = await createEmployee(req.body);
      await logFinanceAudit(req, {
        entity: 'employee',
        entityId: employee.id,
        entityRef: employee.employeeCode,
        action: 'created',
        newValues: auditSnapshot(employee as unknown as Record<string, unknown>, [
          'name', 'department', 'designation', 'baseSalary', 'branchName',
        ]),
      });
      res.status(201).json({ employee });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/employees/:id',
  requireFinance('configure'),
  validate(UpdateEmployeeSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = (await listEmployees({ includeInactive: true })).find((e) => e.id === id);
      const employee = await updateEmployee(id, req.body);

      await logFinanceAudit(req, {
        entity: 'employee',
        entityId: id,
        entityRef: employee.employeeCode,
        action: 'updated',
        previousValues: before
          ? auditSnapshot(before as unknown as Record<string, unknown>, ['name', 'department', 'designation', 'isActive'])
          : null,
        newValues: auditSnapshot(employee as unknown as Record<string, unknown>, ['name', 'department', 'designation', 'isActive']),
      });

      res.json({ employee });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/finance/payroll/employees/:id — biodata, resignation history, last approved salary. */
router.get('/employees/:id', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json({ profile: await getEmployeeProfile(String(req.params['id'])) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/finance/payroll/employees/:id/resignation
 *
 * `configure`, like every other change to the payroll master. The employee is
 * the one in the path and the recorder is the signed-in user; the body carries
 * only the date, the time and the reason.
 */
router.post(
  '/employees/:id/resignation',
  requireFinance('configure'),
  validate(RecordResignationSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const { resignation, impact } = await recordResignation(id, req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'employee',
        entityId: id,
        entityRef: resignation.employeeCode,
        action: 'resigned',
        previousValues: { isActive: true },
        newValues: {
          isActive: false,
          resignationId: resignation.id,
          employeeName: resignation.employeeName,
          resignationDate: resignation.resignationDate,
          resignationTime: resignation.resignationTime,
          reason: resignation.reason,
          remarks: resignation.remarks,
          // What was left standing, so the trail shows it was seen.
          approvedAfter: impact.approvedAfter.map((p) => p.salaryNo),
          pendingAfter: impact.pendingAfter.map((p) => p.salaryNo),
        },
      });
      const { employee } = await getEmployeeProfile(id);
      res.status(201).json({ resignation, impact, employee });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/finance/payroll/employees/:id/resignation/cancel — keeps the record, marks it cancelled. */
router.post(
  '/employees/:id/resignation/cancel',
  requireFinance('configure'),
  validate(CancelResignationSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const resignation = await cancelResignation(id, req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'employee',
        entityId: id,
        entityRef: resignation.employeeCode,
        action: 'resignation_cancelled',
        previousValues: {
          isActive: false,
          resignationDate: resignation.resignationDate,
          reason: resignation.reason,
        },
        newValues: { isActive: true, resignationId: resignation.id, cancelReason: resignation.cancelReason },
      });
      const { employee } = await getEmployeeProfile(id);
      res.json({ resignation, employee });
    } catch (err) {
      next(err);
    }
  },
);

router.get('/employees/:id/salary-revisions', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const revisions = await listSalaryRevisions(String(req.params['id']));
    res.json({ revisions, total: revisions.length });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/employees/:id/salary-revisions',
  requireFinance('configure'),
  validate(CreateSalaryRevisionSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const { employee, revision } = await reviseEmployeeSalary(id, req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'employee',
        entityId: id,
        entityRef: employee.employeeCode,
        action: 'salary_revised',
        previousValues: { baseSalary: revision.previousSalary },
        newValues: { baseSalary: revision.newSalary, reason: revision.reason, effectiveFrom: revision.effectiveFrom },
      });
      res.status(201).json({ employee, revision });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Salary payments
// ---------------------------------------------------------------------------

router.get('/salaries', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const { salaries, total } = await listSalaryPayments({
      status: (q['status'] as FinanceDocStatus | 'pending') || undefined,
      salaryMonth: q['salaryMonth'],
      employeeId: q['employeeId'],
      department: q['department'],
      search: q['search'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
      sortBy: q['sortBy'] as SalaryQuery['sortBy'],
      sortDir: q['sortDir'] as SalaryQuery['sortDir'],
    });
    res.json({ salaries, total });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/salaries',
  requireFinance('create'),
  validate(CreateSalaryPaymentSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const salary = await createSalaryPayment(req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'salary_payment',
        entityId: salary.id,
        entityRef: salary.salaryNo,
        action: 'created',
        newValues: {
          ...auditSnapshot(salary as unknown as Record<string, unknown>, [
            'employeeName', 'salaryMonth', 'grossSalary', 'bonus', 'deductions', 'netSalary', 'status',
          ]),
          // Which advances this payslip settled is exactly the question an
          // auditor asks about a deduction, and it is not recoverable from the
          // figures alone once the advance rows have moved on.
          recoveredAdvanceIds: req.body.recoverAdvanceIds ?? [],
        },
      });
      res.status(201).json({ salary });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/salaries/:id',
  requireFinance('create'),
  validate(UpdateSalaryPaymentSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = await getSalaryPayment(id);
      const salary = await updateSalaryPayment(id, req.body);

      await logFinanceAudit(req, {
        entity: 'salary_payment',
        entityId: id,
        entityRef: salary.salaryNo,
        action: 'updated',
        previousValues: before
          ? auditSnapshot(before as unknown as Record<string, unknown>, ['grossSalary', 'bonus', 'deductions', 'netSalary', 'paymentDate', 'status'])
          : null,
        newValues: auditSnapshot(salary as unknown as Record<string, unknown>, ['grossSalary', 'bonus', 'deductions', 'netSalary', 'paymentDate', 'status']),
      });

      res.json({ salary });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/salaries/:id/submit', requireFinance('create'), async (req: AuthRequest, res, next) => {
  try {
    const salary = await submitSalaryPayment(String(req.params['id']));
    await logFinanceAudit(req, {
      entity: 'salary_payment',
      entityId: salary.id,
      entityRef: salary.salaryNo,
      action: 'submitted',
      newValues: { netSalary: salary.netSalary, status: salary.status },
    });
    res.json({ salary });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/salaries/:id/approve',
  requireFinance('approve'),
  validate(ApproveSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { document, entry } = await approveSalaryPayment(String(req.params['id']), actorOf(req), req.body.notes);
      await logFinanceAudit(req, {
        entity: 'salary_payment',
        entityId: document.id,
        entityRef: document.salaryNo,
        action: 'approved',
        newValues: {
          employeeName: document.employeeName,
          salaryMonth: document.salaryMonth,
          netSalary: document.netSalary,
          voucherNo: entry.voucherNo,
        },
      });
      res.json({ salary: document, ledgerEntry: entry });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/salaries/:id/reject',
  requireFinance('approve'),
  validate(RejectSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const salary = await rejectSalaryPayment(String(req.params['id']), req.body.reason, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'salary_payment',
        entityId: salary.id,
        entityRef: salary.salaryNo,
        action: 'rejected',
        newValues: { reason: req.body.reason, employeeName: salary.employeeName, netSalary: salary.netSalary },
      });
      res.json({ salary });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Employee advances
//
// A separate resource from /salaries rather than a mode of it: an advance is its
// own document with its own approval, and the only thing the two share is the
// employee and the head they post to.
// ---------------------------------------------------------------------------

router.get('/advances', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const { advances, total } = await listEmployeeAdvances({
      status: (q['status'] as FinanceDocStatus | 'pending') || undefined,
      employeeId: q['employeeId'],
      department: q['department'],
      from: q['from'],
      to: q['to'],
      salaryId: q['salaryId'],
      outstandingOnly: q['outstandingOnly'] === 'true',
      search: q['search'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
      sortBy: q['sortBy'] as AdvanceQuery['sortBy'],
      sortDir: q['sortDir'] as AdvanceQuery['sortDir'],
    });
    res.json({ advances, total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/finance/payroll/employees/:id/advance-summary — the "Previous
 * payment" panel, and what the payslip form prefills Bonus and Deduction from.
 */
router.get('/employees/:id/advance-summary', requireFinance('view'), async (req: AuthRequest, res, next) => {
  try {
    res.json({ summary: await getEmployeeAdvanceSummary(String(req.params['id'])) });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/advances',
  requireFinance('create'),
  validate(CreateEmployeeAdvanceSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const advance = await createEmployeeAdvance(req.body, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'employee_advance',
        entityId: advance.id,
        entityRef: advance.advanceNo,
        action: 'created',
        newValues: auditSnapshot(advance as unknown as Record<string, unknown>, [
          'employeeName', 'businessDate', 'advanceAmount', 'bonusAmount', 'loanAmount', 'totalAmount', 'status',
        ]),
      });
      res.status(201).json({ advance });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/advances/:id',
  requireFinance('create'),
  validate(UpdateEmployeeAdvanceSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const id = String(req.params['id']);
      const before = await getEmployeeAdvance(id);
      const advance = await updateEmployeeAdvance(id, req.body);

      const fields = ['advanceAmount', 'bonusAmount', 'loanAmount', 'totalAmount', 'businessDate', 'status'];
      await logFinanceAudit(req, {
        entity: 'employee_advance',
        entityId: id,
        entityRef: advance.advanceNo,
        action: 'updated',
        previousValues: before ? auditSnapshot(before as unknown as Record<string, unknown>, fields) : null,
        newValues: auditSnapshot(advance as unknown as Record<string, unknown>, fields),
      });

      res.json({ advance });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/advances/:id/submit', requireFinance('create'), async (req: AuthRequest, res, next) => {
  try {
    const advance = await submitEmployeeAdvance(String(req.params['id']));
    await logFinanceAudit(req, {
      entity: 'employee_advance',
      entityId: advance.id,
      entityRef: advance.advanceNo,
      action: 'submitted',
      newValues: { totalAmount: advance.totalAmount, status: advance.status },
    });
    res.json({ advance });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/advances/:id/approve',
  requireFinance('approve'),
  validate(ApproveSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const { document, entry } = await approveEmployeeAdvance(String(req.params['id']), actorOf(req), req.body.notes);
      await logFinanceAudit(req, {
        entity: 'employee_advance',
        entityId: document.id,
        entityRef: document.advanceNo,
        action: 'approved',
        newValues: {
          employeeName: document.employeeName,
          businessDate: document.businessDate,
          totalAmount: document.totalAmount,
          voucherNo: entry.voucherNo,
        },
      });
      res.json({ advance: document, ledgerEntry: entry });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/advances/:id/reject',
  requireFinance('approve'),
  validate(RejectSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const advance = await rejectEmployeeAdvance(String(req.params['id']), req.body.reason, actorOf(req));
      await logFinanceAudit(req, {
        entity: 'employee_advance',
        entityId: advance.id,
        entityRef: advance.advanceNo,
        action: 'rejected',
        newValues: { reason: req.body.reason, employeeName: advance.employeeName, totalAmount: advance.totalAmount },
      });
      res.json({ advance });
    } catch (err) {
      next(err);
    }
  },
);
