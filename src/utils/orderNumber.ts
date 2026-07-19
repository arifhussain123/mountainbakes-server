import { supabaseAdmin } from '../config/supabase';

/**
 * Allocate the next order number ("MB-000125", ...).
 *
 * The increment-and-format lives in the `next_order_number()` SQL function
 * (migration 03), not here: a single UPDATE ... RETURNING is atomic under
 * Postgres row locking, which replaces the Firestore transaction that used to
 * wrap the read-modify-write. Two concurrent callers can no longer be handed the
 * same number, and the seed value (124) stays with the schema.
 */
export async function generateOrderNumber(): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc('next_order_number');
  if (error) throw new Error(`Failed to allocate an order number: ${error.message}`);
  if (!data) throw new Error('next_order_number() returned no value');
  return data as string;
}
