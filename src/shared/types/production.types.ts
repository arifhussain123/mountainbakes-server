export type ProductionStatus = 'pending' | 'preparing' | 'ready';

export interface ProductionOrder {
  id: string;
  orderNumber: string;
  branchId: string;
  branchName: string;
  customerName: string;
  items: {
    productName: string;
    categoryName: string;
    qty: number;
  }[];
  status: ProductionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionStats {
  waitingCount: number;
  preparingCount: number;
  completedTodayCount: number;
}
