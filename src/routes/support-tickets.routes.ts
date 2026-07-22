import { Router } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateTicketSchema, AddTicketMessageSchema, businessDateStr, businessDayBounds } from '../shared';
import { rowToApi } from '../utils/case';
import { peekNextTicketNumber } from '../utils/ticketNumber';
import { logTicketHistory } from '../services/ticket-history.service';
import { notify } from '../services/push.service';

/**
 * Fire a notification without letting a failure break the mutation that raised it.
 * Ticket notifications need the `ticket_*` values in the notification_type enum;
 * until that DDL is applied, notify() throws — swallow it so ticket create/reply
 * still succeed (the in-app alert simply doesn't appear until the enum is added).
 */
async function notifySafe(input: Parameters<typeof notify>[0]): Promise<void> {
  try {
    await notify(input);
  } catch (err) {
    console.warn('[tickets] notification skipped:', err instanceof Error ? err.message : err);
  }
}

export const router = Router();

const ATTACHMENT_BUCKET = 'support-attachments';
const SIGNED_URL_TTL = 60; // seconds

/**
 * Attachment MIME allowlist — mirrors support-attachments' allowed_mime_types
 * (migration 20). The bucket would also reject others, but we fail fast here with
 * a clear message and never trust the client's declared filename for the path.
 */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authenticate);

/** Scope a ticket-list query to what the caller may see. */
function scopeList<T>(query: T, user: NonNullable<AuthRequest['user']>): T {
  // super_admin: everything. branch_manager: only their branch.
  // production_user: only tickets raised by production users (a central role).
  const q = query as { eq: (col: string, val: unknown) => T };
  if (user.role === 'branch_manager' && user.branchId) return q.eq('branch_id', user.branchId);
  if (user.role === 'production_user') return q.eq('created_by_role', 'production_user');
  return query;
}

/** Whether a caller may read/act on a specific ticket row. */
function canAccess(ticket: { branch_id: string | null; created_by_role: string | null }, user: NonNullable<AuthRequest['user']>): boolean {
  if (user.role === 'super_admin') return true;
  if (user.role === 'branch_manager') return !!user.branchId && ticket.branch_id === user.branchId;
  if (user.role === 'production_user') return ticket.created_by_role === 'production_user';
  return false;
}

