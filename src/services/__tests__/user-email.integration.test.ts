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
 * Changing the address an account signs in with, end to end: the real auth and
 * users routers on a local server over pglite, every assertion made over HTTP
 * and then against what the database is left holding.
 *
 * The harness is auth.integration.test's. What is added to its tables are the
 * two shapes a business record takes around a user — a row that points at the
 * user by id with the address copied beside it (`orders`), and an append-only
 * log that refuses an UPDATE (`finance_audit_logs`) — because what the change
 * does and does not do to those is most of what is being promised.
 */

process.env['JWT_SECRET'] = 'test-secret-test-secret-test-secret-0123456789';

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
  create table login_sessions (id uuid primary key default gen_random_uuid(), auth_session_id uuid, revoked_at timestamptz, user_email text);
  create table login_attempts (id uuid primary key default gen_random_uuid());

  create table orders (
    id uuid primary key default gen_random_uuid(), branch_id uuid references branches(id),
    created_by uuid references users(id), created_by_name text, note jsonb);
  create table finance_audit_logs (id uuid primary key default gen_random_uuid(), actor_id uuid, actor_name text);
  create function app.finance_audit_immutable() returns trigger language plpgsql as $$
  begin
    raise exception 'finance_audit_logs is append-only (% attempted)', tg_op;
  end $$;
  create trigger finance_audit_no_update before update on finance_audit_logs
    for each row execute function app.finance_audit_immutable();
