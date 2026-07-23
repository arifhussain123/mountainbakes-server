import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  CreateSupportTicketSchema,
  EditSupportTicketSchema,
  ResolveSupportTicketSchema,
  ChangeFiguresSchema,
  type SupportReference,
  type SupportReferenceType,
} from '../shared';
import { notify } from '../services/push.service';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate);

// ---------------------------------------------------------------------------
// Reference lookup — resolve a typed ID (MB-/EXP-/STK-) to its detail, scoped to
// the caller's role/branch. Throws { status } errors that map to HTTP codes.
// ---------------------------------------------------------------------------
class LookupError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const money = (v: unknown) => `Rs.${Number(v ?? 0).toLocaleString('en-PK')}`;

function refType(refId: string): SupportReferenceType {
  const id = refId.toUpperCase();
  if (id.startsWith('MB-')) return 'sale';
  if (id.startsWith('EXP-')) return 'expense';
  if (id.startsWith('STK-')) return 'stock';
  throw new LookupError('Unknown ID. Use a sale (MB-…), expense (EXP-…), or stock (STK-…) ID.', 400);
}

async function resolveReference(user: AuthRequest['user'], rawRef: string): Promise<SupportReference> {
  const referenceId = rawRef.trim().toUpperCase();
  const type = refType(referenceId);
  const role = user!.role;
  const branchId = user!.branchId;

  // --- SALE (orders.order_number) -----------------------------------------
  if (type === 'sale') {
    if (role === 'production_user') throw new LookupError('Sales are not available for the production role.', 403);
    let q = supabaseAdmin
      .from('orders')
      .select('id, order_number, customer_name, branch_name, branch_id, grand_total, payment_method, status, business_date')
      .eq('order_number', referenceId)
      .limit(1);
    if (role === 'branch_manager' && branchId) q = q.eq('branch_id', branchId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) throw new LookupError(`No sale found for ${referenceId}.`, 404);
    return {
      type,
      referenceId,
      entityId: data.id,
      title: `Sale ${referenceId} — ${data.customer_name ?? 'Walk-in'} · ${money(data.grand_total)}`,
      fields: [
        { label: 'Customer', value: data.customer_name ?? 'Walk-in' },
        { label: 'Branch', value: data.branch_name ?? '—' },
        { label: 'Grand Total', value: money(data.grand_total) },
        { label: 'Payment', value: String(data.payment_method ?? '—') },
        { label: 'Status', value: String(data.status ?? '—') },
        { label: 'Date', value: String(data.business_date ?? '—') },
      ],
      // Order totals derive from line items; they are shown for correction as a
      // recorded note rather than mutated directly.
      editableFields: [],
    };
  }

  // --- EXPENSE (expenses / production_expenses .expense_number) ------------
  if (type === 'expense') {
    // Branch managers see only their branch's shop expenses; production users
    // see only production expenses; admins see either.
    if (role !== 'production_user') {
      let q = supabaseAdmin
        .from('expenses')
        .select('id, expense_number, description, amount, payment_method, branch_id, branch_name, business_date')
        .eq('expense_number', referenceId)
        .limit(1);
      if (role === 'branch_manager' && branchId) q = q.eq('branch_id', branchId);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      if (data) {
        return {
          type,
          referenceId,
          entityId: data.id,
          entityTable: 'expenses',
          title: `Expense ${referenceId} — ${data.description} · ${money(data.amount)}`,
          fields: [
            { label: 'Description', value: data.description },
            { label: 'Amount', value: money(data.amount) },
            { label: 'Payment', value: String(data.payment_method ?? '—') },
            { label: 'Branch', value: data.branch_name ?? '—' },
            { label: 'Date', value: String(data.business_date ?? '—') },
          ],
          editableFields: [
            { key: 'amount', label: 'Amount', kind: 'number', value: Number(data.amount) },
            { key: 'description', label: 'Description', kind: 'text', value: data.description },
          ],
        };
      }
    }
    if (role !== 'branch_manager') {
      const { data, error } = await supabaseAdmin
        .from('production_expenses')
        .select('id, expense_number, category, description, amount, payment_method, supplier, business_date')
        .eq('expense_number', referenceId)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        return {
          type,
          referenceId,
          entityId: data.id,
          entityTable: 'production_expenses',
          title: `Production Expense ${referenceId} — ${data.category} · ${money(data.amount)}`,
          fields: [
            { label: 'Category', value: data.category },
            { label: 'Description', value: data.description ?? '—' },
            { label: 'Amount', value: money(data.amount) },
            { label: 'Payment', value: String(data.payment_method ?? '—') },
            { label: 'Supplier', value: data.supplier ?? '—' },
            { label: 'Date', value: String(data.business_date ?? '—') },
          ],
          editableFields: [
            { key: 'amount', label: 'Amount', kind: 'number', value: Number(data.amount) },
            { key: 'description', label: 'Description', kind: 'text', value: data.description ?? '' },
          ],
        };
      }
    }
    throw new LookupError(`No expense found for ${referenceId}.`, 404);
  }

  // --- STOCK (products.stock_code) ----------------------------------------
  const { data: product, error: prodErr } = await supabaseAdmin
    .from('products')
    .select('id, name, sku, stock_code, price')
    .eq('stock_code', referenceId)
    .maybeSingle();
  if (prodErr) throw prodErr;
  if (!product) throw new LookupError(`No stock item found for ${referenceId}.`, 404);

  const fields: SupportReference['fields'] = [
    { label: 'Product', value: product.name },
    { label: 'SKU', value: product.sku ?? '—' },
    { label: 'Price', value: money(product.price) },
  ];

  // Attach the caller-relevant balance. Branch managers see their branch's
  // balance; admins see the total across branches.
  if (role === 'branch_manager' && branchId) {
    const { data: bal } = await supabaseAdmin
      .from('stock')
      .select('balance')
      .eq('product_id', product.id)
      .eq('branch_id', branchId)
      .maybeSingle();
    fields.push({ label: 'Branch Balance', value: String(bal?.balance ?? 0) });
  } else if (role === 'super_admin') {
    const { data: rows } = await supabaseAdmin.from('stock').select('balance').eq('product_id', product.id);
    const total = (rows ?? []).reduce((s, r) => s + Number(r.balance ?? 0), 0);
    fields.push({ label: 'Total Balance (all branches)', value: String(total) });
  }

  return {
    type,
    referenceId,
    entityId: product.id,
    title: `Stock ${referenceId} — ${product.name}`,
    fields,
    // Stock balances are a derived ledger; corrections are recorded, not written directly.
    editableFields: [],
  };
}

