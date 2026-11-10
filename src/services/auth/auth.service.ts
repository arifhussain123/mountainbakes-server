import { dbFor } from '../../db';
import { getPrisma } from '../../db/prisma';
import type { UserRole } from '../../shared';
import { burnPasswordCheck, hashPassword, verifyPassword } from './passwords';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_REUSE_GRACE_MS,
  SESSION_IDLE_DAYS,
  hashToken,
  newOpaqueToken,
  signAccessToken,
} from './tokens';

const db = dbFor('auth');

/**
 * Sign-in, as the API's own business: checking a password, opening a session,
 * renewing it, ending it.
 *
 * Written against Prisma Client directly rather than the src/db chain the
 * older modules use. Every state change that has to
 * be all-or-nothing — spending a refresh token and issuing its successor — is
 * one `$transaction`.
 *
 * WHAT A CLIENT IS TOLD WHEN SIGN-IN FAILS is one message for an unknown
 * account, a wrong password and an account with no password, after the same
 * amount of work. A deactivated account is told so, but only once the password
 * has been checked: the person who knows the password is the person entitled
 * to know why it did not work.
 */

/** A refusal with an HTTP status and a code the clients branch on. */
export class AuthError extends Error {
  status: number;
  details: { code: string };

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.details = { code };
  }
}

const invalidCredentials = () => new AuthError(401, 'invalid_credentials', 'Invalid email or password');
const sessionExpired = () => new AuthError(401, 'session_expired', 'Your session has expired. Please sign in again.');

/** What the clients keep about the signed-in person. */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  username: string | null;
  role: UserRole;
  branchId: string | null;
  branchName: string | null;
  mustChangePassword: boolean;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires, and the moment it does (Unix seconds). */
  expiresIn: number;
  expiresAt: number;
  user: SessionUser;
}

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  username: string | null;
  role: string;
  branch_id: string | null;
  branch_name: string | null;
  status: string;
  must_change_password: boolean | null;
};

const USER_COLUMNS = {
  id: true,
  email: true,
  display_name: true,
  username: true,
  role: true,
  branch_id: true,
  branch_name: true,
  status: true,
  must_change_password: true,
} as const;

function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    username: row.username,
    role: row.role as UserRole,
    branchId: row.branch_id,
    branchName: row.branch_name,
    mustChangePassword: row.must_change_password === true,
  };
}

const idleDeadline = () => new Date(Date.now() + SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000);

function issue(user: UserRow, sessionId: string, refreshToken: string): IssuedSession {
  const access = signAccessToken(user.id, sessionId);
  return {
    accessToken: access.token,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    expiresAt: access.expiresAt,
    user: toSessionUser(user),
  };
}

/**
 * The account an identifier names: an email address or a username, matched
 * without regard to case. Both are meant to be stored lowercase and neither
 * reliably is — one email and one username in production carry capitals — and
 * the person typing has no way to know which.
 *
 * Uniqueness in the database IS case-sensitive, so two accounts could differ
 * only by case. Then the identifier names nobody: guessing which of two people
 * is signing in is not something to get wrong.
 */
async function findUser(identifier: string): Promise<UserRow | null> {
  const value = identifier.trim();
  if (!value) return null;
  const column = value.includes('@') ? 'email' : 'username';
  const matches = await getPrisma().users.findMany({
    where: { [column]: { equals: value, mode: 'insensitive' } },
    select: USER_COLUMNS,
    take: 2,
  });
  return matches.length === 1 ? matches[0]! : null;
}

export async function signIn(input: { identifier: string; password: string; client?: string }): Promise<IssuedSession> {
  const prisma = getPrisma();
  const user = await findUser(input.identifier);
  const credentials = user ? await prisma.user_credentials.findUnique({ where: { user_id: user.id } }) : null;

  let accepted = false;
  if (credentials) accepted = await verifyPassword(input.password, credentials.password_hash);
  else await burnPasswordCheck(input.password);

  if (!user || !accepted) throw invalidCredentials();
  if (user.status !== 'active') {
    throw new AuthError(403, 'account_inactive', 'This account has been deactivated. Please contact your administrator.');
  }

  const refresh = newOpaqueToken();
  const session = await prisma.auth_sessions.create({
    data: {
      user_id: user.id,
      client: input.client === 'mobile' ? 'mobile' : 'web',
      expires_at: idleDeadline(),
      auth_refresh_tokens: { create: { token_hash: refresh.hash } },
    },
    select: { id: true },
  });
  return issue(user, session.id, refresh.token);
}

