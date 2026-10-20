import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { NoPermissionPage } from '../pages/NoPermissionPage';
import { useAuth } from './AuthProvider';
import { can, type Permission } from './permissions';

/**
 * Signed-out visitors go to the login page, which brings them back afterwards. A user who must change their
 * password or set up two-factor first goes to the account gate (the server refuses everything else anyway).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, mustChangePassword, mfaSetupRequired } = useAuth();
  const location = useLocation();
  const from = { from: location.pathname + location.search };
  if (!user) return <Navigate to="/login" replace state={from} />;
  if (mustChangePassword || mfaSetupRequired) return <Navigate to="/account/required" replace state={from} />;
  return <>{children}</>;
}

/** Mirrors the server's matrix. The server still decides: pages keep handling 403 responses. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { user } = useAuth();
  if (!can(user?.role, permission)) return <NoPermissionPage />;
  return <>{children}</>;
}
