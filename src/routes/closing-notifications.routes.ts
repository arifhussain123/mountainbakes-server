import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateRecipientSchema,
  UpdateRecipientSchema,
  DispatchClosingSchema,
} from '../shared';
import { rowToApi } from '../utils/case';
import { dispatchClosingSummaries } from '../services/closing-notifications.service';
import { getMessageProvider, getRetryPolicy } from '../services/messaging';

export const router = Router();

router.use(authenticate);

// ---------------------------------------------------------------------------
// Recipients — Admin only (Settings → Notification Recipients)
// ---------------------------------------------------------------------------

// GET /api/closing-notifications/recipients
router.get('/recipients', requireRole('super_admin'), async (_req: AuthRequest, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('notification_recipients')
      .select('*, branch:branches(name)')
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Flatten the joined branch name onto the row before the case conversion.
    const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => {
      const { branch, ...rest } = r as { branch?: { name?: string } | null };
      return { ...rest, branch_name: branch?.name ?? null };
    });
    res.json({ recipients: rowToApi(rows) });
  } catch (err) {
    next(err);
  }
});

// POST /api/closing-notifications/recipients
router.post('/recipients', requireRole('super_admin'), validate(CreateRecipientSchema), async (req: AuthRequest, res, next) => {
  try {
    const { branchId, department, recipientName, mobileNumber, channel, active } = req.body;
    const { data, error } = await supabaseAdmin
      .from('notification_recipients')
      .insert({
        branch_id: branchId ?? null,
        department: department ?? null,
        recipient_name: recipientName,
        mobile_number: mobileNumber,
        channel,
        active,
      })
      .select('*')
      .single();
    if (error) throw error;
    res.status(201).json({ recipient: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/closing-notifications/recipients/:id
router.patch('/recipients/:id', requireRole('super_admin'), validate(UpdateRecipientSchema), async (req: AuthRequest, res, next) => {
  try {
    const patch: Record<string, unknown> = {};
    if (req.body.recipientName !== undefined) patch['recipient_name'] = req.body.recipientName;
    if (req.body.mobileNumber !== undefined) patch['mobile_number'] = req.body.mobileNumber;
    if (req.body.channel !== undefined) patch['channel'] = req.body.channel;
    if (req.body.active !== undefined) patch['active'] = req.body.active;
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

    const { data, error } = await supabaseAdmin
      .from('notification_recipients')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Recipient not found' }); return; }
    res.json({ recipient: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/closing-notifications/recipients/:id
router.delete('/recipients/:id', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { error } = await supabaseAdmin.from('notification_recipients').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Reports — role-scoped. A branch manager sees only their branch's reports, a
// production user only the production report, admin sees everything. The
// service-role client bypasses RLS, so this scoping IS the access control.
// ---------------------------------------------------------------------------

// GET /api/closing-notifications/reports?businessDate=&days=
router.get('/reports', async (req: AuthRequest, res, next) => {
  try {
    let query = supabaseAdmin
      .from('daily_closing_reports')
      .select('*')
      .order('business_date', { ascending: false })
      .limit(200);

    const businessDate = req.query['businessDate'] ? String(req.query['businessDate']) : null;
    if (businessDate) query = query.eq('business_date', businessDate);

    const role = req.user!.role;
    if (role === 'branch_manager') {
      if (!req.user!.branchId) { res.json({ reports: [] }); return; }
      query = query.eq('scope', 'branch').eq('branch_id', req.user!.branchId);
    } else if (role === 'production_user') {
      query = query.eq('scope', 'production');
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ reports: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Delivery logs + manual dispatch — Admin only
// ---------------------------------------------------------------------------

// GET /api/closing-notifications/logs?businessDate=&status=
router.get('/logs', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    let query = supabaseAdmin
      .from('notification_logs')
      .select('*, recipient:notification_recipients(recipient_name, mobile_number)')
      .order('created_at', { ascending: false })
      .limit(500);
    if (req.query['businessDate']) query = query.eq('business_date', String(req.query['businessDate']));
    if (req.query['status']) query = query.eq('status', String(req.query['status']));

    const { data, error } = await query;
    if (error) throw error;

    const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => {
      const { recipient, ...rest } = r as { recipient?: { recipient_name?: string; mobile_number?: string } | null };
      return {
        ...rest,
        recipient_name: recipient?.recipient_name ?? null,
        mobile_number: recipient?.mobile_number ?? null,
      };
    });
    res.json({ logs: rowToApi(rows) });
  } catch (err) {
    next(err);
  }
});

// GET /api/closing-notifications/provider — what the server would actually send with
router.get('/provider', requireRole('super_admin'), async (_req: AuthRequest, res) => {
  const provider = getMessageProvider();
  const policy = getRetryPolicy();
  res.json({
    provider: provider.name,
    live: provider.name !== 'log',
    retry: policy,
  });
});

// POST /api/closing-notifications/dispatch — generate + send now (admin/manual).
// Always runs regardless of the closingNotificationsEnabled toggle, which only
// gates the unattended scheduler run.
router.post('/dispatch', requireRole('super_admin'), validate(DispatchClosingSchema), async (req: AuthRequest, res, next) => {
  try {
    const result = await dispatchClosingSummaries({
      businessDate: req.body.businessDate,
      resend: req.body.resend,
      trigger: 'manual',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
