import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html'],
      // Q1: thresholds start just below the measured coverage, so the gate only catches regressions.
      thresholds: { lines: 87, branches: 78 },
    },
  },
});
