import { SqlQueryBuilder } from './builder';
import { prismaExecutor } from './prisma';
import { runRpc } from './rpc';
import type { Db, DbResult, Executor, QueryBuilder } from './types';

/**
 * The database, as the rest of the API sees it.
 *
 *     const db = dbFor('orders');
 *     const { data, error } = await db.from('orders').select('*').eq('id', id).maybeSingle();
 *     const { data, error } = await db.rpc('commit_sale', { p_order, p_items });
 *
 * Each chain becomes one SQL statement, run on Prisma's connection (./builder,
 * ./rpc). Results and errors have the `{ data, error, count }` shape described
 * in ./types.
 *
 * The name given to `dbFor` says which part of the API is asking. Nothing is
 * decided by it; it is there so that a module's database access can be found,
 * and one day routed or measured, by name.
 *
 * New code that is not built on this chain should not come here at all: it uses
 * Prisma Client (`getPrisma()` in ./prisma), with its typed models and
 * `$transaction`.
 */

/** The most rows one read returns, whatever it asked for. */
export const maxRows = () => Number(process.env.DB_MAX_ROWS) || 1000;

let executor: Executor = prismaExecutor;

/** Tests run the SQL layer on pglite instead of a server. */
export function setExecutor(next: Executor): void {
  executor = next;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function dbFor(module: string): Db {
  return {
    from: (table: string): QueryBuilder => new SqlQueryBuilder(executor, table, maxRows()),
    rpc: <T>(fn: string, args?: Record<string, unknown>): PromiseLike<DbResult<T>> =>
      runRpc<T>(executor, fn, args, maxRows()),
  };
}

export { getPrisma, disconnectPrisma } from './prisma';
export { DbError } from './types';
export type { Db, DbResult, Executor, QueryBuilder } from './types';
