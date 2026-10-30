/**
 * AI Expense Capture — receipts photographed or uploaded, read by Google Gemini
 * on the server, proposed back as expense entries for a finance user to check.
 *
 * Shared because the web page, the mobile screen and the API state the same
 * proposal. Nothing here is saved by the analysis: a proposal becomes an entry
 * only when the user saves it through the ordinary Income & Expense create
 * (`POST /api/finance/income/entries`, with `aiCaptureId`), which makes it a
 * draft that a finance approver still has to approve.
 *
 * The model never has the last word. Every figure it reads is checked on the
 * server (the items against the total, the date against today) and anything
 * it could not read is null — never guessed — and marks the proposal for
 * review.
 */

/** At most this many photos are read in one run. */
export const AI_CAPTURE_MAX_PHOTOS = 10;

/** Why a proposal needs a person to look at it before it is saved. */
export const AI_EXPENSE_ISSUES = [
  'missing_date',
  'missing_amount',
  'total_mismatch',
  'future_date',
  'unreadable',
  'low_confidence',
] as const;
export type AiExpenseIssue = (typeof AI_EXPENSE_ISSUES)[number];

export const AI_EXPENSE_ISSUE_LABELS: Record<AiExpenseIssue, string> = {
  missing_date: 'No date could be read — enter it',
  missing_amount: 'No total could be read — enter it',
  total_mismatch: 'The items do not add up to the bill total',
  future_date: 'The date read is in the future',
  unreadable: 'Part of the receipt could not be read',
  low_confidence: 'The AI is unsure of what it read',
};

export type AiConfidence = 'high' | 'medium' | 'low';

/** One line read off a bill. Kept as detail of its expense, never an expense of its own. */
export interface AiExpenseLineItem {
  /** As printed or written on the receipt, in its own language. */
  description: string;
  /** An English rendering when the original is not English; otherwise null. */
  descriptionEnglish: string | null;
  quantity: number | null;
  amount: number | null;
}

/** Something already on the books (or in this run) that the proposal may repeat. */
export interface AiExpenseDuplicate {
  kind: 'reference' | 'amount_date' | 'same_photo' | 'same_batch';
  message: string;
  /** The existing entry, for the first three kinds. */
  entryId?: string | null;
  txnNo?: string | null;
  /** The other proposal in this run, for `same_batch`. */
  otherKey?: string | null;
}

/** One proposed expense: one bill, with every photo it was read from. */
export interface AiExpenseProposal {
  /** Stable within the run; the client keys its cards by it. */
  key: string;
  /** The staged attachment ids this bill was read from. */
  photoIds: string[];
  merchant: string | null;
  invoiceNo: string | null;
  /** 'YYYY-MM-DD' as printed on the bill; null if it could not be read. */
  businessDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  discount: number | null;
  /** The bill total; null if it could not be read. */
  total: number | null;
  /** A short English description for the entry, e.g. "Flour purchase — Al-Madina Traders". */
  description: string;
  /** The receipt's own wording when it is not English (e.g. Urdu); otherwise null. */
  descriptionOriginal: string | null;
  /** The receipt's main language, e.g. "English", "Urdu", "Mixed". */
  language: string | null;
  lineItems: AiExpenseLineItem[];
  /** An active expense ledger head the model thinks fits, checked against the real list; null if none. */
  suggestedLedgerHeadId: string | null;
  confidence: AiConfidence;
  issues: AiExpenseIssue[];
  /** Whether a person must check it before saving (any issue, low confidence, or a possible duplicate). */
  needsReview: boolean;
  /** What the model said it could not make out, in its words; null if nothing. */
  notes: string | null;
  duplicates: AiExpenseDuplicate[];
}

/** Each photo sent, and whether anything could be read from it. */
export interface AiCapturePhoto {
  id: string;
  readable: boolean;
  note: string | null;
}

/** `POST /api/finance/ai-capture/analyze` → this. */
export interface AiCaptureResult {
  captureId: string;
  model: string;
  photos: AiCapturePhoto[];
  expenses: AiExpenseProposal[];
}
