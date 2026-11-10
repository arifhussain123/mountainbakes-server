/**
 * Every role the app recognises.
 *
 * The four `finance_*` / `accountant` values were added by migration 51 for the
 * Finance Ledger module. They are ordinary
 * members of the `user_role` Postgres enum rather than a parallel claim, so RLS
 * (`app.jwt_role()`), the API's `requireRole()` and the client's RouteGuard all
 * keep working unchanged.
 *
 * ORDER MATTERS to nothing here, but every value must exist in the Postgres
 * enum — a drift surfaces as a runtime 22P02 on the first insert.
 *
 * The enum still holds `branch_user` (migration 65): Postgres cannot drop an
 * enum value in place. The shift-account role was removed by migration 122,
 * which deleted every such account and added `users_no_branch_user`, so the
 * value can never be assigned again and has no place in this list.
 */
export type UserRole =
  | 'super_admin'
  | 'branch_manager'
  | 'production_user'
  | 'finance_admin'
  | 'finance_manager'
  | 'accountant'
  | 'finance_auditor'
  // Dry Items Store keeper (migration 20261110000001). Not a branch role and
  // not a finance role: it sees the Store and nothing else.
  | 'store_user';

export const USER_ROLES = [
  'super_admin',
  'branch_manager',
  'production_user',
  'finance_admin',
  'finance_manager',
  'accountant',
  'finance_auditor',
  'store_user',
] as const satisfies readonly UserRole[];

/**
 * The roles that work a shop floor. One since migration 122 removed the shift
 * account (`branch_user`); kept as the named test for "scope this request to
 * the caller's own branch", which is what every call site means by it, rather
 * than scattering `role === 'branch_manager'` across forty files.
 */
export const BRANCH_ROLES = ['branch_manager'] as const satisfies readonly UserRole[];

/**
 * True for a shop-floor role — the branch-scoping test.
 *
 * Takes a loose `string` for the same reason `financeCan` does: the client reads
 * the role out of its stored session, where it is whatever was put there, and the
 * guard that has to cope with an unrecognised value is exactly the caller that
 * must not be forced to cast one in.
 */
export function isBranchRole(role: UserRole | string | null | undefined): boolean {
  return (BRANCH_ROLES as readonly string[]).includes(role ?? '');
}

export type UserStatus = 'active' | 'inactive' | 'suspended';

export interface User {
  id: string;
  /**
   * Mountain Bakes staff ID — `MBU-000125`. Allocated by Postgres on insert
   * (migration 98) and never reassigned, so it is safe to print, quote and
   * search by. `MBU-`, not `MB-`: `MB-######` has meant a sales order since
   * migration 03 and one namespace cannot mean two things.
   */
  userCode: string;
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
