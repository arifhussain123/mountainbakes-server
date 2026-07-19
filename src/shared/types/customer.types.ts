export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  branchId: string;
  branchName: string;
  totalOrders: number;
  totalSpent: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomerPayload {
  name: string;
  phone: string;
  email: string;
  address: string;
  branchId: string;
}

export interface UpdateCustomerPayload {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
}
