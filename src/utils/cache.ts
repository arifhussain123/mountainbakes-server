// Tiny in-process TTL cache for hot, rarely-changing reads (products, categories,
// branches, settings). These are the same for every authenticated user, so a shared
// process-level cache cuts Firestore reads dramatically without external infra.
//
// Caveat: the cache is per-process. With a single API instance (the current deploy)
// invalidation is global and immediate. If the API is ever horizontally scaled, each
// instance keeps its own cache, so a write on one instance leaves others stale until
// the TTL lapses (bounded staleness). Swap this for Redis if multi-instance is needed.

type Entry = { value: unknown; expiresAt: number };

const store = new Map<string, Entry>();
const DEFAULT_TTL_MS = 60_000; // 60s — combined with invalidate-on-write, staleness is bounded

/** Return a cached value if present and unexpired, else undefined. */
export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

/** Store a value under `key` for `ttlMs` (default 60s). */
export function setCached(key: string, value: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Drop every entry whose key equals `prefix` or starts with `prefix:` — so
 * `invalidate('products')` clears both `products` and `products:cat1:true`.
 */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) {
    if (key === prefix || key.startsWith(`${prefix}:`)) store.delete(key);
  }
}
