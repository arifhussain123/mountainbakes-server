/**
 * Photo attachments — the supporting image captured alongside a finance
 * document or a branch demand.
 *
 * One shape for every attachment site. The parent is identified by
 * `(entity, entityId)` rather than by a foreign key, because the ledger reaches
 * an attachment from a posted voucher's `(sourceType, sourceId)` and no single
 * column can reference five different tables. See migration 67.
 */

export const ATTACHMENT_ENTITIES = [
  'finance_transaction',
  'partner_expense',
  'branch_share_payment',
  'salary_payment',
  'employee_advance',
  'finance_income_approval',
  'production_order_demand',
  'production_order_verification',
  'production_order_special_item',
  // Special Orders (migration 142): the branch's proof of the finished item,
  // bound to the special ORDER. Deliberately not the entity the request photo
  // uses, so the two can never be confused or overwrite one another.
  'special_order_verification',
  // Finance Help Desk (migration 94): the supporting document a raiser attaches
  // to a query, and to each reply in its conversation. Two entities rather than
  // one — a photo posted mid-thread belongs to the message that explains it, and
  // flattening both onto the query would lose which reply it arrived with.
  'finance_ticket',
  'finance_ticket_message',
  // Cash transfers (migration 118): the photo of the slip or handover a branch
  // attaches when it records money sent to the company. Read by Finance from
  // the transfer and again from the RV- voucher it becomes.
  'cash_transfer',
  // Branch returns (migration 148): the picture of the goods a branch is sending
  // back. Since migration 20261020000001, ONE photo per returned product: each
  // `production_returns` row points at its own through `photo_attachment_id`,
  // and the photo is bound to that row (`entity_id`). Returns raised before then
  // share one photo across their rows (`legacy_single_photo`).
  'branch_return',
  // Refundable & Receivable Loans (migration 20261031000001): the optional
  // supporting document for one loan register entry.
  'finance_loan_entry',
] as const;

export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number];

/** Human labels for the places a photo can be attached. */
export const ATTACHMENT_ENTITY_LABELS: Record<AttachmentEntity, string> = {
  finance_transaction: 'Income / expense entry',
  partner_expense: 'Partner advance or draw',
  branch_share_payment: 'Branch share payout',
  salary_payment: 'Salary payment',
  employee_advance: 'Employee advance',
  finance_income_approval: 'Branch income',
  production_order_demand: 'Demand',
  production_order_verification: 'Delivery verification',
  production_order_special_item: 'Special order item',
  special_order_verification: 'Special order verification',
  finance_ticket: 'Finance Help Desk query',
  finance_ticket_message: 'Help Desk reply',
  cash_transfer: 'Branch cash transfer',
  branch_return: 'Branch return',
  finance_loan_entry: 'Loan register entry',
};

/**
 * What the API returns for one photo.
 *
 * `url` is a SHORT-LIVED signed URL minted at read time, not a stored value —
 * the bucket is private (migration 67) and an `<img src>` cannot carry a Bearer
 * token. It expires; never persist it, cache it past a page load, or put it in
 * a printed document. Re-fetch the parent to get a fresh one.
 */
export interface Attachment {
  id: string;
  entity: AttachmentEntity;
  /** Null only while the photo is staged and its parent does not exist yet. */
  entityId: string | null;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string; // ISO UTC
}

/** How long a minted signed URL stays valid, in seconds. */
export const ATTACHMENT_URL_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * The ceiling the API enforces on an upload, in bytes.
 *
 * The client downscales every capture well below this (see
 * ATTACHMENT_TARGET_MAX_BYTES); this is the backstop for a client that does
 * not, and it matches the bucket's own file_size_limit.
 */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Accepted image formats. Mirrors the bucket's allowed_mime_types. */
export const ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

// ---------------------------------------------------------------------------
// Capture/compression targets — shared so the client and any future server-side
// re-encode agree on what "low size" means.
// ---------------------------------------------------------------------------

