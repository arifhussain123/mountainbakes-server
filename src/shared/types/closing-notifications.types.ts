// Automatic end-of-day closing summaries + WhatsApp/SMS delivery.
//
// After the 2 AM closing archives the day, the dispatcher builds one report per
// scope (each branch, production, the company) and sends every recipient ONLY
// their own summary. These types are the contract for the report payload stored
// in daily_closing_reports.report_json and rendered by the admin UI.

export type NotificationChannel = 'whatsapp' | 'sms' | 'both';
export type NotificationDeliveryStatus = 'pending' | 'sent' | 'failed';
export type ClosingReportScope = 'branch' | 'production' | 'company';

/** A phone number that receives a closing summary. */
export interface NotificationRecipient {
  id: string;
  /** Set for a branch recipient; null for a central (production/admin) one. */
  branchId: string | null;
  branchName?: string | null;
  /** 'production' | 'admin' for central recipients; null for a branch one. */
  department: string | null;
  recipientName: string;
  mobileNumber: string;
  channel: NotificationChannel;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Money + counts for one branch's trading day. */
export interface BranchClosingReport {
  scope: 'branch';
  businessDate: string;
  branchId: string;
  branchName: string;
  sales: {
    total: number;
    transactions: number;
    average: number;
    discount: number;
    tax: number;
    net: number;
  };
  /** `other` catches any payment method outside the four known ones. */
  payments: {
    cash: number;
    easypaisa: number;
    foodpanda: number;
    bank: number;
    other: number;
    total: number;
  };
  /** Unit counts summed across every product in the branch. */
  stock: {
    opening: number;
    received: number;
    sold: number;
    returned: number;
    closing: number;
  };
  expenses: {
    total: number;
    byCategory: Record<string, number>;
    cash: number;
    easypaisa: number;
  };
  /** What this branch asked Production for — i.e. next day's demand. */
  demand: {
    items: { productName: string; qty: number }[];
    totalQty: number;
  };
  overall: {
    income: number;
    expenses: number;
    netCollection: number;
  };
}

/** The central kitchen's day. */
export interface ProductionClosingReport {
  scope: 'production';
  businessDate: string;
  production: {
    prepared: number;
    delivered: number;
    returned: number;
    remaining: number;
  };
  demand: {
    total: number;
    approved: number;
    pending: number;
  };
  expenses: {
    total: number;
    byCategory: Record<string, number>;
  };
  orders: {
    closed: number;
    pending: number;
  };
}

/** Company-wide rollup for the Admin. */
export interface CompanyClosingReport {
  scope: 'company';
  businessDate: string;
  totalSales: number;
  totalExpenses: number;
  totalProduction: number;
  totalClosingStock: number;
  totalPendingOrders: number;
  totalTomorrowDemand: number;
  companyProfit: number;
  branches: {
    branchId: string;
    branchName: string;
    sales: number;
    expenses: number;
    net: number;
  }[];
}

export type ClosingReport = BranchClosingReport | ProductionClosingReport | CompanyClosingReport;

/** A persisted daily_closing_reports row. */
export interface DailyClosingReportRecord {
  id: string;
  businessDate: string;
  scope: ClosingReportScope;
  branchId: string | null;
  department: string | null;
  reportJson: ClosingReport;
  generatedAt: string;
}

/** A persisted notification_logs row — one delivery attempt. */
export interface NotificationLogRecord {
  id: string;
  reportId: string | null;
  recipientId: string | null;
  businessDate: string | null;
  channel: string;
  status: NotificationDeliveryStatus;
  provider: string | null;
  providerMessageId: string | null;
  errorMessage: string | null;
  retryCount: number;
  sentAt: string | null;
  createdAt: string;
}

/** Outcome of a dispatch run, returned by the manual-trigger endpoint. */
export interface ClosingDispatchResult {
  businessDate: string;
  reportsGenerated: number;
  messagesSent: number;
  messagesFailed: number;
  skipped?: string;
}
