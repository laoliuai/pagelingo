import { test as base, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const extensionDist = fileURLToPath(new URL('../../dist/', import.meta.url));

export const test = base.extend<{ control: Page; extensionId: string }>({
  context: async ({}, use) => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'pagelingo-e2e-'));
    const extension = path.join(temporary, 'extension');
    cpSync(extensionDist, extension, { recursive: true });
    const manifestPath = path.join(extension, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Only the test copy receives access to localhost. Headless action clicks
    // cannot grant activeTab; production still requires an explicit user gesture.
    manifest.host_permissions = ['http://127.0.0.1/*'];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      await use(context);
    } finally {
      await context?.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },
  control: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    await expect(page.getByRole('button', { name: '保存设置' })).toBeEnabled();
    await use(page);
  },
});
