import { columnType, ident, tableInfo, tableRef } from './catalog';
import { failed, notOneRow, ok, toDbError } from './errors';
import { parseSelect, renderOrder, renderSelectList, type EmbedOrder } from './select';
import {
  DbError,
  type DbResult,
  type Executor,
  type OrderOptions,
  type QueryBuilder,
  type SelectOptions,
  type UpsertOptions,
  type WriteOptions,
} from './types';
import { WhereClause } from './where';

/**
 * The query builder: a PostgREST-style call chain in, one SQL statement out.
 *
 * WHY IT GENERATES SQL INSTEAD OF CALLING PRISMA CLIENT. The API's responses
 * are whatever Postgres serialises: money as JSON numbers, dates as
 * 'YYYY-MM-DD', timestamps with microseconds and `+00:00`. Prisma Client hands
 * back `Decimal`, `Date` and `BigInt` instead, and converting those back by
 * hand at 580 call sites is 580 chances to change a number on a receipt. So the
 * statement built here has Postgres turn the rows into JSON (`json_agg`) and
 * read the payload out of JSON (`json_populate_recordset`), the way PostgREST
 * builds its own, and the web and mobile apps get the bytes they were written
 * against. It runs on Prisma's connection; new code uses Prisma Client directly.
 *
 * ONE STATEMENT PER CALL. A write and the rows it returns are a single
 * statement, so it is atomic without a transaction around it.
 */

type Operation = 'select' | 'insert' | 'upsert' | 'update' | 'delete';

const MUTATION_GUARD = /"PGRST116:(\d+)"/;

export class SqlQueryBuilder implements QueryBuilder<any> {
  private operation: Operation = 'select';
  private columns = '*';
  /** The select string for the rows a write returns; null when it returns none. */
  private returning: string | null = null;
  private counting = false;
  private head = false;
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private upsertOptions: UpsertOptions = {};
  private readonly filters: WhereClause;
  private readonly orders: EmbedOrder[] = [];
  private readonly embedOrders = new Map<string, EmbedOrder[]>();
  private limitRows: number | null = null;
  private offsetRows = 0;
  private one: 'single' | 'maybe' | null = null;

  constructor(
    private readonly executor: Executor,
    private readonly table: string,
    private readonly maxRows: number,
  ) {
    this.filters = new WhereClause(table);
  }

  // ── what to do ───────────────────────────────────────────────────────────

  select(columns = '*', options: SelectOptions = {}): this {
    if (this.operation === 'select') {
      this.columns = columns;
      this.counting = options.count === 'exact';
      this.head = options.head === true;
    } else {
      // After a write, `.select()` asks for the written rows back.
      this.returning = columns;
    }
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[], options: WriteOptions = {}): this {
    return this.write('insert', values, options);
  }

  upsert(values: Record<string, unknown> | Record<string, unknown>[], options: UpsertOptions = {}): this {
    this.upsertOptions = options;
    return this.write('upsert', values, options);
  }

  update(values: Record<string, unknown>, options: WriteOptions = {}): this {
    return this.write('update', values, options);
  }

  delete(options: WriteOptions = {}): this {
    return this.write('delete', null, options);
  }

  private write(operation: Operation, values: Record<string, unknown> | Record<string, unknown>[] | null, options: WriteOptions): this {
    this.operation = operation;
    this.payload = values;
    this.counting = options.count === 'exact';
    return this;
  }

  // ── which rows ───────────────────────────────────────────────────────────

  eq(column: string, value: unknown): this { this.filters.eq(column, value); return this; }
  neq(column: string, value: unknown): this { this.filters.neq(column, value); return this; }
  gt(column: string, value: unknown): this { this.filters.gt(column, value); return this; }
  gte(column: string, value: unknown): this { this.filters.gte(column, value); return this; }
  lt(column: string, value: unknown): this { this.filters.lt(column, value); return this; }
  lte(column: string, value: unknown): this { this.filters.lte(column, value); return this; }
  like(column: string, pattern: string): this { this.filters.like(column, pattern); return this; }
  ilike(column: string, pattern: string): this { this.filters.ilike(column, pattern); return this; }
  in(column: string, values: readonly unknown[]): this { this.filters.in(column, values); return this; }
  is(column: string, value: boolean | null): this { this.filters.is(column, value); return this; }
  not(column: string, operator: string, value: unknown): this { this.filters.not(column, operator, value); return this; }
  or(filters: string): this { this.filters.or(filters); return this; }

