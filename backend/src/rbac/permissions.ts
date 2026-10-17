// Permission matrix (contract: docs/CONTRACTS.md section 8). The only place roles are mapped to capabilities.
// Enforced on the server for every route; the UI only mirrors it.

export const ROLES = ['ADMIN', 'PHARMACIST', 'INSPECTOR'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;

export const PERMISSIONS = {
  'dashboard:read': ALL, // dashboard, fridges, batches, alerts
  'batch:write': ['ADMIN', 'PHARMACIST'], // create/edit batches, move between fridges
  'batch:delete': ['ADMIN'], // soft-delete an emptied batch (P10: Admin only, quantity 0)
  'relocation:confirm': ['ADMIN', 'PHARMACIST'],
  'alert:ack': ['ADMIN', 'PHARMACIST'],
  'latch:reset': ['ADMIN'], // reset red latch, discard acknowledgement
  'user:manage': ['ADMIN'],
  'audit:read': ALL, // security events and audit log (read-only for Pharmacist and Inspector)
  'audit:verify': ALL, // Verify Integrity
  'metrics:read': ['ADMIN', 'INSPECTOR'], // ingestion metrics (P09)
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
