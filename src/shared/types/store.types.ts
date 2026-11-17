// ── Dry Items Store (migrations 20261110000001/2) ───────────────────────────
//
// A department that receives dry items in costed batches, keeps an
// effective-dated Price Control list, and issues stock to Production against
// an approved demand. Nothing here ever reaches the Finance ledger.
//
// Numbers: DRY-STORE-001 (the store), DRY-001 (item), PRC-0001 (price),
// RCV-000001 (receipt), BAT-000001 (batch), DRD-000001 (dry-items demand —
// not DMD-, which is the branch→Production demand), ISS-000001 (issue),
// ADJ-000001 (adjustment), SQ-000001 (query).

import type { UserRole } from './user.types';

export const STORE_DEMAND_STATUSES = ['pending_review', 'ready_to_issue', 'issued', 'received', 'rejected', 'cancelled'] as const;
export type StoreDemandStatus = (typeof STORE_DEMAND_STATUSES)[number];
export const STORE_DEMAND_STATUS_LABELS: Record<StoreDemandStatus, string> = {
  pending_review: 'Pending review',
  ready_to_issue: 'Ready to issue',
  issued: 'Issued',
  received: 'Received',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export type StoreLineStatus = 'pending' | 'approved' | 'rejected' | 'issued';
export type StoreIssueStatus = 'issued' | 'received' | 'received_with_difference';
export const STORE_ISSUE_STATUS_LABELS: Record<StoreIssueStatus, string> = {
  issued: 'Awaiting Production',
  received: 'Received',
  received_with_difference: 'Received with difference',
};

/** Where a price stands today. Computed, never stored. */
export type StorePriceState = 'active' | 'scheduled' | 'superseded' | 'inactive';

export type StoreLookupKind = 'category' | 'base_unit' | 'purchase_unit' | 'adjust_reason';

/** The physical kind of a unit, so the pick-list is a managed master (problem 5). */
export const STORE_UNIT_TYPES = ['weight', 'volume', 'count', 'pack'] as const;
export type StoreUnitType = (typeof STORE_UNIT_TYPES)[number];
export const STORE_UNIT_TYPE_LABELS: Record<StoreUnitType, string> = {
  weight: 'Weight',
  volume: 'Volume',
  count: 'Count',
  pack: 'Pack',
};

export type StoreMovementType = 'opening' | 'receipt' | 'issue' | 'adjustment' | 'return';
export const STORE_MOVEMENT_LABELS: Record<StoreMovementType, string> = {
  opening: 'Opening',
  receipt: 'Received',
  issue: 'Issued',
  adjustment: 'Adjusted',
  return: 'Returned',
};

/** Adjustment reasons the database treats specially (not in Store Settings). */
export const STORE_OPENING_REASON = 'Opening stock';
export const STORE_RETURN_REASON = 'Returned from Production';

export const STORE_QUERY_TYPES = [
  'stock_receiving',
  'missing_stock',
  'quantity_difference',
  'price_difference',
  'production_demand',
  'stock_issuance',
  'incorrect_transaction',
  'other',
] as const;
export type StoreQueryType = (typeof STORE_QUERY_TYPES)[number];
export const STORE_QUERY_TYPE_LABELS: Record<StoreQueryType, string> = {
  stock_receiving: 'Stock receiving',
  missing_stock: 'Missing stock',
  quantity_difference: 'Quantity difference',
  price_difference: 'Price difference',
  production_demand: 'Production demand',
  stock_issuance: 'Stock issuance',
  incorrect_transaction: 'Incorrect transaction',
  other: 'Other',
};

export const STORE_QUERY_STATUSES = ['open', 'in_review', 'responded', 'resolved', 'rejected'] as const;
export type StoreQueryStatus = (typeof STORE_QUERY_STATUSES)[number];
export const STORE_QUERY_STATUS_LABELS: Record<StoreQueryStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  responded: 'Responded',
  resolved: 'Resolved',
  rejected: 'Rejected',
};

export const STORE_REPORT_TYPES = [
  'daily_receiving',
  'monthly_receiving',
  'item_stock',
  'purchase_price_history',
  'production_demand',
  'approved_demand',
  'stock_issuance',
  'remaining_stock',
  'stock_adjustment',
  'stock_valuation',
] as const;
export type StoreReportType = (typeof STORE_REPORT_TYPES)[number];

