// Product price-change history / audit trail. Every price change (manual or bulk
// import) appends one immutable `product_price_history` document. `products.price`
// always holds the currently-active price; a future-dated change sits as `scheduled`
// until the 2 AM business-day activation flips it to `active`.

export type PriceChangeStatus = 'scheduled' | 'active' | 'superseded';
export type PriceChangeSource = 'manual' | 'import';

export interface PriceHistoryDoc {
  id: string;
  productId: string;
  productCode: string; // = product.sku snapshot at change time
  productName: string;
  categoryName: string;
  oldPrice: number;
  newPrice: number;
  effectiveDate: string; // 'YYYY-MM-DD' (business-date semantics)
  reason: string;
  source: PriceChangeSource;
  status: PriceChangeStatus;
  versionNumber: number; // per-product, monotonic
  changedBy: string; // uid
  changedByName: string;
  changedOn: string; // ISO UTC — when recorded
  activatedOn: string | null; // ISO UTC — when it became products.price (null while scheduled)
  batchId: string | null; // groups rows from one import (single summary notification)
}

/** Reason a spreadsheet row was rejected in the import preview. */
export type ImportRowError = 'UNKNOWN_SKU' | 'INVALID_PRICE' | 'DUPLICATE_IN_FILE' | 'MISSING_FIELD';

export interface ImportValidRow {
  productId: string;
  productCode: string;
  productName: string;
  categoryName: string;
  currentPrice: number;
  newPrice: number;
}

export interface ImportUnchangedRow {
  productCode: string;
  productName: string;
  price: number;
}

export interface ImportErrorRow {
  rowNumber: number;
  productCode: string;
  rawPrice: string;
  error: ImportRowError;
  message: string;
}

export interface ImportPreviewResult {
  summary: { total: number; valid: number; unchanged: number; errors: number };
  validRows: ImportValidRow[];
  unchangedRows: ImportUnchangedRow[];
  errorRows: ImportErrorRow[];
}

export interface ImportCommitResult {
  batchId: string;
  appliedImmediate: number;
  scheduled: number;
  skipped: number;
  errors: { productId: string; message: string }[];
}
