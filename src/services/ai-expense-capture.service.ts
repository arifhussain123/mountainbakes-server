import { z } from 'zod';
import { getPrisma } from '../db';
import {
  AI_CAPTURE_MAX_PHOTOS,
  businessDateStr,
  type AiCapturePhoto,
  type AiCaptureResult,
  type AiConfidence,
  type AiExpenseDuplicate,
  type AiExpenseIssue,
  type AiExpenseProposal,
  type Attachment,
} from '../shared';
import { assertStagedAttachments, uploadAttachment } from './attachments.service';
import { fileStore } from './file-store';
import { AiError, aiConfig, aiReader, type AiImage } from './ai/claude';

/**
 * AI Expense Capture: read a finance user's receipt photos with Claude and
 * propose one expense per bill (owner's order, 2026-10-30).
 *
 * Nothing here writes an entry. The proposals go back to the user, who edits
 * them and saves each one through the ordinary Income & Expense create, where
 * every existing rule (head, branch, back-date restriction, audit, draft
 * status, approval) still applies. What this module adds is the reading, and
 * the checks that keep the reading honest:
 *
 *   * the model's figures are re-checked here — items against the subtotal,
 *     subtotal + tax − discount against the total, the date against today —
 *     and a mismatch is flagged, never corrected;
 *   * anything it could not read stays null and marks the proposal for review;
 *   * possible duplicates are looked up in the books (same invoice number;
 *     same amount within a day; the very same photo already on an entry) and
 *     within the run itself.
 *
 * Each run is recorded in finance_ai_captures (photos, model, proposals or the
 * failure) so an entry saved from it can be traced back. Receipt text is never
 * logged.
 */

/** Rupees: two figures within this are the same amount. */
const TOLERANCE = 1;

// ── What the model is asked for ────────────────────────────────────────────

// Structured outputs need every object closed (additionalProperties: false);
// every field is required, and a value the receipt does not show is null.
const nullable = (type: 'string' | 'number') => ({ anyOf: [{ type }, { type: 'null' }] });
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const RESPONSE_SCHEMA = obj({
  photos: {
    type: 'array',
    items: obj({ photo: { type: 'integer' }, readable: { type: 'boolean' }, note: nullable('string') }),
  },
  bills: {
    type: 'array',
    items: obj({
      photos: { type: 'array', items: { type: 'integer' } },
      merchant: nullable('string'),
      invoiceNo: nullable('string'),
      date: { ...nullable('string'), description: 'YYYY-MM-DD' },
      currency: nullable('string'),
      subtotal: nullable('number'),
      tax: nullable('number'),
      discount: nullable('number'),
      total: nullable('number'),
      description: { type: 'string' },
      descriptionOriginal: nullable('string'),
      language: nullable('string'),
      lineItems: {
        type: 'array',
        items: obj({
          description: { type: 'string' },
          descriptionEnglish: nullable('string'),
          quantity: nullable('number'),
          amount: nullable('number'),
        }),
      },
      ledgerHeadCode: nullable('string'),
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      unclear: nullable('string'),
    }),
  },
});

