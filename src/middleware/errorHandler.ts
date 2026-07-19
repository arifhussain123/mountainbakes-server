import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

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

  const status = (err as { status?: number }).status || 500;
  // Client errors (4xx) carry actionable, user-facing messages (e.g. "business day
  // closed", "not found") — expose them. Server errors (5xx) stay masked in prod.
  const expose = status < 500 || process.env.NODE_ENV !== 'production';
  res.status(status).json({
    error: expose ? err.message : 'Internal server error',
  });
}