  // ── in what order, how many ──────────────────────────────────────────────

  order(column: string, options: OrderOptions = {}): this {
    if (options.referencedTable) {
      const list = this.embedOrders.get(options.referencedTable) ?? [];
      list.push({ column, options });
      this.embedOrders.set(options.referencedTable, list);
    } else {
      this.orders.push({ column, options });
    }
    return this;
  }

  range(from: number, to: number): this {
    this.offsetRows = from;
    this.limitRows = to - from + 1;
    return this;
  }

  limit(count: number): this {
    this.limitRows = count;
    return this;
  }

  single(): this {
    this.one = 'single';
    return this;
  }

  maybeSingle(): this {
    this.one = 'maybe';
    return this;
  }

  // ── running it ───────────────────────────────────────────────────────────

  then<R1 = DbResult, R2 = never>(
    onfulfilled?: ((value: DbResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }

  /**
   * Never rejects for a database error: a failed query is a resolved
   * `{ data: null, error }`, and the call sites are written for that.
   */
  private async run(): Promise<DbResult> {
    try {
      return this.operation === 'select' ? await this.runSelect() : await this.runWrite();
    } catch (e) {
      return failed(toDbError(e));
    }
  }

  private where(alias: string, params: unknown[]): string {
    return this.filters.render(alias, params);
  }

  private async runSelect(): Promise<DbResult> {
    const params: unknown[] = [];
    const from = `${tableRef(this.table)} as _t`;
    tableInfo(this.table);
    const where = this.where('_t', params);
    const total = `(select count(*) from ${from}${where})`;

    if (this.head) {
      const [row] = await this.executor.query(`select ${total} as c`, params);
      return ok(null, this.counting ? Number(row!['c']) : null);
    }

    const list = renderSelectList(parseSelect(this.columns), this.table, '_t', this.embedOrders);
    const order = renderOrder(this.table, '_t', this.orders);
    // PostgREST never returns more than its configured maximum, whatever was
    // asked for; callers that need more page through in windows. A one-row
    // read needs two rows at most to know whether there was exactly one.
    const wanted = this.limitRows ?? (this.one ? 2 : this.maxRows);
    const page = ` limit ${Math.max(0, Math.min(wanted, this.maxRows))}${this.offsetRows > 0 ? ` offset ${this.offsetRows}` : ''}`;

    const sql =
      `select coalesce(json_agg(_q), '[]'::json) as r, ${this.counting ? total : 'null::bigint'} as c ` +
      `from (select ${list} from ${from}${where}${order}${page}) as _q`;
    const [row] = await this.executor.query(sql, params);
    const rows = row!['r'] as unknown[];
    const count = this.counting ? Number(row!['c']) : null;

    // A page that starts past the last row is an error only when the total is
    // known, i.e. when a count was asked for — PostgREST's rule, kept because
    // the pager in data-engine/queryBuilder.ts recovers from exactly this.
    if (count !== null && this.offsetRows > count) {
      return failed(
        new DbError({
          code: 'PGRST103',
          message: 'Requested range not satisfiable',
          details: `An offset of ${this.offsetRows} was requested, but there are only ${count} rows.`,
        }),
      );
    }

    if (this.one === 'single') {
      return rows.length === 1 ? ok(rows[0], count) : failed(notOneRow(rows.length, 'server'));
    }
    if (this.one === 'maybe') {
      return rows.length > 1 ? failed(notOneRow(rows.length, 'client')) : ok(rows[0] ?? null, count);
    }
    return ok(rows, count);
  }

  private async runWrite(): Promise<DbResult> {
    const params: unknown[] = [];
    const bindJson = (value: unknown) => {
      params.push(JSON.stringify(value));
      return `$${params.length}::text::json`;
    };
    const target = tableRef(this.table);
    const info = tableInfo(this.table);
    const knownColumn = (column: string) => {
      if (!Object.prototype.hasOwnProperty.call(info.columns, column)) {
        throw new DbError({
          code: 'PGRST204',
          message: `Could not find the '${column}' column of '${this.table}' in the schema cache`,
        });
      }
      return ident(column);
    };

    let statement: string;

    if (this.operation === 'insert' || this.operation === 'upsert') {
      const many = Array.isArray(this.payload);
      const rows = (many ? this.payload : [this.payload]) as Record<string, unknown>[];
      if (rows.length === 0) return this.nothingWritten();

      // A list is written with the union of its rows' keys, and a key one row
      // lacks is NULL for that row. A single object is written with the keys
      // it has, and every other column takes its default — PostgREST's rules
      // for a bulk and a single insert, which the call sites were written to.
      const keys = many
        ? [...new Set(rows.flatMap((r) => Object.keys(r)))]
        : Object.keys(rows[0]!).filter((k) => rows[0]![k] !== undefined);
      const cols = keys.map(knownColumn).join(', ');

      statement =
        keys.length === 0
          ? `insert into ${target} default values`
          : `insert into ${target} (${cols}) select ${cols} from json_populate_recordset(null::${target}, ${bindJson(rows)})`;

      if (this.operation === 'upsert') {
        const conflict = this.upsertOptions.onConflict
          ? this.upsertOptions.onConflict.split(',').map((c) => c.trim())
          : info.pk;
        const action =
          this.upsertOptions.ignoreDuplicates || keys.length === 0
            ? 'do nothing'
            : `do update set ${keys.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(', ')}`;
        statement += ` on conflict (${conflict.map(knownColumn).join(', ')}) ${action}`;
      }
      statement += ' returning *';
    } else if (this.operation === 'update') {
      const values = this.payload as Record<string, unknown>;
      const keys = Object.keys(values).filter((k) => values[k] !== undefined);
      if (keys.length === 0) return this.nothingWritten();
      const sets = keys.map((k) => `${knownColumn(k)} = _p.${ident(k)}`).join(', ');
      // The payload is bound before the filters so the parameter numbers follow
      // the order they appear in the statement.
      const source = `(select * from json_populate_record(null::${target}, ${bindJson(values)})) as _p`;
      statement = `update ${target} as _t set ${sets} from ${source}${this.where('_t', params)} returning _t.*`;
    } else {
      statement = `delete from ${target} as _t${this.where('_t', params)} returning _t.*`;
    }

    if (this.limitRows !== null) {
      throw new DbError({ message: `db.from('${this.table}'): limit/range on a write is not supported` });
    }

    const written = '(select count(*) from _src)';
    let result = 'null::json';
    if (this.returning !== null) {
      const list = renderSelectList(parseSelect(this.returning), this.table, '_t', this.embedOrders);
      const order = renderOrder(this.table, '_t', this.orders);
      result = `(select coalesce(json_agg(_q), '[]'::json) from (select ${list} from _src as _t${order}) as _q)`;

      // `.single()` on a write that did not touch exactly one row must leave
      // the database as it was: PostgREST fails the request and its
      // transaction with it. The same is achieved in one statement by making
      // the wrong row count a cast error — the statement aborts, the write
      // inside it is undone — and the error is turned back into PGRST116 below.
      //
      // `.maybeSingle()` is NOT guarded, deliberately: the write goes through
      // as an ordinary one, and only then is "more than one row" reported. A
      // write that matched several rows has always been applied, error or
      // not, and callers must not start seeing it undone.
      if (this.one === 'single') {
        result = `case when ${written} = 1 then ${result} else ('PGRST116:' || ${written})::int::text::json end`;
      }
    }

    let row: Record<string, unknown>;
    try {
      [row] = (await this.executor.query(`with _src as (${statement}) select ${result} as r, ${written} as c`, params)) as [
        Record<string, unknown>,
      ];
    } catch (e) {
      const error = toDbError(e);
      const guard = error.code === '22P02' ? MUTATION_GUARD.exec(error.message) : null;
      if (!guard) throw error;
      return failed(notOneRow(Number(guard[1]), 'server'));
    }

    const count = this.counting ? Number(row['c']) : null;
    if (this.returning === null) return ok(null, count);
    const rows = row['r'] as unknown[];
    if (this.one === 'maybe' && rows.length > 1) return failed(notOneRow(rows.length, 'client'));
    return ok(this.one ? (rows[0] ?? null) : rows, count);
  }

  /** An empty list to insert, or an update that sets nothing: PostgREST does nothing and says so. */
  private nothingWritten(): DbResult {
    const count = this.counting ? 0 : null;
    if (this.returning === null) return ok(null, count);
    if (this.one === 'single') return failed(notOneRow(0, 'server'));
    return ok(this.one ? null : [], count);
  }
}