function buildPrompt(photoCount: number, heads: { code: string; name: string }[], today: string): string {
  return [
    `You are reading ${photoCount} photo(s) of receipts and bills for Mountain Bakes, a bakery in Pakistan, so its accountant can enter them as expenses.`,
    `The photos are numbered 1 to ${photoCount} in the order they are attached.`,
    `Today is ${today}. Amounts are in Pakistani Rupees unless the receipt says otherwise.`,
    '',
    'Rules:',
    '1. Read every receipt line by line, printed or handwritten, in whatever language it is written (English, Urdu or others).',
    '2. Group the photos into BILLS. One bill is one purchase from one supplier: several photos of the same long receipt, or the same receipt photographed twice or from different angles, are ONE bill; one photo showing two separate receipts is TWO bills. List in `photos` every photo number a bill appears on.',
    '3. Return one entry in `bills` per bill. The items on a bill go in its `lineItems`; never make a separate bill for each item.',
    '4. Never invent anything. If a date, amount, merchant or invoice number cannot be read with confidence, return null for it and say what was unclear in `unclear`. Do not compute a missing total from the items.',
    '5. `total` is the final amount payable as printed. `subtotal`, `tax` and `discount` only when printed.',
    '6. `date` is the bill date as YYYY-MM-DD. Pakistani receipts usually write dates day first (30-10-2026 is 30 October 2026).',
    '7. Keep each line item\'s `description` exactly as written in its own language and script; add `descriptionEnglish` only when it is not English.',
    '8. `description` is a short English summary for the books, e.g. "Flour purchase — Al-Madina Traders" or "Electricity bill — October". `descriptionOriginal` is the receipt\'s own wording of it when not English, else null. `language` is the main language: English, Urdu or Mixed (or another name).',
    '9. `ledgerHeadCode`: the code of the expense head below that best fits the bill, or null if none clearly fits.',
    '10. `confidence`: high only when every figure is clearly legible; low when you are guessing at any figure.',
    '11. In `photos`, report each photo number once: `readable` false (with a `note`) when nothing usable can be read from it, e.g. it is blurred or not a receipt.',
    '',
    'Expense heads (code — name):',
    ...heads.map((h) => `${h.code} — ${h.name}`),
  ].join('\n');
}

// ── What the model answers (checked, never trusted) ────────────────────────

const num = z.number().finite().nullable().optional().transform((v) => (v === undefined ? null : v));
const str = z.string().nullable().optional().transform((v) => {
  const t = v?.trim();
  return t ? t : null;
});

const ReplySchema = z.object({
  photos: z.array(z.object({ photo: z.number().int(), readable: z.boolean(), note: str })).default([]),
  bills: z.array(z.object({
    photos: z.array(z.number().int()).default([]),
    merchant: str,
    invoiceNo: str,
    date: str,
    currency: str,
    subtotal: num,
    tax: num,
    discount: num,
    total: num,
    description: z.string().default(''),
    descriptionOriginal: str,
    language: str,
    lineItems: z.array(z.object({
      description: z.string().default(''),
      descriptionEnglish: str,
      quantity: num,
      amount: num,
    })).default([]),
    ledgerHeadCode: str,
    confidence: z.enum(['high', 'medium', 'low']).catch('low'),
    unclear: str,
  })).default([]),
});
type Reply = z.infer<typeof ReplySchema>;
type ReplyBill = Reply['bills'][number];

// ── Helpers ────────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

/** A real calendar date in YYYY-MM-DD, or null. */
function validDate(s: string | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

function shiftDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Server-side checks of what the model read. Flags; never corrects. */
function issuesOf(bill: ReplyBill, date: string | null, today: string): AiExpenseIssue[] {
  const issues: AiExpenseIssue[] = [];
  if (!date) issues.push('missing_date');
  else if (date > today) issues.push('future_date');
  if (bill.total === null || bill.total <= 0) issues.push('missing_amount');

  const amounts = bill.lineItems.map((l) => l.amount);
  const itemsSum = amounts.length > 0 && amounts.every((a) => a !== null)
    ? round2((amounts as number[]).reduce((s, a) => s + a, 0))
    : null;
  let mismatch = false;
  if (itemsSum !== null && bill.total !== null) {
    // The items add up to the subtotal when one is printed, else to the total
    // (allowing for a printed tax or discount).
    const target = bill.subtotal ?? round2(bill.total - (bill.tax ?? 0) + (bill.discount ?? 0));
    if (!near(itemsSum, target)) mismatch = true;
  }
  if (bill.subtotal !== null && bill.total !== null
      && !near(round2(bill.subtotal + (bill.tax ?? 0) - (bill.discount ?? 0)), bill.total)) {
    mismatch = true;
  }
  if (mismatch) issues.push('total_mismatch');
  if (bill.unclear) issues.push('unreadable');
  if (bill.confidence === 'low') issues.push('low_confidence');
  return issues;
}

interface PhotoRow {
  id: string;
  storage_path: string;
  mime_type: string;
  content_sha256: string | null;
}

/** The bytes of a stored photo, from the store or (a store that cannot read) its signed URL. */
async function readPhoto(path: string): Promise<Buffer> {
  const store = fileStore();
  if (store.download) {
    const bytes = await store.download('attachments', path);
    if (bytes) return bytes;
  } else {
    const url = (await store.signUrls('attachments', [path], 300)).get(path);
    if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    }
  }
  throw Object.assign(new Error('A receipt photo could not be read back from storage. Upload it again.'), { status: 409 });
}

