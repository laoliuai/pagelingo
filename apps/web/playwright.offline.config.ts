import { defineConfig } from '@playwright/test';
/** Standalone file:// readers require no API, database, credentials or development server. */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['web-offline.test.ts', 'web-bundle-offline.test.ts'],
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: 'list',
  use: { browserName: 'chromium', screenshot: 'only-on-failure' },
});
