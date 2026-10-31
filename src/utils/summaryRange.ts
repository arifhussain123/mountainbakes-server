import { monthToDateRange } from '../shared';

/**
 * The window a page's summary cards cover, from its Date filter's `from`/`to`
 * query params (YYYY-MM-DD business dates).
 *
 *   - neither → this business month to date (1st → today), the default view;
 *   - `from` only → from that day to today;
 *   - `to` only → from the 1st of that day's month to that day;
 *   - both → exactly that range.
 *
 * So the cards above a table always cover the same days the table's Date
 * filter does. A range that ends before it starts is allowed, and sums to zero,
 * just as the table lists nothing for it.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type SummaryRangeResult =
  | { ok: true; range: { from: string; to: string } }
  | { ok: false; error: string };

export function summaryRangeFromQuery(query: Record<string, unknown>, now: Date = new Date()): SummaryRangeResult {
  const pick = (k: string) => {
    const v = query[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const from = pick('from');
  const to = pick('to');
  if (from !== undefined && !isRealDate(from)) return { ok: false, error: 'from must be a date (YYYY-MM-DD)' };
  if (to !== undefined && !isRealDate(to)) return { ok: false, error: 'to must be a date (YYYY-MM-DD)' };

  const monthToDate = monthToDateRange(now);
  if (from === undefined && to === undefined) return { ok: true, range: monthToDate };
  return {
    ok: true,
    range: {
      from: from ?? `${to!.slice(0, 7)}-01`,
      to: to ?? monthToDate.to,
    },
  };
}
