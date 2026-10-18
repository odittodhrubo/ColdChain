import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth, RequirePermission } from './auth/guards';
import { AppShell } from './layout/AppShell';
import { shouldRetry } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NoPermissionPage';
import { PlannedPage } from './pages/PlannedPage';
import { RealtimeProvider, type Connect } from './realtime/RealtimeProvider';
import { ThemeProvider } from './theme/ThemeProvider';
import { ToastProvider } from './ui/Toast';

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
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route
          index
          element={
            <PlannedPage title="Dashboard" subtitle="Every fridge and batch at a glance">
              Live temperature, door, power, compressor and heat-budget status for every fridge.
            </PlannedPage>
          }
        />
        <Route
          path="fridges/*"
          element={
            <PlannedPage title="Fridges" subtitle="Live readings and history per fridge">
              Temperature history, events and controls for each fridge.
            </PlannedPage>
          }
        />
        <Route
          path="inventory/*"
          element={
            <PlannedPage title="Inventory" subtitle="Vaccine batches and where they are">
              Batches with heat budget, expiry and QR codes; move them between fridges.
            </PlannedPage>
          }
        />
        <Route
          path="alerts"
          element={
            <PlannedPage title="Alerts" subtitle="Door, power, breach and budget alerts">
              Open and past alerts, with acknowledgement.
            </PlannedPage>
          }
        />
        <Route
          path="relocations"
          element={
            <PlannedPage title="Relocations" subtitle="AI suggestions to move batches">
              Suggested batch moves when a fridge is predicted to breach, confirmed with one click.
            </PlannedPage>
          }
        />
        <Route
          path="ai-report"
          element={
            <PlannedPage title="AI Report" subtitle="Forecast and compressor health models">
              Dataset, features and model performance.
            </PlannedPage>
          }
        />
        <Route
          path="security"
          element={
            <RequirePermission permission="audit:read">
              <PlannedPage title="Security" subtitle="Rejected device messages">
                Forged, stale and replayed messages the server refused, by reason.
              </PlannedPage>
            </RequirePermission>
          }
        />
        <Route
          path="audit"
          element={
            <RequirePermission permission="audit:read">
              <PlannedPage title="Audit Log" subtitle="Hash-chained record of every action">
                The tamper-evident log and Verify Integrity.
              </PlannedPage>
            </RequirePermission>
          }
        />
        <Route
          path="users"
          element={
            <RequirePermission permission="user:manage">
              <PlannedPage title="Users" subtitle="Accounts and roles">
                Create users, change roles, disable accounts.
              </PlannedPage>
            </RequirePermission>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
