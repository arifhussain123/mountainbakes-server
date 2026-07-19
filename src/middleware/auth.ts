import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import type { UserRole } from '../shared';

export interface AuthRequest extends Request {
  user?: {
    uid: string;
    email: string;
    role: UserRole;
    branchId: string | null;
    branchName: string | null;
  };
}

/**
 * Verify the caller's Supabase access token (sent as `Authorization: Bearer <jwt>`)
 * and attach the resolved identity to `req.user`.
 *
 * Role / branch come from the user's `app_metadata` (server-controlled claims that
 * Supabase embeds in the JWT), replacing the previous Firebase custom claims.
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  const meta = (data.user.app_metadata ?? {}) as {
    role?: UserRole;
    branchId?: string | null;
    branchName?: string | null;
  };

  req.user = {
    uid: data.user.id,
    email: data.user.email ?? '',
    role: meta.role ?? 'branch_manager',
    branchId: meta.branchId ?? null,
    branchName: meta.branchName ?? null,
  };
  next();
}