export interface StoreReportColumn {
  key: string;
  header: string;
  kind?: 'text' | 'date' | 'qty' | 'money' | 'rate';
}

/** Columns per report: the API's Excel export and the page's table read the same list. */
export const STORE_REPORTS: Record<StoreReportType, { label: string; dated: boolean; columns: StoreReportColumn[] }> = {
  daily_receiving: {
    label: 'Daily Stock Receiving',
    dated: true,
    columns: [
      { key: 'receiptDate', header: 'Date', kind: 'date' },
      { key: 'receiptNo', header: 'Receiving ID' },
      { key: 'supplierName', header: 'Supplier' },
      { key: 'invoiceNo', header: 'Invoice' },
      { key: 'itemNo', header: 'Item ID' },
      { key: 'itemName', header: 'Item' },
      { key: 'packageName', header: 'Package' },
      { key: 'packages', header: 'Packages', kind: 'qty' },
      { key: 'receivedQty', header: 'Quantity', kind: 'qty' },
      { key: 'baseUnit', header: 'Unit' },
      { key: 'pricePerPackage', header: 'Price / pkg', kind: 'money' },
      { key: 'amount', header: 'Amount', kind: 'money' },
      { key: 'batchNo', header: 'Batch' },
      { key: 'expiryDate', header: 'Expiry', kind: 'date' },
      { key: 'receivedByName', header: 'Received by' },
    ],
  },
  monthly_receiving: {
    label: 'Monthly Stock Receiving',
    dated: true,
    columns: [
      { key: 'month', header: 'Month' },
      { key: 'itemNo', header: 'Item ID' },
      { key: 'itemName', header: 'Item' },
      { key: 'receipts', header: 'Receipts', kind: 'qty' },
      { key: 'receivedQty', header: 'Quantity', kind: 'qty' },
      { key: 'baseUnit', header: 'Unit' },
      { key: 'avgUnitCost', header: 'Avg cost / unit', kind: 'rate' },
      { key: 'amount', header: 'Amount', kind: 'money' },
    ],
  },
  item_stock: {
    label: 'Item-wise Stock',
    dated: true,
    columns: [
      { key: 'itemNo', header: 'Item ID' },
      { key: 'name', header: 'Item' },
      { key: 'category', header: 'Category' },
      { key: 'baseUnit', header: 'Unit' },
      { key: 'opening', header: 'Opening', kind: 'qty' },
      { key: 'received', header: 'Received', kind: 'qty' },
      { key: 'returned', header: 'Returned', kind: 'qty' },
      { key: 'issued', header: 'Issued', kind: 'qty' },
      { key: 'adjusted', header: 'Adjusted', kind: 'qty' },
      { key: 'closing', header: 'Closing', kind: 'qty' },
      { key: 'committed', header: 'Committed', kind: 'qty' },
      { key: 'minStock', header: 'Low-stock level', kind: 'qty' },
    ],
  },
  purchase_price_history: {
    label: 'Item-wise Purchase Price History',
    dated: true,
    columns: [
      { key: 'itemName', header: 'Item' },
      { key: 'receiptDate', header: 'Date', kind: 'date' },
      { key: 'receiptNo', header: 'Receiving ID' },
      { key: 'batchNo', header: 'Batch' },
      { key: 'supplierName', header: 'Supplier' },
      { key: 'packageName', header: 'Package' },
      { key: 'packageQty', header: 'Package qty', kind: 'qty' },
      { key: 'listPrice', header: 'Price Control / pkg', kind: 'money' },
      { key: 'pricePerPackage', header: 'Paid / pkg', kind: 'money' },
      { key: 'unitCost', header: 'Cost / unit', kind: 'rate' },
      { key: 'overrideReason', header: 'Override reason' },
    ],
  },
  production_demand: {
    label: 'Production Demand',
    dated: true,
    columns: [
      { key: 'demandDate', header: 'Date', kind: 'date' },
      { key: 'demandNo', header: 'Demand ID' },
      { key: 'productionCode', header: 'Production ID' },
      { key: 'requestedByName', header: 'Requested by' },
      { key: 'requiredDate', header: 'Needed by', kind: 'date' },
      { key: 'itemName', header: 'Item' },
      { key: 'unit', header: 'Unit' },
      { key: 'requestedQty', header: 'Requested', kind: 'qty' },
      { key: 'approvedQty', header: 'Approved', kind: 'qty' },
      { key: 'rejectedQty', header: 'Rejected', kind: 'qty' },
      { key: 'issuedQty', header: 'Issued', kind: 'qty' },
      { key: 'status', header: 'Line status' },
      { key: 'demandAmount', header: 'Demand amount', kind: 'money' },
    ],
  },
  approved_demand: {
    label: 'Approved Demand',
    dated: true,
    columns: [
      { key: 'demandDate', header: 'Date', kind: 'date' },
      { key: 'demandNo', header: 'Demand ID' },
      { key: 'itemName', header: 'Item' },
      { key: 'unit', header: 'Unit' },
      { key: 'requestedQty', header: 'Requested', kind: 'qty' },
      { key: 'approvedQty', header: 'Approved', kind: 'qty' },
      { key: 'unitPrice', header: 'Unit price', kind: 'rate' },
      { key: 'demandAmount', header: 'Demand amount', kind: 'money' },
      { key: 'issuedQty', header: 'Issued', kind: 'qty' },
      { key: 'remainingQty', header: 'Remaining', kind: 'qty' },
      { key: 'decidedByName', header: 'Approved by' },
    ],
  },
  stock_issuance: {
    label: 'Stock Issuance',
    dated: true,
    columns: [
      { key: 'issueDate', header: 'Date', kind: 'date' },
      { key: 'issueNo', header: 'Issue ID' },
      { key: 'demandNo', header: 'Demand ID' },
      { key: 'itemName', header: 'Item' },
      { key: 'unit', header: 'Unit' },
      { key: 'approvedQty', header: 'Approved', kind: 'qty' },
      { key: 'issuedQty', header: 'Issued', kind: 'qty' },
      { key: 'receivedQty', header: 'Received', kind: 'qty' },
      { key: 'differenceQty', header: 'Difference', kind: 'qty' },
      { key: 'costAmount', header: 'Cost (FIFO)', kind: 'money' },
      { key: 'batches', header: 'Batches' },
      { key: 'issuedByName', header: 'Issued by' },
      { key: 'receivedByName', header: 'Received by' },
      { key: 'status', header: 'Status' },
    ],
  },
  remaining_stock: {
    label: 'Remaining Stock (batches)',
    dated: false,
    columns: [
      { key: 'itemNo', header: 'Item ID' },
      { key: 'itemName', header: 'Item' },
      { key: 'batchNo', header: 'Batch' },
      { key: 'source', header: 'Source' },
      { key: 'receivedAt', header: 'Received', kind: 'date' },
      { key: 'supplierBatchNo', header: 'Supplier batch' },
      { key: 'expiryDate', header: 'Expiry', kind: 'date' },
      { key: 'receivedQty', header: 'Received qty', kind: 'qty' },
      { key: 'remainingQty', header: 'Remaining', kind: 'qty' },
      { key: 'baseUnit', header: 'Unit' },
      { key: 'unitCost', header: 'Cost / unit', kind: 'rate' },
      { key: 'value', header: 'Value', kind: 'money' },
    ],
  },
  stock_adjustment: {
    label: 'Stock Adjustment',
    dated: true,
    columns: [
      { key: 'businessDate', header: 'Date', kind: 'date' },
      { key: 'adjNo', header: 'Adjustment ID' },
      { key: 'itemName', header: 'Item' },
      { key: 'kind', header: 'Kind' },
      { key: 'qty', header: 'Quantity', kind: 'qty' },
      { key: 'baseUnit', header: 'Unit' },
      { key: 'reason', header: 'Reason' },
      { key: 'note', header: 'Note' },
      { key: 'value', header: 'Value', kind: 'money' },
      { key: 'createdByName', header: 'By' },
    ],
  },
  stock_valuation: {
    label: 'Stock Valuation',
    dated: true,
    columns: [
      { key: 'itemNo', header: 'Item ID' },
      { key: 'name', header: 'Item' },
      { key: 'category', header: 'Category' },
      { key: 'availableQty', header: 'In store now', kind: 'qty' },
      { key: 'baseUnit', header: 'Unit' },
      { key: 'activeBatches', header: 'Batches', kind: 'qty' },
      { key: 'stockValue', header: 'Value at cost', kind: 'money' },
      { key: 'unitPrice', header: 'Price Control / unit', kind: 'rate' },
      { key: 'valueAtPrice', header: 'Value at Price Control', kind: 'money' },
    ],
  },
};

