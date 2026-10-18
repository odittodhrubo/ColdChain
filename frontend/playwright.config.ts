import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Smoke tests against the real stack: a freshly seeded backend (no broker: MQTT points at a closed port) and
// the Vite dev server, on ports that do not clash with a running dev setup. Run: npm run e2e
const API_PORT = 4310;
const WEB_PORT = 5310;
const ML_PORT = 8310;
// Set once by the runner and inherited by its workers, so a spec can tamper with the same file the API uses.
process.env.E2E_DB ??= path.join(os.tmpdir(), `coldchain-e2e-${process.pid}.db`);
export const E2E_DB = process.env.E2E_DB;
export const E2E_ADMIN = { email: 'admin@coldchain.local', password: 'E2e-Admin-Pass-1!' };
export const E2E_PHARMACIST = { email: 'pharmacist@coldchain.local', password: 'E2e-Pharm-Pass-1!' };
export const E2E_INSPECTOR = { email: 'inspector@coldchain.local', password: 'E2e-Insp-Pass-1!' };

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000, // the AI flow sets its own, longer budget
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/ml-server.mjs', // the real prediction service with the committed models
      url: `http://127.0.0.1:${ML_PORT}/health`,
      reuseExistingServer: false,
      env: { ML_PORT: String(ML_PORT) },
      timeout: 60_000,
    },
    {
      command: 'npx tsx src/scripts/seed.ts && npx tsx src/index.ts',
      cwd: '../backend',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        DB_PATH: E2E_DB,
        MQTT_URL: 'mqtt://127.0.0.1:1',
        ML_URL: `http://127.0.0.1:${ML_PORT}`,
        ML_INTERVAL_MS: '5000', // the AI flow should not wait for 30 s ticks
        DEMO_TIME_SCALE: '1',
        CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        SEED_ADMIN_PASSWORD: E2E_ADMIN.password,
        SEED_PHARMACIST_PASSWORD: E2E_PHARMACIST.password,
        SEED_INSPECTOR_PASSWORD: E2E_INSPECTOR.password,
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