// GET /api/support/lookup?ref=EXP-000012 — used by the Help Desk to auto-show detail
router.get('/lookup', async (req: AuthRequest, res, next) => {
  try {
    const ref = String(req.query['ref'] || '').trim();
    if (!ref) { res.status(400).json({ error: 'Reference ID is required' }); return; }
    const reference = await resolveReference(req.user, ref);
    res.json({ reference });
  } catch (err) {
    if (err instanceof LookupError) { res.status(err.status).json({ error: err.message }); return; }
    next(err);
  }
});

// GET /api/support — admin sees the whole queue; a raiser sees only their own tickets
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    let query = supabaseAdmin
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (req.user!.role !== 'super_admin') {
      query = query.eq('raised_by', req.user!.uid);
    } else if (req.query['status']) {
      query = query.eq('status', String(req.query['status']));
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ tickets: rowToApi(data ?? []) });
  } catch (err) {
    next(err);
  }
});

// POST /api/support — raise a query (branches + production). Snapshots the reference.
router.post('/', requireRole('branch_manager', 'production_user'), validate(CreateSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { referenceId, message } = req.body;
    let reference: SupportReference;
    try {
      reference = await resolveReference(req.user, referenceId);
    } catch (err) {
      if (err instanceof LookupError) { res.status(err.status).json({ error: err.message }); return; }
      throw err;
    }

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .insert({
        reference_type: reference.type,
        reference_id: reference.referenceId,
        reference_snapshot: reference,
        message,
        branch_id: req.user!.branchId,
        branch_name: req.user!.branchName,
        raised_by: req.user!.uid,
        raised_by_name: req.user!.email,
        raised_by_role: req.user!.role,
      })
      .select('*')
      .single();
    if (error) throw error;

    // In-app notification to admins — best-effort, never fails the mutation.
    try {
      await notify({
        type: 'support_query',
        title: `New support query ${data.ticket_number}`,
        message: `${req.user!.branchName || req.user!.email} raised a query on ${reference.referenceId}`,
        targetRole: 'super_admin',
        branchId: req.user!.branchId,
        relatedId: data.id,
      });
    } catch { /* notification failure must not fail ticket creation */ }

    res.status(201).json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// Helper: load a ticket or 404.
async function getTicket(id: string) {
  const { data, error } = await supabaseAdmin.from('support_tickets').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// PATCH /api/support/:id — admin edits the ticket text (Edit button)
router.patch('/:id', requireRole('super_admin'), validate(EditSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const patch: Record<string, unknown> = {};
    if (req.body.message !== undefined) patch['message'] = req.body.message;
    if (req.body.resolutionNote !== undefined) patch['resolution_note'] = req.body.resolutionNote;
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Ticket not found' }); return; }
    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/support/:id/resolve — admin resolves or rejects (Reject button + Resolve)
router.patch('/:id/resolve', requireRole('super_admin'), validate(ResolveSupportTicketSchema), async (req: AuthRequest, res, next) => {
  try {
    const { status, resolutionNote } = req.body;
    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .update({
        status,
        resolution_note: resolutionNote || null,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Ticket not found' }); return; }

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} ${status}`,
          message: resolutionNote || `Your query on ${data.reference_id} was ${status}.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/support/:id/figures — admin "Change" button. Applies a live edit to
// expenses; for sale/stock the requested figures are recorded and the ticket is
// resolved. Either way the ticket is marked resolved.
router.patch('/:id/figures', requireRole('super_admin'), validate(ChangeFiguresSchema), async (req: AuthRequest, res, next) => {
  try {
    const ticket = await getTicket(req.params.id);
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }

    const snapshot = (ticket.reference_snapshot ?? null) as SupportReference | null;
    const { edits, note } = req.body as { edits: Record<string, string | number>; note: string };
    const allowed = new Set((snapshot?.editableFields ?? []).map((f) => f.key));

    let applied = false;
    if (snapshot?.entityTable && allowed.size > 0) {
      // Live mutation — only expense columns are ever in `allowed`.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(edits)) {
        if (!allowed.has(k)) continue;
        patch[k] = k === 'amount' ? Number(v) : v;
      }
      if (Object.keys(patch).length > 0) {
        const { error } = await supabaseAdmin.from(snapshot.entityTable).update(patch).eq('id', snapshot.entityId);
        if (error) throw error;
        applied = true;
      }
    }

    // Compose an audit-friendly resolution note describing what changed.
    const changeLines = Object.entries(edits)
      .filter(([k]) => allowed.size === 0 || allowed.has(k))
      .map(([k, v]) => `${k} → ${v}`);
    const prefix = applied ? 'Figures updated' : 'Correction recorded (manual follow-up)';
    const resolutionNote = [note, `${prefix}: ${changeLines.join(', ')}`].filter(Boolean).join(' — ');

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_note: resolutionNote,
        resolved_by: req.user!.uid,
        resolved_by_name: req.user!.email,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;

    try {
      if (data.raised_by) {
        await notify({
          type: 'support_resolved',
          title: `Query ${data.ticket_number} resolved`,
          message: resolutionNote || `Your query on ${data.reference_id} was resolved.`,
          targetUserId: data.raised_by,
          branchId: data.branch_id,
          relatedId: data.id,
        });
      }
    } catch { /* best-effort */ }

    res.json({ ticket: rowToApi(data), applied });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/support/:id — admin removes a ticket (Delete button)
router.delete('/:id', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { error } = await supabaseAdmin.from('support_tickets').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
