import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Dashboard vitest config — targets the dashboard-Next tests that need
 * next/server + better-sqlite3 resolved. These are excluded from the
 * framework `npm test` run because they require dashboard/node_modules
 * to be populated (Next.js is ~200MB, better-sqlite3 needs native compile).
 *
 * Run via:
 *   npm install --prefix dashboard   # ONE-TIME, if not already done
 *   npm run test:dashboard
 *
 * Ship 2026-07-02 (build #3 per Fable audit): separates the two surfaces
 * so `npm test` reports a clean framework baseline without hiding the
 * dashboard tests from CI/local when the dashboard deps ARE installed.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'dashboard/src'),
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    include: [
      // Dashboard-Next files intentionally EXCLUDED from framework `npm test`.
      'dashboard/src/**/__tests__/**/*.test.ts',
      'tests/integration/phase4-dashboard-backtest.test.ts',
      'tests/integration/phase4-performance.test.ts',
      'tests/integration/phase5-user-journeys.test.ts',
    ],
  },
});
