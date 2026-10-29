import { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';
import { financeCan, financeCanReview, financeHelpDeskCan, isFinanceRole, type FinancePermission } from '../shared';
import { getFinanceSettings } from '../services/finance-settings.service';

/**
 * Authorise a Finance Ledger request.
 *
 * This is `requireRole` one level up: the finance module's rules are not "which
 * role are you" but "which role are you AND what is this endpoint about". A
 * Finance Manager may approve a partner expense but not rewrite the share
 * percentages; an Accountant may raise the expense but not approve it; a Read
 * Only Auditor may see all of it and touch none of it.
 *
 * Super Admin is the interesting case and the reason this reads settings. The
 * brief says Admin may view reports but not modify finance records "unless
 * granted permission" — so `view` always passes for a super admin, and every
 * other permission is gated on the `allowSuperAdminWrite` toggle in Finance
 * Settings (off by default). That toggle is read per request rather than
 * captured at boot so revoking the grant takes effect immediately; the settings
 * read is served from the same 60-second in-process cache the rest of the app
 * uses, so it costs no round trip in the common case.
 *
 * Branch managers and production users never match — `financeCan` returns false
 * for them on every permission, including `view`.
 */
export function requireFinance(permission: FinancePermission) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const { allowSuperAdminWrite } = await getFinanceSettings();
      if (!financeCan(req.user.role, permission, allowSuperAdminWrite)) {
        // The message distinguishes "you are not in finance at all" from "you
        // are, but not at this level" — the second is a normal, recoverable
        // situation (ask an approver) and the user deserves to be told which.
        const inModule = req.user.role === 'super_admin' || req.user.role.startsWith('finance_') || req.user.role === 'accountant';
        res.status(403).json({
          error: inModule
            ? `Forbidden: your finance role may not ${permission} finance records.`
            : 'Forbidden: the Finance Ledger is restricted to Finance and Super Admin accounts.',
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Edit and Submit for Approval on an Income & Expense entry or a cash deposit.
 *
 * The Accountant's step alone (`financeCanReview`): Finance Admin and Finance
 * Manager decide what the Accountant sends and do not prepare it themselves, so
 * `requireFinance('create')` — which every one of them passes — is too wide.
 */
export function requireFinanceReviewer() {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!financeCanReview(req.user.role)) {
      res.status(403).json({
        error: 'Forbidden: only the Accountant may edit or submit this for approval. Finance Admin approves or rejects it once it is submitted.',
      });
      return;
    }
    next();
  };
}

/**
 * Administering a Finance Help Desk query — respond, assign, resolve, and change
 * or delete the finance record behind it.
 *
 * THIS IS THE BRIEF'S §6 AND §21, AND IT IS THE ONE PLACE THEY ARE ENFORCED.
 * Only an Admin may change the books through the Help Desk; a Finance user may
 * report, view and discuss. Every control the UI hides is re-decided here from
 * the JWT, because hiding a button is courtesy and refusing the request is the
 * boundary.
 *
 * Deliberately NOT one of the five `FinancePermission`s. Those describe acts on
 * the BOOKS in the ordinary workflow: `configure` is ledger heads and share
 * percentages, `adjust` is reversing a posted entry. Routing the Help Desk
 * through either would overload a permission with a meaning it does not have,
 * and would silently hand query deletion to anyone later granted `configure`
 * for an unrelated reason.
 *
 * TWO THINGS CHANGED IN MIGRATION 94, both deliberate and both worth stating.
 *
 * 1. `finance_admin` NO LONGER PASSES. Migration 60 gave it the queue; §3 of the
 *    brief now says a query must not be sent to another Finance user first, and
 *    a finance_admin is a Finance-module account. Its authority over the books
 *    elsewhere — approving a voucher, posting an entry — is untouched by this;
 *    only the Help Desk moved. A finance_admin raising and discussing queries
 *    still works, through `requireFinance('create')` like every other Finance
 *    role.
 *
 * 2. `allowSuperAdminWrite` IS NOT CONSULTED. That toggle (Finance Settings, off
 *    by default) guards a super admin writing to finance OUTSIDE this queue. The
 *    Help Desk IS the sanctioned channel for those corrections — every one
 *    carries a Query ID, a stated reason and a row in `finance_amendments` — so
 *    gating it on a flag that ships off would leave every query on a fresh
 *    install unanswerable, by the only role the brief names as the answerer.
 *    Keeping the toggle here would not be "safer"; it would be a queue that
 *    silently does not work.
 *
 * `financeHelpDeskCan(role, 'respond')` in the shared types is the same rule for
 * the UI, and the two are meant to be read together.
 */
export function requireFinanceHelpDeskAdmin() {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (financeHelpDeskCan(req.user.role, 'respond')) {
      next();
      return;
    }
    // The message distinguishes "you are in finance, but this is not yours" from
    // "you are not in this module at all" — the first is a normal situation with
    // a normal answer (raise it and an admin will act), and the person deserves
    // to be told which.
    const inModule = isFinanceRole(req.user.role);
    res.status(403).json({
      error: inModule
        ? 'Forbidden: only an Admin may change, resolve or delete a Help Desk query or the ' +
          'finance record behind it. Add a message to the query and an Admin will action it.'
        : 'Forbidden: the Finance Help Desk is restricted to Finance and Admin accounts.',
    });
  };
}

/**
 * Either side of the Help Desk — the one gate for the routes BOTH parties use.
 *
 * The conversation thread (§7, §17) and the reopen request (§12) are not admin
 * actions and not raiser actions; they are the two halves talking to each other,
 * and each route decides from `sideOf(role)` which half is speaking.
 *
 * It exists because `requireFinance('create')` is the wrong gate for them and
 * fails in the direction hardest to notice: `financeCan` grants a super admin
 * nothing but `view` unless `finance_settings.allowSuperAdminWrite` is on, and
 * that toggle ships OFF — so an Admin could read a query and not reply to it on
 * a fresh install. That is the exact failure requireFinanceHelpDeskAdmin's
 * header describes and refuses, and the reasoning is identical here: the Help
 * Desk is the sanctioned, audited channel, so the toggle that guards writing to
 * the books OUTSIDE it has no business closing the thread inside it.
 *
 * A Read Only Auditor is excluded — they see the queue and say nothing into it,
 * the same shape their access takes everywhere else in the module.
 */
export function requireFinanceHelpDeskParticipant() {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { role } = req.user;
    if (financeHelpDeskCan(role, 'respond') || (isFinanceRole(role) && role !== 'finance_auditor')) {
      next();
      return;
    }
    res.status(403).json({
      error: isFinanceRole(role)
        ? 'Forbidden: a Read Only Auditor may view a Help Desk query but not write to it.'
        : 'Forbidden: the Finance Help Desk is restricted to Finance and Admin accounts.',
    });
  };
}

/**
 * The Admin-verifies step in the branch-income workflow.
 *
 *   Branch closing → ADMIN VERIFIES → Finance approves → posted.
 *
 * Deliberately NOT `requireFinance('approve')`, for a reason that would
 * otherwise be a live bug: verification is the brief's *Admin* step, but
 * `allowSuperAdminWrite` defaults to OFF — so routing it through requireFinance
 * would lock the only role the workflow names out of the only step it names for
 * them, and every branch's income would sit at pending_verification forever.
 *
 * Verification moves no money (it advances a row from pending_verification to
 * pending_approval and posts nothing), so it is not a "modification of a finance
 * record" in the sense the toggle guards. Finance Admins and Managers may also
 * verify, so a finance team running without the admin step is not blocked.
 */
export function requireIncomeVerifier() {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const allowed = ['super_admin', 'finance_admin', 'finance_manager'];
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({
        error: 'Forbidden: only a Super Admin, Finance Admin or Finance Manager may verify branch income.',
      });
      return;
    }
    next();
  };
}
