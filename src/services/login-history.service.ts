import { dbFor } from '../db';
import {
  businessDateStr,
  businessDaysAgoStr,
  type ActiveSessionGroup,
  type ActiveSessionsResponse,
  type LoginHistoryFilters,
  type LoginHistoryPage,
  type LoginSession,
  type LoginSessionState,
  type LoginStatus,
  type GeoPosition,
  type RevokeSessionResult,
  type UserRole,
} from '../shared';
import { rowToApi } from '../utils/case';
import { maskEmail } from '../utils/mask';
import { parseUserAgent, describeDevice } from '../utils/userAgent';
import { lookupIp } from './geoip.service';
import { reverseGeocode } from './geocode.service';
import { logAudit } from './audit.service';
import { alertSuspiciousLogin, detectSuspicion } from './login-security.service';
import { resumeVerdict } from './login-identity.service';

const db = dbFor('login-history');

/**
 * Login History & Active Sessions — opening, keeping, reading and ending
 * sessions.
 *
 * The client drives the first three: each app opens its row once it has signed
 * in, pings to keep it, and closes it on the way out. Everything identifying
 * still comes off the verified token here, never off the body.
 *
 * The fourth — ending somebody else's session — is the half added by migration
 * 98, and it is the only part of this module that CHANGES anything outside its
 * own table. See `revokeSession` for why it takes two mechanisms rather than one.
 *
 * See the headers of migrations 20260822000085 and 20260901000098 for the
 * table's own reasoning.
 */

/**
 * Silence after which an un-ended session is read as expired.
 *
 * The client pings on its existing 2-minute refresh tick, so this is five missed
 * pings. Generous on purpose: a laptop that sleeps for four minutes, a phone
 * that backgrounds the tab and a spell of bad signal are all ordinary, and
 * calling any of them "logged out" would make the duration column lie in the
 * direction that matters least — nobody is harmed by a session that reads five
 * minutes longer than it was, and a session chopped into fragments every time a
 * screen locked would be useless.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Silence after which a still-open session is called idle rather than active.
 *
 * Three missed pings, against the five that make it expired. Configurable
 * through `LOGIN_SESSION_IDLE_MINUTES` because what counts as "gone quiet"
 * depends on how the shops actually work — a till that is used in bursts and a
 * back-office laptop that sits open all day want different answers, and the
 * right number is discovered in operation rather than argued about here.
 *
 * WHAT IT DOES NOT MEAN. Not "the person stepped away": the ping is on a timer
 * and fires whether or not anybody is typing, so it reports that the TAB is
 * open, never that somebody is at it. Idle means the tab stopped checking in —
 * backgrounded, asleep, or on bad signal — which is the honest reading and the
 * one the UI gives.
 *
 * Clamped between one minute and the stale threshold. Above it, nothing would
 * ever be idle because the session would already read as expired; below a
 * minute, a session would flicker between active and idle inside a single ping
 * interval.
 */
const IDLE_AFTER_MS = (() => {
  const raw = Number(process.env['LOGIN_SESSION_IDLE_MINUTES']);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 6;
  return Math.min(Math.max(minutes, 1), STALE_AFTER_MS / 60_000) * 60_000;
})();

/** The moment before which an un-ended session counts as expired. */
function staleCutoff(): string {
  return new Date(Date.now() - STALE_AFTER_MS).toISOString();
}

/** The moment before which a still-open session counts as idle. */
function idleCutoff(): string {
  return new Date(Date.now() - IDLE_AFTER_MS).toISOString();
}

/**
 * Every column the API reads.
 *
 * Written out rather than `*` since migration 98 widened the table: `*` would
 * quietly start shipping any column added later, and the next column added here
 * is as likely to be something an admin should not see as not.
 */
const COLUMNS = `
  id, user_id, user_code, user_email, browser_email, user_name, user_role, branch_id, branch_name,
  auth_session_id, ip_address, user_agent, browser, browser_version, os, os_version,
  device_type, device_name, screen_size,
  country, country_code, city, region, area, timezone, location_source, latitude, longitude,
  login_at, last_seen_at, ended_at, end_reason,
  revoked_at, revoked_by_name, revoke_reason, is_suspicious, suspicious_reason,
  business_date
`;

/** Row shape as stored, before `rowToApi`. */
interface SessionRow {
  id: string;
  user_id: string | null;
  last_seen_at: string;
  ended_at: string | null;
  revoked_at?: string | null;
  auth_session_id: string | null;
}

/**
 * Fill in the three fields the table does not store.
 *
 * Duration is `coalesce(ended, last seen) − login` — for a signed-out or revoked
 * session that is exact, and for one that simply went quiet it is the last
 * moment the tab was known to be open, which is the most that can honestly be
 * claimed. Clamped at zero because clock skew between the server and Postgres
 * could otherwise produce a negative.
 *
 * ORDER OF THE STATE TESTS MATTERS. `revoked` is checked before `ended` because
 * a revoked row carries BOTH — `ended_at` so every duration calculation keeps
 * working untouched, `revoked_at` so the history can say who ended it. Testing
 * `ended` first would report every revocation as an ordinary sign-out and lose
 * the distinction the audit trail exists for.
 */
function derive(row: Record<string, unknown>): {
  state: LoginSessionState;
  loginStatus: LoginStatus;
  durationMs: number;
  canRevoke: boolean;
} {
  const loginAt = Date.parse(String(row['loginAt']));
  const lastSeen = Date.parse(String(row['lastSeenAt']));
  const endedAtRaw = row['endedAt'];
  const endedAt = endedAtRaw ? Date.parse(String(endedAtRaw)) : null;

  const finish = endedAt ?? lastSeen;
  const durationMs = Number.isFinite(loginAt) && Number.isFinite(finish) ? Math.max(0, finish - loginAt) : 0;

  const quietFor = Date.now() - lastSeen;
  const state: LoginSessionState = row['revokedAt']
    ? 'revoked'
    : endedAt
      ? 'ended'
      : quietFor > STALE_AFTER_MS
        ? 'expired'
        : quietFor > IDLE_AFTER_MS
          ? 'idle'
          : 'active';

  // Only a LIVE session can be ended — which is both 'active' and 'idle', since
  // an idle session is one whose tab merely went quiet and is, if anything, the
  // likelier of the two to be the one an admin wants gone.
  //
  // And only one whose GoTrue session we recorded can be ended for real. A row
  // from before migration 98 has no `auth_session_id`, so revoking it could do
  // nothing but relabel our own bookkeeping while the browser carried on — the
  // button says so rather than pretending, by not being offered.
  const canRevoke = (state === 'active' || state === 'idle') && Boolean(row['authSessionId']);

  // A constant, and honestly so: a row only ever reaches this table after a
  // session was issued, so every one of them is a successful sign-in.
  // Refused attempts live in `login_attempts`. It is still sent as a field so
  // the history table can show "Login status" and "Session status" as the two
  // separate facts they are — see `LoginStatus` in the shared types.
  const loginStatus: LoginStatus = 'SUCCESS';

  return { state, loginStatus, durationMs, canRevoke };
}

