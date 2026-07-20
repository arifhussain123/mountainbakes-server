import { Router } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { UpdateSettingsSchema, type AppSettings } from '../shared';
import { invalidate } from '../utils/cache';
import { getAppSettings, FIELD_TO_COLUMN } from '../services/settings.service';

export const router = Router();

const LOGO_BUCKET = 'branding';

/**
 * Extension is derived from the sniffed mimetype, never from originalname —
 * that string is attacker-controlled and would otherwise land in a storage path.
 * The keys mirror the bucket's allowed_mime_types (migration 10); anything else
 * is rejected below, so the bucket never has to be the one to say no.
 */
const LOGO_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.use(authenticate);

router.get('/', async (_req, res, next) => {
  try {
    const settings = await getAppSettings();
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

/**
 * The `settings` table is a singleton: `id` is a boolean primary key with a
 * `settings_singleton` check constraint pinning it to true. Upserting on `id`
 * therefore creates the row on first write and merges into it thereafter —
 * the Postgres equivalent of Firestore's `.doc('app').set(…, { merge: true })`.
 *
 * updated_at is maintained by the settings_touch trigger — do not set it here.
 */
router.put('/', requireRole('super_admin'), validate(UpdateSettingsSchema), async (req: AuthRequest, res, next) => {
  try {
    // Only fields present in the (already validated) body are written, so a
    // partial update leaves every other column untouched.
    const row: Record<string, unknown> = { id: true, updated_by: req.user!.uid };
    for (const [field, value] of Object.entries(req.body)) {
      const column = FIELD_TO_COLUMN[field as keyof AppSettings];
      if (column) row[column] = value;
    }

    const { error } = await supabaseAdmin.from('settings').upsert(row, { onConflict: 'id' });
    if (error) throw error;

    invalidate('settings');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/logo', requireRole('super_admin'), // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upload.single('logo') as any, async (req: AuthRequest, res, next) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

    const extension = LOGO_EXTENSIONS[req.file.mimetype];
    if (!extension) {
      res.status(400).json({ error: 'Logo must be a PNG, JPEG, WebP, or SVG image' });
      return;
    }

    // The path of the logo currently on record, read straight from the table
    // rather than via the cached getAppSettings() — this is the delete target,
    // and deleting based on a stale value could remove the live logo.
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('settings')
      .select('logo_path')
      .maybeSingle();
    if (readErr) throw readErr;
    const previousPath: string | null = existing?.logo_path ?? null;

    const logoPath = `settings/logo-${Date.now()}.${extension}`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(LOGO_BUCKET)
      .upload(logoPath, req.file.buffer, { contentType: req.file.mimetype });
    if (uploadErr) throw uploadErr;

    // `branding` is a PUBLIC bucket, so this URL is permanent and unauthenticated
    // — which is required: logo_url is persisted and rendered on the login page
    // and on printed receipts, where there is no session. A signed URL would
    // expire and silently break both. See migration 10.
    const { data: publicUrl } = supabaseAdmin.storage.from(LOGO_BUCKET).getPublicUrl(logoPath);
    const logoUrl = publicUrl.publicUrl;

    const { error: writeErr } = await supabaseAdmin
      .from('settings')
      .upsert({ id: true, logo_url: logoUrl, logo_path: logoPath, updated_by: req.user!.uid }, { onConflict: 'id' });
    if (writeErr) throw writeErr;

    invalidate('settings');

    // Remove the superseded file. The old Firebase code never did this, so logos
    // accumulated forever (migration 10 flags it). Done last and best-effort: the
    // new logo is already live, so a failed cleanup must not fail the request —
    // it just leaves one orphan behind. Deleting any earlier would risk removing
    // the current logo if the upload or the row write then failed.
    if (previousPath && previousPath !== logoPath) {
      const { error: removeErr } = await supabaseAdmin.storage.from(LOGO_BUCKET).remove([previousPath]);
      if (removeErr) {
        console.warn(`[settings] could not delete previous logo ${previousPath}:`, removeErr.message);
      }
    }

    res.json({ success: true, logoUrl });
  } catch (err) {
    next(err);
  }
});
