import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
// Playwright sets FORCE_COLOR for its child processes.
delete process.env.NO_COLOR;
export default defineConfig({
  testDir: './tests/e2e',
  ...(process.env.PAGELINGO_TEST_OUTPUT_ROOT ? { outputDir: join(process.env.PAGELINGO_TEST_OUTPUT_ROOT, 'site') } : {}),
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4338', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/start-service.mjs',
    url: 'http://127.0.0.1:4338/health/ready',
    reuseExistingServer: false,
  },
});
