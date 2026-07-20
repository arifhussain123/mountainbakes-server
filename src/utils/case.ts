/**
 * snake_case ↔ camelCase conversion at the Postgres boundary.
 *
 * The API contract is camelCase (the shared types in src/shared/types are what
 * the frontend compiles against), while Postgres columns are snake_case. Rather
 * than hand-maintaining a field map per table,
 * every route converts rows on the way out and payloads on the way in.
 *
 * Scope note: these walk plain objects and arrays only. Date, and any other
 * class instance, is returned as-is rather than being destructured into a plain
 * object — supabase-js hands back JSON scalars, so in practice values are
 * strings, numbers, booleans, null, arrays, or nested plain objects.
 */

/** `daily_budget` → `dailyBudget` */
export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `dailyBudget` → `daily_budget` */
export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function convertKeys<T>(value: unknown, convert: (key: string) => string): T {
  if (Array.isArray(value)) return value.map((v) => convertKeys(v, convert)) as T;
  if (!isPlainObject(value)) return value as T;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[convert(key)] = convertKeys(val, convert);
  }
  return out as T;
}

/** Postgres row(s) → API shape. */
export function rowToApi<T = Record<string, unknown>>(row: unknown): T {
  return convertKeys<T>(row, snakeToCamel);
}

/**
 * API payload → Postgres row shape.
 *
 * `undefined` values are dropped so a partial update never writes NULL over a
 * column the caller simply didn't mention. An explicit `null` IS preserved —
 * that is how the API clears a nullable field (e.g. managerId: null).
 */
export function apiToRow(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (val === undefined) continue;
    out[camelToSnake(key)] = convertKeys(val, camelToSnake);
  }
  return out;
}
