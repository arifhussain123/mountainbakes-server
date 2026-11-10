import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { setPrisma } from '../../db/prisma';
import { usePglite } from '../../db/testing';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * The API's own sign-in, end to end: migration 149 applied verbatim in pglite,
 * the real auth and users routers mounted on a local server, and every
 * assertion made over HTTP — so what is tested is what a browser or a phone
 * would see, and what the database is left holding afterwards.
 *
 * Nothing is mocked but the mail transport: the database is a real Postgres
 * in the test process, and Prisma talks to it.
 */

process.env['JWT_SECRET'] = 'test-secret-test-secret-test-secret-0123456789';
process.env['NEXT_PUBLIC_WEB_URL'] = 'https://app.test';
process.env['SMTP_HOST'] = 'smtp.test';
process.env['SMTP_USER'] = 'no-reply@mb.test';
process.env['SMTP_PASS'] = 'x';

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema app;
  create type user_role as enum ('super_admin', 'branch_manager', 'production_user', 'finance_admin', 'finance_manager', 'accountant', 'finance_auditor');
  create type user_status as enum ('active', 'inactive', 'suspended');
  create table branches (id uuid primary key default gen_random_uuid(), name text not null);
  create table users (
    id uuid primary key, email text not null unique, display_name text, phone text, username text unique,
    role user_role not null, branch_id uuid references branches(id), branch_name text,
    status user_status not null default 'active', last_login_at timestamptz,
    must_change_password boolean default false, last_password_reset timestamptz,
    password_reset_by uuid, password_reset_by_name text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(), user_code text);
  create table audit_logs (
    id uuid primary key default gen_random_uuid(), legacy_id text, action text, admin_id uuid, admin_name text,
    target_user_id uuid, target_user_name text, target_user_role user_role, details jsonb,
    created_at timestamptz not null default now());
  create table notifications (
    id uuid primary key default gen_random_uuid(), legacy_id text, type text, title text, message text,
    is_read boolean not null default false, target_user_id uuid, target_role user_role, branch_id uuid,
    related_id uuid, created_at timestamptz not null default now());
  create table push_subscriptions (id uuid primary key default gen_random_uuid(), user_id uuid, endpoint text, p256dh text, auth text);
  -- Read by the request middleware; empty means nothing has been revoked.
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz);
  create table login_attempts (id uuid primary key default gen_random_uuid());
