import { Router } from 'express';
import { adminDb } from '../config/firebase';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateUserSchema, UpdateUserSchema, AdminResetPasswordSchema, type User } from '../shared';
import { generateTempPassword } from '../utils/password';
import { logAudit, resolveAdminName } from '../services/audit.service';
import { notify } from '../services/push.service';

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

// GET /api/users/activity — audit log feed (most recent first). Declared before
// '/:id' so it isn't captured as a user id.
router.get('/activity', async (_req: AuthRequest, res, next) => {
  try {
    const snap = await adminDb.collection('auditLogs').orderBy('createdAt', 'desc').limit(100).get();
    const logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// GET /api/users
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { status, role } = req.query;
    let query = adminDb.collection('users').orderBy('createdAt', 'desc') as FirebaseFirestore.Query;

    if (status) query = query.where('status', '==', status);
    if (role) query = query.where('role', '==', role);

    const snapshot = await query.get();
    const users = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ users, total: users.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const doc = await adminDb.collection('users').doc(req.params['id']!).get();
    if (!doc.exists) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ user: { id: doc.id, ...doc.data() } });
  } catch (err) {
    next(err);
  }
});

// POST /api/users
router.post('/', validate(CreateUserSchema), async (req: AuthRequest, res, next) => {
  try {
    const { email, displayName, phone, username, password, role, branchId } = req.body;

    // Look up branch name if branchId provided
    let branchName: string | null = null;
    if (branchId) {
      const branchDoc = await adminDb.collection('branches').doc(branchId).get();
      if (!branchDoc.exists) { res.status(400).json({ error: 'Branch not found' }); return; }
      branchName = (branchDoc.data() as { name: string }).name;
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

    // Write Firestore doc (keyed by the Supabase user id)
    const now = new Date().toISOString();
    await adminDb.collection('users').doc(uid).set({
      email,
      displayName,
      phone,
      username,
      role,
      branchId: branchId ?? null,
      branchName,
      status: 'active',
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });

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
    const { id } = req.params;
    const updates = req.body;
    const now = new Date().toISOString();

    // If role or branchId changed, update app_metadata claims
    if (updates.role !== undefined || updates.branchId !== undefined) {
      const userDoc = await adminDb.collection('users').doc(id!).get();
      const current = userDoc.data() as { role: string; branchId: string | null; branchName: string | null };

      let branchName = current.branchName;
      if (updates.branchId !== undefined) {
        branchName = null;
        if (updates.branchId) {
          const branchDoc = await adminDb.collection('branches').doc(updates.branchId).get();
          if (branchDoc.exists) branchName = (branchDoc.data() as { name: string }).name;
        }
        updates['branchName'] = branchName;
      }

      await mergeClaims(id!, {
        role: updates.role ?? current.role,
        branchId: updates.branchId !== undefined ? updates.branchId : current.branchId,
        branchName,
      });
    }

    await adminDb.collection('users').doc(id!).update({ ...updates, updatedAt: now });

    // Update the auth user's displayName if provided
    if (updates.displayName) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id!, {
        user_metadata: { displayName: updates.displayName },
      });
      if (error) throw error;
    }

    const updatedDoc = await adminDb.collection('users').doc(id!).get();
    const updated = updatedDoc.data() as User | undefined;
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
    const { id } = req.params;
    const doc = await adminDb.collection('users').doc(id!).get();
    const target = doc.data() as User | undefined;

    await adminDb.collection('users').doc(id!).update({
      status: 'inactive',
      updatedAt: new Date().toISOString(),
    });
    // Ban the auth user (~100 years) to block sign-in. 'none' re-enables.
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id!, { ban_duration: '876000h' });
    if (error) throw error;

    await logAudit({
      action: 'user_deactivated',
      adminId: req.user!.uid,
      adminName: await resolveAdminName(req.user!.uid, req.user!.email),
      targetUserId: id,
      targetUserName: target?.displayName ?? null,
      targetUserRole: target?.role ?? null,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/activate — re-enable a deactivated user
router.post('/:id/activate', async (req: AuthRequest, res, next) => {
  try {
    const { id } = req.params;
    const doc = await adminDb.collection('users').doc(id!).get();
    if (!doc.exists) { res.status(404).json({ error: 'User not found' }); return; }
    const target = doc.data() as User;

    await adminDb.collection('users').doc(id!).update({
      status: 'active',
      updatedAt: new Date().toISOString(),
    });
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id!, { ban_duration: 'none' });
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
    const { id } = req.params;
    const { generateTemp, sendEmail, forceChange } = req.body as {
      generateTemp: boolean; sendEmail: boolean; forceChange: boolean;
    };

    const doc = await adminDb.collection('users').doc(id!).get();
    if (!doc.exists) { res.status(404).json({ error: 'User not found' }); return; }
    const target = doc.data() as User;

    let tempPassword: string | null = null;
    if (generateTemp) {
      tempPassword = generateTempPassword();
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id!, { password: tempPassword });
      if (error) throw error;
    }

    if (forceChange) {
      await mergeClaims(id!, { mustChangePassword: true });
    }

    const now = new Date().toISOString();
    const adminName = await resolveAdminName(req.user!.uid, req.user!.email);
    await adminDb.collection('users').doc(id!).update({
      mustChangePassword: forceChange ? true : (target.mustChangePassword ?? false),
      lastPasswordReset: now,
      passwordResetBy: req.user!.uid,
      passwordResetByName: adminName,
      updatedAt: now,
    });

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

    // Notify the affected user (in-app + web push).
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
