import { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';
import type { UserRole } from '../shared';

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: `Forbidden: requires one of [${roles.join(', ')}]` });
      return;
    }
    next();
  };
}
