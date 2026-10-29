import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
// Playwright sets FORCE_COLOR for its child processes.
delete process.env.NO_COLOR;
/** Standalone file:// readers require no API, database, credentials or development server. */
export default defineConfig({
  testDir: './tests/e2e',
  ...(process.env.PAGELINGO_TEST_OUTPUT_ROOT ? { outputDir: join(process.env.PAGELINGO_TEST_OUTPUT_ROOT, 'offline') } : {}),
  testMatch: ['web-offline.test.ts', 'web-bundle-offline.test.ts'],
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: 'list',
  use: { browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