`;

const SESSIONS_ONLY = readFileSync(join(__dirname, '../../../prisma/migrations/20261010000001_api_sessions_only/migration.sql'), 'utf8');

const ADMIN = '10000000-0000-4000-8000-000000000001';
const MANAGER = '10000000-0000-4000-8000-000000000002';
const BRANCH = '20000000-0000-4000-8000-000000000001';
const PASSWORD = 'Correct-Horse-9!';

let pg: PGlite;
let server: Server;
let base: string;
const mail: { to: string; text: string }[] = [];

interface Reply { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const signInAs = async (identifier: string, password = PASSWORD) => {
  const res = await call('POST', '/api/auth/login', { identifier, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { accessToken: string; refreshToken: string; user: Record<string, unknown> };
};

const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => pg.query<T>(q, p).then((r) => r.rows);

before(async () => {
  pg = new PGlite();
  await pg.exec(`set time zone 'UTC'`);
  await pg.exec(STUBS);
  // One transaction, as it was applied — and on a database with no `auth`
  // schema, which is the kind the API serves from.
  const migration = readFileSync(join(__dirname, '../../../db/history/migrations/20261009000149_custom_auth.sql'), 'utf8');
  await pg.exec(`begin;${migration}commit;`);
  // The session and account functions as they are today: the API's own tables only.
  await pg.exec(`begin;${SESSIONS_ONLY}commit;`);

  await usePglite(pg);
  setPrisma(new PrismaClient({ adapter: new PrismaPGlite(pg) }));

  await sql(`insert into branches (id, name) values ($1, 'Gulberg')`, [BRANCH]);
  await sql(
    `insert into users (id, email, display_name, username, role, branch_id, branch_name) values
       ($1, 'Admin@MB.test', 'The Admin', 'admin', 'super_admin', null, null),
       ($2, 'manager@mb.test', 'A Manager', 'gulberg', 'branch_manager', $3, 'Gulberg')`,
    [ADMIN, MANAGER, BRANCH],
  );
  const { createCredentials } = await import('../auth/auth.service');
  await createCredentials(ADMIN, PASSWORD);
  await createCredentials(MANAGER, PASSWORD);

  const { setMailTransport } = await import('../mailer');
  setMailTransport({
    sendMail: async (message: { to: string; text: string }) => { mail.push({ to: message.to, text: message.text }); return {}; },
  } as never);

  const express = (await import('express')).default;
  const { router: authRouter } = await import('../../routes/auth.routes');
  const { router: usersRouter } = await import('../../routes/users.routes');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
});

describe('migration 149', () => {
  test('applies on a database with no auth schema, and again without complaint', async () => {
    const migration = readFileSync(join(__dirname, '../../../db/history/migrations/20261009000149_custom_auth.sql'), 'utf8');
    await pg.exec(`begin;${migration}commit;`);
    const [{ n }] = await sql<{ n: number }>(`select count(*)::int as n from user_credentials`);
    assert.equal(n, 2); // re-running did not disturb what was there
  });
});

describe('the session and account functions', () => {
  test('look nowhere but the API\'s own tables, and the migration can be applied again', async () => {
    await pg.exec(`begin;${SESSIONS_ONLY}commit;`);
    const bodies = await sql<{ proname: string; def: string }>(
      `select proname, pg_get_functiondef(oid) as def from pg_proc
        where proname in ('revoke_auth_session', 'revoke_all_auth_sessions', 'delete_user_account')`,
    );
    assert.equal(bodies.length, 3);
    for (const fn of bodies) assert.doesNotMatch(fn.def, /auth\.(users|sessions)|to_regclass/, fn.proname);
  });

  test('ending a session that is not there, or nobody\'s, is a plain no', async () => {
    const { dbFor } = await import('../../db');
    const nobody = '99999999-0000-4000-8000-000000000009';
    assert.equal((await dbFor('test').rpc('revoke_auth_session', { p_auth_session_id: nobody })).data, false);
    assert.equal((await dbFor('test').rpc('revoke_auth_session', { p_auth_session_id: null })).data, false);
    assert.equal((await dbFor('test').rpc('revoke_all_auth_sessions', { p_user_id: nobody })).data, 0);
    assert.equal((await dbFor('test').rpc('delete_user_account', { p_user_id: nobody })).data, false);
  });
});

describe('signing in', () => {
  test('by email in any case, or by username; role and branch come back with the tokens', async () => {
    const byEmail = await signInAs('admin@mb.test');
    assert.equal(byEmail.user['role'], 'super_admin');
    assert.equal(byEmail.user['email'], 'Admin@MB.test');
    const byUsername = await signInAs('Gulberg');
    assert.deepEqual(
      [byUsername.user['role'], byUsername.user['branchId'], byUsername.user['branchName'], byUsername.user['mustChangePassword']],
      ['branch_manager', BRANCH, 'Gulberg', false],
    );
    const viaEmailField = await call('POST', '/api/auth/login', { email: 'manager@mb.test', password: PASSWORD });
    assert.equal(viaEmailField.status, 200);
  });

  test('a username stored with capitals still signs in; two that differ only by case name nobody', async () => {
    await sql(`update users set username = 'GulBerg' where id = $1`, [MANAGER]);
    await signInAs('gulberg');
    await signInAs('GULBERG');
    await sql(`insert into users (id, email, username, role) values ('10000000-0000-4000-8000-0000000000aa', 'twin@mb.test', 'gulberg', 'production_user')`);
    assert.equal((await call('POST', '/api/auth/login', { identifier: 'gulberg', password: PASSWORD })).status, 401);
    await sql(`delete from users where id = '10000000-0000-4000-8000-0000000000aa'`);
    await sql(`update users set username = 'gulberg' where id = $1`, [MANAGER]);
  });

  test('a wrong password and an unknown account are told the same thing', async () => {
    const wrong = await call('POST', '/api/auth/login', { identifier: 'admin@mb.test', password: 'nope' });
    const unknown = await call('POST', '/api/auth/login', { identifier: 'nobody@mb.test', password: PASSWORD });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.body.details.code, 'invalid_credentials');
  });

  test('the access token identifies the caller to a protected route', async () => {
    const { accessToken } = await signInAs('gulberg');
    const me = await call('GET', '/api/auth/me', undefined, accessToken);
    assert.equal(me.status, 200);
    assert.deepEqual(
      { ...me.body.user, authSessionId: typeof me.body.user.authSessionId },
      { uid: MANAGER, email: 'manager@mb.test', role: 'branch_manager', branchId: BRANCH, branchName: 'Gulberg', authSessionId: 'string', authMethods: ['password'], googleEmail: null },
    );
    // …and role checks still apply: a branch manager is not an administrator.
    assert.equal((await call('GET', '/api/users', undefined, accessToken)).status, 403);
  });

  test('what is not one of our tokens is refused', async () => {
    const { accessToken } = await signInAs('gulberg');
    const [header, payload] = accessToken.split('.');
    const forged = (claims: object, alg: string) =>
      `${Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());

    for (const bad of [
      '',
      'garbage',
      `${header}.${payload}.${'A'.repeat(43)}`, // right claims, wrong signature
      forged(claims, 'none'), // "unsigned" token
      forged({ ...claims, sub: ADMIN }, 'HS256'), // somebody else, no signature
      forged({ iss: 'https://issuer.example/auth/v1', sub: ADMIN }, 'HS256'), // another issuer's token
    ]) {
      assert.equal((await call('GET', '/api/auth/me', undefined, bad)).status, 401, bad.slice(0, 40));
    }
  });
});

