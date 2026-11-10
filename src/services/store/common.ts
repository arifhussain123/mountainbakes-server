import { dbFor } from '../../db';
import { rowToApi } from '../../utils/case';
import { notify, type NotifyInput } from '../push.service';
import { DEFAULT_STORE_FLAGS, type StoreAccountFlags, type UserRole } from '../../shared';

export const db = dbFor('store');

/** Who is acting: id, the name shown on records, the role, the account switches. */
export interface StoreActor {
  uid: string;
  name: string;
  role: UserRole;
  flags: StoreAccountFlags;
}

/**
 * A database refusal as the HTTP answer it means (same mapping as purchasing):
 *   P0002 → 404 · P0001 / 23505 → 409 · 22023 and bad-value codes → 400.
 */
export function clientError(err: unknown): Error {
  const e = err as { code?: string; message?: string };
  const status =
    e.code === 'P0002' ? 404
      : e.code === 'P0001' || e.code === '23505' ? 409
        : e.code === '22023' || e.code === '23514' || e.code === '22P02' || e.code === '22007' || e.code === '22008' ? 400
          : 500;
  const message =
    e.code === '23505' ? 'That was already recorded.'
      : e.code === '23514' ? 'A value is out of range. Check the figures and try again.'
        : (e.message ?? 'Database error');
  return Object.assign(new Error(message), { status });
}

export function httpError(status: number, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { status, ...(details === undefined ? {} : { details }) });
}

/** Run a store database function; throw its refusal as an HTTP error. */
export async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc<T>(fn, args);
  if (error) throw clientError(error);
  return data as T;
}

export const api = <T>(row: unknown): T => rowToApi<T>(row);

/** Search text safe to put inside a PostgREST-style `or(...)` filter. */
export const searchTerm = (s?: string) => s?.replace(/[(),*%]/g, ' ').trim() || '';

/** Today's business date (Asia/Karachi, 02:00 rollover), from the database clock. */
export async function businessDate(): Promise<string> {
  const { data, error } = await db.rpc<string>('store_business_date', {});
  if (error) throw clientError(error);
  return String(data).slice(0, 10);
}

/** Load the actor: display name and, for a Store keeper, Admin's switches. */
export async function loadActor(uid: string, email: string, role: UserRole): Promise<StoreActor> {
  const { data: u } = await db.from('users').select('display_name').eq('id', uid).maybeSingle();
  let flags: StoreAccountFlags = { ...DEFAULT_STORE_FLAGS };
  if (role === 'store_user') {
    const { data: a, error } = await db
      .from('store_accounts')
      .select('can_manage_items, can_edit_prices, can_adjust_stock, can_issue')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) throw clientError(error);
    if (a) flags = api<StoreAccountFlags>(a);
  }
  return { uid, name: (u?.['display_name'] as string | undefined)?.trim() || email, role, flags };
}

/** A notification must never undo the stock change that raised it. */
export async function tell(input: NotifyInput): Promise<void> {
  try {
    await notify(input);
  } catch (err) {
    console.error('[store] notification failed', input.type, err instanceof Error ? err.message : err);
  }
}

/** Read every row of a query in pages (reads are capped per statement). */
export async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>, size = 500): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw clientError(error);
    const rows = data ?? [];
    out.push(...api<T[]>(rows));
    if (rows.length < size) return out;
  }
}