/** Possible repeats of a proposal already in the books. */
async function duplicatesInBooks(p: AiExpenseProposal, hashes: string[]): Promise<AiExpenseDuplicate[]> {
  const prisma = getPrisma();
  const out: AiExpenseDuplicate[] = [];
  const seen = new Set<string>();
  const add = (d: AiExpenseDuplicate) => {
    const k = `${d.kind}:${d.entryId}`;
    if (!seen.has(k)) { seen.add(k); out.push(d); }
  };

  if (hashes.length > 0) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; txn_no: string }[]>(
      `select distinct t.id::text, t.txn_no
         from attachments a
         join finance_transactions t on t.id = a.entity_id
        where a.entity = 'finance_transaction' and a.entity_id is not null
          and a.content_sha256 = any(string_to_array($1, ','))
          and t.deleted_at is null
        limit 5`,
      hashes.join(','),
    );
    for (const r of rows) add({ kind: 'same_photo', entryId: r.id, txnNo: r.txn_no, message: `This photo is already attached to ${r.txn_no}.` });
  }
  if (p.invoiceNo) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; txn_no: string; business_date: string }[]>(
      `select id::text, txn_no, business_date::text
         from finance_transactions
        where txn_type = 'expense' and deleted_at is null and status <> 'rejected'
          and lower(btrim(reference_no)) = lower(btrim($1))
        order by business_date desc
        limit 5`,
      p.invoiceNo,
    );
    for (const r of rows) add({ kind: 'reference', entryId: r.id, txnNo: r.txn_no, message: `Invoice ${p.invoiceNo} is already on ${r.txn_no} (${r.business_date}).` });
  }
  if (p.total !== null && p.total > 0 && p.businessDate) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; txn_no: string; business_date: string; description: string }[]>(
      `select id::text, txn_no, business_date::text, description
         from finance_transactions
        where txn_type = 'expense' and deleted_at is null and status <> 'rejected'
          and amount = $1::numeric
          and business_date between $2::date and $3::date
        order by business_date desc
        limit 5`,
      String(round2(p.total)),
      shiftDays(p.businessDate, -1),
      shiftDays(p.businessDate, 1),
    );
    for (const r of rows) {
      add({
        kind: 'amount_date',
        entryId: r.id,
        txnNo: r.txn_no,
        message: `${r.txn_no} (${r.business_date}, "${r.description.slice(0, 60)}") has the same amount.`,
      });
    }
  }
  return out;
}

/** Proposals in the same run that look like the same bill read twice. */
function duplicatesInRun(list: AiExpenseProposal[]): void {
  const norm = (s: string | null) => (s ?? '').trim().toLowerCase();
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const sameInvoice = a.invoiceNo !== null && norm(a.invoiceNo) === norm(b.invoiceNo);
      const sameBill = a.merchant !== null && norm(a.merchant) === norm(b.merchant)
        && a.businessDate !== null && a.businessDate === b.businessDate
        && a.total !== null && b.total !== null && near(a.total, b.total);
      if (!sameInvoice && !sameBill) continue;
      const why = sameInvoice ? `the same invoice number (${a.invoiceNo})` : 'the same supplier, date and total';
      a.duplicates.push({ kind: 'same_batch', otherKey: b.key, message: `Expense ${j + 1} in this batch has ${why}.` });
      b.duplicates.push({ kind: 'same_batch', otherKey: a.key, message: `Expense ${i + 1} in this batch has ${why}.` });
    }
  }
}

