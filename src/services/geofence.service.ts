import { dbFor } from '../db';
import {
  decodeGeoPosition,
  evaluateGeofence,
  GEO_POSITION_HEADER,
  type GeofenceVerdict,
  type GeoPoint,
  type GeoPosition,
  type UserRole,
} from '../shared';
import { getAppSettings } from './settings.service';
import { getCached, setCached, invalidate } from '../utils/cache';

const db = dbFor('geofence');

/**
 * Server-side geofencing.
 *
 * This is the enforcing copy. The browser runs the same `evaluateGeofence` from
 * `shared/utils/geo`, but only to decide what to render — a patched client, or a
 * request replayed straight at the API, never reaches that code at all. Everything
 * that actually refuses a sale is here.
 *
 * What that does and does not buy you is worth stating plainly: a browser cannot
 * attest that a coordinate came from real GPS hardware. Chrome's sensor override
 * and a two-line patch of `navigator.geolocation` both produce a position this code
 * cannot distinguish from a genuine one. So the goal is NOT "unspoofable" — it is
 * that every attempt is measured by the server against data the client does not
 * supply (the branch centre and radius come from the database, never the request),
 * and that every attempt lands in `geofence_logs` with its IP and user agent
 * attached. Bypass becomes visible and attributable rather than impossible.
 */

/** A branch's configured area, as the check needs it. */
export interface BranchGeofence {
  branchId: string;
  branchName: string | null;
  centre: GeoPoint;
  radiusKm: number;
}

const CACHE_PREFIX = 'branch-location';

/**
 * The configured, ACTIVE geofence for a branch, or null when it has none.
 *
 * Cached under the shared 60s TTL like every other hot, rarely-changing read. Null
 * results are cached too — a company that has geofenced two of its branches would
 * otherwise hit the database on every single sale at the other five.
 */
export async function getBranchGeofence(branchId: string): Promise<BranchGeofence | null> {
  const cacheKey = `${CACHE_PREFIX}:${branchId}`;
  const hit = getCached<{ value: BranchGeofence | null }>(cacheKey);
  if (hit) return hit.value;

  const { data, error } = await db
    .from('branch_locations')
    .select('branch_id, branch_name, latitude, longitude, radius_km')
    .eq('branch_id', branchId)
    .eq('is_active', true)
    .maybeSingle();

  // A read failure must not be treated as "no geofence configured": that would turn
  // a transient database blip into a silent, open door. Propagate and let the caller
  // decide — the middleware answers 503 rather than waving the sale through.
  if (error) throw new Error(`Failed to load branch geofence: ${error.message}`);

  const value: BranchGeofence | null = data
    ? {
        branchId: data.branch_id as string,
        branchName: (data.branch_name as string | null) ?? null,
        centre: { latitude: Number(data.latitude), longitude: Number(data.longitude) },
        radiusKm: Number(data.radius_km),
      }
    : null;

  setCached(cacheKey, { value });
  return value;
}

/** Drop cached geofences after a write. Prefix match clears every branch's entry. */
export function invalidateBranchGeofences(branchId?: string): void {
  invalidate(branchId ? `${CACHE_PREFIX}:${branchId}` : CACHE_PREFIX);
}

/**
 * Roles the rule does not apply to.
 *
 * Super admins are exempt because they administer every branch from wherever they
 * are — geofencing them would lock the company out of its own back office. Production
 * users are exempt because they do not create branch sales at all: their sales go
 * through the production pool, which has no branch location to be measured against.
 */
export function isGeofenceExempt(role: UserRole): boolean {
  return role === 'super_admin' || role === 'production_user';
}

/** Pull the device position off the request header, or null if absent/malformed. */
export function positionFromRequest(headers: Record<string, unknown>): GeoPosition | null {
  const raw = headers[GEO_POSITION_HEADER.toLowerCase()];
  return decodeGeoPosition(typeof raw === 'string' ? raw : null);
}

export interface CheckGeofenceInput {
  branchId: string | null;
  role: UserRole;
  position: GeoPosition | null;
}

/**
 * Run the check for one request. Pure decision-making — the caller logs the result,
 * because only the caller knows which action was being attempted.
 */
export async function checkGeofence(input: CheckGeofenceInput): Promise<{
  verdict: GeofenceVerdict;
  geofence: BranchGeofence | null;
}> {
  const settings = await getAppSettings();

  // Order matters: the exempt and disabled short-circuits must not depend on a
  // branch lookup, so an exempt admin never pays for one and a company with the
  // feature switched off never touches the table.
  if (isGeofenceExempt(input.role) || !settings.geofencingEnabled) {
    return {
      verdict: evaluateGeofence({
        branch: null,
        position: input.position,
        radiusKm: null,
        enabled: settings.geofencingEnabled,
        exempt: isGeofenceExempt(input.role),
      }),
      geofence: null,
    };
  }

  // A branch_manager with no branch claim is a broken account, not an exempt one.
  // Treating it as unconfigured (and so permitted) would make "unassign the branch"
  // a one-click bypass.
  const geofence = input.branchId ? await getBranchGeofence(input.branchId) : null;

  const verdict = evaluateGeofence({
    branch: geofence?.centre ?? null,
    position: input.position,
    radiusKm: geofence?.radiusKm ?? settings.geofenceDefaultRadiusKm,
    enabled: true,
    requireHighAccuracy: settings.geofenceRequireHighAccuracy,
    maxAgeSeconds: settings.geofenceMaxPositionAgeSec,
    nowMs: Date.now(),
  });

  return { verdict, geofence };
}

export interface LogGeofenceInput {
  action: string;
  verdict: GeofenceVerdict;
  position: GeoPosition | null;
  branchId: string | null;
  branchName: string | null;
  userId: string;
  userName: string;
  userRole: UserRole;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Append to `geofence_logs`. Never throws.
 *
 * Same contract as logAudit: a failed audit write must not take down the action it
 * was recording. That cuts both ways here — it means a blocked sale still gets
 * blocked even if the log write fails, and an allowed one still goes through.
 */
export async function logGeofenceCheck(input: LogGeofenceInput): Promise<void> {
  try {
    const { error } = await db.from('geofence_logs').insert({
      branch_id: input.branchId,
      branch_name: input.branchName,
      user_id: input.userId,
      user_name: input.userName,
      user_role: input.userRole,
      action: input.action,
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
      accuracy_m:
        input.position?.accuracyM != null ? Math.round(input.position.accuracyM) : null,
      distance_km: input.verdict.distanceKm,
      radius_km: input.verdict.radiusKm,
      outcome: input.verdict.outcome,
      allowed: input.verdict.allowed,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
    });
    if (error) console.error('[geofence] failed to write geofence log', error);
  } catch (err) {
    console.error('[geofence] failed to write geofence log', err);
  }
}

/**
 * Client IP as best the platform can report it.
 *
 * Behind the hosting proxy `req.ip` is only trustworthy with `trust proxy` set, so the
 * forwarded chain is read directly and its FIRST entry taken — the client-supplied
 * end, which is spoofable but is also the only value that means anything about the
 * caller. It is evidence for a human reading the log, never an access decision.
 */
export function clientIp(headers: Record<string, unknown>, fallback: string | undefined): string | null {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]!.trim();
  }
  return fallback ?? null;
}
