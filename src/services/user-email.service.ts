import { getPrisma } from '../db';

/**
 * Change the email address an account signs in with.
 *
 * THE ACCOUNT IS THE SAME ACCOUNT AFTERWARDS. Sign-in is this API's own: the
 * address is one column, `users.email`, and the password and sessions hang off
 * the user's id. So the change is one UPDATE of one row — the id, the branch,
 * the password, the sessions and every record that points at the user stay
 * exactly as they were, and there is no second system to fall out of step
 * with. Nobody is signed out; the person signs in with the new address from
 * then on, at once (this system has no confirm-your-address step).
 *
 * WHAT HISTORY SAYS IS A SEPARATE DECISION (`records`).
 *
 *   'keep'     Nothing else is touched. Records point at the user by id; the
 *              `*_by_name` text beside the id, Login History and old audit
 *              lines are what was true when they were written, and go on
 *              naming the address used at the time. What an administrator
 *              gets from Users → Actions → Change Email Address.
 *
 *   'rewrite'  Every copy of the old address in every text and JSON column of
 *              every table is replaced as well — found by looking, not from a
 *              list that would go stale. The append-only tables (the finance
 *              audit log, bound attachments, ticket versions, salary
 *              revisions) refuse an UPDATE by trigger; this does not go around
 *              them, it reports how many rows each still holds. An address
 *              that is only part of a longer one (old@example.com.pk) is not a
 *              match and is reported the same way. Server command only.
 *
 * ONE TRANSACTION either way, and `apply: false` rehearses: the same
 * statements run and are rolled back, so the report is what would happen.
 * One `user_updated` line goes to the audit log, written last so that a
 * rewrite does not rewrite the line that is supposed to name the old address.
 */

/** Refused for a reason the caller can act on; `status` is the HTTP status. */
export class UserEmailError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface EmailChangeLine {
  /** `table.column` */
  where: string;
  rows: number;
  /** Only on a line that was left: the database's reason. */
  why?: string;
}

export interface EmailChangeResult {
  userId: string;
  from: string;
  to: string;
  displayName: string | null;
  role: string;
  status: string;
  branchId: string | null;
  changed: EmailChangeLine[];
  left: EmailChangeLine[];
}

export interface EmailChangeInput {
  /** The account, by id or by the address it has now. */
  user: { id: string } | { email: string };
  to: string;
  /** What to do with the copies of the old address in existing records. */
  records: 'keep' | 'rewrite';
  /** False rehearses: everything runs and nothing is saved. */
  apply: boolean;
  /** Who is doing it, for the audit line. `id` is null for a server command. */
  actor: { id: string | null; name: string };
  /** Why, in the administrator's words — goes on the audit line. */
  reason?: string | null;
}

const TAKEN = 'This email address is already assigned to another account.';

