/**
 * WhatsApp Purchasing — Production buying from outside suppliers over the one
 * authorized Production WhatsApp Business number. Schema and the rules it holds:
 * prisma/migrations/20261020000002_whatsapp_purchasing. Workflow and setup:
 * WHATSAPP-PURCHASING.md.
 *
 * Every money field is rupees with two decimals, every quantity three; both
 * are computed in Postgres (numeric), never summed as floats on a client.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const PURCHASE_DEMAND_STATUSES = [
  'draft',
  'verified',
  'awaiting_supplier',
  'quotation_received',
  'changes_requested',
  'rejected',
  'awaiting_supplier_bill',
  'bill_submitted',
  'awaiting_delivery',
  'partially_received',
  'received',
  'cancelled',
] as const;
export type PurchaseDemandStatus = (typeof PURCHASE_DEMAND_STATUSES)[number];

export const PURCHASE_DEMAND_STATUS_LABEL: Record<PurchaseDemandStatus, string> = {
  draft: 'Draft',
  verified: 'Verified',
  awaiting_supplier: 'Awaiting supplier',
  quotation_received: 'Quotation received',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  awaiting_supplier_bill: 'Approved · awaiting bill',
  bill_submitted: 'Bill submitted',
  awaiting_delivery: 'Awaiting delivery',
  partially_received: 'Partially received',
  received: 'Received',
  cancelled: 'Cancelled',
};

export const PURCHASE_PRIORITIES = ['urgent', 'normal'] as const;
export type PurchasePriority = (typeof PURCHASE_PRIORITIES)[number];

export const PURCHASE_PAYMENT_PREFERENCES = ['cash', 'easypaisa', 'bank', 'credit'] as const;
export type PurchasePaymentPreference = (typeof PURCHASE_PAYMENT_PREFERENCES)[number];

export const PURCHASE_PAYMENT_PREFERENCE_LABEL: Record<PurchasePaymentPreference, string> = {
  cash: 'Cash',
  easypaisa: 'Easypaisa',
  bank: 'Bank',
  credit: 'Loan / Credit',
};

export type PurchasePaymentStatus = 'unpaid' | 'partially_paid' | 'paid';
export type PurchaseDeliveryStatus = 'not_booked' | 'booked' | 'dispatched' | 'delivered';

export const PURCHASE_UNITS = ['kg', 'g', 'l', 'ml', 'pcs', 'dozen', 'pack', 'box', 'bag', 'tray', 'bottle', 'can', 'carton'] as const;
export type PurchaseUnit = (typeof PURCHASE_UNITS)[number];

export const DELIVERY_PROVIDERS = ['bykea', 'indrive', 'yango', 'other', 'self_pickup'] as const;
export type DeliveryProvider = (typeof DELIVERY_PROVIDERS)[number];

/** Manual selection only: none of these is booked through an API. */
export const DELIVERY_PROVIDER_LABEL: Record<DeliveryProvider, string> = {
  bykea: 'Bykea',
  indrive: 'inDrive',
  yango: 'Yango',
  other: 'Other / Manual',
  self_pickup: 'Self Pickup',
};

export type QuotationAvailability = 'available' | 'partial' | 'unavailable' | 'substitute';
export type QuotationStatus = 'submitted' | 'changes_requested' | 'approved' | 'rejected' | 'superseded';
export type BillStatus = 'submitted' | 'approved' | 'rejected';
export type SubmittedVia = 'portal' | 'staff';

export const SUPPLIER_PAYMENT_METHODS = ['cash', 'easypaisa', 'bank'] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];
export type SupplierPaymentStatus = 'pending_approval' | 'posted' | 'rejected' | 'reversed';
export type SupplierCreditStatus = 'pending_approval' | 'active' | 'settled' | 'rejected' | 'cancelled';

export type WhatsAppMessageStatus = 'queued' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
export type WhatsAppMatchStatus = 'matched' | 'unmatched' | 'assigned' | 'dismissed';

/**
 * The work-queue tabs on the WhatsApp Purchasing page. Each is a filter over
 * `status` / `paymentStatus` / `priority`, defined once on the server
 * (services/purchasing/buckets.ts) so every client counts the same thing.
 */
