import { Router, type RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { adminDb, adminStorage } from '../config/firebase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { UpdateSettingsSchema } from '../shared';
import { invalidate } from '../utils/cache';
import { getAppSettings } from '../services/settings.service';

export const router = Router();
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

router.put('/', requireRole('super_admin'), validate(UpdateSettingsSchema), async (req: AuthRequest, res, next) => {
  try {
    await adminDb.collection('settings').doc('app').set({
      ...req.body,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user!.uid,
    }, { merge: true });
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

    const bucket = adminStorage.bucket();
    const logoPath = `settings/logo-${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const fileRef = bucket.file(logoPath);
    const token = randomUUID();
    await fileRef.save(req.file.buffer, {
      contentType: req.file.mimetype,
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
    const logoUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(logoPath)}?alt=media&token=${token}`;

    await adminDb.collection('settings').doc('app').set({
      logoUrl,
      logoPath,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user!.uid,
    }, { merge: true });
    invalidate('settings');

    res.json({ success: true, logoUrl });
  } catch (err) {
    next(err);
  }
});
