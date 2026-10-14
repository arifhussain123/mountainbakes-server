import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { dbFor } from '../db';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateUserSchema, UpdateUserSchema, AdminResetPasswordSchema, ChangeUserEmailSchema, type User } from '../shared';
import { generateTempPassword } from '../utils/password';
import { logAudit, resolveAdminName } from '../services/audit.service';
import {
  RESET_TOKEN_TTL_MINUTES,
  createCredentials,
  createPasswordResetToken,
  setPassword,
  signOutEverywhere,
} from '../services/auth/auth.service';
import { MailNotConfiguredError, sendPasswordResetEmail } from '../services/mailer';
import { notify } from '../services/push.service';
import { changeUserEmail } from '../services/user-email.service';
import { rowToApi } from '../utils/case';

const db = dbFor('users');

export const router = Router();

// All user routes require super_admin
router.use(authenticate, requireRole('super_admin'));

/** Read one users row, or null. Shared by the paths that need the target's details. */
async function getUserRow(id: string): Promise<User | null> {
  const { data, error } = await db.from('users').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? rowToApi<User>(data) : null;
}

// GET /api/users/activity — audit log feed (most recent first). Declared before
// '/:id' so it isn't captured as a user id.
router.get('/activity', async (_req: AuthRequest, res, next) => {
  try {
    const { data, error } = await db
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ logs: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

// GET /api/users
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { status, role } = req.query;

    let query = db.from('users').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (role) query = query.eq('role', role);

    const { data, error } = await query;
    if (error) throw error;

    const users = rowToApi<Record<string, unknown>[]>(data ?? []);
    res.json({ users, total: users.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const user = await getUserRow(req.params['id']!);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/users
router.post('/', validate(CreateUserSchema), async (req: AuthRequest, res, next) => {
  try {
    const { email, displayName, phone, username, password, role, branchId } = req.body;

    // branch_name is a denormalised cache of branches.name.
    let branchName: string | null = null;
    if (branchId) {
      const { data: branch, error: branchErr } = await db
        .from('branches')
        .select('name')
        .eq('id', branchId)
        .maybeSingle();
      if (branchErr) throw branchErr;
      if (!branch) { res.status(400).json({ error: 'Branch not found' }); return; }
      branchName = branch.name as string;
    }

    const uid = randomUUID();

    // created_at / updated_at come from column defaults and the users_touch
    // trigger — do not set them here.
    const { error: rowErr } = await db.from('users').insert({
      id: uid,
      email,
      display_name: displayName,
      phone,
      username,
      role,
      branch_id: branchId ?? null,
      branch_name: branchName,
      status: 'active',
    });

    if (rowErr) {
      if (rowErr.code === '23505') {
        res.status(409).json({ error: 'That email or username is already taken' });
        return;
      }
      throw rowErr;
    }

    // The password is stored after the row because it references it. If that
    // fails the row is taken back out: an account nobody can sign in to would
    // otherwise hold the email, and the admin could not retry the same address.
    try {
      await createCredentials(uid, password);
    } catch (err) {
      const { error: undoErr } = await db.from('users').delete().eq('id', uid);
      if (undoErr) console.error(`[users] ${uid} was created without a password and could not be removed`, undoErr.message);
      throw err;
    }

    await logAudit({
      action: 'user_created',
      adminId: req.user!.uid,
      adminName: await resolveAdminName(req.user!.uid, req.user!.email),
      targetUserId: uid,
      targetUserName: displayName,
      targetUserRole: role,
    });

    res.status(201).json({ id: uid, email, displayName, role });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id
router.put('/:id', validate(UpdateUserSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const updates = req.body as Record<string, unknown>;

    const current = await getUserRow(id);
    if (!current) { res.status(404).json({ error: 'User not found' }); return; }

    // Build the row patch explicitly rather than spreading the body, so only
    // known columns are ever written.
    const patch: Record<string, unknown> = {};
    if (updates['displayName'] !== undefined) patch['display_name'] = updates['displayName'];
    if (updates['phone'] !== undefined) patch['phone'] = updates['phone'];
    if (updates['username'] !== undefined) patch['username'] = updates['username'];
    if (updates['role'] !== undefined) patch['role'] = updates['role'];
    if (updates['status'] !== undefined) patch['status'] = updates['status'];

    // branch_name is a denormalised cache of branches.name and moves with it.
    if (updates['branchId'] !== undefined) {
      let branchName: string | null = null;
      if (updates['branchId']) {
        const { data: branch, error: branchErr } = await db
          .from('branches')
          .select('name')
          .eq('id', updates['branchId'] as string)
          .maybeSingle();
        if (branchErr) throw branchErr;
        if (!branch) { res.status(400).json({ error: 'Branch not found' }); return; }
        branchName = branch.name as string;
      }
      patch['branch_id'] = updates['branchId'] || null;
      patch['branch_name'] = branchName;
    }

    if (Object.keys(patch).length > 0) {
      // updated_at is maintained by the users_touch trigger — do not set it here.
      const { error } = await db.from('users').update(patch).eq('id', id);
      if (error) {
        if (error.code === '23505') {
          res.status(409).json({ error: 'That email or username is already taken' });
          return;
        }
        throw error;
      }
    }

    // A status change made here rather than through DELETE /:id: an account
    // that is no longer active is signed out everywhere it is signed in.
    if (updates['status'] !== undefined && updates['status'] !== 'active') await signOutEverywhere(id);

    const updated = await getUserRow(id);
    await logAudit({
      action: 'user_updated',
      adminId: req.user!.uid,
      adminName: await resolveAdminName(req.user!.uid, req.user!.email),
      targetUserId: id,
      targetUserName: updated?.displayName ?? null,
      targetUserRole: updated?.role ?? null,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id/permanent — remove the account for good (the row, its
// password and its sessions). Business records keep their *_name columns and
// lose only the user link (ON DELETE SET NULL); see migration 124. DELETE /:id
// below stays a deactivate because the mobile app calls it for that.
router.delete('/:id/permanent', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    if (id === req.user!.uid) {
      res.status(400).json({ error: 'You cannot delete your own account' });
      return;
    }
    const target = await getUserRow(id);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }

    const adminName = await resolveAdminName(req.user!.uid, req.user!.email);

    const { data: deleted, error } = await db.rpc('delete_user_account', { p_user_id: id });
    if (error) throw error;
    if (!deleted) { res.status(404).json({ error: 'User not found' }); return; }

    // target_user_id stays null — the row it would point at no longer exists.
    await logAudit({
      action: 'user_deleted',
      adminId: req.user!.uid,
      adminName,
      targetUserId: null,
      targetUserName: target.displayName ?? null,
      targetUserRole: target.role ?? null,
      details: `Deleted ${target.email} (id ${id})`,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id — soft delete (deactivate)
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const target = await getUserRow(id);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }

    const { error: rowErr } = await db.from('users').update({ status: 'inactive' }).eq('id', id);
    if (rowErr) throw rowErr;

    // `status` is read on every request, so the update above already keeps the
    // account out; ending its sessions means it cannot renew one either.
    await signOutEverywhere(id);

    await logAudit({
      action: 'user_deactivated',
      adminId: req.user!.uid,
      adminName: await resolveAdminName(req.user!.uid, req.user!.email),
      targetUserId: id,
      targetUserName: target.displayName ?? null,
      targetUserRole: target.role ?? null,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/activate — re-enable a deactivated user
router.post('/:id/activate', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const target = await getUserRow(id);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }

    const { error: rowErr } = await db.from('users').update({ status: 'active' }).eq('id', id);
    if (rowErr) throw rowErr;

    await logAudit({
      action: 'user_activated',
      adminId: req.user!.uid,
      adminName: await resolveAdminName(req.user!.uid, req.user!.email),
      targetUserId: id,
      targetUserName: target.displayName,
      targetUserRole: target.role,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/change-email — a new sign-in address for an existing
// account. The id, branch, password, sessions and every record that points at
// the user stay as they are; history goes on naming the address used at the
// time (see user-email.service, which also writes the audit line, inside the
// same transaction as the change).
router.post('/:id/change-email', validate(ChangeUserEmailSchema), async (req: AuthRequest, res, next) => {
  try {
    const { email, reason } = req.body as { email: string; reason?: string };
    const result = await changeUserEmail({
      user: { id: req.params['id']! },
      to: email,
      records: 'keep',
      apply: true,
      actor: { id: req.user!.uid, name: await resolveAdminName(req.user!.uid, req.user!.email) },
      reason,
    });

    res.json({ success: true, id: result.userId, email: result.to, previousEmail: result.from });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/reset-password — Super Admin resets another user's password
router.post('/:id/reset-password', validate(AdminResetPasswordSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { generateTemp, sendEmail, forceChange } = req.body as {
      generateTemp: boolean; sendEmail: boolean; forceChange: boolean;
    };

    const target = await getUserRow(id);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }

    const mustChange = forceChange ? true : (target.mustChangePassword ?? false);

    let tempPassword: string | null = null;
    if (generateTemp) {
      tempPassword = generateTempPassword();
      await setPassword(id, tempPassword, { mustChange });
    }

    // The reset link, mailed by the API.
    //
    // A link that could not be sent is REPORTED, not thrown: any temporary
    // password above has already been set, and failing the request here would
    // leave the administrator with a changed password they were never shown.
    let emailSent = false;
    let emailError: string | null = null;
    if (sendEmail) {
      try {
        const token = await createPasswordResetToken(id);
        await sendPasswordResetEmail(target.email, token, RESET_TOKEN_TTL_MINUTES);
        emailSent = true;
      } catch (err) {
        console.error('[users] reset email could not be sent', err instanceof Error ? err.message : err);
        emailError = err instanceof MailNotConfiguredError ? err.message : 'The reset email could not be sent.';
      }
    }

    const adminName = await resolveAdminName(req.user!.uid, req.user!.email);
    const { error: rowErr } = await db
      .from('users')
      .update({
        must_change_password: mustChange,
        last_password_reset: new Date().toISOString(),
        password_reset_by: req.user!.uid,
        password_reset_by_name: adminName,
      })
      .eq('id', id);
    if (rowErr) throw rowErr;

    const details = [
      generateTemp && 'temporary password',
      sendEmail && 'reset email',
      forceChange && 'force change on next login',
    ].filter(Boolean).join(', ');

    await logAudit({
      action: 'password_reset',
      adminId: req.user!.uid,
      adminName,
      targetUserId: id,
      targetUserName: target.displayName,
      targetUserRole: target.role,
      details,
    });

    // Notify the affected user. 'password_reset' was missing from the
    // notification_type enum until migration 14 — see that file.
    await notify({
      type: 'password_reset',
      title: 'Password Reset',
      message: forceChange
        ? 'An administrator reset your password. You will be asked to set a new one at next login.'
        : 'An administrator reset your password.',
      targetUserId: id,
    });

    res.json({ success: true, tempPassword, email: sendEmail ? target.email : null, emailSent, emailError });
  } catch (err) {
    next(err);
  }
});
