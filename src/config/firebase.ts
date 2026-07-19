import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Load the Firebase Admin service account from (in priority order):
 *   1. FIREBASE_SERVICE_ACCOUNT         — raw JSON string   (hosted deployments)
 *   2. FIREBASE_SERVICE_ACCOUNT_BASE64  — base64 of the JSON (dashboards that mangle newlines)
 *   3. FIREBASE_SERVICE_ACCOUNT_PATH    — path to a JSON file (local development)
 *
 * A file path cannot be used on hosts like Render/Railway/Fly/Cloud Run — there is
 * no service-account file in the container — so production must use option 1 or 2.
 */
function loadServiceAccount(): admin.ServiceAccount {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      return JSON.parse(raw) as admin.ServiceAccount;
    } catch (error) {
      console.error('[admin] FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON.', error);
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    }
  }

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (b64) {
    try {
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as admin.ServiceAccount;
    } catch (error) {
      console.error('[admin] FIREBASE_SERVICE_ACCOUNT_BASE64 is set but could not be decoded.', error);
      throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64-encoded JSON');
    }
  }

  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (path) {
    const absolutePath = resolve(process.cwd(), path);
    try {
      return JSON.parse(readFileSync(absolutePath, 'utf-8')) as admin.ServiceAccount;
    } catch (error) {
      console.error(`[admin] Failed to read service account file at: ${absolutePath}`, error);
      throw new Error(`Failed to read service account file at: ${absolutePath}`);
    }
  }

  throw new Error(
    'No Firebase Admin credentials found. Set FIREBASE_SERVICE_ACCOUNT (raw JSON) or ' +
      'FIREBASE_SERVICE_ACCOUNT_BASE64 in production, or FIREBASE_SERVICE_ACCOUNT_PATH for local dev.'
  );
}

function initAdmin() {
  if (admin.apps.length > 0) return;

  const serviceAccount = loadServiceAccount();
  // The raw Google service-account JSON uses snake_case (project_id); the typed
  // ServiceAccount shape uses camelCase. Read both so projectId is always resolved.
  const sa = serviceAccount as unknown as { projectId?: string; project_id?: string };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || sa.projectId || sa.project_id,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  });

  console.log(
    '[admin] Firebase Admin initialised for project:',
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || sa.projectId || sa.project_id || '(unknown)'
  );
}

initAdmin();

// NOTE: Firebase Auth is no longer used — authentication moved to Supabase
// (see src/config/supabase.ts). Firebase Admin is retained only for Firestore
// (data), Storage, and Cloud Messaging until those phases are migrated.
export const adminDb = admin.firestore();
export const adminStorage = admin.storage();
export { admin };
