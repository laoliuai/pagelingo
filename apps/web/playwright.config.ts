import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4338', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node tests/start-service.mjs',
    url: 'http://127.0.0.1:4338/health/ready',
    reuseExistingServer: false,
  },
});
