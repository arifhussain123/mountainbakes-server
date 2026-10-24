/**
 * Resolve an IP address to a country and city, best-effort.
 *
 * Used by ONE caller — opening a login session — and built around the fact that
 * it must never be able to break that caller. A login that was really made is a
 * fact; the city it was made from is a nicety. So every failure path here
 * returns empty rather than throwing: a provider outage, a rate limit, a
 * malformed answer and a slow network all end in the same place, and the session
 * row is written with null geo columns.
 *
 * PROVIDER. ipapi.co over HTTPS, no account and no key. Chosen over the more
 * commonly cited ip-api.com because that one is plaintext HTTP on its free tier,
 * and shipping staff IP addresses across the internet unencrypted to learn a
 * city name is a bad trade. The free tier is ~1,000 lookups a day, which this
 * uses a tiny fraction of: one lookup per NEW session, never per ping, and
 * cached per IP on top of that. `GEOIP_URL` overrides the endpoint if you later
 * move to a paid provider — it is a template with `{ip}` in it.
 *
 * PRIVACY. The IP is sent to a third party. Nothing else is: not the email, not
 * the role, not the branch. If that trade is unwanted, set `GEOIP_ENABLED=false`
 * and the columns stay null while everything else keeps working.
 */

import type { LocationSource } from '../shared';

const DEFAULT_URL = 'https://ipapi.co/{ip}/json/';

/**
 * A lookup is allowed a little under three seconds.
 *
 * This sits inside the request that opens a login session, so it is time the
 * user spends watching their dashboard load. Long enough for a healthy provider
 * on a slow link, short enough that a dead one costs a noticeable pause and not
 * a hung page.
 */
const TIMEOUT_MS = 2_800;

/** How long a resolved IP is trusted. A shop signs in from the same IP daily. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on distinct IPs held. Bounded because this Map lives for the life of the
 * server; 500 covers every plausible staff network many times over, and the whole
 * cache is dropped rather than evicted one by one — the cost of a cold cache is
 * one extra lookup per IP, which is not worth an LRU to avoid.
 */
const CACHE_MAX = 500;

export interface GeoLocation {
  country: string | null;
  countryCode: string | null;
  city: string | null;
  region: string | null;
  /**
   * IANA zone the ADDRESS resolves to, e.g. 'Asia/Karachi'.
   *
   * Emphatically not the browser's own `Intl.DateTimeFormat().resolvedOptions()
   * .timeZone`, which is client-reported and edited in a settings pane. This one
   * is derived from the same lookup as the city, which is what makes the
   * disagreement worth showing: a session whose device claims Karachi from a
   * London address is exactly the row a security screen exists to surface.
   */
  timezone: string | null;
  /**
   * Centroid of whatever the provider matched — a city, or a network block.
   *
   * NOT WHERE ANYBODY WAS STANDING, and the reason `source` below exists. ipapi.co
   * returns the middle of the city it assigns the address to, so every login from
   * a city shares one pair of coordinates. Stored because "same city" and "same
   * point" are different questions when comparing two sessions, and shown only
   * next to the source that qualifies it.
   */
  latitude: number | null;
  longitude: number | null;
  /**
   * How the answer was obtained — 'IP' when the provider resolved it, 'UNKNOWN'
   * when it did not.
   *
   * Returned rather than assumed by the caller, so a row's `location_source`
   * column can never disagree with whether a lookup actually succeeded. The
   * third value the column accepts, 'DEVICE_GPS', can never come from here:
   * this module only ever asks a database about an address.
   */
  source: LocationSource;
}

const EMPTY: GeoLocation = {
  country: null,
  countryCode: null,
  city: null,
  region: null,
  timezone: null,
  latitude: null,
  longitude: null,
  source: 'UNKNOWN',
};

const cache = new Map<string, { at: number; value: GeoLocation }>();

/**
 * Addresses no public provider can say anything useful about.
 *
 * Covers loopback, RFC1918 private ranges, link-local and IPv6 unique-local, so
 * a developer on localhost and a device behind a VPN that forwards its internal
 * address both skip the network call instead of spending 2.8 seconds learning
 * nothing.
 */
