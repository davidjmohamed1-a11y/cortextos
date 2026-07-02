import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Framework vitest config — targets the cortextOS framework tests.
 *
 * DOES NOT include dashboard-Next tests that top-level-import next/server
 * or better-sqlite3. Those require dashboard/node_modules to be installed
 * (Next.js is ~200MB — framework devs shouldn't need it just to run
 * framework tests). Dashboard tests run via:
 *
 *   npm run test:dashboard
 *
 * which uses vitest.dashboard.config.ts and expects `npm install` inside
 * dashboard/ to have run first.
 *
 * Boss decision 2026-07-02 (build #3): don't normalize a red baseline —
 * separate the two test surfaces so `npm test` reports honestly.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Matches the dashboard's tsconfig path alias so tests under
      // dashboard/src/**/__tests__ can import dashboard source via "@/…".
      '@': path.resolve(__dirname, 'dashboard/src'),
      // Dashboard tests need to resolve `next/server` and other Next deps
      // from dashboard/node_modules, because root's package.json does not
      // depend on Next.js.
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    include: [
      'tests/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
    ],
    exclude: [
      // Excluded from framework test run — these files import next/server at
      // top-level (whole file fails to load without Next installed). Run
      // separately via `npm run test:dashboard` after dashboard's own
      // npm install.
      'tests/integration/phase4-dashboard-backtest.test.ts',
      'tests/integration/phase4-performance.test.ts',
      'tests/integration/phase5-user-journeys.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
      // Default excludes vitest applies; we re-declare so they still take effect.
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