async function recordRun(input: {
  actor: { uid: string; email: string };
  attachmentIds: string[];
  model: string;
  status: 'ok' | 'failed';
  result?: unknown;
  error?: string;
  durationMs: number;
}): Promise<string> {
  const rows = await getPrisma().$queryRawUnsafe<{ id: string }[]>(
    `insert into finance_ai_captures (created_by, created_by_name, attachment_ids, model, status, result, error, duration_ms)
     values ($1::uuid, $2, string_to_array($3, ',')::uuid[], $4, $5, $6::jsonb, $7, $8)
     returning id::text`,
    input.actor.uid,
    input.actor.email,
    input.attachmentIds.join(','),
    input.model,
    input.status,
    input.result === undefined ? null : JSON.stringify(input.result),
    input.error ?? null,
    input.durationMs,
  );
  return rows[0]!.id;
}

// ── The run ────────────────────────────────────────────────────────────────

export async function analyzeReceipts(input: {
  attachmentIds: string[];
  actor: { uid: string; email: string };
}): Promise<AiCaptureResult> {
  const cfg = aiConfig();
  if (!cfg) {
    throw Object.assign(new Error('AI Expense Capture is not set up yet: the server has no Anthropic key. Ask the administrator to add ANTHROPIC_API_KEY.'), {
      status: 503,
      expose: true,
    });
  }
  const ids = [...new Set(input.attachmentIds)];
  if (ids.length > AI_CAPTURE_MAX_PHOTOS) {
    throw Object.assign(new Error(`At most ${AI_CAPTURE_MAX_PHOTOS} photos can be read at once`), { status: 400 });
  }

  // The caller's own receipt photos, not yet used on an entry — the same rule
  // the entry create applies when it binds them.
  await assertStagedAttachments({ entity: 'finance_transaction', attachmentIds: ids, actor: input.actor });
  const prisma = getPrisma();
  const found = await prisma.$queryRawUnsafe<PhotoRow[]>(
    `select id::text, storage_path, mime_type, content_sha256
       from attachments
      where id = any(string_to_array($1, ',')::uuid[])`,
    ids.join(','),
  );
  const byId = new Map(found.map((r) => [r.id, r]));
  const photos = ids.map((id) => byId.get(id)!);
  const images: AiImage[] = [];
  for (const p of photos) images.push({ mimeType: p.mime_type, data: await readPhoto(p.storage_path) });

  const heads = await prisma.$queryRawUnsafe<{ id: string; code: string; name: string }[]>(
    `select id::text, code, name from ledger_heads where type = 'expense' and is_active order by sort_order, name`,
  );
  const headByCode = new Map(heads.map((h) => [h.code.toUpperCase(), h.id]));
  const today = businessDateStr();

  const started = Date.now();
  let reply: Reply;
  try {
    const raw = await aiReader()({ prompt: buildPrompt(photos.length, heads, today), images, responseSchema: RESPONSE_SCHEMA }, cfg);
    const parsed = ReplySchema.safeParse(raw);
    if (!parsed.success) throw new AiError('The AI reply could not be understood. Try again.', 502, 'bad_reply');
    reply = parsed.data;
  } catch (err) {
    const known = err instanceof AiError;
    await recordRun({
      actor: input.actor, attachmentIds: ids, model: cfg.model, status: 'failed',
      error: known ? err.code : 'internal', durationMs: Date.now() - started,
    });
    if (known) throw Object.assign(new Error(err.message), { status: err.status, expose: true, details: { code: `ai_${err.code}` } });
    throw err;
  }

  // Photo numbers back to attachment ids; a number outside the run is dropped.
  const idOf = (n: number) => (n >= 1 && n <= photos.length ? photos[n - 1]!.id : null);
  const expenses: AiExpenseProposal[] = reply.bills.map((bill, i) => {
    const photoIds = [...new Set(bill.photos.map(idOf).filter((id): id is string => id !== null))];
    const date = validDate(bill.date);
    const issues = issuesOf(bill, date, today);
    const confidence: AiConfidence = bill.confidence;
    return {
      key: `e${i + 1}`,
      photoIds,
      merchant: bill.merchant,
      invoiceNo: bill.invoiceNo,
      businessDate: date,
      currency: bill.currency,
      subtotal: bill.subtotal,
      tax: bill.tax,
      discount: bill.discount,
      total: bill.total !== null && bill.total > 0 ? round2(bill.total) : null,
      description: bill.description.trim() || bill.merchant || 'Expense',
      descriptionOriginal: bill.descriptionOriginal,
      language: bill.language,
      lineItems: bill.lineItems
        .filter((l) => l.description.trim() !== '')
        .map((l) => ({ description: l.description.trim(), descriptionEnglish: l.descriptionEnglish, quantity: l.quantity, amount: l.amount })),
      suggestedLedgerHeadId: bill.ledgerHeadCode ? headByCode.get(bill.ledgerHeadCode.toUpperCase()) ?? null : null,
      confidence,
      issues,
      needsReview: false,
      notes: bill.unclear,
      duplicates: [],
    };
  // A bill tied to no photo of this run cannot carry a receipt, so it cannot be saved.
  }).filter((e) => e.photoIds.length > 0);

  const hashOf = new Map(photos.map((p) => [p.id, p.content_sha256]));
  for (const e of expenses) {
    const hashes = e.photoIds.map((id) => hashOf.get(id)).filter((h): h is string => Boolean(h));
    e.duplicates.push(...(await duplicatesInBooks(e, hashes)));
  }
  duplicatesInRun(expenses);
  for (const e of expenses) e.needsReview = e.issues.length > 0 || e.confidence !== 'high' || e.duplicates.length > 0;

  const used = new Set(expenses.flatMap((e) => e.photoIds));
  const reported = new Map(reply.photos.map((p) => [idOf(p.photo), p]));
  const photoStatus: AiCapturePhoto[] = photos.map((p) => {
    const r = reported.get(p.id);
    return {
      id: p.id,
      // A photo no bill was read from was not usable, whatever the model said of it.
      readable: used.has(p.id) && (r?.readable ?? true),
      note: r?.note ?? (used.has(p.id) ? null : 'No bill could be read from this photo.'),
    };
  });

  const result = { photos: photoStatus, expenses };
  const captureId = await recordRun({
    actor: input.actor, attachmentIds: ids, model: cfg.model, status: 'ok', result, durationMs: Date.now() - started,
  });
  return { captureId, model: cfg.model, ...result };
}

/**
 * A second copy of one of the caller's receipt photos, staged for a new entry
 * — for a bill the user splits into several expenses, since each entry binds a
 * photo row of its own (a receipt cannot support two vouchers through one
 * row). The file is copied so the copy has its own storage path; it carries
 * the same fingerprint, so it is still recognised as the same receipt.
 */
export async function copyReceiptPhoto(input: {
  id: string;
  actor: { uid: string; email: string };
}): Promise<Attachment> {
  const rows = await getPrisma().$queryRawUnsafe<(PhotoRow & { width: number | null; height: number | null })[]>(
    `select id::text, storage_path, mime_type, content_sha256, width, height
       from attachments
      where id = $1::uuid and entity = 'finance_transaction' and uploaded_by = $2::uuid`,
    input.id,
    input.actor.uid,
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error('That receipt photo was not found.'), { status: 404 });
  const buffer = await readPhoto(row.storage_path);
  return uploadAttachment({
    entity: 'finance_transaction',
    buffer,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    actor: input.actor,
  });
}
