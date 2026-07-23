import { z } from 'zod';

/** 24-hour 'HH:mm' (00:00–23:59). */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm (24-hour)');

export const UpdateSettingsSchema = z.object({
  companyName: z.string().min(2).optional(),
  currency: z.string().min(2).optional(),
  currencySymbol: z.string().min(1).optional(),
  gstRate: z.number().min(0).max(100).optional(),
  gstEnabled: z.boolean().optional(),
  receiptFooter: z.string().optional(),
  theme: z.enum(['light', 'dark']).optional(),
  businessStartTime: HHMM.optional(),
  businessClosingTime: HHMM.optional(),
  orderStartTime: HHMM.optional(),
  orderEndTime: HHMM.optional(),
  autoCloseBusiness: z.boolean().optional(),
  autoStockClosing: z.boolean().optional(),
  closingNotificationsEnabled: z.boolean().optional(),
});

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
