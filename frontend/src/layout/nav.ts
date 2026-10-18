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

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  primary?: boolean; // shown in the mobile bottom bar (max 4 + More)
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard:read', primary: true },
  { to: '/fridges', label: 'Fridges', icon: Refrigerator, permission: 'dashboard:read', primary: true },
  { to: '/inventory', label: 'Inventory', icon: Package, permission: 'dashboard:read', primary: true },
  { to: '/alerts', label: 'Alerts', icon: Bell, permission: 'dashboard:read', primary: true },
  { to: '/relocations', label: 'Relocations', icon: ArrowLeftRight, permission: 'dashboard:read' },
  { to: '/ai-report', label: 'AI Report', icon: BrainCircuit, permission: 'dashboard:read' },
  { to: '/security', label: 'Security', icon: ShieldCheck, permission: 'audit:read' },
  { to: '/audit', label: 'Audit Log', icon: ScrollText, permission: 'audit:read' },
  { to: '/users', label: 'Users', icon: Users, permission: 'user:manage' },
];

/** Only what the role may open; the server enforces the same matrix on every request. */
export const navFor = (role: Role | undefined) => NAV.filter((item) => can(role, item.permission));
