import { Router } from 'express';
import { z } from 'zod';
import { adminDb } from '../config/firebase';
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

    // Role is read from the Firestore users doc (retained this phase). Unknown
    // emails resolve to undefined — treated the same as a non-admin.
    let role: string | undefined;
    try {
      const snap = await adminDb
        .collection('users')
        .where('email', '==', parsed.data.email)
        .limit(1)
        .get();
      role = snap.empty ? undefined : (snap.docs[0]!.data()['role'] as string | undefined);
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

    // Mirror the cleared flag onto the Firestore doc.
    await adminDb.collection('users').doc(uid).update({
      mustChangePassword: false,
      updatedAt: new Date().toISOString(),
    }).catch(() => undefined);

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
