import { inFilter, notFilter, parseLogic, renderCond, textOf, type Cond } from './logic';

/** A filter as the caller gave it; turned into a condition when the clause is rendered. */
type FilterSpec = () => Cond;

/**
 * A WHERE clause, built with the query builder's own filter calls — `.eq`,
 * `.or`, `.is` and the rest — and rendered by the same code, so it is the same
 * grammar and the same SQL.
 *
 * The builder keeps one of these for its filters. It is exported for the one
 * thing a builder chain cannot say: an aggregate. A summary that must count
 * exactly the rows a list shows applies the list's filter helper to one of
 * these and puts the clause under its own `select sum(...)`, so the two never
 * disagree about which rows they mean.
 *
 * Each call is kept as a thunk and turned into a condition only by `render`,
 * so a malformed `.or()` string fails when the statement is built — inside the
 * builder's error handling — not while the chain is being written.
 */
export class WhereClause {
  private readonly filters: FilterSpec[] = [];

  constructor(private readonly table: string) {}

  eq(column: string, value: unknown): this { return this.compare('eq', column, value); }
  neq(column: string, value: unknown): this { return this.compare('neq', column, value); }
  gt(column: string, value: unknown): this { return this.compare('gt', column, value); }
  gte(column: string, value: unknown): this { return this.compare('gte', column, value); }
  lt(column: string, value: unknown): this { return this.compare('lt', column, value); }
  lte(column: string, value: unknown): this { return this.compare('lte', column, value); }
  like(column: string, pattern: string): this { return this.compare('like', column, pattern); }
  ilike(column: string, pattern: string): this { return this.compare('ilike', column, pattern); }

  private compare(op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike', column: string, value: unknown): this {
    this.filters.push(() => ({ column, op, negate: false, value: textOf(value) }));
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push(() => inFilter(column, values));
    return this;
  }

  is(column: string, value: boolean | null): this {
    this.filters.push(() => ({ column, op: 'is', negate: false, value: value === null ? 'null' : value ? 'true' : 'false' }));
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    this.filters.push(() => notFilter(column, operator, value));
    return this;
  }

  or(filters: string): this {
    this.filters.push(() => ({ join: 'or', negate: false, items: parseLogic(filters) }));
    return this;
  }

  /**
   * ` where …` over the table aliased `alias`, or '' when nothing was added.
   * Each value is appended to `params` and referred to by its `$n`, so the
   * caller binds anything of its own before or after, in statement order.
   */
  render(alias: string, params: unknown[]): string {
    if (this.filters.length === 0) return '';
    const ctx = {
      table: this.table,
      alias,
      bind: (value: string) => {
        params.push(value);
        return `$${params.length}`;
      },
    };
    return ` where ${this.filters.map((spec) => renderCond(spec(), ctx)).join(' and ')}`;
  }
}