// GET /api/support-tickets — role-scoped list (most recent first, capped).
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    let query = supabaseAdmin
      .from('support_tickets')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(300);

    query = scopeList(query, req.user!);

    const { data, error } = await query;
    if (error) throw error;

    const tickets = rowToApi<Record<string, unknown>[]>(data ?? []);
    res.json({ tickets, total: tickets.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/support-tickets/categories — active categories for the New Query form.
router.get('/categories', async (_req: AuthRequest, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('support_ticket_categories')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    res.json({ categories: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

// GET /api/support-tickets/stats — Admin Support Center counters.
router.get('/stats', requireRole('super_admin'), async (_req: AuthRequest, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .select('status, priority, created_at')
      .is('deleted_at', null);
    if (error) throw error;

    const { fromISO, toISO } = businessDayBounds(businessDateStr());
    const rows = (data ?? []) as { status: string; priority: string; created_at: string }[];
    const stats = {
      total: rows.length,
      open: rows.filter((r) => r.status === 'open').length,
      inProgress: rows.filter((r) => r.status === 'in_progress').length,
      resolved: rows.filter((r) => r.status === 'resolved').length,
      closed: rows.filter((r) => r.status === 'closed').length,
      highPriority: rows.filter((r) => r.priority === 'high' || r.priority === 'urgent').length,
      today: rows.filter((r) => r.created_at >= fromISO && r.created_at <= toISO).length,
    };
    res.json({ stats });
  } catch (err) {
    next(err);
  }
});

// GET /api/support-tickets/attachments/:id/url — signed URL for one attachment.
// Placed before '/:id' so the literal 'attachments' segment is not treated as an id.
router.get('/attachments/:id/url', async (req: AuthRequest, res, next) => {
  try {
    const { data: att, error: attErr } = await supabaseAdmin
      .from('support_ticket_attachments')
      .select('storage_path, ticket_id')
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (attErr) throw attErr;
    if (!att) { res.status(404).json({ error: 'Attachment not found' }); return; }

    const { data: ticket, error: tErr } = await supabaseAdmin
      .from('support_tickets')
      .select('branch_id, created_by_role')
      .eq('id', att.ticket_id)
      .maybeSingle();
    if (tErr) throw tErr;
    if (!ticket || !canAccess(ticket, req.user!)) { res.status(403).json({ error: 'Access denied' }); return; }

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(att.storage_path, SIGNED_URL_TTL);
    if (signErr) throw signErr;

    res.json({ url: signed.signedUrl });
  } catch (err) {
    next(err);
  }
});

// GET /api/support-tickets/:id — full ticket with conversation + history.
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { data: ticket, error } = await supabaseAdmin
      .from('support_tickets')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (!canAccess(ticket, req.user!)) { res.status(403).json({ error: 'Access denied' }); return; }

    const [messagesRes, attachmentsRes, historyRes] = await Promise.all([
      supabaseAdmin.from('support_ticket_messages').select('*').eq('ticket_id', id).order('created_at', { ascending: true }),
      supabaseAdmin.from('support_ticket_attachments').select('*').eq('ticket_id', id).order('created_at', { ascending: true }),
      supabaseAdmin.from('support_ticket_history').select('*').eq('ticket_id', id).order('performed_at', { ascending: true }),
    ]);
    if (messagesRes.error) throw messagesRes.error;
    if (attachmentsRes.error) throw attachmentsRes.error;
    if (historyRes.error) throw historyRes.error;

    const attachments = rowToApi<{ id: string; messageId: string | null }[]>(attachmentsRes.data ?? []);
    const messages = rowToApi<{ id: string }[]>(messagesRes.data ?? []).map((m) => ({
      ...m,
      attachments: attachments.filter((a) => a.messageId === m.id),
    }));

    res.json({
      ticket: {
        ...rowToApi<Record<string, unknown>>(ticket),
        messages,
        history: rowToApi(historyRes.data ?? []),
        attachments: attachments.filter((a) => a.messageId === null), // opening-post files
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/support-tickets — a user opens a ticket.
router.post('/', requireRole('super_admin', 'branch_manager', 'production_user'), validate(CreateTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { subject, categoryId, description, priority } = req.body as {
      subject: string; categoryId: string; description: string; priority: string;
    };
    const user = req.user!;

    // Denormalise the category name so the list/report never joins back.
    const { data: category, error: catErr } = await supabaseAdmin
      .from('support_ticket_categories')
      .select('name')
      .eq('id', categoryId)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!category) { res.status(400).json({ error: 'Category not found' }); return; }

    const businessDate = businessDateStr();
    const department = user.role === 'production_user' ? 'Production' : (user.branchName ?? null);
    const baseRow = {
      created_by: user.uid,
      created_by_name: user.email,
      created_by_role: user.role,
      branch_id: user.branchId,
      department,
      category_id: categoryId,
      category_name: category.name,
      subject,
      description,
      priority,
      status: 'open',
    };

    // Allocate the ticket number and insert, retrying on the (rare) race where two
    // creates computed the same number — ticket_no is UNIQUE, so a collision is a
    // 23505 we simply re-peek and retry, never a duplicate.
    let ticket: { id: string } | null = null;
    let ticketNo = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      ticketNo = await peekNextTicketNumber(businessDate);
      const { data, error } = await supabaseAdmin
        .from('support_tickets')
        .insert({ ...baseRow, ticket_no: ticketNo })
        .select('id')
        .single();
      if (!error) { ticket = data; break; }
      if (error.code !== '23505') throw error; // not a uniqueness collision
    }
    if (!ticket) { res.status(409).json({ error: 'Could not allocate a ticket number, please retry' }); return; }

    await logTicketHistory({
      ticketId: ticket.id,
      action: 'created',
      newValue: ticketNo,
      performedBy: user.uid,
      performedByName: user.email,
    });

    // Notify all admins. branchId stays null so the role broadcast is not
    // narrowed to a branch (see the orders.routes.ts note on role broadcasts).
    await notifySafe({
      type: 'ticket_created',
      title: 'New Support Ticket',
      message: `${ticketNo}: ${subject}`,
      targetRole: 'super_admin',
      branchId: null,
      relatedId: ticket.id,
    });

    res.status(201).json({ id: ticket.id, ticketNo });
  } catch (err) {
    next(err);
  }
});

// POST /api/support-tickets/:id/messages — post a reply into the thread.
router.post('/:id/messages', validate(AddTicketMessageSchema), async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const { message } = req.body as { message: string };
    const user = req.user!;

    const { data: ticket, error: tErr } = await supabaseAdmin
      .from('support_tickets')
      .select('id, status, created_by, created_by_role, branch_id, ticket_no, subject')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (tErr) throw tErr;
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (!canAccess(ticket, user)) { res.status(403).json({ error: 'Access denied' }); return; }

    const { data: msg, error: msgErr } = await supabaseAdmin
      .from('support_ticket_messages')
      .insert({
        ticket_id: id,
        sender_id: user.uid,
        sender_name: user.email,
        sender_role: user.role,
        message,
      })
      .select('*')
      .single();
    if (msgErr) throw msgErr;

    // First admin reply moves an untouched ticket into "In Progress".
    if (user.role === 'super_admin' && ticket.status === 'open') {
      await supabaseAdmin.from('support_tickets').update({ status: 'in_progress' }).eq('id', id);
      await logTicketHistory({
        ticketId: id, action: 'status_changed', oldValue: 'open', newValue: 'in_progress',
        performedBy: user.uid, performedByName: user.email,
      });
    }

    await logTicketHistory({
      ticketId: id, action: 'reply_added', performedBy: user.uid, performedByName: user.email,
    });

    // Notify the other party: admin reply → the creator; user reply → all admins.
    if (user.role === 'super_admin') {
      if (ticket.created_by) {
        await notifySafe({
          type: 'ticket_replied',
          title: 'Support Reply',
          message: `${ticket.ticket_no}: Admin replied to "${ticket.subject}"`,
          targetUserId: ticket.created_by,
          relatedId: id,
        });
      }
    } else {
      await notifySafe({
        type: 'ticket_replied',
        title: 'Ticket Reply',
        message: `${ticket.ticket_no}: new reply on "${ticket.subject}"`,
        targetRole: 'super_admin',
        branchId: null,
        relatedId: id,
      });
    }

    res.status(201).json({ message: rowToApi({ ...msg, attachments: [] }) });
  } catch (err) {
    next(err);
  }
});

// POST /api/support-tickets/:id/attachments — upload a file to the ticket.
// Optional ?messageId= links it to a specific reply; omitted = opening post.
router.post('/:id/attachments', // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload.single('file') as any, async (req: AuthRequest, res, next) => {
  try {
    const id = req.params['id']!;
    const user = req.user!;
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    if (!ALLOWED_MIME.has(req.file.mimetype)) {
      res.status(400).json({ error: 'Unsupported file type. Allowed: images, PDF, Excel, Word.' });
      return;
    }

    const { data: ticket, error: tErr } = await supabaseAdmin
      .from('support_tickets')
      .select('branch_id, created_by_role')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (tErr) throw tErr;
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (!canAccess(ticket, user)) { res.status(403).json({ error: 'Access denied' }); return; }

    // The stored name never trusts originalname for the path (attacker-controlled);
    // a sanitized copy is kept only as display metadata.
    const safeName = req.file.originalname.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
    const storagePath = `${id}/${Date.now()}-${safeName}`;

    const { error: upErr } = await supabaseAdmin.storage
      .from(ATTACHMENT_BUCKET)
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) throw upErr;

    const messageId = (req.query['messageId'] as string) || null;
    const { data: att, error: attErr } = await supabaseAdmin
      .from('support_ticket_attachments')
      .insert({
        ticket_id: id,
        message_id: messageId,
        storage_path: storagePath,
        file_name: safeName,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
        uploaded_by: user.uid,
      })
      .select('*')
      .single();
    if (attErr) throw attErr;

    res.status(201).json({ attachment: rowToApi(att) });
  } catch (err) {
    next(err);
  }
});
