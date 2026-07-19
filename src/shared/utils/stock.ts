// Shared stock-status helpers used by both the API (validation, notifications)
// and the web app (colour bands, warnings) so the two never drift apart.

/**
 * A product is "low on stock" once its available balance drops below this many
 * units — the branch is prompted to raise a Production Order. Distinct from the
 * colour bands below: this is the alert threshold, those are the visual scale.
 */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Colour band for an available balance. Maps to the spec's four levels:
 *  - `healthy`  > 20   (green)
 *  - `moderate` 6–20   (orange)
 *  - `critical` 1–5    (red)
 *  - `out`      0      (dark red)
 */
export type StockLevel = 'healthy' | 'moderate' | 'critical' | 'out';

export function stockLevel(available: number): StockLevel {
  if (available <= 0) return 'out';
  if (available <= 5) return 'critical';
  if (available <= 20) return 'moderate';
  return 'healthy';
}

/** True when a product is running low but not yet out (1 .. threshold-1). */
export function isLowStock(available: number): boolean {
  return available > 0 && available < LOW_STOCK_THRESHOLD;
}
