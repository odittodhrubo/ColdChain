// Permission matrix (contract: docs/CONTRACTS.md section 8). The only place roles are mapped to capabilities.
// Enforced on the server for every route; the UI only mirrors it.

export const ROLES = ['ADMIN', 'PHARMACIST', 'INSPECTOR', 'DISPLAY'] as const;
export type Role = (typeof ROLES)[number];

// The people who sign in and act. DISPLAY is not one of them: it is a long-lived, read-only wall-screen token
// (P1) that may only read the dashboard, so it appears in dashboard:read alone and in no write capability.
const STAFF: readonly Role[] = ['ADMIN', 'PHARMACIST', 'INSPECTOR'];

export const PERMISSIONS = {
  'dashboard:read': [...STAFF, 'DISPLAY'], // dashboard, fridges, batches, alerts
  'batch:write': ['ADMIN', 'PHARMACIST'], // create/edit batches, move between fridges
  'batch:delete': ['ADMIN'], // soft-delete an emptied batch (P10: Admin only, quantity 0)
  'relocation:confirm': ['ADMIN', 'PHARMACIST'],
  'alert:ack': ['ADMIN', 'PHARMACIST'],
  'device:test': ['ADMIN', 'PHARMACIST'], // "Test buzzer" (P12)
  'latch:reset': ['ADMIN'], // reset red latch, discard acknowledgement
  'user:manage': ['ADMIN'],
  'audit:read': STAFF, // security events and audit log (read-only for Pharmacist and Inspector)
  'audit:verify': STAFF, // Verify Integrity
  'metrics:read': ['ADMIN', 'INSPECTOR'], // ingestion metrics (P09)
  'device:manage': ['ADMIN'], // rotate a device's secret (S7)
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
