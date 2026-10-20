/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    // In Docker the backend is reachable as http://backend:4000.
    proxy: {
      '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000',
      // realtime push (Socket.IO) goes to the same backend, over WebSocket
      '/socket.io': { target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'], // e2e/ runs under Playwright (npm run e2e)
    // userEvent flows take ~1 s alone but several times that while `make test` runs every suite at once
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'html'],
      // Q1: thresholds start just below the measured coverage (pages are covered by Playwright, not here).
      thresholds: { lines: 60, branches: 48 },
    },
  },
});