/**
 * The single size every stored capture is normalised to: its longest edge, in
 * pixels. Aspect ratio is preserved, so a portrait shot stores 1500×2000 and a
 * landscape one 2000×1500 — the same amount of picture either way.
 *
 * ONE canonical size matters because the phones do not agree on anything. The
 * same receipt photographed on four branch handsets arrives as a 12 MP frame,
 * a 48 MP frame, a 1080p frame and whatever an old Android WebView decides to
 * hand over. Normalising on capture is what makes a stored photo cost a
 * predictable amount of space and look the same in the gallery, whichever phone
 * took it — rather than the database holding a 4 MB photo next to a 40 KB one.
 *
 * 2000 rather than the old 1280: 1280 is where small printed digits start to
 * mush together, and a photo nobody can read is one nobody can check. The extra
 * pixels are paid for by the encoder, not by the budget below — WebP at 2000px
 * is smaller than JPEG was at 1280px.
 *
 * Never UPSCALED to reach it. A gallery image that arrives smaller is stored as
 * it is: enlarging invents no detail and costs real bytes.
 */
export const ATTACHMENT_STORED_DIMENSION = 2000;

/**
 * Kept as an alias so the ceiling has one name across both trees. Identical to
 * ATTACHMENT_STORED_DIMENSION — nothing may exceed the size everything is
 * normalised to.
 */
export const ATTACHMENT_MAX_DIMENSION = ATTACHMENT_STORED_DIMENSION;

/**
 * Quality for the first encode pass.
 *
 * 0.82, up from 0.7: at 0.7 the encoder puts visible ringing around small dark
 * text on white, which is exactly the content these photos carry.
 */
export const ATTACHMENT_JPEG_QUALITY = 0.82;

/**
 * Byte budget the client compresses towards.
 *
 * Only QUALITY steps down to meet it, never the dimensions — the stored size
 * stays fixed at ATTACHMENT_STORED_DIMENSION so every photo in the database is
 * the same size. Roughly a quarter-megabyte: small enough to upload on a weak
 * branch connection, and enough for a sharp 2000px WebP.
 */
export const ATTACHMENT_TARGET_MAX_BYTES = 300 * 1024;

/** How many photos may hang off one document. */
export const ATTACHMENT_MAX_PER_ENTITY = 5;

// ---------------------------------------------------------------------------
// Return photos — a smaller profile than the receipt one above.
//
// A receipt has to stay READABLE, which is what buys it 2000px. A return photo
// only has to show WHICH goods came back and what state they were in, and there
// is one on every return a branch raises, every evening — so it is sized for
// storage first. 1280px identifies a tray of pastries comfortably; nobody reads
// small print off it.
// ---------------------------------------------------------------------------

/** Longest edge of a stored return photo, in pixels. Never upscaled to reach it. */
export const RETURN_PHOTO_MAX_DIMENSION = 1280;

/** First-pass encode quality for a return photo (JPEG or WebP). */
export const RETURN_PHOTO_QUALITY = 0.7;

/** Byte budget the client compresses a return photo towards. */
export const RETURN_PHOTO_TARGET_MAX_BYTES = 200 * 1024;

/**
 * The ceiling on a stored return photo, enforced by the API at upload. Five
 * times the budget: a compressed 1280px frame cannot honestly reach it, so
 * anything that does was not compressed.
 */
export const RETURN_PHOTO_MAX_BYTES = 1024 * 1024;

/** The largest ORIGINAL a client will even try to process. */
export const RETURN_PHOTO_MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

/**
 * How long an uploaded return photo may stay unclaimed before the API's sweep
 * deletes it. A photo is uploaded the moment it is taken, before its return is
 * saved; one whose return never arrived is removed after this. A client that
 * submits later gets `attachment_unavailable` and uploads it again.
 */
export const RETURN_PHOTO_STAGED_TTL_HOURS = 24;
