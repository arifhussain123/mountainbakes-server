import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateUserSchema, UpdateUserSchema, AdminResetPasswordSchema, type User } from '../shared';
import { generateTempPassword } from '../utils/password';
import { logAudit, resolveAdminName } from '../services/audit.service';
import { notify } from '../services/push.service';
import { rowToApi } from '../utils/case';

export const router = Router();

// All user routes require super_admin
router.use(authenticate, requireRole('super_admin'));

/** Merge a claims patch onto a user's existing app_metadata (role/branch preserved). */
async function mergeClaims(uid: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(uid);
  if (error || !data.user) throw error ?? new Error('User not found');
  const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(uid, {
    app_metadata: { ...(data.user.app_metadata ?? {}), ...patch },
  });
  if (updErr) throw updErr;
}

/** Read one users row, or null. Shared by the paths that need the target's details. */
async function getUserRow(id: string): Promise<User | null> {
  const { data, error } = await supabaseAdmin.from('users').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? rowToApi<User>(data) : null;
}

// GET /api/users/activity — audit log feed (most recent first). Declared before
// '/:id' so it isn't captured as a user id.
router.get('/activity', async (_req: AuthRequest, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
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

    let query = supabaseAdmin.from('users').select('*').order('created_at', { ascending: false });
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
      const { data: branch, error: branchErr } = await supabaseAdmin
        .from('branches')
        .select('name')
        .eq('id', branchId)
        .maybeSingle();
      if (branchErr) throw branchErr;
      if (!branch) { res.status(400).json({ error: 'Branch not found' }); return; }
      branchName = branch.name as string;
    }

    // Create the Supabase Auth user with role/branch in app_metadata.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { displayName },
      app_metadata: { role, branchId: branchId ?? null, branchName },
    });
    if (createErr || !created.user) throw createErr ?? new Error('Failed to create user');
    const uid = created.user.id;

    // public.users.id is FK → auth.users.id, so the row must follow the auth user.
    // created_at / updated_at come from column defaults and the users_touch
    // trigger — do not set them here.
    const { error: rowErr } = await supabaseAdmin.from('users').insert({
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
      // Roll the auth user back. Without this an orphaned auth account keeps the
      // email (auth.users.email is unique), so the admin could never retry the
      // same address — and the account would exist with no profile row.
      await supabaseAdmin.auth.admin.deleteUser(uid).catch((e) =>
        console.error(`[users] orphaned auth user ${uid} — profile insert failed and cleanup did too`, e),
      );
      if (rowErr.code === '23505') {
        res.status(409).json({ error: 'That email or username is already taken' });
        return;
      }
      throw rowErr;
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

    // If role or branchId changed, the JWT claims must move with them — the RLS
    // policies and middleware/auth.ts both read role/branch from app_metadata.
    if (updates['role'] !== undefined || updates['branchId'] !== undefined) {
      let branchName = current.branchName ?? null;

      if (updates['branchId'] !== undefined) {
        branchName = null;
        if (updates['branchId']) {
          const { data: branch, error: branchErr } = await supabaseAdmin
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

      await mergeClaims(id, {
        role: updates['role'] ?? current.role,
        branchId: updates['branchId'] !== undefined ? updates['branchId'] || null : current.branchId,
        branchName,
      });
    }

    if (Object.keys(patch).length > 0) {
      // updated_at is maintained by the users_touch trigger — do not set it here.
      const { error } = await supabaseAdmin.from('users').update(patch).eq('id', id);
      if (error) {
        if (error.code === '23505') {
          res.status(409).json({ error: 'That email or username is already taken' });
          return;
        }
        throw error;
      }
    }

    // Keep the auth user's display name in step with the profile row.
    if (updates['displayName']) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
        user_metadata: { displayName: updates['displayName'] },
      });
      if (error) throw error;
    }

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

// DELETE /api/users/:id — soft delete (deactivate)
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const target = await getUserRow(id);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }

    const { error: rowErr } = await supabaseAdmin.from('users').update({ status: 'inactive' }).eq('id', id);
    if (rowErr) throw rowErr;

    // Ban the auth user (~100 years) to block sign-in. 'none' re-enables.
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: '876000h' });
    if (error) throw error;

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

    const { error: rowErr } = await supabaseAdmin.from('users').update({ status: 'active' }).eq('id', id);
    if (rowErr) throw rowErr;

    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: 'none' });
    if (error) throw error;

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

// POST /api/users/:id/reset-password — Super Admin resets another user's password
router.post('/:id/reset-password', validate(AdminResetPasswordSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { generateTemp, sendEmail, forceChange } = req.body as {
      generateTemp: boolean; sendEmail: boolean; forceChange: boolean;
    };

    const target = await getUserRow(id);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }

    let tempPassword: string | null = null;
    if (generateTemp) {
      tempPassword = generateTempPassword();
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password: tempPassword });
      if (error) throw error;
    }

    if (forceChange) {
      await mergeClaims(id, { mustChangePassword: true });
    }

    const adminName = await resolveAdminName(req.user!.uid, req.user!.email);
    const { error: rowErr } = await supabaseAdmin
      .from('users')
      .update({
        must_change_password: forceChange ? true : (target.mustChangePassword ?? false),
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

    res.json({ success: true, tempPassword, email: sendEmail ? target.email : null });
  } catch (err) {
    next(err);
  }
});
