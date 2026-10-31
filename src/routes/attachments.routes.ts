import { Router } from 'express';
import multer from 'multer';
import { authenticate, type AuthRequest } from '../middleware/auth';
import {
  ATTACHMENT_MAX_BYTES,
  UploadAttachmentSchema,
  canAccessFinanceHelpDesk,
  isBranchRole,
  isFinanceRole,
  type AttachmentEntity,
  type UserRole,
} from '../shared';
import { discardStagedAttachment, uploadAttachment } from '../services/attachments.service';

export const router = Router();

/**
 * The one place a captured photo enters the system.
 *
 * Multipart rather than base64-in-JSON: an image inflates ~33% under base64 and
 * would sit in every finance payload's request log. Memory storage because the
 * buffer goes straight to S3 — nothing is ever written to the
 * server's disk, which is ephemeral anyway.
 *
 * The 5 MB limit is a backstop, not the working size. The client downscales
 * every capture to roughly 100–300 KB before it gets here (compressImage in the
 * frontend's lib/attachments.ts); anything arriving near this limit means the
 * client-side compression did not run.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 },
});

/**
 * Who may attach a photo to what.
 *
 * This is the same authorization the CREATE endpoint applies, enforced a second
 * time at upload. Without it, a branch user could stage a photo against
 * `salary_payment` — harmless on its own, since binding also checks the entity
 * and the finance create endpoints are role-guarded, but it would let anyone
 * with a login write objects into the finance folder of the bucket.
 */
const ENTITY_ROLES: Record<AttachmentEntity, (role: UserRole) => boolean> = {
  finance_transaction: (r) => isFinanceRole(r) || r === 'super_admin',
  finance_loan_entry: (r) => isFinanceRole(r) || r === 'super_admin',
  partner_expense: (r) => isFinanceRole(r) || r === 'super_admin',
  branch_share_payment: (r) => isFinanceRole(r) || r === 'super_admin',
  salary_payment: (r) => isFinanceRole(r) || r === 'super_admin',
  employee_advance: (r) => isFinanceRole(r) || r === 'super_admin',
  finance_income_approval: (r) => isFinanceRole(r) || r === 'super_admin',
  production_order_demand: (r) => isBranchRole(r) || r === 'super_admin',
  production_order_verification: (r) => isBranchRole(r) || r === 'super_admin',
  production_order_special_item: (r) => isBranchRole(r) || r === 'super_admin',
  special_order_verification: (r) => isBranchRole(r) || r === 'super_admin',
  // Finance Help Desk (migration 94). Both sides of the desk attach documents —
  // a raiser evidences the problem, an admin evidences the correction — so this
  // is the finance roles AND super_admin, which is what `canAccessFinanceHelpDesk`
  // already means. Binding still refuses a photo whose uploader is not the one
  // creating the query, so a Finance user cannot attach to somebody else's.
  finance_ticket: (r) => canAccessFinanceHelpDesk(r),
  finance_ticket_message: (r) => canAccessFinanceHelpDesk(r),
  // Cash transfers (migration 118): the branch photographs the handover.
  // Finance only ever READS this photo — from the transfer and from the RV-
  // voucher it becomes — so it does not upload against this entity.
  cash_transfer: (r) => isBranchRole(r) || r === 'super_admin',
  // Branch returns (migration 148): the same roles POST /api/stock/return
  // admits. Production and Finance only ever READ this photo, off the return.
  branch_return: (r) => isBranchRole(r) || r === 'super_admin',
};

router.use(authenticate);

/**
 * POST /api/attachments — upload one captured photo, staged against `entity`.
 *
 * Returns the attachment, including a signed URL for the form's own thumbnail.
 * The `id` is what the caller then sends as one of `attachmentIds` on the
 * request that creates the document; until that binding happens the row belongs
 * to nothing. See the lifecycle note in migration 67.
 */
router.post(
  '/',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload.single('photo') as any,
  async (req: AuthRequest, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No photo uploaded' });
        return;
      }

      // Parsed here rather than through the `validate` middleware: that runs
      // before multer, so it would see an empty body on a multipart request.
      // The schema is still the source of truth for what `entity` may be.
      const parsed = UploadAttachmentSchema.safeParse({ entity: req.body?.entity });
      if (!parsed.success) {
        res.status(400).json({ error: 'Unknown attachment type' });
        return;
      }
      const { entity } = parsed.data;

      if (!ENTITY_ROLES[entity](req.user!.role)) {
        res.status(403).json({ error: 'Forbidden: cannot attach a photo to this kind of record' });
        return;
      }

      // Dimensions are captured client-side and are presentational only (they
      // let the gallery reserve space before the image loads), so a missing or
      // nonsensical value is dropped rather than rejected.
      const toDimension = (v: unknown): number | null => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 && n < 100_000 ? Math.round(n) : null;
      };

      const attachment = await uploadAttachment({
        entity,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        width: toDimension(req.body?.width),
        height: toDimension(req.body?.height),
        actor: { uid: req.user!.uid, email: req.user!.email },
      });

      res.status(201).json({ attachment });
    } catch (err) {
      next(err);
    }
  },
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/attachments/:id — discard a photo the caller uploaded and never
 * used.
 *
 * For the case a form cannot avoid: the photo has to be uploaded before the
 * document that cites it, and then the document is refused. Without this the
 * file sits in the bucket for good.
 *
 * It can only ever remove the caller's OWN, still-STAGED upload. A bound photo
 * is part of a document's audit trail and stays immutable (migration 67, kept
 * by 148); the service's delete carries `entity_id is null` in the statement
 * itself, so there is no window in which this could take one.
 *
 * 204 whether or not anything was removed. "Not yours", "already bound" and
 * "already gone" are indistinguishable on purpose, and to a client cleaning up
 * after itself they all mean the same thing: nothing left to do.
 */
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = String(req.params['id'] ?? '');
    if (!UUID.test(id)) {
      res.status(400).json({ error: 'Invalid attachment id' });
      return;
    }
    await discardStagedAttachment({ id, actor: { uid: req.user!.uid } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
