import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright sets FORCE_COLOR for child processes; do not also inherit NO_COLOR.
delete process.env.NO_COLOR;
export default defineConfig({
  testDir: './tests/e2e',
  ...(process.env.PAGELINGO_TEST_OUTPUT_ROOT ? { outputDir: join(process.env.PAGELINGO_TEST_OUTPUT_ROOT, 'extension') } : {}),
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/serve-fixtures.mjs',
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: false,
  },
});
