import { supabaseAdmin } from '../config/supabase';
import {
  DEFAULT_BUSINESS_HOURS,
  hhmmToMinutes,
  ORDER_WINDOW_OPEN_MINUTES,
  ORDER_WINDOW_CLOSE_MINUTES,
  type AppSettings,
} from '../shared';
import { getCached, setCached } from '../utils/cache';

/** Full defaults — used when the settings/app doc is missing or partially populated. */
const FULL_DEFAULTS: AppSettings = {
  companyName: 'Mountain Bakes',
  logoUrl: '',
  logoPath: '',
  currency: 'PKR',
  currencySymbol: 'Rs.',
  gstRate: 0,
  gstEnabled: false,
  receiptFooter: 'Thank you for choosing Mountain Bakes!',
  theme: 'light',
  ...DEFAULT_BUSINESS_HOURS,
  updatedAt: '',
  updatedBy: '',
};

/** snake_case `settings` row → camelCase AppSettings field. */
const COLUMN_TO_FIELD: Record<string, keyof AppSettings> = {
  company_name: 'companyName',
  logo_url: 'logoUrl',
  logo_path: 'logoPath',
  currency: 'currency',
  currency_symbol: 'currencySymbol',
  gst_rate: 'gstRate',
  gst_enabled: 'gstEnabled',
  receipt_footer: 'receiptFooter',
  theme: 'theme',
  business_start_time: 'businessStartTime',
  business_closing_time: 'businessClosingTime',
  order_start_time: 'orderStartTime',
  order_end_time: 'orderEndTime',
  auto_close_business: 'autoCloseBusiness',
  auto_stock_closing: 'autoStockClosing',
  updated_at: 'updatedAt',
  updated_by: 'updatedBy',
};

/**
 * camelCase AppSettings field → snake_case `settings` column, derived from
 * COLUMN_TO_FIELD so the two can never drift. Used by the settings route to
 * translate an incoming PUT body into a row.
 */
export const FIELD_TO_COLUMN = Object.fromEntries(
  Object.entries(COLUMN_TO_FIELD).map(([column, field]) => [field, column]),
) as Record<keyof AppSettings, string>;

/**
 * Resolve app settings with every field guaranteed present (defaults filled in),
 * using the shared 60s in-process cache. The single source both the settings
 * route and the business-logic (order window, daily closing) read from.
 *
 * NULL columns are skipped rather than spread over FULL_DEFAULTS. Postgres
 * returns unset fields as null, which would otherwise clobber a default with
 * null and hand callers a settings object that fails its own type; skipping them
 * lets the defaults fill in instead.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const hit = getCached<AppSettings>('settings');
  if (hit) return hit;

  const { data, error } = await supabaseAdmin.from('settings').select('*').maybeSingle();
  if (error) throw new Error(`Failed to load app settings: ${error.message}`);

  const settings: AppSettings = { ...FULL_DEFAULTS };
  for (const [column, value] of Object.entries(data ?? {})) {
    const field = COLUMN_TO_FIELD[column];
    if (field && value !== null && value !== undefined) {
      (settings as unknown as Record<string, unknown>)[field] = value;
    }
  }

  setCached('settings', settings);
  return settings;
}

/** Order-window bounds in Karachi minutes-of-day, from settings (with safe fallbacks). */
export function orderWindowMinutes(
  settings: Pick<AppSettings, 'orderStartTime' | 'orderEndTime'>,
): { openMin: number; closeMin: number } {
  return {
    openMin: hhmmToMinutes(settings.orderStartTime) ?? ORDER_WINDOW_OPEN_MINUTES,
    closeMin: hhmmToMinutes(settings.orderEndTime) ?? ORDER_WINDOW_CLOSE_MINUTES,
  };
}
