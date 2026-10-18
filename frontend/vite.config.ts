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
  },
});