// ── Permissions ──────────────────────────────────────────────────────────────

export type StoreAction =
  | 'view' // Dashboard, items, prices, stock, ledger
  | 'items.edit'
  | 'items.delete'
  | 'prices.edit'
  | 'receive'
  | 'receive.override'
  | 'adjust'
  | 'opening'
  | 'demand.create'
  | 'demand.review'
  | 'issue'
  | 'issue.confirm'
  | 'queries.raise'
  | 'queries.admin'
  | 'reports'
  | 'accounts';

/** The per-account switches Admin sets on a Store keeper (store_accounts). */
export interface StoreAccountFlags {
  canManageItems: boolean;
  canEditPrices: boolean;
  canAdjustStock: boolean;
  canIssue: boolean;
}

export const DEFAULT_STORE_FLAGS: StoreAccountFlags = {
  canManageItems: true,
  canEditPrices: false,
  canAdjustStock: true,
  canIssue: true,
};

/** Every role that can open the Store pages at all. */
export const STORE_VIEW_ROLES: readonly UserRole[] = [
  'super_admin',
  'store_user',
  'finance_admin',
  'finance_manager',
  'accountant',
  'finance_auditor',
];

/**
 * What a role (and, for a Store keeper, their account switches) may do.
 * The API enforces exactly this; the client uses it only to hide buttons.
 *
 *   Admin        everything.
 *   Store keeper the store's daily work; items, prices, adjustments and
 *                issuing as Admin has switched them on for the account.
 *   Finance      reads the store; Finance Admin / Manager set prices.
 *   Production   reads items and stock, raises demand, confirms receipt.
 *
 * Takes a loose `string` role for the same reason `isBranchRole` does.
 */
