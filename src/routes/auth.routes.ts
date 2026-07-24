import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { ForgotPasswordSchema, StrongPasswordSchema } from '../shared';
import { logAudit } from '../services/audit.service';

export const router = Router();

// ─── Password recovery (PUBLIC — user is logged out) ──────────────────────────
// Admin accounts only. Returns { allowed: true } so the client may then trigger
// Supabase's built-in reset email; non-admin / unknown emails get a 403 with a
// fixed message (we never confirm whether a non-admin email exists).
router.post('/forgot-password', async (req, res, next) => {
  try {
    const parsed = ForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }

    // Role is read from the `users` table. Unknown emails resolve to undefined —
    // treated the same as a non-admin, so this endpoint never reveals whether a
    // given address exists. maybeSingle() returns null rather than erroring on
    // no match, which keeps that indistinguishable from a genuine lookup failure.
    let role: string | undefined;
    try {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('role')
        .eq('email', parsed.data.email)
        .maybeSingle();
      role = error ? undefined : (data?.role ?? undefined);
    } catch {
      role = undefined;
    }

    if (role !== 'super_admin') {
      res.status(403).json({
        error: 'Password recovery is only available for Administrator accounts. Please contact your system administrator.',
        code: 'not-admin',
      });
      return;
    }

    res.json({ allowed: true });
  } catch (err) {
    next(err);
  }
});

// ─── Change own password (any authenticated user) ─────────────────────────────
// Used by the forced "Change Password" screen. Clears the must-change flag.
router.post('/change-password', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const parsed = z.object({ newPassword: StrongPasswordSchema }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Password does not meet the requirements', details: parsed.error.errors });
      return;
    }

    const uid = req.user!.uid;

    // Set the new password and clear mustChangePassword, preserving the other
    // app_metadata claims (role / branch).
    const { data: current, error: getErr } = await supabaseAdmin.auth.admin.getUserById(uid);
    if (getErr || !current.user) throw getErr ?? new Error('User not found');

    const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(uid, {
      password: parsed.data.newPassword,
      app_metadata: { ...(current.user.app_metadata ?? {}), mustChangePassword: false },
    });
    if (updErr) throw updErr;

    // Mirror the cleared flag onto the users row. Deliberately best-effort: the
    // password has already been changed in Auth by this point, so a failure here
    // must not fail the request. app_metadata (above) is what the app actually
    // gates on; this row is the reporting copy. The supabase-js client returns
    // errors rather than throwing, so the error is discarded explicitly.
    // updated_at is maintained by the users_touch trigger — do not set it here.
    await supabaseAdmin
      .from('users')
      .update({ must_change_password: false })
      .eq('id', uid);

    await logAudit({
      action: 'password_changed',
      adminId: uid,
      adminName: req.user!.email,
      targetUserId: uid,
      targetUserName: req.user!.email,
      targetUserRole: req.user!.role,
      details: 'User changed their own password',
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Set app_metadata claims (role + branch) on a Supabase Auth user
router.post('/set-custom-claims', authenticate, requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { uid, role, branchId, branchName } = req.body as {
      uid: string;
      role: string;
      branchId: string | null;
      branchName: string | null;
    };

    if (!uid || !role) {
      res.status(400).json({ error: 'uid and role are required' });
      return;
    }

    const { data: current, error: getErr } = await supabaseAdmin.auth.admin.getUserById(uid);
    if (getErr || !current.user) throw getErr ?? new Error('User not found');

    const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(uid, {
      app_metadata: {
        ...(current.user.app_metadata ?? {}),
        role,
        branchId: branchId ?? null,
        branchName: branchName ?? null,
      },
    });
    if (updErr) throw updErr;

    res.json({ success: true, message: 'Custom claims set successfully' });
  } catch (err) {
    next(err);
  }
});

// Get current user info from token
router.get('/me', authenticate, async (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

// Reset user password (admin only)
router.post('/reset-password', authenticate, requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { uid, newPassword } = req.body as { uid: string; newPassword: string };
    const { error } = await supabaseAdmin.auth.admin.updateUserById(uid, { password: newPassword });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