describe('staying signed in', () => {
  test('a refresh token is exchanged for a new pair, and each works once', async () => {
    const first = await signInAs('gulberg');
    const second = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.refreshToken, first.refreshToken);
    assert.equal(second.body.user.role, 'branch_manager');
    assert.equal((await call('GET', '/api/auth/me', undefined, second.body.accessToken)).status, 200);
  });

  test('the same token again within moments (two tabs, a retry) gets a token of its own', async () => {
    const first = await signInAs('gulberg');
    const a = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken });
    const b = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken });
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.notEqual(a.body.refreshToken, b.body.refreshToken);
    // Both branches of the chain stay usable.
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: a.body.refreshToken })).status, 200);
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: b.body.refreshToken })).status, 200);
  });

  test('a spent token presented later, after its successor was used, ends the session for both holders', async () => {
    const first = await signInAs('gulberg');
    const second = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken });
    const third = await call('POST', '/api/auth/refresh', { refreshToken: second.body.refreshToken });
    assert.equal(third.status, 200);
    await sql(`update auth_refresh_tokens set used_at = now() - interval '5 minutes' where used_at is not null`);

    const replay = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.details.code, 'session_revoked');
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: third.body.refreshToken })).status, 401);
    const me = await call('GET', '/api/auth/me', undefined, third.body.accessToken);
    assert.equal(me.status, 401);
    assert.equal(me.body.details.code, 'session_revoked');
  });

  test('a lost answer: the old token asked again later still renews, and the pair that never arrived is dropped', async () => {
    const first = await signInAs('gulberg');
    const lost = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(lost.status, 200);
    await sql(`update auth_refresh_tokens set used_at = now() - interval '5 minutes' where used_at is not null`);

    const retry = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(retry.status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, retry.body.accessToken)).status, 200);
    // The pair that never arrived no longer works…
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: lost.body.refreshToken })).status, 401);
    // …but that did not end the session: the retry's own token carries on.
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: retry.body.refreshToken })).status, 200);
  });

  test('a token that was never issued, and a session left unused too long', async () => {
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: 'never-issued' })).status, 401);
    const stale = await signInAs('gulberg');
    await sql(`update auth_sessions set expires_at = now() - interval '1 minute' where id = (select session_id from auth_refresh_tokens order by created_at desc limit 1)`);
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: stale.refreshToken })).status, 401);
    assert.equal((await call('GET', '/api/auth/me', undefined, stale.accessToken)).status, 401);
  });

  test('nothing a client holds is stored as it is', async () => {
    const { refreshToken } = await signInAs('gulberg');
    const [{ n }] = await sql<{ n: number }>(`select count(*)::int as n from auth_refresh_tokens where token_hash = $1`, [refreshToken]);
    assert.equal(n, 0);
    const [{ password_hash }] = await sql<{ password_hash: string }>(`select password_hash from user_credentials where user_id = $1`, [MANAGER]);
    assert.match(password_hash, /^\$2[ab]\$10\$/);
  });
});

