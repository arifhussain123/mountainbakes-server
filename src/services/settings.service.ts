import { adminDb } from '../config/firebase';
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

/**
 * Resolve app settings with every field guaranteed present (defaults filled in),
 * using the shared 60s in-process cache. The single source both the settings
 * route and the business-logic (order window, daily closing) read from.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const hit = getCached<AppSettings>('settings');
  if (hit) return hit;

  const doc = await adminDb.collection('settings').doc('app').get();
  const settings = { ...FULL_DEFAULTS, ...(doc.exists ? doc.data() : {}) } as AppSettings;
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
