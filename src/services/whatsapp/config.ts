/**
 * WhatsApp Business Platform (Cloud API) configuration, read from the server's
 * environment on every call so a changed variable needs no code change.
 *
 * Every value here is server-side only. The access token and app secret never
 * leave this process: no route returns them, no log line prints them, and the
 * status panel reports only WHICH variables are missing.
 *
 *   WHATSAPP_PROVIDER              meta | mock. Unset: meta when the Meta
 *                                  credentials below are complete, else mock.
 *   WHATSAPP_ACCESS_TOKEN          system-user token with whatsapp_business_messaging
 *   WHATSAPP_PHONE_NUMBER_ID       the authorized Production number's id (NOT the number)
 *   WHATSAPP_BUSINESS_ACCOUNT_ID   the WABA that owns it (templates live there)
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN  any long random string, also typed into Meta
 *   WHATSAPP_APP_SECRET            the Meta app's secret, for X-Hub-Signature-256
 *   WHATSAPP_API_VERSION           Graph API version, default below
 *   WHATSAPP_DISPLAY_NUMBER        the number as people read it, for the page
 *   WHATSAPP_TEMPLATE_DEMAND       approved template for a new demand
 *   WHATSAPP_TEMPLATE_UPDATE       approved template for every later update
 *   WHATSAPP_TEMPLATE_LANGUAGE     the templates' language code (default en)
 *   WHATSAPP_PRODUCTION_ALERT_TO   optional, comma-separated staff numbers that
 *                                  get a WhatsApp when a supplier responds
 *   SUPPLIER_PORTAL_URL            web origin serving /supplier-portal
 *                                  (default NEXT_PUBLIC_WEB_URL)
 *   SUPPLIER_LINK_TTL_DAYS         how long a supplier link works (default 14)
 */

/**
 * The Graph API version this integration was written against: v26.0, the
 * current version per Meta's Graph API changelog when this was built
 * (2026-10). Override with WHATSAPP_API_VERSION rather than editing this.
 */
export const DEFAULT_WHATSAPP_API_VERSION = 'v26.0';

export const DEFAULT_TEMPLATE_DEMAND = 'mb_purchase_demand';
export const DEFAULT_TEMPLATE_UPDATE = 'mb_purchase_update';

const env = (k: string) => (process.env[k] ?? '').trim();

export interface WhatsAppConfig {
  provider: 'meta' | 'mock';
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  verifyToken: string;
  appSecret: string;
  apiVersion: string;
  displayNumber: string;
  templateDemand: string;
  templateUpdate: string;
  templateLanguage: string;
  productionAlertTo: string[];
  portalUrl: string;
  linkTtlDays: number;
  /** Names of the variables a live Meta setup still needs. */
  missing: string[];
}

const META_REQUIRED = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
] as const;

export function whatsappConfig(): WhatsAppConfig {
  const missing = META_REQUIRED.filter((k) => !env(k));
  const requested = env('WHATSAPP_PROVIDER').toLowerCase();
  const provider: 'meta' | 'mock' =
    requested === 'mock' ? 'mock' : requested === 'meta' ? 'meta' : missing.length === 0 ? 'meta' : 'mock';
  const ttl = Number(env('SUPPLIER_LINK_TTL_DAYS'));

  return {
    provider,
    accessToken: env('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    businessAccountId: env('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    verifyToken: env('WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
    appSecret: env('WHATSAPP_APP_SECRET'),
    apiVersion: /^v\d+\.\d+$/.test(env('WHATSAPP_API_VERSION')) ? env('WHATSAPP_API_VERSION') : DEFAULT_WHATSAPP_API_VERSION,
    displayNumber: env('WHATSAPP_DISPLAY_NUMBER'),
    templateDemand: env('WHATSAPP_TEMPLATE_DEMAND') || DEFAULT_TEMPLATE_DEMAND,
    templateUpdate: env('WHATSAPP_TEMPLATE_UPDATE') || DEFAULT_TEMPLATE_UPDATE,
    templateLanguage: env('WHATSAPP_TEMPLATE_LANGUAGE') || 'en',
    productionAlertTo: env('WHATSAPP_PRODUCTION_ALERT_TO')
      .split(',')
      .map((s) => s.replace(/\D/g, ''))
      .filter((s) => /^[1-9]\d{7,14}$/.test(s)),
    portalUrl: (env('SUPPLIER_PORTAL_URL') || env('NEXT_PUBLIC_WEB_URL') || 'http://localhost:3000').replace(/\/+$/, ''),
    linkTtlDays: Number.isFinite(ttl) && ttl >= 1 && ttl <= 60 ? ttl : 14,
    missing: [...missing],
  };
}
