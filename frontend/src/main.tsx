import '@fontsource-variable/public-sans';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppRoutes, Providers } from './App';
import './index.css';
import { reportError } from './lib/errorReport';
import { ErrorBoundary } from './ui/ErrorBoundary';

// D4: errors outside React rendering (event handlers, promises); a no-op without VITE_ERROR_DSN
addEventListener('error', (e) => reportError(e.error ?? e.message, { kind: 'window' }));
addEventListener('unhandledrejection', (e) => reportError(e.reason, { kind: 'unhandledrejection' }));

// P7: register the service worker in production only, so Vite's dev HMR is never intercepted.
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Providers>
          <AppRoutes />
        </Providers>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