/** A PostgREST `numeric` (a string) as a number, or null. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Who is reading a row, for the one decision that depends on it: whether the
 * activated email address goes out in full or masked.
 *
 * TWO WAYS TO SEE THE ADDRESS, and they are different facts. A super admin sees
 * every address because the whole-company history cannot be read without
 * knowing which account each row belongs to. Everybody sees the address on
 * their OWN rows because it is their own — the dashboard card already prints it
 * in plain text in its header, so masking it on the rows beneath hid nothing
 * from the one person able to see them and only made the column look broken.
 * The mask still applies to the case neither covers: a non-admin somehow
 * reading somebody else's row. No endpoint offers that today, and the default
 * keeps it that way if one ever does.
 */
interface Viewer {
  /** The caller's own user id, off the verified token. */
  id: string;
  /** True for a super admin — sees every address in full. */
  admin: boolean;
}

/** May this viewer see the activated address on this row? */
function mayRevealEmail(viewer: Viewer | undefined, userId: unknown): boolean {
  if (!viewer) return false;
  return viewer.admin || (typeof userId === 'string' && userId === viewer.id);
}

/**
 * Row → API shape, deciding email visibility on the way.
 *
 * `revealEmail` is passed in by the caller rather than read from a global,
 * because the same row is legitimately shown both ways in one request: an admin
 * viewing their own session detail sees the address, the table behind the dialog
 * does not. Defaulting it to FALSE is the important part — a new call site that
 * forgets the argument leaks nothing.
 *
 * `userEmail` is the address off the verified token at sign-in, stored in its
 * own column. It is NEVER substituted with `userCode` when it is missing: an old
 * row without an address goes out as '' and the UI says "Not recorded".
 */
function toApi(row: unknown, revealEmail = false): LoginSession {
  const { businessDate, userEmail, browserEmail, latitude, longitude, ...rest } =
    rowToApi<Record<string, unknown>>(row);
  const email = typeof userEmail === 'string' ? userEmail : '';
  // The Google account the session was opened with, or null — see migration
  // 103. Masked under the same rule as the account address, and never
  // substituted: null stays null, so the UI can say "Not recorded".
  const google = typeof browserEmail === 'string' && browserEmail ? browserEmail : null;

  const base = {
    ...rest,
    date: businessDate,
    userEmail: revealEmail ? email : maskEmail(email),
    browserEmail: google === null ? null : revealEmail ? google : maskEmail(google),
    emailMasked: !revealEmail,
    // COERCED, and this is not defensive typing for its own sake: PostgREST
    // serialises `numeric` as a STRING to preserve exactness, so these arrive as
    // '24.860700' and would be typed `number` while being nothing of the kind.
    // The client calls `.toFixed()` on them; a string would throw in a dialog
    // rather than fail visibly here. `branch_locations` is read the same way in
    // geofence.service.ts, for the same reason.
    latitude: num(latitude),
    longitude: num(longitude),
  } as Record<string, unknown>;

  return { ...base, ...derive(base) } as unknown as LoginSession;
}

// ---------------------------------------------------------------------------
// Opening, keeping and closing — the client-driven half
// ---------------------------------------------------------------------------

/**
 * Has this GoTrue session been revoked by an admin?
 *
 * Checked on BOTH `startSession` and `touchSession`, which is not redundant. The
 * ping catches an open tab; this catches the reload. Without the check on start,
 * a browser an admin has just signed out would reload, find its access token
 * still valid for the rest of its lifetime, open a brand-new `login_sessions`
 * row and reappear in the Active Sessions list as though nothing had happened —
 * the revocation would look undone from the one screen built to confirm it.
 *
 * Reads OUR table, not GoTrue's. The `auth.sessions` row is already gone by
 * then, and the service-role client cannot see that schema anyway; the revoked
 * `login_sessions` row is the durable record that the revocation happened.
 *
 * NOT MADE REDUNDANT BY THE SAME CHECK IN `authenticate`, which now runs in
 * front of every request in the app. That one is CACHED — a negative answer is
 * held for a minute, which is the enforcement lag it trades for not querying on
 * every request — and it fails open on a database error. This one is uncached
 * and runs on the two endpoints where being a minute late actually matters: the
 * one that opens a session row, and the one that keeps it alive. A revoked
 * browser must not be able to reload into a brand-new row inside that window.
 */