// Narrower than what a mail server accepts, on purpose: the new address goes
// into regexp_replace as the replacement, where a backslash would mean something.
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The address as a whole, not as the start, end or middle of a longer one. */
function wholeAddress(address: string): string {
  const literal = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?<![[:alnum:]._%+-])${literal}(?![[:alnum:]-]|\\.[[:alnum:]])`;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

interface UserRow {
  id: string; email: string; display_name: string | null; role: string; status: string;
  branch_id: string | null; branch_name: string | null;
}
interface Column { schema: string; table: string; column: string; type: string; text: boolean }
type Tx = Pick<ReturnType<typeof getPrisma>, '$queryRawUnsafe' | '$executeRawUnsafe'>;

class Rehearsal extends Error {}

export async function changeUserEmail(input: EmailChangeInput): Promise<EmailChangeResult> {
  // Lower case, as Login Attempts already keys a typed address: two spellings
  // of one address are then the same string to the unique constraint.
  const to = input.to.trim().toLowerCase();
  if (!ADDRESS.test(to)) throw new UserEmailError(400, 'That is not an email address this system can use.');
  if ('id' in input.user && !UUID.test(input.user.id)) throw new UserEmailError(404, 'User not found');

  const changed: EmailChangeLine[] = [];
  const left: EmailChangeLine[] = [];
  let user: UserRow | undefined;

  try {
    await getPrisma().$transaction(
      async (tx) => {
        const select = 'select id, email, display_name, role::text as role, status::text as status, branch_id, branch_name from public.users';
        [user] = 'id' in input.user
          ? await tx.$queryRawUnsafe<UserRow[]>(`${select} where id = $1::uuid for update`, input.user.id)
          : await tx.$queryRawUnsafe<UserRow[]>(`${select} where lower(email) = lower($1) for update`, input.user.email.trim());
        if (!user) {
          throw new UserEmailError(404, 'id' in input.user ? 'User not found' : `No account has the email ${input.user.email}`);
        }
        const from = user.email;
        if (from.toLowerCase() === to) throw new UserEmailError(400, "That is already this account's email address.");
        const taken = await tx.$queryRawUnsafe<unknown[]>('select 1 from public.users where lower(email) = $1 and id <> $2::uuid', to, user.id);
        if (taken.length > 0) throw new UserEmailError(409, TAKEN);

        // The check above cannot see a change another administrator has not
        // committed yet; the unique constraint can, and is what decides. The
        // address is the only unique thing this statement writes.
        try {
          await tx.$executeRawUnsafe('update public.users set email = $1 where id = $2::uuid', to, user.id);
        } catch (err) {
          if (/23505|unique constraint/i.test(`${describe(err)} ${err instanceof Error ? err.message : ''}`)) throw new UserEmailError(409, TAKEN);
          throw err;
        }
        changed.push({ where: 'users.email', rows: 1 });

        if (input.records === 'rewrite') await rewriteRecords(tx, from, to, changed, left);

        const reason = (input.reason ?? '').trim();
        await tx.$executeRawUnsafe(
          `insert into public.audit_logs (action, admin_id, admin_name, target_user_id, target_user_name, target_user_role, details)
           values ('user_updated', $1::uuid, $2, $3::uuid, $4, $5::public.user_role, to_jsonb($6::text))`,
          input.actor.id,
          input.actor.name,
          user.id,
          user.display_name,
          user.role,
          [
            `Email changed from ${from} to ${to}`,
            user.branch_name && `Branch: ${user.branch_name}`,
            reason && `Reason: ${reason}`,
          ].filter(Boolean).join('. '),
        );

        if (!input.apply) throw new Rehearsal();
      },
      { maxWait: 15_000, timeout: input.records === 'rewrite' ? 10 * 60_000 : 15_000 },
    );
  } catch (err) {
    if (!(err instanceof Rehearsal)) throw err;
  }

  const account = user!;
  return {
    userId: account.id,
    from: account.email,
    to,
    displayName: account.display_name,
    role: account.role,
    status: account.status,
    branchId: account.branch_id,
    changed,
    left,
  };
}

/** Replace `from` with `to` wherever a text or JSON column of any table holds it. */
async function rewriteRecords(tx: Tx, from: string, to: string, changed: EmailChangeLine[], left: EmailChangeLine[]): Promise<void> {
  // A whole-table scan per table; the pool's limit is for API requests.
  await tx.$executeRawUnsafe('set local statement_timeout = 0');

  const columns = await tx.$queryRawUnsafe<Column[]>(`
    select n.nspname as schema, c.relname as "table", a.attname as "column",
           format_type(a.atttypid, a.atttypmod) as type, t.typcategory = 'S' as text
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid
     where n.nspname in ('public', 'app')
       and c.relkind in ('r', 'p') and not c.relispartition
       and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and (t.typcategory = 'S' or t.typname in ('json', 'jsonb', '_text', '_varchar'))
     order by n.nspname, c.relname, a.attnum`);

  const tables = new Map<string, Column[]>();
  for (const col of columns) {
    const key = `${ident(col.schema)}.${ident(col.table)}`;
    tables.set(key, [...(tables.get(key) ?? []), col]);
  }

  const pattern = wholeAddress(from);
  for (const [table, cols] of tables) {
    // One pass over the table: per column, the rows that hold the address as a
    // whole (m) and the rows that hold those characters at all (s).
    const counts = (await tx.$queryRawUnsafe<Record<string, number>[]>(
      `select ${cols
        .map((c, i) => `count(*) filter (where ${ident(c.column)}::text ~* $1)::int as m${i}, count(*) filter (where position(lower($2) in lower(${ident(c.column)}::text)) > 0)::int as s${i}`)
        .join(', ')} from ${table}`,
      pattern,
      from,
    ))[0]!;

    for (const [i, col] of cols.entries()) {
      const where = `${col.table}.${col.column}`;
      const whole = counts[`m${i}`]!;
      const any = counts[`s${i}`]!;
      if (any > whole) left.push({ where, rows: any - whole, why: 'part of a longer address or word' });
      if (whole === 0) continue;

      // A string column takes the text as it is, so a value too long for it is
      // an error rather than a silent cut. JSON and arrays go back through
      // their own type.
      const value = `regexp_replace(${ident(col.column)}::text, $1, $2, 'gi')`;
      await tx.$executeRawUnsafe('savepoint one_column');
      try {
        const n = await tx.$executeRawUnsafe(
          `update ${table} set ${ident(col.column)} = ${col.text ? value : `(${value})::${col.type}`} where ${ident(col.column)}::text ~* $1`,
          pattern,
          to,
        );
        await tx.$executeRawUnsafe('release savepoint one_column');
        changed.push({ where, rows: n });
      } catch (err) {
        await tx.$executeRawUnsafe('rollback to savepoint one_column');
        left.push({ where, rows: whole, why: describe(err).trim().split('\n').pop()!.replace(/^(ERROR|Message):\s*/i, '').slice(0, 140) });
      }
    }
  }
}

/** The database's own words for an error Prisma has wrapped. */
function describe(err: unknown): string {
  const meta = (err as { meta?: { message?: unknown; driverAdapterError?: { cause?: { message?: unknown; originalMessage?: unknown } } } }).meta;
  const cause = meta?.driverAdapterError?.cause;
  return String(cause?.originalMessage ?? cause?.message ?? meta?.message ?? (err instanceof Error ? err.message : err));
}