export function storeCan(role: string | null | undefined, action: StoreAction, flags?: Partial<StoreAccountFlags> | null): boolean {
  const f = { ...DEFAULT_STORE_FLAGS, ...(flags ?? {}) };
  switch (role) {
    case 'super_admin':
      return true;
    case 'store_user':
      switch (action) {
        case 'view':
        case 'receive':
        case 'demand.review':
        case 'queries.raise':
        case 'reports':
          return true;
        case 'items.edit':
          return f.canManageItems;
        case 'prices.edit':
          return f.canEditPrices;
        case 'adjust':
          return f.canAdjustStock;
        case 'issue':
          return f.canIssue;
        default:
          return false;
      }
    case 'finance_admin':
    case 'finance_manager':
      return action === 'view' || action === 'reports' || action === 'prices.edit';
    case 'accountant':
    case 'finance_auditor':
      return action === 'view' || action === 'reports';
    case 'production_user':
      // `view` lets the demand form show items and free stock. Production has
      // no Store pages of its own (STORE_VIEW_ROLES); its screen is /production-dry-demand.
      return action === 'view' || action === 'demand.create' || action === 'issue.confirm' || action === 'queries.raise';
    default:
      return false;
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

export interface StoreDepartment {
  id: string;
  storeCode: string;
  name: string;
  openingDate: string | null;
  isActive: boolean;
}

// ── Feature flags ─────────────────────────────────────────────────────────────
// Optional inventory modules ship behind a per-store switch so they can merge
// dark and be enabled once ready. A missing store_features row reads as off.
export const STORE_FEATURE_KEYS = [
  'suppliers',
  'barcodes',
  'purchase_orders',
  'returns',
  'stock_counts',
  'locations',
  'transfers',
] as const;
export type StoreFeatureKey = (typeof STORE_FEATURE_KEYS)[number];

export const STORE_FEATURE_LABELS: Record<StoreFeatureKey, string> = {
  suppliers: 'Suppliers master',
  barcodes: 'Item barcodes',
  purchase_orders: 'Purchase Orders',
  returns: 'Returns from Production',
  stock_counts: 'Stock counts (stocktake)',
  locations: 'Locations & bins',
  transfers: 'Stock transfers',
};

export const STORE_FEATURE_DESCRIPTIONS: Record<StoreFeatureKey, string> = {
  suppliers: 'A managed supplier list with codes, contacts and per-item pricing.',
  barcodes: 'Scan-ready barcodes on items and batches.',
  purchase_orders: 'Raise, approve and receive against purchase orders, with reorder suggestions.',
  returns: 'Take unused stock back from Production against an issue.',
  stock_counts: 'Physical stocktakes that post count-correction adjustments.',
  locations: 'Track stock by store location / bin and move it between them.',
  transfers: 'Send stock from one store or branch to another.',
};

/** One feature and whether it is on for the store — the admin toggle list. */
export interface StoreFeature {
  key: StoreFeatureKey;
  label: string;
  description: string;
  enabled: boolean;
}

/** GET /api/store/me — who is asking and what they may do. */
export interface StoreMe {
  store: StoreDepartment;
  role: UserRole;
  flags: StoreAccountFlags;
  can: Record<StoreAction, boolean>;
  /** Which optional modules are enabled for this store (missing key = off). */
  features: Record<StoreFeatureKey, boolean>;
  businessDate: string;
}

export interface StoreAccount extends StoreAccountFlags {
  id: string | null; // null: a store_user with no account row yet (defaults apply)
  userId: string;
  storeId: string;
  notes: string | null;
  email: string;
  displayName: string;
  username: string | null;
  phone: string | null;
  userCode: string | null;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface StoreLookup {
  id: string;
  kind: StoreLookupKind;
  value: string;
  sortOrder: number;
  isActive: boolean;
  /** Only set for unit kinds: weight / volume / count / pack. */
  unitType: StoreUnitType | null;
}

export type StorePriceRequestStatus = 'open' | 'resolved' | 'cancelled';

/** A Store keeper's ask for Finance/Admin to price an item that has none (problem 3). */
export interface StorePriceRequest {
  id: string;
  itemId: string;
  itemNo: string;
  itemName: string;
  baseUnit: string;
  note: string | null;
  status: StorePriceRequestStatus;
  requestedByName: string | null;
  resolvedByName: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * The supplier master (Phase 2). Shared with WhatsApp Purchasing — the same
 * `public.suppliers` row. `whatsappNumber` is optional for store-only suppliers.
 */
export interface StoreSupplier {
  id: string;
  supplierCode: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  whatsappNumber: string | null;
  email: string | null;
  category: string | null;
  address: string | null;
  ntn: string | null;
  strn: string | null;
  paymentTerms: string | null;
  leadTimeDays: number | null;
  notes: string | null;
  isActive: boolean;
}

export interface StoreItem {
  id: string;
  itemNo: string;
  itemCode: string;
  name: string;
  category: string;
  baseUnit: string;
  purchaseUnit: string;
  conversionQty: number;
  minStock: number;
  availableQty: number;
  status: 'active' | 'inactive';
  remarks: string | null;
  purchaseItemId: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on lists: approved-not-issued, and the current Price Control unit price. */
  committedQty?: number;
  unitPrice?: number | null;
}

export interface StorePrice {
  id: string;
  priceNo: string;
  itemId: string;
  itemNo: string;
  itemName: string;
  baseUnit: string;
  packageName: string;
  packageQty: number;
  price: number;
  effectiveFrom: string;
  status: 'active' | 'inactive';
  state: StorePriceState;
  createdByName: string | null;
  createdAt: string;
  deactivatedByName: string | null;
  deactivatedAt: string | null;
}

export interface StoreBatch {
  id: string;
  batchNo: string;
  itemId: string;
  source: 'receipt' | 'opening' | 'adjustment' | 'return';
  receiptId: string | null;
  lineNo: number | null;
  priceId: string | null;
  packageName: string | null;
  packageQty: number | null;
  packages: number | null;
  listPrice: number | null;
  pricePerPackage: number | null;
  overrideReason: string | null;
  unitCost: number;
  receivedQty: number;
  remainingQty: number;
  amount: number;
  supplierBatchNo: string | null;
  expiryDate: string | null;
  receivedAt: string;
  createdAt: string;
  // On receipt lines
  itemNo?: string;
  itemCode?: string;
  itemName?: string;
  baseUnit?: string;
  receiptNo?: string | null;
}

export interface StoreReceipt {
  id: string;
  receiptNo: string;
  storeId: string;
  receiptDate: string;
  supplierId: string | null;
  supplierName: string;
  invoiceNo: string | null;
  remarks: string | null;
  totalAmount: number;
  receivedBy: string | null;
  receivedByName: string | null;
  createdAt: string;
  lines: StoreBatch[];
}

export interface StoreStockRow {
  id: string;
  itemNo: string;
  itemCode: string;
  name: string;
  category: string;
  baseUnit: string;
  purchaseUnit: string;
  conversionQty: number;
  minStock: number;
  status: 'active' | 'inactive';
  availableQty: number;
  opening: number;
  received: number;
  issued: number;
  adjusted: number;
  returned: number;
  closing: number;
  committed: number;
  activeBatches: number;
  lastReceived: string | null;
  /** Remaining batches at what they cost. */
  stockValue: number;
  /** Price Control's current price of one base unit, if any. */
  unitPrice: number | null;
}

export interface StoreLedgerRow {
  id: string;
  businessDate: string;
  type: StoreMovementType;
  refNo: string;
  detail: string | null;
  qtyDelta: number;
  balance: number;
  value: number;
  createdByName: string | null;
  createdAt: string;
}

export interface StoreLedger {
  opening: number;
  closing: number;
  totalIn: number;
  totalOut: number;
  rows: StoreLedgerRow[];
}

export interface StoreAuditEvent {
  id: string;
  entity: string;
  entityId: string | null;
  entityRef: string | null;
  action: string;
  detail: string | null;
  actorName: string | null;
  actorRole: string | null;
  createdAt: string;
}

export interface StoreItemHistory {
  item: StoreItem;
  batches: StoreBatch[];
  prices: StorePrice[];
  events: StoreAuditEvent[];
  demandLines: Array<{
    id: string;
    demandId: string;
    demandNo: string;
    demandDate: string;
    requestedQty: number;
    approvedQty: number | null;
    issuedQty: number;
    status: StoreLineStatus;
  }>;
}

export interface StoreDemandLine {
  id: string;
  demandId: string;
  lineNo: number;
  itemId: string;
  itemNo: string;
  itemCode: string;
  itemName: string;
  unit: string;
  requestedQty: number;
  status: StoreLineStatus;
  approvedQty: number | null;
  issuedQty: number;
  receivedQty: number;
  unitPrice: number | null;
  currentUnitPrice: number | null;
  remarks: string | null;
  decisionNote: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  availableQty: number;
  committedQty: number;
  issueNos: string[];
}

export interface StoreDemand {
  id: string;
  demandNo: string;
  storeId: string;
  demandDate: string;
  requiredDate: string;
  requestedBy: string | null;
  requestedByName: string | null;
  productionCode: string | null;
  remarks: string | null;
  status: StoreDemandStatus;
  cancelledAt: string | null;
  cancelledByName: string | null;
  createdAt: string;
  lines: StoreDemandLine[];
  issues: Array<{ id: string; issueNo: string; issueDate: string; status: StoreIssueStatus }>;
}

export interface StoreIssueLine {
  id: string;
  issueId: string;
  demandItemId: string;
  itemId: string;
  itemNo: string;
  itemName: string;
  unit: string;
  issuedQty: number;
  receivedQty: number | null;
  costAmount: number;
  unitPrice: number | null;
  batches: Array<{ batchNo: string; qty: number; unitCost: number; amount: number; receivedAt: string }>;
}

export interface StoreIssue {
  id: string;
  issueNo: string;
  demandId: string;
  demandNo: string;
  productionCode: string | null;
  requestedByName: string | null;
  issueDate: string;
  issuedByName: string | null;
  receivedByName: string;
  remarks: string | null;
  status: StoreIssueStatus;
  confirmedByName: string | null;
  confirmedAt: string | null;
  confirmNote: string | null;
  totalCost: number;
  createdAt: string;
  lines: StoreIssueLine[];
}

export interface StoreAdjustment {
  id: string;
  adjNo: string;
  itemId: string;
  itemName?: string;
  itemNo?: string;
  baseUnit?: string;
  kind: 'adjustment' | 'opening' | 'return';
  direction: 'in' | 'out';
  qty: number;
  reason: string;
  note: string | null;
  businessDate: string;
  value: number;
  createdByName: string | null;
  createdAt: string;
}

export interface StoreQueryMessage {
  id: string;
  queryId: string;
  authorName: string | null;
  authorSide: 'store' | 'production' | 'admin';
  body: string | null;
  statusChange: StoreQueryStatus | null;
  createdAt: string;
}

export interface StoreQuery {
  id: string;
  queryNo: string;
  subject: string;
  queryType: StoreQueryType;
  description: string;
  relatedReceiptId: string | null;
  relatedDemandId: string | null;
  relatedIssueId: string | null;
  relatedReceiptNo?: string | null;
  relatedDemandNo?: string | null;
  relatedIssueNo?: string | null;
  status: StoreQueryStatus;
  raisedBy: string | null;
  raisedByName: string | null;
  raisedByRole: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: StoreQueryMessage[];
  /** Latest admin reply, on lists. */
  lastReply?: string | null;
}

export interface StoreDashboard {
  businessDate: string;
  itemsActive: number;
  itemsInactive: number;
  itemsInStock: number;
  stockValue: number;
  committedValue: number;
  receivedToday: { amount: number; receipts: number; lines: number };
  issuedToday: { value: number; lines: number };
  pending: { lines: number; demands: number };
  approved: { lines: number; demands: number };
  rejected: { lines: number; demands: number };
  low: Array<{ id: string; itemNo: string; name: string; baseUnit: string; minStock: number; availableQty: number }>;
  outOfStock: Array<{ id: string; itemNo: string; name: string; baseUnit: string; minStock: number; availableQty: number }>;
  waiting: Array<{ id: string; demandNo: string; status: StoreDemandStatus; requiredDate: string; lines: number }>;
  movement: Array<{ k: string; received: number; receivedLines: number; issued: number; issuedLines: number; adjusted: number }>;
  consumption: Array<{ id: string; itemNo: string; name: string; baseUnit: string; qty: number; days: number; lastIssued: string; value: number }>;
}

export interface StoreReport {
  type: StoreReportType;
  from: string;
  to: string;
  rows: Array<Record<string, unknown>>;
}

export interface StorePage<T> {
  rows: T[];
  total: number;
}

// ── Items: Excel import / export ──────────────────────────────────────────────

/**
 * Column headers for the item export. The import reads them by name,
 * case- and space-insensitive, so a downloaded sheet is a valid re-upload.
 * `Item ID` and `Status` are informational — the import ignores them.
 */
export const STORE_ITEM_EXPORT_HEADERS = [
  'Item ID', 'Item Code', 'Item Name', 'Category', 'Base Unit', 'Purchase Unit', 'Conversion Qty', 'Low-stock Level', 'Remarks', 'Status',
] as const;

/** The editable fields of one imported row — what a commit writes. */
export interface StoreItemImportFields {
  itemCode: string;
  name: string;
  category: string;
  baseUnit: string;
  purchaseUnit: string;
  conversionQty: number;
  minStock: number;
  remarks: string | null;
}

/** One validated, committable row: a create, or an update of an existing item matched by Item Code. */
export interface StoreItemImportRow extends StoreItemImportFields {
  rowNumber: number;
  action: 'create' | 'update';
  /** The matched item's id on an update; null on a create. */
  id: string | null;
  /** Human-readable field changes on an update (e.g. 'Low-stock 5 → 8'); empty on a create. */
  changes: string[];
}

/** A row the import could not accept, with why. */
export interface StoreItemImportError {
  rowNumber: number;
  itemCode: string;
  message: string;
}

/** Result of parsing an uploaded workbook. Never writes. */
export interface StoreItemImportPreview {
  summary: { total: number; create: number; update: number; unchanged: number; errors: number };
  rows: StoreItemImportRow[];
  errors: StoreItemImportError[];
}

/** Result of committing the confirmed rows. */
export interface StoreItemImportResult {
  created: number;
  updated: number;
  failed: { itemCode: string; message: string }[];
}