function isUnresolvable(ip: string): boolean {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.') || ip.startsWith('fe80:')) return true;
  // IPv6 unique-local: fc00::/7.
  if (/^f[cd]/i.test(ip)) return true;
  return false;
}

/**
 * A coordinate, or null.
 *
 * Providers variously send a number, a numeric string, or an empty string, and
 * `Number('')` is 0 — which would place every unresolved address in the Gulf of
 * Guinea. So an empty value is rejected before conversion, and the result is
 * range-checked: a value outside ±90 / ±180 is not a coordinate, whatever it is.
 */
function coord(value: unknown, limit: number): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
}

/** ipinfo.io's `loc: "24.8607,67.0011"` — index 0 is latitude, 1 is longitude. */
function locPart(loc: unknown, index: 0 | 1): string | null {
  if (typeof loc !== 'string') return null;
  return loc.split(',')[index]?.trim() || null;
}

/** Empty string, 'null', 'undefined' and 'Unknown' all mean "the provider does not know". */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^(null|undefined|unknown)$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Look up one IP. Never throws, never rejects.
 *
 * The shape below is ipapi.co's; the field names are also the ones ipinfo.io and
 * freeipapi.com use for the same values, so a swap of `GEOIP_URL` alone has a
 * fair chance of working. `error: true` is how ipapi.co reports a rate limit —
 * with HTTP 200 — so the body is checked as well as the status.
 */
export async function lookupIp(ip: string | null | undefined): Promise<GeoLocation> {
  if (process.env['GEOIP_ENABLED'] === 'false') return EMPTY;
  if (!ip || isUnresolvable(ip)) return EMPTY;

  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const template = process.env['GEOIP_URL'] || DEFAULT_URL;
  const url = template.replace('{ip}', encodeURIComponent(ip));

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'mountain-bakes-server' },
    });
    if (!res.ok) return EMPTY;

    const body = (await res.json()) as Record<string, unknown>;
    if (body['error']) return EMPTY;

    const value: GeoLocation = {
      country: clean(body['country_name']) ?? clean(body['country']),
      countryCode: clean(body['country_code']) ?? clean(body['countryCode']),
      city: clean(body['city']),
      region: clean(body['region']) ?? clean(body['regionName']),
      // `timezone` on ipapi.co and ipinfo.io, `timeZone` on freeipapi.com — both
      // spellings are read so a GEOIP_URL swap keeps working, which is the whole
      // reason the other fields are read in pairs too.
      timezone: clean(body['timezone']) ?? clean(body['timeZone']),
      // `latitude`/`longitude` on ipapi.co and freeipapi.com; ipinfo.io packs
      // both into one `loc: "24.86,67.01"` string, which is read here too so a
      // GEOIP_URL swap keeps working — the same pair-of-spellings treatment
      // every other field above gets.
      latitude: coord(body['latitude'] ?? body['lat'] ?? locPart(body['loc'], 0), 90),
      longitude: coord(body['longitude'] ?? body['lon'] ?? locPart(body['loc'], 1), 180),
      // Set only on an answer that resolved something. A response that came back
      // 200 with every field empty is not a location, and calling it one would
      // put 'IP' on a row that knows nothing.
      source: 'IP',
    };
    // A 200 with every field empty is not a location. Returning EMPTY rather
    // than a `source: 'IP'` row of nulls is what keeps `location_source` honest:
    // it must say 'IP' only where an address really did resolve to somewhere.
    //
    // This is also the "do not cache a blank answer" guard it replaced — caching
    // one would hold a transient rate-limit response for a day and blank every
    // subsequent login from that IP.
    if (!value.country && !value.city) return EMPTY;

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(ip, { at: Date.now(), value });
    return value;
  } catch {
    // Timeout, DNS failure, non-JSON body — all the same outcome. Not logged at
    // error level: a provider being down is not this app misbehaving, and one
    // line per login would drown the server log.
    return EMPTY;
  }
}
