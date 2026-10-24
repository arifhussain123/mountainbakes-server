import { createHash } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import { dbFor } from '../db';
import type { AuthRequest } from './auth';

const db = dbFor('idempotency');

/**
 * Replay protection for `Idempotency-Key`.
 *
 * The mobile client commits a transaction to its own database first and sends it
 * afterwards, so every send can be retried: after a timeout, after a server
 * restart, after the app is killed mid-request. Without this, a retry of a
 * request the server already processed applies it twice — a second sale, with
 * real money against it, that nobody is looking for.
 *
 * The key is the client's `client_operation_id`, minted once when the
 * transaction is created and identical on every attempt. Storage and the claim
 * decision live in migration 84; this is the HTTP layer around it.
 *
 *   no header          → straight through, unchanged. Every existing caller
 *                        (the web app included) is unaffected.
 *   first request      → claim, run the handler, record what it answered
 *   repeat, completed  → the ORIGINAL response, never re-run. Stored as jsonb,
 *                        so fields and values are the original ones and only
 *                        key order may differ
 *   repeat, in flight  → 503 + Retry-After. Come back shortly.
 *   repeat, stale      → 409. A previous attempt died without recording an
 *                        outcome; a person has to check before it is sent again.
 *   same key, new body → 422. A client bug, surfaced rather than papered over.
 *
 * ── WHY A FAILED REQUEST GIVES THE KEY BACK ────────────────────────────────
 *
 * Only responses worth replaying are stored; everything else releases the claim.
 * A 409 'stock has changed' committed nothing, and storing it would mean the
 * queued sale could never succeed on a later retry — it would replay its own
 * refusal until a human deleted it. Releasing keeps the retry honest. The
 * exception is a request that failed AFTER moving something (a branch return
 * that committed three products before hitting a shortfall on the fourth):
 * `persistOn` keeps those, because re-running one double-applies the part that
 * did land.
 */

/** How long a claim may sit in flight before a repeat is treated as stale. */
const STALE_AFTER_SECONDS = 300;

/** Bounds on the header itself, so a hostile value cannot become a large row. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export interface IdempotencyOptions {
  /**
   * Whether this response is worth replaying. Default: 2xx only.
   *
   * Override where a non-2xx response can still have moved data.
   */
  persistOn?: (status: number, body: unknown) => boolean;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Stable hash of the request body.
 *
 * Keys are sorted at every level: two sends of the same transaction must
 * fingerprint identically, and `JSON.stringify` preserves insertion order, which
 * nothing guarantees across a serialise/deserialise round trip on the device.
 */
function fingerprint(body: unknown): string {
  return createHash('sha256').update(canonicalise(body)).digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

interface ClaimResult {
  outcome: 'claimed' | 'replay' | 'in_progress' | 'mismatch';
  stale?: boolean;
  responseStatus?: number;
  responseBody?: unknown;
}

/**
 * Guard the route against replay.
 *
 * Mount it AFTER `requireRole` — authorization is re-decided on every attempt,
 * including a replay — and BEFORE `validate`, so a replay returns the stored
 * answer without re-running the handler's input parsing.
 */
export function idempotent(endpoint: string, options: IdempotencyOptions = {}) {
  const persistOn = options.persistOn ?? ((status: number) => isSuccess(status));

  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const key = req.header(IDEMPOTENCY_HEADER);
    if (!key) { next(); return; }

    const userId = req.user?.uid;
    if (!userId) { next(); return; } // authenticate() has already rejected; belt and braces.

    if (!KEY_PATTERN.test(key)) {
      res.status(400).json({ error: 'Idempotency-Key must be 8–200 characters of A–Z, a–z, 0–9, dot, underscore, colon or hyphen.' });
      return;
    }

    let claim: ClaimResult;
    try {
      const { data, error } = await db.rpc('claim_idempotency_key', {
        p_user_id: userId,
        p_key: key,
        p_endpoint: endpoint,
        p_fingerprint: fingerprint(req.body),
        p_stale_seconds: STALE_AFTER_SECONDS,
      });
      if (error) throw error;
      claim = data as ClaimResult;
    } catch (err) {
      // The claim could not be taken, so replay protection is not in force for
      // this request. Refuse rather than process it unprotected: the caller
      // retries, and a queued transaction is never lost by being refused.
      next(Object.assign(new Error('Could not verify this request is not a duplicate. Please retry.'), {
        status: 503,
        cause: err,
      }));
      return;
    }

    switch (claim.outcome) {
      case 'mismatch':
        res.status(422).json({
          error: 'This Idempotency-Key was already used for a different request.',
        });
        return;

      case 'replay':
        res.setHeader('Idempotency-Replayed', 'true');
        res.status(claim.responseStatus ?? 200).json(claim.responseBody ?? {});
        return;

      case 'in_progress':
        if (claim.stale) {
          // Deliberately NOT re-run. See the migration header: an operation
          // parked for a person to check is recoverable, a duplicate sale is not.
          res.status(409).json({
            error: 'An earlier attempt at this transaction did not finish. Check whether it went through before sending it again.',
          });
          return;
        }
        res.setHeader('Retry-After', '5');
        res.status(503).json({
          error: 'This transaction is already being processed. It will be retried shortly.',
        });
        return;

      case 'claimed':
      default:
        break;
    }

    // Capture whatever the handler answers. `res.json` is the only exit used by
    // the routes and by the error handler, so wrapping it covers both.
    const sendJson = res.json.bind(res);
    let settled = false;

    res.json = (body: unknown): Response => {
      if (settled) return sendJson(body);
      settled = true;

      const status = res.statusCode;
      const keep = persistOn(status, body);

      const record = keep
        ? db.rpc('complete_idempotency_key', {
            p_user_id: userId,
            p_key: key,
            p_status: status,
            p_body: body ?? null,
          })
        : db.rpc('release_idempotency_key', { p_user_id: userId, p_key: key });

      void Promise.resolve(record)
        .then(({ error }) => {
          // A completion that fails to record leaves the claim in flight. The
          // transaction itself is committed and the response is still sent —
          // withholding it would be worse — but a retry then meets the stale
          // path above and is parked for a person rather than re-run.
          if (error) console.error(`[idempotency] failed to record ${endpoint} ${key}:`, error);
        })
        .catch((err) => console.error(`[idempotency] failed to record ${endpoint} ${key}:`, err))
        .finally(() => { sendJson(body); });

      return res;
    };

    // A connection dropped before the handler answered is NOT released. The
    // request may well have committed — a phone that gave up waiting is the
    // ordinary way that happens — and handing the key back would let the retry
    // apply it a second time. The claim stays, and the retry meets the stale
    // path above: parked for a person, which is recoverable.
    res.on('close', () => {
      if (settled) return;
      settled = true;
      console.warn(`[idempotency] ${endpoint} ${key} closed without a response; claim left in flight`);
    });

    next();
  };
}

/**
 * Keep a failure that still moved data.
 *
 * The branch-return route commits product by product and reports what it managed
 * before a shortfall stopped it, so its 409 is a record of real movement — re-
 * running it would return those units twice.
 */
export function persistIfCommitted(status: number, body: unknown): boolean {
  if (isSuccess(status)) return true;
  const committed = (body as { committed?: unknown[] } | null)?.committed;
  return Array.isArray(committed) && committed.length > 0;
}
