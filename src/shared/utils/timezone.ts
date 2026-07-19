// Asia/Karachi is a fixed UTC+5 offset (no DST since 2009), so we avoid the
// date-fns-tz dependency and compute boundaries with plain Date math.
// All *ISO helpers return UTC ISO strings so they compare correctly against
// stored `createdAt` values (which are `new Date().toISOString()`).

const KARACHI_OFFSET = '+05:00';

/** A Date whose UTC fields read as Karachi wall-clock time. Internal use only. */
function toKarachiClock(d: Date): Date {
  return new Date(d.getTime() + 5 * 60 * 60 * 1000);
}

/** 'YYYY-MM-DD' for the given instant in Karachi (defaults to now). */
export function karachiDateStr(d: Date = new Date()): string {
  return toKarachiClock(d).toISOString().slice(0, 10);
}

/** 'HH:mm' for the given instant in Karachi (defaults to now). */
export function karachiTimeStr(d: Date = new Date()): string {
  return toKarachiClock(d).toISOString().slice(11, 16);
}

/** Minutes since Karachi midnight (0–1439). 10:00 AM === 600. */
export function karachiMinutesOfDay(d: Date = new Date()): number {
  const k = toKarachiClock(d);
  return k.getUTCHours() * 60 + k.getUTCMinutes();
}

/** UTC ISO bounds [start,end] of a Karachi calendar day. */
export function karachiDayBounds(dateStr: string = karachiDateStr()): { fromISO: string; toISO: string } {
  return {
    fromISO: new Date(`${dateStr}T00:00:00.000${KARACHI_OFFSET}`).toISOString(),
    toISO: new Date(`${dateStr}T23:59:59.999${KARACHI_OFFSET}`).toISOString(),
  };
}

/** Add `n` days to a 'YYYY-MM-DD' string (calendar-safe, UTC-based). */
function addDaysStr(dateStr: string, n: number): string {
  const base = new Date(`${dateStr}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + n);
  return base.toISOString().slice(0, 10);
}

/** UTC ISO bounds for a named period, anchored to "now" in Karachi. Week starts Monday. */
export function karachiRange(
  period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  now: Date = new Date(),
): { fromISO: string; toISO: string } {
  const todayStr = karachiDateStr(now);
  const [y, m] = todayStr.split('-').map(Number) as [number, number, number];

  if (period === 'daily') return karachiDayBounds(todayStr);

  if (period === 'monthly') {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { fromISO: karachiDayBounds(first).fromISO, toISO: karachiDayBounds(last).toISO };
  }

  if (period === 'yearly') {
    return { fromISO: karachiDayBounds(`${y}-01-01`).fromISO, toISO: karachiDayBounds(`${y}-12-31`).toISO };
  }

  // weekly — Monday..Sunday containing today
  const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const monday = addDaysStr(todayStr, -daysSinceMonday);
  const sunday = addDaysStr(monday, 6);
  return { fromISO: karachiDayBounds(monday).fromISO, toISO: karachiDayBounds(sunday).toISO };
}

/** Karachi date string N days ago (inclusive window helper for "last 7 days"). */
export function karachiDaysAgoStr(n: number, now: Date = new Date()): string {
  return addDaysStr(karachiDateStr(now), -n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Business day — the bakery operates 8:00 AM → 2:00 AM (next day). The business
// day rolls over at 2:00 AM Karachi: anything from 00:00–01:59 belongs to the
// PREVIOUS business date. This boundary is a fixed constant (not settings-driven)
// on purpose — changing it would silently reclassify which business day the
// midnight–2 AM records fall into.
// ─────────────────────────────────────────────────────────────────────────────

/** Karachi minutes-of-day at which the business day rolls over. 2:00 AM === 120. */
export const BUSINESS_DAY_START_MINUTES = 120;

/** Default order window when settings are absent. 8:00 AM === 480; 2:00 AM === 120. */
export const ORDER_WINDOW_OPEN_MINUTES = 480;
export const ORDER_WINDOW_CLOSE_MINUTES = 120;

/** 'HH:mm' → minutes since midnight (0–1439). Returns null on malformed input. */
export function hhmmToMinutes(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Business date 'YYYY-MM-DD' for an instant: shift the clock back by the rollover
 * offset, then take the Karachi calendar date. So 01:30 AM → previous day,
 * 02:00 AM → new day, 08:00 AM → same day.
 */
export function businessDateStr(d: Date = new Date()): string {
  return karachiDateStr(new Date(d.getTime() - BUSINESS_DAY_START_MINUTES * 60_000));
}

/** UTC ISO bounds [start,end] of a business day: date 02:00 → next-day 01:59:59.999 (Karachi). */
export function businessDayBounds(dateStr: string = businessDateStr()): { fromISO: string; toISO: string } {
  const startHH = String(Math.floor(BUSINESS_DAY_START_MINUTES / 60)).padStart(2, '0');
  const startMM = String(BUSINESS_DAY_START_MINUTES % 60).padStart(2, '0');
  const endMin = BUSINESS_DAY_START_MINUTES - 1; // last minute before the next rollover
  const endHH = String(Math.floor(endMin / 60)).padStart(2, '0');
  const endMM = String(endMin % 60).padStart(2, '0');
  const next = addDaysStr(dateStr, 1);
  return {
    fromISO: new Date(`${dateStr}T${startHH}:${startMM}:00.000${KARACHI_OFFSET}`).toISOString(),
    toISO: new Date(`${next}T${endHH}:${endMM}:59.999${KARACHI_OFFSET}`).toISOString(),
  };
}

/** Business date N days ago (inclusive window helper for "last N business days"). */
export function businessDaysAgoStr(n: number, now: Date = new Date()): string {
  return addDaysStr(businessDateStr(now), -n);
}

/** UTC ISO bounds for a named period anchored on the *business* date. Week starts Monday. */
export function businessRange(
  period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  now: Date = new Date(),
): { fromISO: string; toISO: string } {
  const todayStr = businessDateStr(now);
  const [y, m] = todayStr.split('-').map(Number) as [number, number, number];

  if (period === 'daily') return businessDayBounds(todayStr);

  if (period === 'monthly') {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { fromISO: businessDayBounds(first).fromISO, toISO: businessDayBounds(last).toISO };
  }

  if (period === 'yearly') {
    return { fromISO: businessDayBounds(`${y}-01-01`).fromISO, toISO: businessDayBounds(`${y}-12-31`).toISO };
  }

  // weekly — Monday..Sunday containing today's business date
  const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const monday = addDaysStr(todayStr, -daysSinceMonday);
  const sunday = addDaysStr(monday, 6);
  return { fromISO: businessDayBounds(monday).fromISO, toISO: businessDayBounds(sunday).toISO };
}

/**
 * Whether `minutesOfDay` (Karachi minutes-of-day) is inside an order window that
 * may wrap past midnight. Non-wrapping (open ≤ close): open ≤ m ≤ close.
 * Wrapping (open > close, e.g. 08:00 → 02:00): m ≥ open OR m ≤ close. Bounds are
 * inclusive, so 02:00 (120) is allowed and 02:01 (121) is not.
 */
export function isWithinOrderWindow(minutesOfDay: number, openMin: number, closeMin: number): boolean {
  return openMin <= closeMin
    ? minutesOfDay >= openMin && minutesOfDay <= closeMin
    : minutesOfDay >= openMin || minutesOfDay <= closeMin;
}
