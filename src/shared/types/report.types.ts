export type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
export type ExportFormat = 'pdf' | 'excel' | 'csv';

export interface DailySalesData {
  date: string;
  totalOrders: number;
  totalRevenue: number;
  totalCancelled: number;
  expenses?: number;
  profit?: number;
}

export interface PaymentMethodBreakdown {
  method: string;
  total: number;
  count: number;
}

export interface BudgetSummary {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BranchSalesData {
  branchId: string;
  branchName: string;
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
}

export interface TopProduct {
  productId: string;
  productName: string;
  categoryName: string;
  totalQty: number;
  totalRevenue: number;
}

export interface ReportSummary {
  period: ReportPeriod;
  from: string;
  to: string;
  totalOrders: number;
  totalRevenue: number;
  totalCancelled: number;
  totalPending: number;
  averageOrderValue: number;
  totalExpenses: number;
  totalProfit: number;
  dailyData: DailySalesData[];
  branchData: BranchSalesData[];
  topProducts: TopProduct[];
  paymentMethodBreakdown: PaymentMethodBreakdown[];
  budget?: BudgetSummary;
}
