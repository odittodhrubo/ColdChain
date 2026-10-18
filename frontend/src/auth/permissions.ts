// Mirror of the server's permission matrix (docs/CONTRACTS.md §8, backend/src/rbac/permissions.ts).
// The UI only uses it to hide what a role cannot do; the server enforces every request and the UI still
// handles its 403s.

export const ROLES = ['ADMIN', 'PHARMACIST', 'INSPECTOR'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;

export const PERMISSIONS = {
  'dashboard:read': ALL,
  'batch:write': ['ADMIN', 'PHARMACIST'],
  'batch:delete': ['ADMIN'],
  'relocation:confirm': ['ADMIN', 'PHARMACIST'],
  'alert:ack': ['ADMIN', 'PHARMACIST'],
  'device:test': ['ADMIN', 'PHARMACIST'],
  'latch:reset': ['ADMIN'],
  'user:manage': ['ADMIN'],
  'audit:read': ALL,
  'audit:verify': ALL,
  'metrics:read': ['ADMIN', 'INSPECTOR'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role | undefined, permission: Permission) =>
  !!role && (PERMISSIONS[permission] as readonly Role[]).includes(role);

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  PHARMACIST: 'Pharmacist',
  INSPECTOR: 'Inspector',
};
