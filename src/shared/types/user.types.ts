export type UserRole = 'super_admin' | 'branch_manager' | 'production_user';
export type UserStatus = 'active' | 'inactive' | 'suspended';

export interface User {
  id: string;
  email: string;
  displayName: string;
  phone: string;
  username: string;
  role: UserRole;
  branchId: string | null;
  branchName: string | null;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Password-recovery / admin-reset management
  mustChangePassword?: boolean;
  lastPasswordReset?: string | null;
  passwordResetBy?: string | null;
  passwordResetByName?: string | null;
}

export interface UserCustomClaims {
  role: UserRole;
  branchId: string | null;
  branchName: string | null;
}

export interface CreateUserPayload {
  email: string;
  displayName: string;
  phone: string;
  username: string;
  password: string;
  role: UserRole;
  branchId: string | null;
}

export interface UpdateUserPayload {
  displayName?: string;
  phone?: string;
  role?: UserRole;
  branchId?: string | null;
  status?: UserStatus;
}