async function isAuthSessionRevoked(authSessionId: string | null): Promise<boolean> {
  if (!authSessionId) return false;
  const { data, error } = await db
    .from('login_sessions')
    .select('id')
    .eq('auth_session_id', authSessionId)
    .not('revoked_at', 'is', null)
    .limit(1);
  // Fail OPEN. A failed read here must not lock somebody out of an app they are
  // legitimately signed in to; the revocation still stands at GoTrue, which is
  // the mechanism that does not depend on this query succeeding.
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

/** Raised when a revoked browser tries to carry on. The routes turn it into a 403. */
export class SessionRevokedError extends Error {
  status = 403;
  constructor() {
    super('This session was signed out by an administrator');
  }
}

/**
 * Open a session, or resume the one this browser already holds.
 *
 * RESUME IS THE INTERESTING HALF. Without it every page reload would be a new
 * login: the client re-runs its start call on mount, and the history would fill
 * with one-second sessions. So the client offers back the id it was given, and
 * it is honoured only when the session is genuinely still this user's and still
 * live. A resumed session is also PINGED, not merely accepted — a reload is
 * proof the tab is open, and the session should not expire because the user
 * happened to reload just before the next tick.
 *
 * The ownership check is the security-relevant part: `user_id` must match the
 * caller's. Without it, one account could pass another's session id and extend —
 * or, on end, close — somebody else's row.
 */
export async function startSession(params: {
  userId: string;
  email: string;
  /**
   * The verified Google account this session was signed in WITH, or null. The
   * route derives it from the token's identities and `amr` claim — never from
   * the body — and passes null for a password login. See migration 103.
   */
  browserEmail: string | null;
  name: string;
  role: string;
  userCode: string | null;
  branchId: string | null;
  branchName: string | null;
  authSessionId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * Reported by the browser, e.g. '1920x1080'. The one field on this row that
   * comes from a request body — see the note on `StartLoginSessionSchema` for
   * why that is acceptable here and nowhere else in this feature.
   */
  screenSize?: string | null;
  /**
   * The device's own position, off the `X-Geo-Position` header the browser
   * attaches once location has been granted — or null. When present it wins
   * over the IP lookup for the location block and is reverse-geocoded for the
   * neighbourhood; see `deviceLocation`.
   */
  position?: GeoPosition | null;
  resumeSessionId?: string | undefined;
}): Promise<LoginSession> {
  if (await isAuthSessionRevoked(params.authSessionId)) throw new SessionRevokedError();

  if (params.resumeSessionId) {
    const { data, error } = await db
      .from('login_sessions')
      .select('id, user_id, last_seen_at, ended_at, auth_session_id')
      .eq('id', params.resumeSessionId)
      .maybeSingle();
    if (error) throw error;

    const existing = data as SessionRow | null;
    // Same user, still open, seen recently — AND the same GoTrue session. The
    // fourth test is the one that was missing, and its absence is the exact
    // reason a browser that had just authenticated with Google went on showing
    // "Not recorded": see `resumeVerdict` for the sequence.
    const verdict = resumeVerdict(
      existing,
      { userId: params.userId, authSessionId: params.authSessionId },
      STALE_AFTER_MS,
    );

    if (verdict === 'resume' && existing) {
      const resumed = await touchSession(existing.id, params.userId, params.position ?? null);
      if (resumed.status === 'ok') return resumed.session;
      // Fell through: the row was closed or revoked between the two reads. A
      // revocation is re-raised rather than silently opening a fresh session,
      // which would be the reload hole isAuthSessionRevoked closes above.
      if (resumed.status === 'revoked') throw new SessionRevokedError();
    }

    if (verdict === 'reauthenticated' && existing) {
      // The browser holds a different session now — a Google link, or a fresh
      // sign-in that never closed the old row. The old row is over, and is
      // ended with its own reason so the history says what happened rather
      // than reading as a sign-out nobody performed. Same guards as
      // `endSession`: a row a ping or an admin has already closed is left as
      // they left it. A failure here is logged, not raised — the row would
      // otherwise fall to 'expired' in ten minutes, and the new session must
      // be recorded either way.
      const now = new Date().toISOString();
      const { error: endError } = await db
        .from('login_sessions')
        .update({ ended_at: now, last_seen_at: now, end_reason: 'reauth' })
        .eq('id', existing.id)
        .eq('user_id', params.userId)
        .is('ended_at', null);
      if (endError) console.error('[login-history] end on reauth', endError.message);
    }
  }

  // Resolved BEFORE the insert so the row is written complete, and awaited
  // rather than fired off afterwards because there is no second write to attach
  // it to. Neither lookup can throw and each is capped at ~2.8s, so the worst
  // case is a login that takes an extra moment to record — never one that
  // fails to be. The two run CONCURRENTLY: they ask different providers about
  // different inputs, and running them in sequence would put both timeouts,
  // back to back, inside somebody's sign-in.
  //
  // The device fix, when the browser sent one, is resolved to a place name
  // beside the IP lookup rather than instead of it: the IP answer is what the
  // suspicion detector compares countries with, and the fallback for any field
  // the geocoder could not name.
  const [geo, fix] = await Promise.all([
    lookupIp(params.ipAddress),
    deviceLocation(params.position ?? null),
  ]);
  const device = parseUserAgent(params.userAgent);

  // Judged BEFORE the insert, against a history that does not yet include this
  // session. Doing it afterwards would mean every login compared itself with
  // itself and found its own country familiar.
  const verdict = await detectSuspicion({
    userId: params.userId,
    // The address off the verified token, not off a body — and used for one
    // thing only: counting the refused attempts recorded against it. It is never
    // used to identify the account, which is what `userId` above is for.
    email: params.email,
    country: geo.country,
    device,
  });

  const { data, error } = await db
    .from('login_sessions')
    .insert({
      user_id: params.userId,
      user_code: params.userCode,
      user_email: params.email,
      browser_email: params.browserEmail,
      user_name: params.name,
      user_role: params.role,
      branch_id: params.branchId,
      branch_name: params.branchName,
      auth_session_id: params.authSessionId,
      ip_address: params.ipAddress,
      user_agent: params.userAgent,
      browser: device.browser,
      browser_version: device.browserVersion,
      os: device.os,
      os_version: device.osVersion,
      device_type: device.deviceType,
      device_name: device.deviceName,
      screen_size: params.screenSize ?? null,
      // The device fix where there is one, the IP answer otherwise — field by
      // field, so a geocoder that named the neighbourhood but not the region
      // still leaves the region the IP lookup knew. `location_source` follows
      // whichever supplied the coordinates, taken from that lookup's own
      // verdict rather than inferred: a caller deciding it separately is how a
      // row ends up claiming a source for a location nothing ever resolved.
      country: fix?.country ?? geo.country,
      country_code: fix?.countryCode ?? geo.countryCode,
      city: fix?.city ?? geo.city,
      region: fix?.region ?? geo.region,
      area: fix?.area ?? null,
      timezone: geo.timezone,
      location_source: fix ? 'DEVICE_GPS' : geo.source,
      latitude: fix ? fix.latitude : geo.latitude,
      longitude: fix ? fix.longitude : geo.longitude,
      is_suspicious: verdict.isSuspicious,
      suspicious_reason: verdict.reason,
      business_date: businessDateStr(),
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;

  // Fire-and-forget, deliberately. The login is recorded; whether an admin was
  // told about it is a second, lesser fact, and awaiting the notification write
  // would put its latency inside somebody's sign-in.
  if (verdict.isSuspicious && verdict.reason) {
    void alertSuspiciousLogin({
      sessionId: (data as { id: string }).id,
      userId: params.userId,
      userCode: params.userCode,
      userName: params.name,
      userRole: params.role,
      country: geo.country,
      city: geo.city,
      device,
      reason: verdict.reason,
    });
  }

  // The caller is the session's own owner, so there is nothing to hide from them.
  return toApi(data, true);
}

/**
 * A device position resolved to a place, or null when there is no position or
 * the geocoder named nothing — in which case the IP answer stands alone. The
 * coordinates are the device's own, never the geocoder's centroid, so the
 * `DEVICE_GPS` row says where the device was, not where the neighbourhood is.
 */
async function deviceLocation(position: GeoPosition | null): Promise<{
  latitude: number;
  longitude: number;
  area: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
} | null> {
  if (!position) return null;
  const place = await reverseGeocode(position);
  // A fix the geocoder could not name is still a fix — the coordinates are
  // real and the source is honest — so it is kept, with the place fields null
  // for the IP answer to fill.
  return {
    latitude: position.latitude,
    longitude: position.longitude,
    area: place.area,
    city: place.city,
    region: place.region,
    country: place.country,
    countryCode: place.countryCode,
  };
}

/**
 * The columns a ping should write to lift a row from its IP city to the
 * device's neighbourhood — or nothing, when the row already has a device fix.
 * Reads one row first so the geocoder is asked only for a session that can use
 * the answer; the geocoder's own cache absorbs the rest.
 */
async function locationUpgrade(
  sessionId: string,
  userId: string,
  position: GeoPosition,
): Promise<Record<string, unknown>> {
  const { data } = await db
    .from('login_sessions')
    .select('location_source, country, country_code, city, region')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  const row = data as {
    location_source: string;
    country: string | null;
    country_code: string | null;
    city: string | null;
    region: string | null;
  } | null;
  if (!row || row.location_source === 'DEVICE_GPS') return {};

  const fix = await deviceLocation(position);
  if (!fix) return {};
  return {
    location_source: 'DEVICE_GPS',
    latitude: fix.latitude,
    longitude: fix.longitude,
    area: fix.area,
    // Field by field again: the geocoder's answer where it has one, the IP's
    // where it does not, so an upgrade never blanks a city the row already knew.
    city: fix.city ?? row.city,
    region: fix.region ?? row.region,
    country: fix.country ?? row.country,
    country_code: fix.countryCode ?? row.country_code,
  };
}

/** What a ping found. The three outcomes need three different client reactions. */
export type PingOutcome =
  | { status: 'ok'; session: LoginSession }
  | { status: 'revoked' }
  | { status: 'gone' };

/**
 * Bump `last_seen_at`.
 *
 * Guarded on `user_id` and on `ended_at is null` in the UPDATE itself rather
 * than read-then-write: a ping racing a sign-out must not resurrect a session
 * that has just been closed, and a predicate in the statement is the only way to
 * decide that atomically from here.
 *
 * WHEN THE UPDATE MATCHES NOTHING there are two very different reasons, and this
 * is the one place that can tell them apart. Either the session is simply over —
 * the client should drop its id and open a fresh one — or an admin revoked it,
 * and the client must sign itself out instead. Collapsing both into "not found",
 * as this did before migration 98, would let a revoked browser answer the
 * revocation by opening a new session; that is the hole this second read closes,
 * and it is why the ping is the practical enforcement of a revocation rather
 * than the GoTrue delete, which is invisible until a token refresh falls due.
 */
export async function touchSession(
  sessionId: string,
  userId: string,
  position: GeoPosition | null = null,
): Promise<PingOutcome> {
  // A session usually opens BEFORE the browser has a location — the fix is
  // asked for on the sales screen, the session on the first render — so the
  // first ping that carries one is the moment the row can be upgraded from the
  // IP's city to the device's neighbourhood. Once, and only upwards: a row that
  // already holds a device fix is left alone, so a phone wandering during a
  // session keeps the place it signed in from.
  const upgrade = position ? await locationUpgrade(sessionId, userId, position) : {};

  const { data, error } = await db
    .from('login_sessions')
    .update({ last_seen_at: new Date().toISOString(), ...upgrade })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('ended_at', null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (data) return { status: 'ok', session: toApi(data, true) };

  const { data: closed } = await db
    .from('login_sessions')
    .select('revoked_at')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  return (closed as { revoked_at: string | null } | null)?.revoked_at
    ? { status: 'revoked' }
    : { status: 'gone' };
}

/**
 * Close a session on an explicit sign-out.
 *
 * `end_reason` is always 'logout' here — 'expired' exists in the check
 * constraint for a sweeper that does not exist yet, and 'revoked' is written
 * only by `revokeSession`. Idempotent through the same `ended_at is null`
 * predicate: signing out twice, or a retry, leaves the first end time standing
 * rather than stretching the session to the second call. The same predicate is
 * what stops a sign-out from overwriting a revocation and erasing who performed
 * it.
 */
export async function endSession(sessionId: string, userId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from('login_sessions')
    .update({ ended_at: now, last_seen_at: now, end_reason: 'logout' })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('ended_at', null);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Reading — the admin half
// ---------------------------------------------------------------------------

/**
 * Make a search term safe to drop into PostgREST's `or` filter.
 *
 * That filter is a comma-separated, parenthesised mini-language parsed as a
 * STRING, so a comma or a bracket in the term does not fail — it silently
 * changes which columns are searched. `%` and `_` are `ilike` wildcards and are
 * stripped for the same reason: a term of `%` would match every row and read as
 * a broken filter rather than as the user having typed a wildcard.
 */
function safeSearch(term: string): string {
  return term.replace(/[,()%_\\*"']/g, ' ').trim();
}

/** The state words the search box recognises. Kept as a list so the check is a lookup, not a cast. */
const SEARCHABLE_STATES: readonly LoginSessionState[] = ['active', 'idle', 'ended', 'expired', 'revoked'];

/**
 * The state filter, in SQL.
 *
 * It has to be here rather than applied to the page after it is fetched, or
 * `total` would count rows the page then discarded and the pager would promise
 * pages that come back empty.
 *
 * `ended` deliberately excludes revoked rows even though a revoked row also
 * carries `ended_at`: lumping them together would make this filter mean
 * "over", which is just the inverse of `active` and answers nothing new.
 *
 * `idle` is the band between the two cutoffs — quiet enough to be idle, not
 * quiet enough to be over. Expressed as two bounds rather than "not active and
 * not expired", so the SQL says the same thing `derive()` does and the two
 * cannot drift into disagreeing about one row.
 */
function applyStateFilter<Q extends {
  not(column: string, operator: string, value: unknown): Q;
  is(column: string, value: null): Q;
  gte(column: string, value: string): Q;
  lt(column: string, value: string): Q;
}>(q: Q, state: LoginSessionState): Q {
  switch (state) {
    case 'revoked': return q.not('revoked_at', 'is', null);
    case 'ended': return q.not('ended_at', 'is', null).is('revoked_at', null);
    case 'active': return q.is('ended_at', null).gte('last_seen_at', idleCutoff());
    case 'idle': return q.is('ended_at', null).lt('last_seen_at', idleCutoff()).gte('last_seen_at', staleCutoff());
    case 'expired': return q.is('ended_at', null).lt('last_seen_at', staleCutoff());
  }
}

/**
 * The history, newest first, one page at a time.
 *
 * PAGED IN SQL, not in the browser. The screen this feeds can be asked for every
 * account's sessions at once, and the previous version's answer — fetch a capped
 * 500 rows and filter them client-side — meant the cap silently truncated the
 * result the moment the table outgrew it, with no indication that anything was
 * missing. Every filter below is therefore applied in the query, and `total` is
 * the count of rows matching it, so the pager can be honest.
 *
 * `userId` null means every user — the caller decides that, and only a super
 * admin is allowed to pass it (see the route). Everyone else is pinned to their
 * own id, which is what makes this table safe to put on every dashboard.
 */
/** The column a `sortBy` key resolves to. Not part of the shared, mirrored
 * `LoginHistoryFilters` type — sort is parsed ad hoc by the route (see there).
 *
 * `duration` and session `state` are deliberately absent: both are computed in
 * `derive()` from `login_at`/`last_seen_at`/`ended_at` (`state` also folds in
 * "now", for the idle/expired boundary), not a single stored column a plain
 * `.order()` can express — sorting by either would need a SQL expression this
 * query builder doesn't offer, so they stay unsortable rather than silently
 * ordering by the wrong thing. */
export const SESSION_SORT_COLUMNS = {
  loginAt: 'login_at',
  userName: 'user_name',
  browserEmail: 'browser_email',
  city: 'city',
  country: 'country',
  browser: 'browser',
  browserVersion: 'browser_version',
  os: 'os',
  deviceType: 'device_type',
  ipAddress: 'ip_address',
} as const;
export type SessionSortKey = keyof typeof SESSION_SORT_COLUMNS;

export async function listSessions(opts: {
  filters: LoginHistoryFilters;
  page: number;
  pageSize: number;
  sortBy?: SessionSortKey;
  sortDir?: 'asc' | 'desc';
  /**
   * Whether this caller may SEARCH by the activated address. Only a super admin
   * may: leaving it in for everyone else would turn the search box into an
   * oracle for which addresses have accounts, even with the column itself
   * masked.
   *
   * Reading the address is decided separately, per row, by `mayRevealEmail` —
   * an admin sees every one, and every caller sees the address on their own
   * sessions. Non-admins are pinned to their own sessions by the route, so in
   * practice every row they receive carries its address in full; the mask is
   * left in the path for any row that is not theirs.
   */
  searchEmail: boolean;
  /** The caller, for the per-row email decision. */
  viewer: Viewer;
}): Promise<LoginHistoryPage> {
  const { filters } = opts;

  let q = db
    .from('login_sessions')
    // `count: 'exact'` rather than 'estimated': the numbers here are small enough
    // that an exact count is cheap, and an estimate that disagrees with the rows
    // on screen reads as a bug to the person looking at both.
    .select(COLUMNS, { count: 'exact' })
    .order(opts.sortBy ? SESSION_SORT_COLUMNS[opts.sortBy] : 'login_at', { ascending: opts.sortDir === 'asc' });

  if (filters.userId) q = q.eq('user_id', filters.userId);
  if (filters.from) q = q.gte('business_date', filters.from);
  if (filters.to) q = q.lte('business_date', filters.to);
  if (filters.country) q = q.eq('country', filters.country);
  if (filters.suspiciousOnly) q = q.eq('is_suspicious', true);

  // The narrowings added for the Login History screen's filter bar. Every one is
  // an exact match on a column denormalised onto the row AT SIGN-IN — so
  // filtering by branch finds the sessions somebody opened while they worked for
  // that branch, not the sessions of whoever works there today. That is the
  // useful reading for a security screen, and it is the reason none of these
  // joins `users`.
  if (filters.branchId) q = q.eq('branch_id', filters.branchId);
  if (filters.role) q = q.eq('user_role', filters.role);
  if (filters.city) q = q.eq('city', filters.city);
  // Browser NAME, never the version: 'Chrome' matches every Chrome, where
  // 'Chrome 140' would split one browser across a new filter value every six
  // weeks and make the dropdown useless within a year.
  if (filters.browser) q = q.eq('browser', filters.browser);
  if (filters.deviceType) q = q.eq('device_type', filters.deviceType);

  // The state filter, in SQL — see `applyStateFilter` for why it cannot be
  // applied to the page after the fact.
  if (filters.state) q = applyStateFilter(q, filters.state);

  if (filters.search) {
    const term = safeSearch(filters.search);
    if (term) {
      // Email is searchable ONLY for an admin. Leaving it in for everyone else
      // would turn the search box into an oracle: type an address, and whether a
      // row comes back tells you whether that account exists — even though the
      // column itself comes back masked, so nothing appears to have leaked.
      // Place names are searchable by everyone: "Karachi" narrows a person's own
      // history as usefully as the company's, and reveals nothing about anyone.
      //
      // Device facts are searchable too — 'Chrome', 'Android', 'mobile', an IP
      // address — so one box answers "every session from this address" as well
      // as "every session from Karachi". All text columns, all `ilike`, so a
      // partial IP or a browser name typed in any case still matches.
      const cols = [
        'user_code',
        'user_name',
        'area',
        'city',
        'region',
        'country',
        'browser',
        'browser_version',
        'os',
        'device_type',
        'ip_address',
        ...(opts.searchEmail ? ['user_email', 'browser_email'] : []),
      ];
      q = q.or(cols.map((c) => `${c}.ilike.%${term}%`).join(','));
    }
  }

  // A status word typed into the search box — 'active', 'revoked', 'success' —
  // names something no column holds: the session state is derived from three
  // timestamps on read, and the login status is the constant every row shares.
  // So the words are recognised and turned into the predicate they mean, when
  // the explicit state filter has not already said otherwise. 'success'
  // narrows nothing, which is correct: every row here is a successful sign-in,
  // and the refused ones live in `login_attempts`.
  if (filters.search && !filters.state) {
    const word = filters.search.trim().toLowerCase();
    const state = SEARCHABLE_STATES.find((s) => s === word);
    if (state) q = applyStateFilter(q, state);
  }

  const from = (opts.page - 1) * opts.pageSize;
  const { data, error, count } = await q.range(from, from + opts.pageSize - 1);
  if (error) throw error;

  return {
    // In full for a super admin and on the caller's own rows, masked for any
    // row that is neither. See `mayRevealEmail`.
    sessions: (data ?? []).map((r) =>
      toApi(r, mayRevealEmail(opts.viewer, (r as { user_id: string | null }).user_id)),
    ),
    total: count ?? 0,
    page: opts.page,
    pageSize: opts.pageSize,
    scope: filters.userId ? 'self' : 'all',
  };
}

/**
 * Everything currently live, grouped by account.
 *
 * THE GROUPING IS THE FEATURE. A flat list answers "who is online"; grouped by
 * account it answers "is anybody signed in from three countries at once", which
 * is the question the screen exists for and the reason this endpoint is separate
 * from the history list rather than a filter on it.
 *
 * Grouped in JavaScript rather than in SQL because the set is small by
 * construction — only sessions pinged within the last ten minutes qualify, which
 * is at most the number of tabs the company has open — and because the same rows
 * are needed both grouped and individually. A `group by` would need a second
 * query to get the sessions back.
 */
export async function listActiveSessions(opts: {
  userId: string | null;
  /**
   * True for the super-admin roster. This endpoint has no non-admin caller
   * today — the route is `requireRole('super_admin')` — but the flag is passed
   * explicitly rather than assumed, so the day a scoped version is added it has
   * to decide, instead of inheriting an admin's visibility by omission.
   */
  revealEmail: boolean;
}): Promise<ActiveSessionsResponse> {
  // The STALE cutoff, not the idle one: an idle session is still a live session
  // whose tab has merely gone quiet, and dropping it out of the roster would
  // hide exactly the second device somebody left signed in at home — which is
  // the thing this screen exists to surface. Each row carries its own `state`,
  // so the list distinguishes the two without excluding either.
  let q = db
    .from('login_sessions')
    .select(COLUMNS)
    .is('ended_at', null)
    .gte('last_seen_at', staleCutoff())
    .order('last_seen_at', { ascending: false });

  if (opts.userId) q = q.eq('user_id', opts.userId);

  const { data, error } = await q;
  if (error) throw error;

  // The roster is super-admin-only, and its whole job is to answer "WHICH
  // account is live in three countries at once" — which is a question about an
  // identity, so the identity is shown. The staff code is still the primary
  // handle and the address sits under it.
  const sessions = (data ?? []).map((r) => toApi(r, opts.revealEmail));

  // Keyed by user id, falling back to the staff code and then the row id. The
  // fallbacks matter for a deleted account: `user_id` is null on every one of
  // its rows, so keying on it alone would collapse every deleted account's
  // sessions into one bogus group.
  const byUser = new Map<string, LoginSession[]>();
  for (const s of sessions) {
    const key = s.userId ?? s.userCode ?? s.id;
    const bucket = byUser.get(key);
    if (bucket) bucket.push(s);
    else byUser.set(key, [s]);
  }

  const groups: ActiveSessionGroup[] = [...byUser.values()].map((rows) => {
    const head = rows[0]!;
    const countries = [...new Set(rows.map((r) => r.country).filter((c): c is string => !!c))];
    return {
      userId: head.userId,
      userCode: head.userCode,
      userName: head.userName,
      userEmail: head.userEmail,
      emailMasked: head.emailMasked,
      userRole: head.userRole as UserRole | null,
      branchName: head.branchName,
      sessions: rows,
      sessionCount: rows.length,
      countries,
      // Two RESOLVED countries. A session whose lookup failed contributes
      // nothing rather than counting as a different place — otherwise a geo
      // provider outage would light up the multi-country warning for everybody
      // who happened to sign in during it.
      multiCountry: countries.length > 1,
      hasSuspicious: rows.some((r) => r.isSuspicious),
      lastSeenAt: head.lastSeenAt,
    };
  });

  // Most recently seen first, and within that the accounts with the most
  // sessions — so a person live on four devices sorts above one on a single tab.
  groups.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || b.sessionCount - a.sessionCount);

  return {
    groups,
    totalSessions: sessions.length,
    totalUsers: groups.length,
    multiCountryUsers: groups.filter((g) => g.multiCountry).length,
    scope: opts.userId ? 'self' : 'all',
  };
}

/**
 * One session in full, for the detail dialog.
 *
 * The address is revealed by `mayRevealEmail` — to an admin, or to the row's own
 * owner. The route still refuses a non-admin somebody else's row outright; this
 * decision only governs what the row looks like for a caller who may see it.
 */
export async function getSession(sessionId: string, viewer: Viewer): Promise<LoginSession> {
  const { data, error } = await db
    .from('login_sessions')
    .select(COLUMNS)
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Session not found'), { status: 404 });
  return toApi(data, mayRevealEmail(viewer, (data as { user_id: string | null }).user_id));
}

/**
 * Record that an admin opened somebody else's session detail.
 *
 * THE ONLY AUDITED READ IN THIS APP, and it earns the exception. This view is
 * where one person sees another's activated email address, IP address and
 * resolved location together — the most sensitive thing the product shows
 * anybody. An audit trail that records who ENDED a session but not who READ one
 * watches the admins' actions and not their access, and access is the half that
 * leaves no other trace.
 *
 * NOT CALLED WHEN AN ADMIN OPENS THEIR OWN SESSION. The route decides that, and
 * it matters: a log filled with rows about people reading their own record is a
 * log nobody reads, which buries the rows that mean something.
 *
 * FIRE-AND-FORGET AND SILENT ON FAILURE. It runs alongside a read that has
 * already succeeded; failing the admin's dialog because the audit write did not
 * land would trade a working screen for a bookkeeping row. Logged to the console
 * so a persistent failure is visible to an operator rather than to nobody.
 */
export function auditSessionView(
  session: LoginSession,
  admin: Admin,
): void {
  void logAudit({
    action: 'session_viewed',
    adminId: admin.id,
    adminName: admin.name,
    targetUserId: session.userId,
    targetUserName: session.userName,
    targetUserRole: session.userRole,
    // The staff code and the device, never the email address. An audit row is
    // read by more people over a longer period than the dialog that produced it,
    // and copying the address into it would spread exactly what the dialog is
    // careful about.
    details: [
      session.userCode ?? 'unknown staff ID',
      describeDevice({
        browser: session.browser,
        browserVersion: session.browserVersion,
        os: session.os,
        osVersion: session.osVersion,
        deviceType: session.deviceType,
        deviceName: session.deviceName,
      }),
      [session.city, session.country].filter(Boolean).join(', ') || 'unresolved location',
    ].join(' · '),
  }).catch((err) => console.error('[login-history] session_viewed audit failed', err));
}

/**
 * The values the country, city and browser dropdowns offer.
 *
 * READ FROM THE ROWS, not from a lookup table, because there is no canonical
 * list to maintain: the countries are whatever the geo provider has said so far
 * and the browsers are whatever the parser has recognised. A hardcoded list
 * would be missing the one somebody actually signed in from — which is the only
 * value a filter is ever used to find.
 *
 * ONE QUERY FOR THREE DROPDOWNS. Three would be three round-trips to produce
 * three de-duplications of the same 2,000 rows, and PostgREST has no
 * `select distinct` to do any of them in SQL — so the rows come back once and
 * are reduced in memory. The 2,000-row window is the same one the single-column
 * version used: recent enough to describe what the filters need to offer, small
 * enough not to read the table into the server to populate a `<select>`.
 *
 * CAPPED PER FACET as well. A filter list is scanned by eye; past a few dozen
 * entries it is worse than a search box, and an unbounded one would let a
 * garbage user agent add an entry per login.
 */
export interface LoginFilterOptions {
  countries: string[];
  cities: string[];
  browsers: string[];
}

const FACET_LIMIT = 60;

export async function listFilterOptions(userId: string | null): Promise<LoginFilterOptions> {
  let q = db
    .from('login_sessions')
    .select('country, city, browser')
    .order('login_at', { ascending: false })
    .limit(2000);
  if (userId) q = q.eq('user_id', userId);

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as Array<{ country: string | null; city: string | null; browser: string | null }>;
  const facet = (pick: (r: (typeof rows)[number]) => string | null): string[] =>
    [...new Set(rows.map(pick).filter((v): v is string => !!v))]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, FACET_LIMIT);

  return {
    countries: facet((r) => r.country),
    cities: facet((r) => r.city),
    browsers: facet((r) => r.browser),
  };
}

// ---------------------------------------------------------------------------
// Ending somebody else's session — the admin half that changes something
// ---------------------------------------------------------------------------

interface Admin {
  id: string;
  name: string;
}

/**
 * End one session, for real.
 *
 * TWO MECHANISMS, AND BOTH ARE NECESSARY.
 *
 *   1. `revoke_auth_session` ends the session itself (its `auth_sessions`
 *      row). The middleware reads that row on every request, so the device's
 *      next call is refused and its refresh token is worth nothing.
 *   2. Marking the Login History row revoked is what the screens show, and it
 *      is checked by the middleware as well — so a session whose row was
 *      marked is treated as ended even if step 1 failed. The ping every open
 *      tab already sends answers 403 on a revoked row and the client signs
 *      itself out without waiting to be refused.
 *
 * ORDER IS DELIBERATE: GoTrue first, our row second. If the process dies between
 * them, the session is genuinely dead and our record merely says it is still
 * open — a history that understates. The reverse order would leave a row marked
 * revoked over a browser that was never actually signed out, which is a history
 * that LIES in the direction an admin would act on.
 */
export async function revokeSession(
  sessionId: string,
  admin: Admin,
  reason: string | null,
): Promise<RevokeSessionResult> {
  const { data, error } = await db
    .from('login_sessions')
    .select('id, user_id, user_code, user_name, user_role, auth_session_id, ended_at, browser, os, country, city')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Session not found'), { status: 404 });

  const row = data as SessionRow & {
    user_code: string | null;
    user_name: string;
    user_role: string | null;
    browser: string | null;
    os: string | null;
    country: string | null;
    city: string | null;
  };

  // 409 rather than a silent success. "Sign out" on a session that already ended
  // is a stale screen, and telling the admin so is what prompts a refresh —
  // reporting success would leave them believing they acted on something.
  if (row.ended_at) {
    throw Object.assign(new Error('That session has already ended'), { status: 409 });
  }

  let authSessionsEnded = 0;
  if (row.auth_session_id) {
    const { data: killed, error: rpcError } = await db.rpc('revoke_auth_session', {
      p_auth_session_id: row.auth_session_id,
    });
    // Logged, not thrown. If GoTrue refuses, marking our row revoked still ejects
    // the browser on its next ping, and abandoning the whole revocation because
    // the stronger of the two mechanisms failed would leave the admin with
    // nothing at all.
    if (rpcError) console.error('[login-history] revoke_auth_session failed', rpcError.message);
    else if (killed === true) authSessionsEnded = 1;
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await db
    .from('login_sessions')
    .update({
      ended_at: now,
      end_reason: 'revoked',
      revoked_at: now,
      revoked_by: admin.id,
      revoked_by_name: admin.name,
      revoke_reason: reason,
    })
    .eq('id', sessionId)
    // Same predicate as `endSession`: a revocation racing a sign-out must not
    // stretch a session that has already closed.
    .is('ended_at', null)
    .select('id');
  if (updateError) throw updateError;

  const revoked = updated?.length ?? 0;

  await logAudit({
    action: 'session_revoked',
    adminId: admin.id,
    adminName: admin.name,
    targetUserId: row.user_id,
    targetUserName: row.user_name,
    targetUserRole: row.user_role,
    details: describeRevocation(row, reason),
  });

  return { revoked, authSessionsEnded };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * End every session for one account, sparing at most one.
 *
 * NOT A LOOP OVER `revokeSession`, and the difference is the point. The SQL
 * function deletes GoTrue sessions by `user_id`, so it also reaches sessions
 * `login_sessions` never recorded — one opened before the history feature
 * shipped, one whose /start call was lost to a dropped connection, one from a
 * client that never called the API at all. "Sign out everywhere" that only signs
 * out the sessions we happen to know about is a promise the button cannot keep.
 *
 * THE SPARED SESSION IS THE CALLER'S OWN, AND THE SERVER DECIDES IT. An admin
 * clearing their own account's other devices must not eject the browser they are
 * sitting in — that ends with them locked out mid-incident, which is the worst
 * possible moment. `keep.authSessionId` is therefore filled in by the route from
 * the caller's own verified token, never from the request body, so the
 * protection holds even for a client that forgot to ask for it.
 *
 * `keep.sessionId` remains as the explicit, client-supplied form and is verified
 * to belong to the SAME user before it is honoured. Without that check an admin
 * could pass a session id belonging to somebody else and spare nothing, while
 * believing they had kept a tab alive.
 */
export async function revokeAllOtherSessions(
  targetUserId: string,
  keep: {
    /** A `login_sessions` id the caller asked to spare. Verified to be the target's. */
    sessionId: string | null;
    /** The caller's own GoTrue session, off their verified token. Never from a body. */
    authSessionId: string | null;
  },
  admin: Admin,
  reason: string | null,
): Promise<RevokeSessionResult> {
  let keepAuthSessionId: string | null = keep.authSessionId;
  if (!keepAuthSessionId && keep.sessionId) {
    const { data } = await db
      .from('login_sessions')
      .select('auth_session_id, user_id')
      .eq('id', keep.sessionId)
      .maybeSingle();
    const row = data as SessionRow | null;
    if (row?.user_id === targetUserId) keepAuthSessionId = row.auth_session_id ?? null;
  }
  // Shape-checked before it is interpolated into the `or` filter below, which is
  // a string mini-language rather than a parameterised query. The value comes
  // from our own column or a verified token, so this is belt and braces — but a
  // filter built by string concatenation gets the check regardless of provenance.
  if (keepAuthSessionId && !UUID.test(keepAuthSessionId)) keepAuthSessionId = null;

  const { data: killed, error: rpcError } = await db.rpc('revoke_all_auth_sessions', {
    p_user_id: targetUserId,
    p_keep_auth_session_id: keepAuthSessionId,
  });
  if (rpcError) console.error('[login-history] revoke_all_auth_sessions failed', rpcError.message);
  const authSessionsEnded = typeof killed === 'number' ? killed : 0;

  const now = new Date().toISOString();
  let update = db
    .from('login_sessions')
    .update({
      ended_at: now,
      end_reason: 'revoked',
      revoked_at: now,
      revoked_by: admin.id,
      revoked_by_name: admin.name,
      revoke_reason: reason,
    })
    .eq('user_id', targetUserId)
    .is('ended_at', null);

  if (keep.sessionId) update = update.neq('id', keep.sessionId);
  if (keepAuthSessionId) {
    // `neq` alone would MISS the null rows: in SQL `auth_session_id <> '…'` is
    // NULL for a null column, not true, so every pre-migration-98 session would
    // survive a "sign out everywhere" — silently, and exactly for the sessions
    // that are hardest to end by other means.
    update = update.or(`auth_session_id.is.null,auth_session_id.neq.${keepAuthSessionId}`);
  }

  const { data: updated, error: updateError } = await update.select('id, user_name, user_role, user_code');
  if (updateError) throw updateError;

  const rows = (updated ?? []) as Array<{ user_name: string; user_role: string | null; user_code: string | null }>;
  const revoked = rows.length;
  const head = rows[0];

  // Named from the rows we just closed where possible, and from a lookup only
  // when there were none — the audit row must still say WHO was signed out even
  // if every session had already expired and nothing matched the update.
  const target = head ?? (await lookupUserForAudit(targetUserId));

  await logAudit({
    action: 'all_sessions_revoked',
    adminId: admin.id,
    adminName: admin.name,
    targetUserId,
    targetUserName: target?.user_name ?? 'Unknown account',
    targetUserRole: target?.user_role ?? null,
    details: [
      `${revoked} recorded session${revoked === 1 ? '' : 's'} ended`,
      `${authSessionsEnded} authentication session${authSessionsEnded === 1 ? '' : 's'} deleted`,
      keepAuthSessionId ? 'the acting session kept' : 'every session ended',
      reason ? `reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  });

  return { revoked, authSessionsEnded };
}

async function lookupUserForAudit(
  userId: string,
): Promise<{ user_name: string; user_role: string | null; user_code: string | null } | null> {
  const { data } = await db
    .from('users')
    .select('display_name, role, user_code')
    .eq('id', userId)
    .maybeSingle();
  const u = data as { display_name: string | null; role: string | null; user_code: string | null } | null;
  return u ? { user_name: u.display_name ?? 'Unknown account', user_role: u.role, user_code: u.user_code } : null;
}

/**
 * The `details` line on a revocation audit row.
 *
 * Names the staff code, the device and the location rather than only the session
 * UUID, because the audit log is read months later by somebody who no longer has
 * the session list open — and a UUID alone means the row cannot be understood
 * without a second lookup into a table that may by then have been pruned.
 */
function describeRevocation(
  row: { user_code: string | null; browser: string | null; os: string | null; country: string | null; city: string | null },
  reason: string | null,
): string {
  const device = describeDevice({
    browser: row.browser,
    browserVersion: null,
    os: row.os,
    osVersion: null,
    deviceType: null,
    deviceName: null,
  });
  const where = [row.city, row.country].filter(Boolean).join(', ') || 'unresolved location';
  return [row.user_code ?? 'unknown staff ID', device, where, reason ? `reason: ${reason}` : null]
    .filter(Boolean)
    .join(' · ');
}
