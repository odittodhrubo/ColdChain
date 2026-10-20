import {
  ArrowLeftRight,
  Bell,
  BrainCircuit,
  LayoutDashboard,
  Package,
  Refrigerator,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { can, type Permission, type Role } from '../auth/permissions';
import type { StringKey } from '../i18n';

export interface NavItem {
  to: string;
  label: string; // English fallback; the UI shows t(labelKey)
  labelKey: StringKey;
  icon: LucideIcon;
  permission: Permission;
  primary?: boolean; // shown in the mobile bottom bar (max 4 + More)
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, permission: 'dashboard:read', primary: true },
  { to: '/fridges', label: 'Fridges', labelKey: 'nav.fridges', icon: Refrigerator, permission: 'dashboard:read', primary: true },
  { to: '/inventory', label: 'Inventory', labelKey: 'nav.inventory', icon: Package, permission: 'dashboard:read', primary: true },
  { to: '/alerts', label: 'Alerts', labelKey: 'nav.alerts', icon: Bell, permission: 'dashboard:read', primary: true },
  { to: '/relocations', label: 'Relocations', labelKey: 'nav.relocations', icon: ArrowLeftRight, permission: 'dashboard:read' },
  { to: '/ai-report', label: 'AI Report', labelKey: 'nav.aiReport', icon: BrainCircuit, permission: 'dashboard:read' },
  { to: '/security', label: 'Security', labelKey: 'nav.security', icon: ShieldCheck, permission: 'audit:read' },
  { to: '/audit', label: 'Audit Log', labelKey: 'nav.audit', icon: ScrollText, permission: 'audit:read' },
  { to: '/users', label: 'Users', labelKey: 'nav.users', icon: Users, permission: 'user:manage' },
];

/** Only what the role may open; the server enforces the same matrix on every request. */
export const navFor = (role: Role | undefined) => NAV.filter((item) => can(role, item.permission));
