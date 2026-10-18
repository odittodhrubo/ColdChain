import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth, RequirePermission } from './auth/guards';
import { AppShell } from './layout/AppShell';
import { shouldRetry } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NoPermissionPage';
import { PublicCheckPage } from './pages/PublicCheckPage';
import { RealtimeProvider, type Connect } from './realtime/RealtimeProvider';
import { ThemeProvider } from './theme/ThemeProvider';
import { Skeleton } from './ui/States';
import { ToastProvider } from './ui/Toast';

// Signed-in pages load on demand, so a QR scan (/check/:token) downloads only the public card.
function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  const Page = lazy(async () => ({ default: (await load())[name] as ComponentType }));
  return function LazyPage() {
    return (
      <Suspense fallback={<Skeleton className="h-64" />}>
        <Page />
      </Suspense>
    );
  };
}
const DashboardPage = lazyPage(() => import('./pages/DashboardPage'), 'DashboardPage');
const FridgesPage = lazyPage(() => import('./pages/FridgesPage'), 'FridgesPage');
const FridgeDetailPage = lazyPage(() => import('./pages/FridgeDetailPage'), 'FridgeDetailPage');
const InventoryPage = lazyPage(() => import('./pages/InventoryPage'), 'InventoryPage');
const AlertsPage = lazyPage(() => import('./pages/AlertsPage'), 'AlertsPage');
const SecurityPage = lazyPage(() => import('./pages/SecurityPage'), 'SecurityPage');
const AuditPage = lazyPage(() => import('./pages/AuditPage'), 'AuditPage');
const UsersPage = lazyPage(() => import('./pages/UsersPage'), 'UsersPage');
const RelocationsPage = lazyPage(() => import('./ai/Relocations'), 'RelocationsPage');
const AiReportPage = lazyPage(() => import('./ai/AiReportPage'), 'AiReportPage');

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 10_000, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

/** Everything a page relies on: theme, toasts, query cache, session, the one realtime connection. */
export function Providers({ children, connect }: { children: ReactNode; connect?: Connect }) {
  const [client] = useState(makeQueryClient);
  return (
    <ThemeProvider>
      <ToastProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <RealtimeProvider connect={connect}>{children}</RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/check/:token" element={<PublicCheckPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="fridges" element={<FridgesPage />} />
        <Route path="fridges/:id" element={<FridgeDetailPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="relocations" element={<RelocationsPage />} />
        <Route path="ai-report" element={<AiReportPage />} />
        <Route
          path="security"
          element={
            <RequirePermission permission="audit:read">
              <SecurityPage />
            </RequirePermission>
          }
        />
        <Route
          path="audit"
          element={
            <RequirePermission permission="audit:read">
              <AuditPage />
            </RequirePermission>
          }
        />
        <Route
          path="users"
          element={
            <RequirePermission permission="user:manage">
              <UsersPage />
            </RequirePermission>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
