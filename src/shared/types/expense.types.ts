export type ExpensePaymentMethod = 'cash' | 'easypaisa';

export interface Expense {
  id: string;
  expenseNumber: string; // human-readable EXP-###### (unique across branch + production expenses)
  branchId: string;
  branchName: string;
  date: string; // 'YYYY-MM-DD' (Karachi)
  category: string; // one of EXPENSE_CATEGORIES (free text in the DB, like production)
  description: string;
  paymentMethod: ExpensePaymentMethod;
  amount: number;
  remarks: string;
  createdBy: string;
  createdByName: string;
  createdAt: string; // ISO UTC
}