describe('signing out, and being signed out', () => {
  test('signing out ends this device and no other', async () => {
    const phone = await signInAs('gulberg');
    const till = await signInAs('gulberg');
    assert.equal((await call('POST', '/api/auth/logout', {}, phone.accessToken)).status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, phone.accessToken)).status, 401);
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: phone.refreshToken })).status, 401);
    assert.equal((await call('GET', '/api/auth/me', undefined, till.accessToken)).status, 200);
  });

  test('an administrator ending a session (the Login History function) stops it at once', async () => {
    const { dbFor } = await import('../../db');
    const device = await signInAs('gulberg');
    const me = await call('GET', '/api/auth/me', undefined, device.accessToken);
    const ended = await dbFor('test').rpc('revoke_auth_session', { p_auth_session_id: me.body.user.authSessionId });
    assert.equal(ended.data, true);
    const after = await call('GET', '/api/auth/me', undefined, device.accessToken);
    assert.equal(after.status, 401);
    assert.equal(after.body.details.code, 'session_revoked');

    const [one, two] = [await signInAs('gulberg'), await signInAs('gulberg')];
    const keep = (await call('GET', '/api/auth/me', undefined, one.accessToken)).body.user.authSessionId;
    const all = await dbFor('test').rpc('revoke_all_auth_sessions', { p_user_id: MANAGER, p_keep_auth_session_id: keep });
    assert.ok(all.data >= 1);
    assert.equal((await call('GET', '/api/auth/me', undefined, one.accessToken)).status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, two.accessToken)).status, 401);
  });

  test('deactivating an account stops it on its next request, and reactivating lets it sign in again', async () => {
    const admin = await signInAs('admin@mb.test');
    const manager = await signInAs('gulberg');

    assert.equal((await call('DELETE', `/api/users/${MANAGER}`, undefined, admin.accessToken)).status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, manager.accessToken)).status, 401);
    assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: manager.refreshToken })).status, 401);
    const blocked = await call('POST', '/api/auth/login', { identifier: 'gulberg', password: PASSWORD });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.details.code, 'account_inactive');
    // The reason is given only to someone who knows the password.
    assert.equal((await call('POST', '/api/auth/login', { identifier: 'gulberg', password: 'nope' })).body.details.code, 'invalid_credentials');

    assert.equal((await call('POST', `/api/users/${MANAGER}/activate`, {}, admin.accessToken)).status, 200);
    await signInAs('gulberg');
  });

  test('a role changed by an administrator applies to the very next request', async () => {
    const admin = await signInAs('admin@mb.test');
    const manager = await signInAs('gulberg');
    assert.equal((await call('PUT', `/api/users/${MANAGER}`, { role: 'production_user', branchId: null }, admin.accessToken)).status, 200);
    const me = await call('GET', '/api/auth/me', undefined, manager.accessToken);
    assert.deepEqual([me.body.user.role, me.body.user.branchId], ['production_user', null]);
    assert.equal((await call('PUT', `/api/users/${MANAGER}`, { role: 'branch_manager', branchId: BRANCH }, admin.accessToken)).status, 200);
  });
});