export const PURCHASE_BUCKETS = [
  'all',
  'pending',
  'urgent',
  'normal',
  'awaiting_supplier',
  'quotation_received',
  'awaiting_approval',
  'approved',
  'awaiting_bill',
  'awaiting_delivery',
  'unpaid',
  'completed',
  'closed',
] as const;
export type PurchaseBucket = (typeof PURCHASE_BUCKETS)[number];

export const PURCHASE_BUCKET_LABEL: Record<PurchaseBucket, string> = {
  all: 'All',
  pending: 'Pending',
  urgent: 'Urgent',
  normal: 'Normal',
  awaiting_supplier: 'Awaiting client response',
  quotation_received: 'Quotation received',
  awaiting_approval: 'Awaiting production approval',
  approved: 'Approved',
  awaiting_bill: 'Awaiting bill',
  awaiting_delivery: 'Awaiting delivery',
  unpaid: 'Unpaid / partly paid',
  completed: 'Completed',
  closed: 'Cancelled / rejected',
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface Supplier {
  id: string;
  supplierCode: string;
  name: string;
  contactPerson: string | null;
  whatsappNumber: string;
  phone: string | null;
  category: string | null;
  address: string | null;
  paymentTerms: string | null;
  notes: string | null;
  isActive: boolean;
  whatsappOptInAt: string | null;
  whatsappOptInSource: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseItem {
  id: string;
  itemCode: string;
  name: string;
  unit: PurchaseUnit;
  category: string | null;
  isActive: boolean;
  /** Ingredient stock on hand, in `unit`. */
  balance: number;
}

export interface IngredientStockMovement {
  id: string;
  movementNo: string;
  itemId: string;
  itemName: string;
  unit: string;
  type: 'receipt' | 'adjustment';
  delta: number;
  balanceAfter: number;
  demandId: string | null;
  receiptId: string | null;
  reason: string | null;
  businessDate: string;
  createdByName: string | null;
  createdAt: string;
}

export interface PurchaseDemandItem {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemName: string;
  itemCode: string | null;
  requestedQty: number;
  unit: string;
  note: string | null;
}

export interface PurchaseDemand {
  id: string;
  demandNo: string;
  status: PurchaseDemandStatus;
  priority: PurchasePriority;
  requiredDate: string;
  supplierId: string;
  supplierName: string;
  supplierWhatsapp: string;
  notes: string | null;
  deliveryInstructions: string | null;
  paymentPreference: PurchasePaymentPreference;
  creditReference: string | null;
  creditAmountRequested: number | null;
  creditTerms: string | null;
  creditDueDate: string | null;
  creditNotes: string | null;
  paymentStatus: PurchasePaymentStatus;
  deliveryStatus: PurchaseDeliveryStatus;
  currentQuotationId: string | null;
  approvedQuotationId: string | null;
  approvedBillId: string | null;
  revision: number;
  verifiedRevision: number | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  sentAt: string | null;
  sentByName: string | null;
  closedReason: string | null;
  closedAt: string | null;
  closedByName: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  items: PurchaseDemandItem[];
}

/** One row of the demand list: the demand without its lines, plus totals. */
export interface PurchaseDemandListRow extends Omit<PurchaseDemand, 'items'> {
  itemCount: number;
  /** Total of the current quotation, then of the approved bill once there is one. */
  quotedTotal: number | null;
  billTotal: number | null;
  paidTotal: number;
  /** The newest message's status for this demand, for the failed-message badge. */
  lastMessageStatus: WhatsAppMessageStatus | null;
}

export interface QuotationItem {
  id: string;
  lineNo: number;
  demandItemId: string | null;
  substituteForDemandItemId: string | null;
  itemName: string;
  unit: string;
  requestedQty: number | null;
  availableQty: number;
  unitRate: number;
  lineTotal: number;
  availability: QuotationAvailability;
  note: string | null;
}

export interface Quotation {
  id: string;
  demandId: string;
  version: number;
  status: QuotationStatus;
  submittedVia: SubmittedVia;
  enteredByName: string | null;
  subtotal: number;
  deliveryCharge: number;
  total: number;
  estimatedDeliveryDate: string | null;
  deliveryNotes: string | null;
  notes: string | null;
  submittedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  items: QuotationItem[];
}

export interface BillDifference {
  item: string | null;
  field: 'quantity' | 'rate' | 'delivery_charge' | 'other_charges';
  quoted: number;
  billed: number;
}

export interface BillItem {
  id: string;
  lineNo: number;
  quotationItemId: string | null;
  itemName: string;
  unit: string;
  qty: number;
  unitRate: number;
  lineTotal: number;
}

export interface SupplierBill {
  id: string;
  demandId: string;
  quotationId: string;
  quotationVersion: number;
  supplierBillNo: string;
  status: BillStatus;
  submittedVia: SubmittedVia;
  enteredByName: string | null;
  invoiceDate: string;
  deliveryDate: string | null;
  subtotal: number;
  deliveryCharge: number;
  discount: number;
  otherCharges: number;
  otherChargesNote: string | null;
  grandTotal: number;
  /** The supplier's own statement. Not a payment. */
  supplierPaymentMethod: string | null;
  supplierStatedPaid: number;
  notes: string | null;
  differsFromQuotation: boolean;
  differences: BillDifference[];
  acceptedDifferences: boolean;
  submittedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  items: BillItem[];
}

export interface PurchaseDelivery {
  id: string;
  demandId: string;
  provider: DeliveryProvider;
  providerName: string | null;
  bookingReference: string | null;
  estimatedFee: number | null;
  actualFee: number | null;
  feePaidBy: 'mountain_bakes' | 'supplier';
  pickupDetails: string | null;
  deliveryNotes: string | null;
  status: 'booked' | 'dispatched' | 'delivered';
  dispatchedAt: string | null;
  deliveredAt: string | null;
  receivedByName: string | null;
  updatedByName: string | null;
  updatedAt: string;
}

export interface ReceiptItem {
  id: string;
  billItemId: string;
  itemId: string;
  itemName: string;
  unit: string;
  receivedQty: number;
  damagedQty: number;
  acceptedQty: number;
  note: string | null;
}

export interface PurchaseReceipt {
  id: string;
  receiptNo: string;
  billId: string;
  businessDate: string;
  isFinal: boolean;
  receivedByName: string | null;
  receivedAt: string;
  notes: string | null;
  items: ReceiptItem[];
}

export interface SupplierPayment {
  id: string;
  paymentNo: string;
  supplierId: string;
  supplierName?: string;
  demandId: string;
  demandNo?: string;
  billId: string;
  supplierBillNo?: string;
  creditId: string | null;
  method: SupplierPaymentMethod;
  account: 'cash' | 'bank';
  amount: number;
  referenceNo: string | null;
  paidOn: string;
  notes: string | null;
  status: SupplierPaymentStatus;
  recordedByName: string | null;
  recordedAt: string;
  ledgerHeadId: string | null;
  voucherNo: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  reversalVoucherNo: string | null;
  reversedByName: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface SupplierCredit {
  id: string;
  creditNo: string;
  supplierId: string;
  supplierName?: string;
  demandId: string;
  demandNo?: string;
  billId: string;
  requestedAmount: number;
  approvedAmount: number | null;
  /** approvedAmount − posted repayments; 0 until approved. */
  outstanding: number;
  terms: string | null;
  dueDate: string | null;
  reference: string | null;
  notes: string | null;
  status: SupplierCreditStatus;
  requestedByName: string | null;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface PurchaseDemandEvent {
  id: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: 'staff' | 'supplier' | 'system';
  actorName: string | null;
  quotationId: string | null;
  billId: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface WhatsAppMessage {
  id: string;
  conversationId: string;
  waId: string;
  direction: 'inbound' | 'outbound';
  provider: string | null;
  providerMessageId: string | null;
  type: string;
  templateName: string | null;
  body: string | null;
  status: WhatsAppMessageStatus;
  errorCode: string | null;
  errorTitle: string | null;
  errorDetail: string | null;
  demandId: string | null;
  demandNo: string | null;
  supplierId: string | null;
  supplierName: string | null;
  matchStatus: WhatsAppMatchStatus | null;
  reviewedByName: string | null;
  createdByName: string | null;
  createdAt: string;
  acceptedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  /** Outbound and still queued: the attempt count and the next try. */
  attempts: number | null;
  nextAttemptAt: string | null;
}

export interface WhatsAppConversation {
  id: string;
  waId: string;
  supplierId: string | null;
  supplierName: string | null;
  profileName: string | null;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  /** Free text is allowed until this time; after it, only an approved template. */
  windowOpenUntil: string | null;
  lastMessage: Pick<WhatsAppMessage, 'body' | 'direction' | 'status' | 'createdAt'> | null;
}

/** What the actions on a demand may currently be — computed on the server. */
export interface PurchaseDemandActions {
  edit: boolean;
  verify: boolean;
  send: boolean;
  resendLink: boolean;
  cancel: boolean;
  enterQuotation: boolean;
  decideQuotation: boolean;
  enterBill: boolean;
  decideBill: boolean;
  saveDelivery: boolean;
  receive: boolean;
  recordPayment: boolean;
  requestCredit: boolean;
  message: boolean;
}

export interface PurchaseDemandDetail extends PurchaseDemand {
  supplier: Supplier | null;
  quotations: Quotation[];
  bills: SupplierBill[];
  delivery: PurchaseDelivery | null;
  receipts: PurchaseReceipt[];
  payments: SupplierPayment[];
  credits: SupplierCredit[];
  events: PurchaseDemandEvent[];
  messages: WhatsAppMessage[];
  /** Per approved-bill line: billed, received, damaged, still owed. */
  receiptProgress: Array<{ billItemId: string; itemName: string; unit: string; billed: number; received: number; damaged: number; outstanding: number }>;
  totals: {
    billTotal: number | null;
    paidPosted: number;
    paidPending: number;
    outstanding: number | null;
    creditOutstanding: number;
  };
  actions: PurchaseDemandActions;
  /** Supplier link: when the current one expires, never the link itself. */
  linkExpiresAt: string | null;
}

export interface VerificationCheck {
  key: string;
  label: string;
  ok: boolean;
  message?: string;
  /** A warning does not block sending; a failed check does. */
  severity: 'error' | 'warning';
}

export interface VerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
  demand: PurchaseDemand;
}

export interface SupplierBalance {
  supplierId: string;
  supplierName: string;
  billed: number;
  paid: number;
  outstanding: number;
  creditApproved: number;
  creditRepaid: number;
  creditOutstanding: number;
  pendingPayments: number;
}

export interface PurchasingSummary {
  buckets: Record<PurchaseBucket, number>;
  failedMessages: number;
  unmatchedMessages: number;
  outstandingSupplierCredit: number;
  pendingSupplierPayments: number;
}

/** The connection panel. No secret ever appears here, only whether it is set. */
export interface WhatsAppConnectionStatus {
  provider: 'meta' | 'mock';
  /** `connected` only once Meta has called the webhook for the authorized number. */
  state: 'connected' | 'awaiting_webhook' | 'configuration_required' | 'mock';
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  authorized: boolean;
  apiVersion: string;
  lastWebhookAt: string | null;
  missing: string[];
  templates: { demand: string; update: string; language: string };
  outbox: { pending: number; failed: number };
}

export interface PurchaseDemandListResponse {
  demands: PurchaseDemandListRow[];
  total: number;
}

// ---------------------------------------------------------------------------
// Supplier portal (unauthenticated, token-scoped)
// ---------------------------------------------------------------------------

/** Everything a supplier may see: their demand, never balances or other demands. */
export interface SupplierPortalView {
  business: string;
  demandNo: string;
  status: PurchaseDemandStatus;
  statusLabel: string;
  priority: PurchasePriority;
  requiredDate: string;
  supplierName: string;
  notes: string | null;
  deliveryInstructions: string | null;
  items: Array<Pick<PurchaseDemandItem, 'id' | 'lineNo' | 'itemName' | 'requestedQty' | 'unit' | 'note'>>;
  /** Their latest quotation, and the approved one if any. */
  latestQuotation: Quotation | null;
  approvedQuotation: Quotation | null;
  latestBill: Omit<SupplierBill, 'enteredByName' | 'decidedByName'> | null;
  /** Production's reason when it asked for changes or rejected a bill. */
  productionNote: string | null;
  canQuote: boolean;
  canBill: boolean;
  linkExpiresAt: string;
}
