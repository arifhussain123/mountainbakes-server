export interface Branch {
  id: string;
  name: string;
  slug: string;
  location: string;
  managerId: string | null;
  managerName: string | null;
  phone: string;
  address: string;
  city: string;
  isActive: boolean;
  dailyBudget?: number;
  weeklyBudget?: number;
  monthlyBudget?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBranchPayload {
  name: string;
  location: string;
  phone: string;
  address: string;
  city: string;
}

export interface UpdateBranchPayload {
  name?: string;
  location?: string;
  phone?: string;
  address?: string;
  city?: string;
  managerId?: string | null;
  isActive?: boolean;
}
