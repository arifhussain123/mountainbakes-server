import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/requireRole';
import { CreateCustomerSchema, UpdateCustomerSchema } from '../shared';
import { rowToApi, apiToRow } from '../utils/case';

export const router = Router();

router.use(authenticate);

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { search } = req.query;

    let query = supabaseAdmin.from('customers').select('*').order('created_at', { ascending: false });

    // Branch managers can only see their own branch customers
    if (req.user!.role === 'branch_manager' && req.user!.branchId) {
      query = query.eq('branch_id', req.user!.branchId);
    } else if (req.query['branchId']) {
      query = query.eq('branch_id', req.query['branchId']);
    }

    // Search moves into Postgres rather than filtering the whole table in memory.
    // Phone matching stays a substring match (it was `phone.includes(...)`), so a
    // partial number still finds the customer; ilike is fine for digits.
    // Commas and parens are stripped — they are the `or` filter's own syntax.
    if (search) {
      const term = String(search).replace(/[(),*]/g, ' ').trim();
      if (term) query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const customers = rowToApi<Record<string, unknown>[]>(data ?? []);
    res.json({ customers, total: customers.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('*')
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Customer not found' }); return; }

    if (req.user!.role === 'branch_manager' && (data as { branch_id: string }).branch_id !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({ customer: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('super_admin', 'branch_manager'), validate(CreateCustomerSchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, phone, email, address, branchId } = req.body;

    // Branch managers can only create customers for their own branch — their own
    // branch always wins over whatever the body claims.
    const effectiveBranchId = req.user!.role === 'branch_manager' ? req.user!.branchId! : branchId;
    if (!effectiveBranchId) { res.status(400).json({ error: 'Branch is required' }); return; }

    // branch_name is a denormalised cache of branches.name.
    const { data: branch, error: branchErr } = await supabaseAdmin
      .from('branches')
      .select('name')
      .eq('id', effectiveBranchId)
      .maybeSingle();
    if (branchErr) throw branchErr;
    if (!branch) { res.status(400).json({ error: 'Branch not found' }); return; }

    // total_orders / total_spent default to 0 and are maintained by
    // increment_customer_stats (migration 13) — do not set them here.
    // created_at / updated_at come from column defaults and customers_touch.
    const { data, error } = await supabaseAdmin
      .from('customers')
      .insert({
        name,
        phone,
        email,
        address,
        branch_id: effectiveBranchId,
        branch_name: branch.name,
      })
      .select('id')
      .single();
    if (error) throw error;

    res.status(201).json({ id: data.id, name });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireRole('super_admin', 'branch_manager'), validate(UpdateCustomerSchema), async (req: AuthRequest, res, next) => {
  try {
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('customers')
      .select('branch_id')
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!existing) { res.status(404).json({ error: 'Customer not found' }); return; }

    if (req.user!.role === 'branch_manager' && existing.branch_id !== req.user!.branchId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // UpdateCustomerSchema covers name/phone/email/address only — branch and the
    // order totals are deliberately not editable here.
    // updated_at is maintained by the customers_touch trigger — do not set it here.
    const { error } = await supabaseAdmin
      .from('customers')
      .update(apiToRow(req.body))
      .eq('id', req.params['id']!);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
