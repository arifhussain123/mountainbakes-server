import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { DbError } from '../db/types';

/**
 * A database error that reached here untranslated — a route did `if (error)
 * throw error`. The SQL functions and triggers refuse things with `raise
 * exception` and a message written for the person at the screen ("this day is
 * closed", "changed by another user"), but a DbError has no `status`, so without
 * this every one of those became a masked 500. Codes not listed here (a missing
 * column, a syntax error) are genuine server faults and stay a 500.
 */
function dbErrorResponse(err: DbError): { status: number; message: string } | null {
  switch (err.code) {
    case 'P0001': // raise exception — a business rule
    case 'MBCON': // changed by another user
    case 'MBRSG': // salary claim refused after resignation
      return { status: 409, message: err.message };
    case '22023': // invalid_parameter_value, raised by the functions with a readable message
      return { status: 400, message: err.message };
    case '42501':
      return { status: 403, message: err.message };
    case 'P0002':
    case 'MBNFD':
      return { status: 404, message: err.message };
    case 'PGRST116':
      return { status: 404, message: 'That record was not found. It may have been deleted — refresh and try again.' };
    // Postgres' own constraint messages name tables and constraints, so they are
    // replaced with a plain sentence rather than shown.
    case '23505':
      return { status: 409, message: 'This already exists. Check for a duplicate entry and try again.' };
    case '23503':
      return { status: 409, message: 'This is linked to another record that is missing or still in use, so it cannot be saved or removed.' };
    case '23502':
      return { status: 400, message: 'A required field is missing. Fill in every required field and try again.' };
    case '23514':
      return {
        status: 400,
        message: err.message.startsWith('new row for relation')
          ? 'One of the values entered is not allowed. Check the form and try again.'
          : err.message,
      };
    default:
      return null;
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error('[Error]', err.message);

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation error',
      details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    });
    return;
  }

  // Multer rejects an oversized or unexpected upload by calling next(err) with a
  // MulterError, which carries no `status` — without this it would fall through
  // to the 500 branch below and be masked as "Internal server error" in
  // production. The user would see a generic failure for something they can
  // actually fix by retaking the photo.
  if (err instanceof MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? 'That file is too large. Retake the photo and try again.'
        : `Upload rejected: ${err.message}`,
    });
    return;
  }

  if (err instanceof DbError && !(err as { status?: number }).status) {
    const mapped = dbErrorResponse(err);
    if (mapped) {
      res.status(mapped.status).json({ error: mapped.message });
      return;
    }
  }

  const status = (err as { status?: number }).status || 500;
  // Client errors (4xx) carry actionable, user-facing messages (e.g. "business day
  // closed", "not found") — expose them. Server errors (5xx) stay masked in prod,
  // unless the thrower marked the message as written for the user (`expose:
  // true`) — e.g. AI Expense Capture's "not set up yet" (503) or "the AI took
  // too long" (504), which the finance user or administrator can act on.
  const expose = status < 500 || (err as { expose?: boolean }).expose === true || process.env.NODE_ENV !== 'production';
  // Optional structured payload alongside the message — e.g. the duplicate-income
  // check attaches { code, existing } so the frontend can offer a confirm-and-retry
  // instead of just a dead-end toast. Nothing else in the app sets this today, so
  // it's a no-op for every other thrown error.
  const details = (err as { details?: unknown }).details;
  res.status(status).json({
    error: expose ? err.message : 'Internal server error',
    ...(expose && details !== undefined ? { details } : {}),
  });
}
