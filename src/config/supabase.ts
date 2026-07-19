import { createClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client, authenticated with the service_role secret key.
 *
 * This key grants FULL admin access (bypasses RLS, can manage any auth user) and
 * must NEVER be sent to the browser. It is used for two things in the API:
 *   1. Verifying a caller's access token   — supabaseAdmin.auth.getUser(token)
 *   2. Managing auth users                 — supabaseAdmin.auth.admin.*
 *
 * Role / branch data lives in each user's `app_metadata` (server-controlled, and
 * automatically embedded in the access-token JWT), mirroring the old Firebase
 * custom claims.
 */
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    'Supabase Auth is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
      'in the server environment (see server/.env.example).'
  );
}

export const supabaseAdmin = createClient(url, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
