import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Smoke tests against the real stack: a freshly seeded backend (no broker: MQTT points at a closed port) and
// the Vite dev server, on ports that do not clash with a running dev setup. Run: npm run e2e
const API_PORT = 4310;
const WEB_PORT = 5310;
const DB = path.join(os.tmpdir(), `coldchain-e2e-${process.pid}.db`);
export const E2E_ADMIN = { email: 'admin@coldchain.local', password: 'E2e-Admin-Pass-1!' };

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx src/scripts/seed.ts && npx tsx src/index.ts',
      cwd: '../backend',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        DB_PATH: DB,
        MQTT_URL: 'mqtt://127.0.0.1:1',
        DEMO_TIME_SCALE: '1',
        CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        SEED_ADMIN_PASSWORD: E2E_ADMIN.password,
        SEED_PHARMACIST_PASSWORD: 'E2e-Pharm-Pass-1!',
        SEED_INSPECTOR_PASSWORD: 'E2e-Insp-Pass-1!',
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { VITE_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
