import { Request, Response, NextFunction } from 'express';
import { dbFor } from '../db';
import { resolveIdentity } from '../services/auth/auth.service';
import { verifyAccessToken } from '../services/auth/tokens';
import { USER_ROLES, type UserRole } from '../shared';

const db = dbFor('auth');

/**
 * Sessions Login History has marked revoked, as this process has seen them.
 *
 * WHY THIS CACHE EXISTS AT ALL. The check below runs on EVERY authenticated
 * request in the app, and an uncached version would add a database round-trip to
 * each one — a real cost paid on every screen to catch a condition that is rare
 * by construction. So the answer is remembered, asymmetrically:
 *
 *   * A revocation is remembered FOREVER (until the process restarts). It cannot
 *     be undone — there is no un-revoke — so a cached `true` can never go stale
 *     in the dangerous direction.
 *   * "Not revoked" is remembered for one minute only, and that TTL is the
 *     longest a session Login History has marked can keep working on this
 *     check alone.
 *
 * BOUNDED. The negative map is capped and cleared wholesale rather than evicted
 * entry by entry; the cost of a cold cache is one extra query per live session,
 * which is not worth an LRU to avoid. The revoked set is not capped because its
 * membership is the number of sessions an admin has ever ended on this server,
 * which is small and self-limiting.
 *
 * PER-PROCESS, like `utils/cache.ts` and for the same reason: the deploy is a
 * single server. On a horizontally scaled API each instance would learn about a
 * revocation independently, within its own TTL — still bounded, and worth
 * swapping for Redis if that day comes.
 */
const revokedSessions = new Set<string>();
const notRevokedUntil = new Map<string, number>();
const NEGATIVE_TTL_MS = 60_000;
const NEGATIVE_CACHE_MAX = 2_000;

/**
 * Has Login History marked this session revoked?
 *
 * The second of two checks, and the weaker one on purpose. `resolveIdentity`
 * has already refused a session whose own row says it has ended; this catches
 * the case where Login History marked its row and ending the session itself
 * then failed.
 *
 * FAILS OPEN, deliberately and in exactly one direction: a database error
 * answers "not revoked". This runs in front of every request in the app, so a
 * transient failure here that failed CLOSED would sign the entire company out of
 * a working system to enforce a revocation that has probably not happened.
 */
async function isRevoked(authSessionId: string | null): Promise<boolean> {
  if (!authSessionId) return false;
  if (revokedSessions.has(authSessionId)) return true;

  const fresh = notRevokedUntil.get(authSessionId);
  if (fresh !== undefined && fresh > Date.now()) return false;

  const { data, error } = await db
    .from('login_sessions')
    .select('id')
    .eq('auth_session_id', authSessionId)
    .not('revoked_at', 'is', null)
    .limit(1);

  if (error) {
    console.error('[auth] revocation check failed', error.message);
    return false;
  }

  if ((data?.length ?? 0) > 0) {
    revokedSessions.add(authSessionId);
    notRevokedUntil.delete(authSessionId);
    return true;
  }

  if (notRevokedUntil.size >= NEGATIVE_CACHE_MAX) notRevokedUntil.clear();
  notRevokedUntil.set(authSessionId, Date.now() + NEGATIVE_TTL_MS);
  return false;
}

/**
 * Driven off the shared USER_ROLES list rather than a literal copy. The literal
 * version had to be remembered when the four Finance Ledger roles were added in
 * migration 51 — and forgetting it fails CLOSED but silently: a correctly
 * provisioned finance account gets "Account has no role assigned" and nothing in
 * the logs points at this line.
 */
const VALID_ROLES = new Set<UserRole>(USER_ROLES);

export interface AuthRequest extends Request {
  user?: {
    uid: string;
    email: string;
    role: UserRole;
    branchId: string | null;
    branchName: string | null;
    /**
     * The session this token belongs to — the id of its `auth_sessions` row.
     *
     * Login History records it so an admin can later revoke THIS device rather
     * than every device the account owns, and the ping uses it to notice that
     * the session it is pinging for has been revoked underneath it.
     */
    authSessionId: string | null;
    /** How this session was authenticated. Always `['password']`: it is the only way in. */
    authMethods: string[];
    /** Always null: there is no Google sign-in. Kept because Login History's rows have the column. */
    googleEmail: string | null;
  };
}

/**
 * What a user who must choose a new password may still do before they have:
 * change it, see who they are, sign out, and the background calls every screen
 * makes whoever is signed in. Everything else waits.
 */
const PASSWORD_CHANGE_ALLOWED = ['/api/auth/', '/api/login-history/', '/api/notifications', '/api/public/'];

/**
 * Identify the caller from `Authorization: Bearer <token>` and attach them to
 * `req.user`.
 *
 * The token is one this API signed (services/auth/tokens.ts). It says who and
 * which signed-in device, and nothing else: the person's role, branch and
 * status are read from `users` here, on every request, so a change to any of
 * them takes effect on their next click.
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const verified = verifyAccessToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  let identity: Awaited<ReturnType<typeof resolveIdentity>>;
  try {
    identity = await resolveIdentity(verified.userId, verified.sessionId);
  } catch (err) {
    // Unlike the revocation cache above, this cannot fail open: without the
    // row there is no role to act under. The request fails; the session does not.
    console.error('[auth] could not load the session', err instanceof Error ? err.message : err);
    res.status(503).json({ error: 'Sign-in could not be checked just now. Please try again.' });
    return;
  }

  if (!identity.ok) {
    // An ended session answers with the code the clients already act on.
    if (identity.reason === 'revoked') {
      res.status(401).json({
        error: 'This session was signed out by an administrator',
        details: { code: 'session_revoked' },
      });
      return;
    }
    if (identity.reason === 'inactive') {
      res.status(401).json({
        error: 'This account has been deactivated. Please contact your administrator.',
        details: { code: 'account_inactive' },
      });
      return;
    }
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  const user = identity.user;
  if (!VALID_ROLES.has(user.role as UserRole)) {
    res.status(403).json({ error: 'Forbidden: Account has no role assigned' });
    return;
  }

  // Login History marks its own row revoked as well as ending the session; a
  // session it has marked is treated as ended even if the second half failed.
  if (await isRevoked(verified.sessionId)) {
    res.status(401).json({
      error: 'This session was signed out by an administrator',
      details: { code: 'session_revoked' },
    });
    return;
  }

  // Enforced here, not left to the screen that asks for the new password: a
  // temporary password is a key to the change-password form and nothing else.
  if (user.must_change_password === true && !PASSWORD_CHANGE_ALLOWED.some((prefix) => req.originalUrl.startsWith(prefix))) {
    res.status(403).json({
      error: 'You must choose a new password before continuing.',
      details: { code: 'password_change_required' },
    });
    return;
  }

  req.user = {
    uid: user.id,
    email: user.email,
    role: user.role as UserRole,
    branchId: user.branch_id,
    branchName: user.branch_name,
    authSessionId: verified.sessionId,
    authMethods: ['password'],
    googleEmail: null,
  };
  next();
}