`;

const ADMIN = '10000000-0000-4000-8000-000000000001';
const MANAGER = '10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000003';
const BRANCH = '20000000-0000-4000-8000-000000000001';
const PASSWORD = 'Correct-Horse-9!';

let pg: PGlite;
let server: Server;
let base: string;

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

/** Ask for the change as the dialog does: the address twice, and maybe a reason. */
const change = (id: string, email: string, token?: string, extra: Record<string, unknown> = {}) =>
  call('POST', `/api/users/${id}/change-email`, { email, confirmEmail: email, ...extra }, token);

/** Everything about the accounts that a change of address must leave alone. */
const accounts = () =>
  sql(`select u.id, u.username, u.role::text as role, u.branch_id, u.branch_name, u.status::text as status, c.password_hash
         from users u left join user_credentials c on c.user_id = u.id order by u.id`);
const emailOf = async (id: string) => (await sql<{ email: string }>(`select email from users where id = $1`, [id]))[0]!.email;

before(async () => {
  pg = new PGlite();
  await pg.exec(`set time zone 'UTC'`);
  await pg.exec(STUBS);
  const dir = join(__dirname, '../../..');
  await pg.exec(`begin;${readFileSync(join(dir, 'db/history/migrations/20261009000149_custom_auth.sql'), 'utf8')}commit;`);
  await pg.exec(`begin;${readFileSync(join(dir, 'prisma/migrations/20261010000001_api_sessions_only/migration.sql'), 'utf8')}commit;`);

  await usePglite(pg);
  setPrisma(new PrismaClient({ adapter: new PrismaPGlite(pg) }));

  await sql(`insert into branches (id, name) values ($1, 'Gulberg')`, [BRANCH]);
  await sql(
    `insert into users (id, email, display_name, username, role, branch_id, branch_name) values
       ($1, 'admin@mb.test', 'The Admin', 'admin', 'super_admin', null, null),
       ($2, 'Gulberg@MB.test', 'A Manager', 'gulberg', 'branch_manager', $4, 'Gulberg'),
       ($3, 'other@mb.test', 'Someone Else', 'other', 'production_user', null, null)`,
    [ADMIN, MANAGER, OTHER, BRANCH],
  );
  const { createCredentials } = await import('../auth/auth.service');
  for (const id of [ADMIN, MANAGER, OTHER]) await createCredentials(id, PASSWORD);

  // What the manager did before the change, as the application records it.
  await sql(
    `insert into orders (branch_id, created_by, created_by_name, note) values
       ($1, $2, 'Gulberg@MB.test', '{"by": "gulberg@mb.test"}'),
       ($1, $2, 'gulberg@mb.test.pk', null)`,
    [BRANCH, MANAGER],
  );
  await sql(`insert into finance_audit_logs (actor_id, actor_name) values ($1, 'Gulberg@MB.test')`, [MANAGER]);
  await sql(`insert into login_sessions (user_email) values ('Gulberg@MB.test')`);

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

describe('who may change an address', () => {
  test('nobody without a session, and nobody but an administrator', async () => {
    assert.equal((await change(MANAGER, 'new@mb.test')).status, 401);
    const manager = await signInAs('gulberg');
    assert.equal((await change(OTHER, 'new@mb.test', manager.accessToken)).status, 403);
    assert.equal((await change(MANAGER, 'new@mb.test', manager.accessToken)).status, 403); // not even their own
    assert.equal(await emailOf(MANAGER), 'Gulberg@MB.test');
    assert.equal(await emailOf(OTHER), 'other@mb.test');
  });

  test('an account that does not exist is not found, whatever shape its id has', async () => {
    const { accessToken } = await signInAs('admin');
    assert.equal((await change('10000000-0000-4000-8000-0000000000ff', 'new@mb.test', accessToken)).status, 404);
    assert.equal((await change('not-an-id', 'new@mb.test', accessToken)).status, 404);
  });
});

describe('what is refused before anything changes', () => {
  test('an address that is not one, an empty one, and two that do not match', async () => {
    const { accessToken } = await signInAs('admin');
    const before = await accounts();
    for (const email of ['', '   ', 'not-an-address', 'two@@mb.test', 'new@mb']) {
      const res = await change(MANAGER, email, accessToken);
      assert.equal(res.status, 400, email);
      assert.equal(res.body.details[0].field, 'email');
    }
    const mismatch = await call('POST', `/api/users/${MANAGER}/change-email`, { email: 'new@mb.test', confirmEmail: 'mew@mb.test' }, accessToken);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.details[0].field, 'confirmEmail');
    assert.equal((await call('POST', `/api/users/${MANAGER}/change-email`, { email: 'new@mb.test' }, accessToken)).status, 400);
    assert.equal((await change(MANAGER, 'new@mb.test', accessToken, { reason: 'x'.repeat(301) })).status, 400);

    assert.equal(await emailOf(MANAGER), 'Gulberg@MB.test');
    assert.deepEqual(await accounts(), before);
  });

  test('the address the account already has, in any case and with stray spaces', async () => {
    const { accessToken } = await signInAs('admin');
    for (const email of ['Gulberg@MB.test', 'gulberg@mb.test', '  GULBERG@mb.test ']) {
      const res = await change(MANAGER, email, accessToken);
      assert.equal(res.status, 400, email);
      assert.match(res.body.error, /already this account/);
    }
    assert.equal(await emailOf(MANAGER), 'Gulberg@MB.test');
  });

  test('an address another account has, in any case — and no account is made or lost', async () => {
    const { accessToken } = await signInAs('admin');
    const before = await accounts();
    for (const email of ['other@mb.test', 'OTHER@mb.test', ' Admin@MB.test']) {
      const res = await change(MANAGER, email, accessToken);
      assert.equal(res.status, 409, email);
      assert.equal(res.body.error, 'This email address is already assigned to another account.');
    }
    assert.deepEqual(await accounts(), before);
    assert.equal(await emailOf(MANAGER), 'Gulberg@MB.test');
    assert.equal(await emailOf(OTHER), 'other@mb.test');
    await signInAs('other@mb.test');
  });
});

describe('changing the address', () => {
  test('is the same account afterwards: same id, branch, role, password and session', async () => {
    const admin = await signInAs('admin');
    const manager = await signInAs('gulberg@mb.test'); // signed in before the change
    const before = await accounts();
    const [{ n: branches }] = await sql<{ n: number }>(`select count(*)::int as n from branches`);

    const res = await change(MANAGER, '  Gulberg.Branch@MB.test ', admin.accessToken, { reason: '  Shared branch mailbox ' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { success: true, id: MANAGER, email: 'gulberg.branch@mb.test', previousEmail: 'Gulberg@MB.test' });

    // Trimmed and lower-cased, on the one row that already existed.
    assert.equal(await emailOf(MANAGER), 'gulberg.branch@mb.test');
    assert.deepEqual(await accounts(), before);
    assert.equal((await sql<{ n: number }>(`select count(*)::int as n from branches`))[0]!.n, branches);

    // The session they already had goes on working, and now names the new address.
    const me = await call('GET', '/api/auth/me', undefined, manager.accessToken);
    assert.equal(me.status, 200);
    assert.deepEqual([me.body.user.uid, me.body.user.email, me.body.user.branchId], [MANAGER, 'gulberg.branch@mb.test', BRANCH]);
    const renewed = await call('POST', '/api/auth/refresh', { refreshToken: manager.refreshToken });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.user.email, 'gulberg.branch@mb.test');
  });

  test('the new address signs in with the old password; the old address no longer does', async () => {
    const byNew = await signInAs('Gulberg.Branch@mb.test');
    assert.deepEqual([byNew.user['id'], byNew.user['branchId'], byNew.user['role']], [MANAGER, BRANCH, 'branch_manager']);
    assert.equal((await call('POST', '/api/auth/login', { identifier: 'gulberg@mb.test', password: PASSWORD })).status, 401);
    const byUsername = await signInAs('gulberg'); // the username was never part of it
    assert.equal(byUsername.user['email'], 'gulberg.branch@mb.test');
  });

  test('records still belong to the user, and say what they said', async () => {
    const orders = await sql(`select created_by, branch_id, created_by_name, note from orders order by created_by_name`);
    assert.deepEqual(orders, [
      { created_by: MANAGER, branch_id: BRANCH, created_by_name: 'Gulberg@MB.test', note: { by: 'gulberg@mb.test' } },
      { created_by: MANAGER, branch_id: BRANCH, created_by_name: 'gulberg@mb.test.pk', note: null },
    ]);
    assert.deepEqual(await sql(`select actor_id, actor_name from finance_audit_logs`), [{ actor_id: MANAGER, actor_name: 'Gulberg@MB.test' }]);
    assert.deepEqual(await sql(`select user_email from login_sessions where user_email is not null`), [{ user_email: 'Gulberg@MB.test' }]);
  });

  test('one audit line says who changed what, for which branch, and why', async () => {
    const lines = await sql(`select action, admin_id, admin_name, target_user_id, target_user_name, target_user_role::text as role, details from audit_logs where action = 'user_updated'`);
    assert.deepEqual(lines, [{
      action: 'user_updated',
      admin_id: ADMIN,
      admin_name: 'The Admin',
      target_user_id: MANAGER,
      target_user_name: 'A Manager',
      role: 'branch_manager',
      details: 'Email changed from Gulberg@MB.test to gulberg.branch@mb.test. Branch: Gulberg. Reason: Shared branch mailbox',
    }]);
  });

  test('the address just given up is free for another account; the one just taken is not', async () => {
    const { accessToken } = await signInAs('admin');
    assert.equal((await change(OTHER, 'gulberg.branch@mb.test', accessToken)).status, 409);
    assert.equal((await change(OTHER, 'gulberg@mb.test', accessToken)).status, 200);
    assert.equal(await emailOf(OTHER), 'gulberg@mb.test');
    assert.equal((await change(OTHER, 'other@mb.test', accessToken)).status, 200);
  });

  test('two administrators giving two accounts the same address: one of them is told no', async () => {
    const { accessToken } = await signInAs('admin');
    const [a, b] = await Promise.all([
      change(MANAGER, 'shared@mb.test', accessToken),
      change(OTHER, 'shared@mb.test', accessToken),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const holders = await sql<{ id: string }>(`select id from users where lower(email) = 'shared@mb.test'`);
    assert.equal(holders.length, 1);
    assert.equal(holders[0]!.id, a.status === 200 ? MANAGER : OTHER);
    const [{ n }] = await sql<{ n: number }>(`select count(*)::int as n from users`);
    assert.equal(n, 3);

    // Back to where the next tests expect them.
    if (a.status === 200) await sql(`update users set email = 'gulberg.branch@mb.test' where id = $1`, [MANAGER]);
    else await sql(`update users set email = 'other@mb.test' where id = $1`, [OTHER]);
  });

  test('a unique-constraint refusal the check did not foresee is the same plain no', async () => {
    // `users_email_key` compares exactly, the check in lower case: a row that
    // differs from the new address only by something the check normalises away
    // is how the constraint, not the check, comes to be what says no.
    await sql(`create unique index users_email_lower on users (lower(btrim(email)))`);
    await sql(`insert into users (id, email, role) values ('10000000-0000-4000-8000-0000000000aa', ' padded@mb.test', 'production_user')`);
    const { accessToken } = await signInAs('admin');
    const res = await change(OTHER, 'padded@mb.test', accessToken);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, 'This email address is already assigned to another account.');
    assert.equal(await emailOf(OTHER), 'other@mb.test');
    await sql(`delete from users where id = '10000000-0000-4000-8000-0000000000aa'`);
    await sql(`drop index users_email_lower`);
  });
});

describe('the server command, which rewrites the records as well', () => {
  const run = async (apply: boolean) => {
    const { changeUserEmail } = await import('../user-email.service');
    return changeUserEmail({
      user: { email: 'GULBERG.branch@mb.test' },
      to: 'branch.gulberg@mb.test',
      records: 'rewrite',
      apply,
      actor: { id: null, name: 'Server command' },
    });
  };

  test('a rehearsal reports the change and saves none of it', async () => {
    await sql(`update orders set created_by_name = 'gulberg.branch@mb.test', note = '{"by": "Gulberg.Branch@MB.test"}' where note is not null`);
    await sql(`update orders set created_by_name = 'gulberg.branch@mb.test.pk' where note is null`);
    const [{ n: lines }] = await sql<{ n: number }>(`select count(*)::int as n from audit_logs`);

    const result = await run(false);
    // (Earlier audit lines quote the address too, and are in the list as well.)
    assert.deepEqual(result.changed.filter((l) => !l.where.startsWith('audit_logs.')), [
      { where: 'users.email', rows: 1 },
      { where: 'orders.created_by_name', rows: 1 },
      { where: 'orders.note', rows: 1 },
    ]);
    assert.equal(await emailOf(MANAGER), 'gulberg.branch@mb.test');
    assert.equal((await sql<{ n: number }>(`select count(*)::int as n from audit_logs`))[0]!.n, lines);
    assert.equal((await sql<{ n: number }>(`select count(*)::int as n from orders where created_by_name = 'gulberg.branch@mb.test'`))[0]!.n, 1);
  });

  test('for real: copies are replaced, a longer address is not a match, an append-only table is left and named', async () => {
    // The log's one row, as it would read had the manager acted under the current address.
    await pg.exec(`alter table finance_audit_logs disable trigger finance_audit_no_update;
                   update finance_audit_logs set actor_name = 'gulberg.branch@mb.test';
                   alter table finance_audit_logs enable trigger finance_audit_no_update;`);

    const result = await run(true);
    assert.equal(await emailOf(MANAGER), 'branch.gulberg@mb.test');
    assert.deepEqual(
      await sql(`select created_by, created_by_name, note from orders order by created_by_name`),
      [
        { created_by: MANAGER, created_by_name: 'branch.gulberg@mb.test', note: { by: 'branch.gulberg@mb.test' } },
        { created_by: MANAGER, created_by_name: 'gulberg.branch@mb.test.pk', note: null },
      ],
    );
    assert.deepEqual(await sql(`select actor_name from finance_audit_logs`), [{ actor_name: 'gulberg.branch@mb.test' }]);
    assert.deepEqual(
      result.left.map((l) => [l.where, l.rows]),
      [['finance_audit_logs.actor_name', 1], ['orders.created_by_name', 1]],
    );
    assert.match(result.left[0]!.why!, /append-only/);

    // The audit line for this change still names the address that was replaced.
    const [line] = await sql<{ details: string; admin_id: string | null }>(`select details, admin_id from audit_logs order by created_at desc limit 1`);
    assert.equal(line!.details, 'Email changed from gulberg.branch@mb.test to branch.gulberg@mb.test. Branch: Gulberg');
    assert.equal(line!.admin_id, null);
    await signInAs('branch.gulberg@mb.test');
  });
});
