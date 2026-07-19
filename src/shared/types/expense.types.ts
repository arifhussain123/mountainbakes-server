export type ExpensePaymentMethod = 'cash' | 'easypaisa';

export interface Expense {
  id: string;
  branchId: string;
  branchName: string;
  date: string; // 'YYYY-MM-DD' (Karachi)
  description: string;
  paymentMethod: ExpensePaymentMethod;
  amount: number;
  remarks: string;
  createdBy: string;
  createdByName: string;
  createdAt: string; // ISO UTC
}