/**
 * Exchange a refresh token for a new access token and a new refresh token.
 *
 * Each refresh token works once. Presenting a spent one is how a stolen chain
 * shows itself — the thief and the owner cannot both hold the newest token —
 * so it ends the session for both. The exception is a token spent only moments
 * ago: that is two tabs or a retried request, and it is simply given a token of
 * its own.
 */
export async function refreshSession(refreshToken: string): Promise<IssuedSession> {
  const prisma = getPrisma();
  const hash = hashToken(refreshToken);
  const next = newOpaqueToken();

  const outcome = await prisma.$transaction(async (tx) => {
    const token = await tx.auth_refresh_tokens.findUnique({
      where: { token_hash: hash },
      include: { auth_sessions: { include: { users: { select: USER_COLUMNS } } } },
    });
    if (!token) return { kind: 'invalid' as const };

    const session = token.auth_sessions;
    const now = Date.now();
    if (session.revoked_at || session.expires_at.getTime() <= now) return { kind: 'invalid' as const };

    if (token.used_at && now - token.used_at.getTime() > REFRESH_REUSE_GRACE_MS) {
      // A spent token, well after the grace. Theft only if the chain MOVED ON:
      // some token issued after this one has itself been exchanged. If none has,
      // the answer that carried the new pair never reached the device — a slow
      // branch connection, the browser's 15-second timeout, a phone put to
      // sleep mid-request — and it is simply asking again. Ending the session
      // for that signed people out at random. Instead the unused successors are
      // dropped, so only the pair issued now stays alive, and the chain carries on.
      const later = { session_id: session.id, created_at: { gt: token.created_at } };
      const movedOn = await tx.auth_refresh_tokens.count({ where: { ...later, used_at: { not: null } } });
      if (movedOn > 0) {
        await tx.auth_sessions.update({ where: { id: session.id }, data: { revoked_at: new Date() } });
        return { kind: 'reused' as const, sessionId: session.id };
      }
      await tx.auth_refresh_tokens.deleteMany({ where: { ...later, used_at: null } });
    }
    if (session.users.status !== 'active') return { kind: 'inactive' as const };

    if (!token.used_at) {
      await tx.auth_refresh_tokens.update({ where: { token_hash: hash }, data: { used_at: new Date() } });
    }
    await tx.auth_refresh_tokens.create({ data: { token_hash: next.hash, session_id: session.id } });
    await tx.auth_sessions.update({
      where: { id: session.id },
      data: { last_used_at: new Date(), expires_at: idleDeadline() },
    });
    return { kind: 'ok' as const, sessionId: session.id, user: session.users };
  });

  if (outcome.kind === 'ok') return issue(outcome.user, outcome.sessionId, next.token);
  if (outcome.kind === 'reused') {
    console.warn(`[auth] a spent refresh token was presented again; session ${outcome.sessionId} ended`);
    throw new AuthError(401, 'session_revoked', 'This session was signed out. Please sign in again.');
  }
  if (outcome.kind === 'inactive') {
    throw new AuthError(403, 'account_inactive', 'This account has been deactivated. Please contact your administrator.');
  }
  throw sessionExpired();
}

