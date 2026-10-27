import { defineConfig } from '@playwright/test';
// Playwright sets FORCE_COLOR for child processes; do not also inherit NO_COLOR.
delete process.env.NO_COLOR;
export default defineConfig({ testDir: './tests/browser', workers: 1, timeout: 30000, use: { browserName: 'chromium', headless: true }, reporter: 'list' });
