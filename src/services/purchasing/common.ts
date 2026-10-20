import { createHash, randomBytes } from 'node:crypto';
import { dbFor } from '../../db';
import { rowToApi } from '../../utils/case';
import { whatsappConfig } from '../whatsapp/config';

export const db = dbFor('purchasing');

export interface Actor {
  uid: string;
  name: string;
}

/**
 * A database refusal as the HTTP answer it means. The purchasing functions
 * raise with a SQLSTATE that says what kind of "no" it is, and a message
 * written for the person who will read it:
 *
 *   P0002  not found                       → 404
 *   P0001  not now (wrong state, conflict) → 409
 *   22023  bad input                       → 400
 *   23505  duplicate                       → 409
 *   23514 / 22P02 / 22007 / 22008          → 400
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

/** Run a database function; throw its refusal as an HTTP error. */
export async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc<T>(fn, args);
  if (error) throw clientError(error);
  return data as T;
}

export function notFound(what: string): Error {
  return Object.assign(new Error(`${what} not found`), { status: 404 });
}

export const api = <T>(row: unknown): T => rowToApi<T>(row);

// ── Supplier links ──────────────────────────────────────────────────────────

export interface IssuedLink {
  token: string;
  hash: string;
  expiresAt: string;
  url: string;
  /** The same link with the token masked: what is stored and displayed. */
  maskedUrl: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * A fresh supplier link: 32 random bytes, base64url. Only the hash is stored;
 * the token itself travels in the WhatsApp message and nowhere else. It sits
 * in the URL fragment, which browsers never send to the web server, so it
 * does not land in hosting logs either.
 */
export function issueLink(now = new Date()): IssuedLink {
  const cfg = whatsappConfig();
  const token = randomBytes(32).toString('base64url');
  const base = `${cfg.portalUrl}/supplier-portal/`;
  return {
    token,
    hash: hashToken(token),
    expiresAt: new Date(now.getTime() + cfg.linkTtlDays * 86_400_000).toISOString(),
    url: `${base}#t=${token}`,
    maskedUrl: `${base}#t=•••`,
  };
}

// ── Formatting for messages ─────────────────────────────────────────────────

export function rs(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `Rs. ${v.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function qty(n: number | string): string {
  return Number(n).toLocaleString('en-PK', { maximumFractionDigits: 3 });
}

export function day(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** '+923001234567' → '923001234567' (WhatsApp's own id for the contact). */
export function waId(e164: string): string {
  return e164.replace(/\D/g, '');
}