/** Sign one device out. Ending a session that is already ended is not an error. */
export async function endSession(sessionId: string): Promise<void> {
  await getPrisma().auth_sessions.updateMany({
    where: { id: sessionId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/** Sign out every device of one user, optionally sparing the one doing the asking. */
export async function endUserSessions(userId: string, exceptSessionId: string | null = null): Promise<void> {
  await getPrisma().auth_sessions.updateMany({
    where: { user_id: userId, revoked_at: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revoked_at: new Date() },
  });
}

export type Identity =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'no_session' | 'revoked' | 'expired' | 'inactive' };

/**
 * Who a verified access token is, right now: its session must still be live
 * and its user still active. Read on every request, from the database, so that
 * an ended session or a deactivated account stops working at once rather than
 * at the token's expiry.
 */
export async function resolveIdentity(userId: string, sessionId: string): Promise<Identity> {
  const session = await getPrisma().auth_sessions.findUnique({
    where: { id: sessionId },
    select: { user_id: true, revoked_at: true, expires_at: true, users: { select: USER_COLUMNS } },
  });
  if (!session || session.user_id !== userId) return { ok: false, reason: 'no_session' };
  if (session.revoked_at) return { ok: false, reason: 'revoked' };
  if (session.expires_at.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (session.users.status !== 'active') return { ok: false, reason: 'inactive' };
  return { ok: true, user: session.users };
}

// ── passwords ───────────────────────────────────────────────────────────────

/** Store a new password hash. */
async function storePassword(userId: string, password: string): Promise<void> {
  const password_hash = await hashPassword(password);
  await getPrisma().user_credentials.upsert({
    where: { user_id: userId },
    create: { user_id: userId, password_hash },
    update: { password_hash, password_changed_at: new Date() },
  });
}

/**
 * Set a user's password, and set or clear the "must choose a new one at next
 * sign-in" flag with it.
 */
export async function setPassword(userId: string, password: string, opts: { mustChange: boolean }): Promise<void> {
  await storePassword(userId, password);
  // The flag lives on the users row. Deliberately best-effort: the password
  // has already been changed by this point, so a failure here must not fail
  // the request. updated_at is maintained by the users_touch trigger — do not
  // set it here.
  const { error } = await db.from('users').update({ must_change_password: opts.mustChange }).eq('id', userId);
  if (error) console.error(`[auth] password set for ${userId} but must_change_password was not updated`, error.message);
}

/**
 * A user choosing their own new password. Every OTHER device of theirs is
 * signed out: whoever knew the old password does not keep a session that
 * outlives it.
 */
export async function changeOwnPassword(userId: string, password: string, currentSessionId: string | null): Promise<void> {
  await setPassword(userId, password, { mustChange: false });
  await endUserSessions(userId, currentSessionId);
}

/** The first password of a new account, stored beside the `users` row just created. */
export async function createCredentials(userId: string, password: string): Promise<void> {
  await storePassword(userId, password);
}

/** Sign an account out everywhere — when it is deactivated, or its password is replaced for it. */
export async function signOutEverywhere(userId: string): Promise<void> {
  await endUserSessions(userId);
}

// ── forgotten passwords ─────────────────────────────────────────────────────

export const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * A single-use reset token for an account, to be mailed as a link. Any earlier
 * unused token for the same account stops working: the newest email is the only
 * one that does.
 */
export async function createPasswordResetToken(userId: string): Promise<string> {
  const prisma = getPrisma();
  const reset = newOpaqueToken();
  await prisma.$transaction([
    prisma.password_reset_tokens.updateMany({ where: { user_id: userId, used_at: null }, data: { used_at: new Date() } }),
    prisma.password_reset_tokens.create({
      data: { token_hash: reset.hash, user_id: userId, expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000) },
    }),
  ]);
  return reset.token;
}

/**
 * Set a new password with a token from a reset email. The token is spent
 * whether or not what follows succeeds, and every device of the account is
 * signed out — a reset is what someone does when they think the password is
 * known to somebody else.
 */
export async function resetPasswordWithToken(token: string, password: string): Promise<{ userId: string; email: string }> {
  const prisma = getPrisma();
  const hash = hashToken(token);
  const spent = await prisma.password_reset_tokens.updateMany({
    where: { token_hash: hash, used_at: null, expires_at: { gt: new Date() } },
    data: { used_at: new Date() },
  });
  if (spent.count !== 1) {
    throw new AuthError(400, 'reset_link_invalid', 'This password reset link is invalid or has expired. Request a new one.');
  }
  const row = await prisma.password_reset_tokens.findUniqueOrThrow({
    where: { token_hash: hash },
    select: { user_id: true, users: { select: { email: true, status: true } } },
  });
  if (row.users.status !== 'active') {
    throw new AuthError(403, 'account_inactive', 'This account has been deactivated. Please contact your administrator.');
  }
  await setPassword(row.user_id, password, { mustChange: false });
  await endUserSessions(row.user_id);
  return { userId: row.user_id, email: row.users.email };
}
