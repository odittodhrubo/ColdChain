import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { NoPermissionPage } from '../pages/NoPermissionPage';
import { useAuth } from './AuthProvider';
import { can, type Permission } from './permissions';

/** Signed-out visitors go to the login page, which brings them back afterwards. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** Mirrors the server's matrix. The server still decides: pages keep handling 403 responses. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { user } = useAuth();
  if (!can(user?.role, permission)) return <NoPermissionPage />;
  return <>{children}</>;
}