describe('passwords', () => {
  test('an administrator creates an account, and it can sign in', async () => {
    const admin = await signInAs('admin@mb.test');
    const created = await call(
      'POST',
      '/api/users',
      { email: 'new@mb.test', displayName: 'New Person', phone: '03001234567', username: 'newperson', password: 'First-Pass-1!', role: 'production_user', branchId: null },
      admin.accessToken,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const session = await signInAs('new@mb.test', 'First-Pass-1!');
    assert.equal(session.user['id'], created.body.id);
    // The list of users never carries a hash.
    const list = await call('GET', '/api/users', undefined, admin.accessToken);
    assert.equal(JSON.stringify(list.body).includes('$2'), false);
  });

  test('a temporary password opens the change-password form and nothing else, until it is changed', async () => {
    const admin = await signInAs('admin@mb.test');
    const reset = await call('POST', `/api/users/${MANAGER}/reset-password`, { generateTemp: true, sendEmail: false, forceChange: true }, admin.accessToken);
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal((await call('POST', '/api/auth/login', { identifier: 'gulberg', password: PASSWORD })).status, 401);

    const temp = await signInAs('gulberg', reset.body.tempPassword);
    assert.equal(temp.user['mustChangePassword'], true);
    assert.equal((await call('GET', '/api/auth/me', undefined, temp.accessToken)).status, 200);
    const elsewhere = await call('GET', '/api/users', undefined, temp.accessToken);
    assert.equal(elsewhere.status, 403);
    assert.equal(elsewhere.body.details.code, 'password_change_required');

    const weak = await call('POST', '/api/auth/change-password', { newPassword: 'short' }, temp.accessToken);
    assert.equal(weak.status, 400);
    const other = await signInAs('gulberg', reset.body.tempPassword);
    assert.equal((await call('POST', '/api/auth/change-password', { newPassword: PASSWORD }, temp.accessToken)).status, 200);

    // This device carries on; the other one, signed in with the old password, does not.
    assert.equal((await call('GET', '/api/auth/me', undefined, temp.accessToken)).status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, other.accessToken)).status, 401);
    assert.equal((await signInAs('gulberg')).user['mustChangePassword'], false);
  });

  test('a forgotten password: only an administrator is sent a link, it works once, and it signs every device out', async () => {
    const refused = await call('POST', '/api/auth/forgot-password', { email: 'manager@mb.test', deliver: true });
    assert.equal(refused.status, 403);
    assert.equal((await call('POST', '/api/auth/forgot-password', { email: 'nobody@mb.test', deliver: true })).status, 403);
    assert.equal(mail.length, 0);

    // An app that has not been updated only asks whether it may; nothing is sent.
    assert.deepEqual((await call('POST', '/api/auth/forgot-password', { email: 'Admin@MB.test' })).body, { allowed: true });
    assert.equal(mail.length, 0);

    const signedIn = await signInAs('admin@mb.test');
    assert.deepEqual((await call('POST', '/api/auth/forgot-password', { email: 'Admin@MB.test', deliver: true })).body, { allowed: true });
    assert.equal(mail.length, 1);
    assert.equal(mail[0]!.to, 'Admin@MB.test');
    const token = /https:\/\/app\.test\/reset-password\?token=([^\s]+)/.exec(mail[0]!.text)![1]!;
    const [{ n }] = await sql<{ n: number }>(`select count(*)::int as n from password_reset_tokens where token_hash = $1`, [decodeURIComponent(token)]);
    assert.equal(n, 0); // only its hash is stored

    assert.equal((await call('POST', '/api/auth/password-reset/confirm', { token, newPassword: 'weak' })).status, 400);
    assert.equal((await call('POST', '/api/auth/password-reset/confirm', { token: 'not-a-token', newPassword: 'New-Pass-22!' })).status, 400);
    assert.equal((await call('POST', '/api/auth/password-reset/confirm', { token: decodeURIComponent(token), newPassword: 'New-Pass-22!' })).status, 200);
    assert.equal((await call('POST', '/api/auth/password-reset/confirm', { token: decodeURIComponent(token), newPassword: 'Another-33!' })).status, 400);

    assert.equal((await call('GET', '/api/auth/me', undefined, signedIn.accessToken)).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { identifier: 'admin@mb.test', password: PASSWORD })).status, 401);
    await signInAs('admin@mb.test', 'New-Pass-22!');
  });

  test('a second link replaces the first, and a link does not outlive its hour', async () => {
    mail.length = 0;
    await call('POST', '/api/auth/forgot-password', { email: 'Admin@MB.test', deliver: true });
    await call('POST', '/api/auth/forgot-password', { email: 'Admin@MB.test', deliver: true });
    const tokens = mail.map((m) => decodeURIComponent(/token=([^\s]+)/.exec(m.text)![1]!));
    assert.equal((await call('POST', '/api/auth/password-reset/confirm', { token: tokens[0], newPassword: 'New-Pass-44!' })).status, 400);
    await sql(`update password_reset_tokens set expires_at = now() - interval '1 minute' where used_at is null`);
    assert.equal((await call('POST', '/api/auth/password-reset/confirm', { token: tokens[1], newPassword: 'New-Pass-44!' })).status, 400);
    await signInAs('admin@mb.test', 'New-Pass-22!');
  });

  test('deleting an account takes its password and sessions with it', async () => {
    const admin = await signInAs('admin@mb.test', 'New-Pass-22!');
    const doomed = await signInAs('new@mb.test', 'First-Pass-1!');
    const id = doomed.user['id'] as string;
    assert.equal((await call('DELETE', `/api/users/${id}/permanent`, undefined, admin.accessToken)).status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, doomed.accessToken)).status, 401);
    const [{ n }] = await sql<{ n: number }>(
      `select (select count(*) from user_credentials where user_id = $1) + (select count(*) from auth_sessions where user_id = $1) as n`,
      [id],
    );
    assert.equal(Number(n), 0);
  });
});
