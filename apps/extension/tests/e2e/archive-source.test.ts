import { expect, type Page } from '@playwright/test';
import type { CaptureDraft } from '@pagelingo/document-contracts';
import type { CaptureIdentity } from '../../src/archive/grants';
import { test } from './extension-fixture';

async function command(control: Page, page: Page, command: unknown) {
  return control.evaluate(async ({ url, command }) => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url)!;
    return chrome.runtime.sendMessage({ type: 'extension:command', tabId: tab.id, command });
  }, { url: page.url(), command });
}
async function capture(control: Page, page: Page) {
  return control.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url)!;
    const identity = await chrome.tabs.sendMessage(tab.id!, { type: 'capture:identity' }, { frameId: 0 }) as { ok: boolean; value: CaptureIdentity };
    if (!identity.ok) throw new Error('Capture identity unavailable');
    const [frame] = await chrome.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, func: () => null });
    return chrome.tabs.sendMessage(tab.id!, { type: 'capture:collect', grant: { ...identity.value, grantId: crypto.randomUUID(), captureId: crypto.randomUUID(), tabId: tab.id!, frameId: 0, documentId: frame!.documentId } }, { frameId: 0 });
  }, page.url()) as Promise<{ ok: boolean; value: CaptureDraft; linkFallback?: { kind: string; url: string; warnings: string[] } }>;
}
test('trusted content capture preserves one original across all three live modes and does no resource fetch', async ({ control, page }) => {
  await page.goto('http://127.0.0.1:4317/archive-source.html');
  expect((await command(control, page, { type: 'page:mode', mode: 'source' })).ok).toBe(true);
  const original = await capture(control, page);
  expect(original.ok).toBe(true);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await command(control, page, { type: 'page:preview', mode: 'bilingual' });
  await expect(page.locator('[data-pl-owned="translation"]')).toHaveCount(3);
  const saved: string[] = [];
  for (const mode of ['source', 'translation', 'bilingual']) {
    await command(control, page, { type: 'page:mode', mode });
    const before = await page.locator('article').innerHTML();
    const draft = await capture(control, page);
    expect(draft.ok).toBe(true);
    expect(await page.locator('article').innerHTML()).toBe(before);
    saved.push(draft.value.snapshot.html);
    expect(draft.value.existingTranslation).toBeNull();
    expect(draft.value.snapshot.html).not.toMatch(/private-form-value|hidden application state|data-pl-owned/);
    expect(draft.value.pendingResources[0]?.url).toMatch(/^data:image\/gif;base64,/);
  }
  expect(saved).toEqual([original.value.snapshot.html, original.value.snapshot.html, original.value.snapshot.html]);
  expect(requests).toEqual([]);
});
test('unavailable article returns a link fallback through the real content listener', async ({ control, page }) => {
  await page.goto('http://127.0.0.1:4317/archive-source.html');
  await command(control, page, { type: 'page:mode', mode: 'source' });
  await page.evaluate(() => { document.body.innerHTML = '<article>One article</article><article>Another article</article>'; });
  const response = await capture(control, page);
  expect(response.ok).toBe(false);
  expect(response.linkFallback).toMatchObject({ kind: 'link-only', url: page.url() });
  expect(response.linkFallback?.warnings.length).toBeGreaterThan(0);
  expect(response.value).toBeUndefined();
});
test('capture does not invoke source custom-element constructors', async ({ control, page }) => {
  await page.goto('http://127.0.0.1:4317/archive-source.html');
  await page.evaluate(() => {
    const state = window as typeof window & { captureConstructors: number }; state.captureConstructors = 0;
    customElements.define('capture-probe', class extends HTMLElement { constructor() { super(); state.captureConstructors++; } });
    const custom = document.createElement('capture-probe'); custom.textContent = 'Custom source'; document.querySelector('article')!.append(custom);
  });
  await command(control, page, { type: 'page:mode', mode: 'source' });
  const before = await page.evaluate(() => (window as typeof window & { captureConstructors: number }).captureConstructors);
  const response = await capture(control, page);
  expect(response.ok).toBe(true);
  expect(await page.evaluate(() => (window as typeof window & { captureConstructors: number }).captureConstructors)).toBe(before);
});

test.describe('source adapter handoff', () => {
  test.use({ sourceHandoffHosts: true });
  test('collects repo and paper links through the actual extension', async ({ control, context, page, request, extensionId }, info) => {
    test.skip(!process.env.PAGELINGO_TEST_DATABASE_URL, 'Requires owned temporary PostgreSQL');
    test.setTimeout(90000);
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { resolve } = await import('node:path');
    const child = spawn(process.execPath, ['tests/start-service.mjs'], { cwd: resolve('../web'), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    const base = 'http://127.0.0.1:4338';
    try {
      await expect.poll(async () => { try { return (await request.get(`${base}/health/ready`)).status(); } catch { return 0; } }, { timeout: 20000, message: output }).toBe(200);
      const auth = await request.post(`${base}/api/v1/auth/login`, { headers: { Origin: base }, data: { username: 'admin', password: 'test-admin-password' } });
      const session = await auth.json();
      const code = await (await request.post(`${base}/api/v1/devices/pairing-codes`, { headers: { Origin: base, 'X-CSRF-Token': session.csrfToken }, data: {} })).json();
      const paired = await control.evaluate(async value => chrome.runtime.sendMessage({ type: 'archive:pair', ...value }), { origin: base, code: code.code });
      expect(paired.ok).toBe(true);
      await context.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<article><h1>Repository page</h1><p>Browser content must not become repository source.</p></article>' }));
      await context.route('https://arxiv.org/**', route => route.fulfill({ contentType: 'text/html', body: '<article><h1>Paper page</h1><p>Browser content must not become paper source.</p></article>' }));
      const popup = await context.newPage();
      for (const [url, button] of [
        ['https://github.com/Org/Repo', '保存仓库固定 README'],
        ['https://arxiv.org/html/2401.12345v1', '保存论文固定版本'],
        ['https://github.com/Org/Repo/blob/Main/docs/guide.md', '保存当前页面原文'],
      ]) {
        await page.goto(url);
        await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
        await page.bringToFront();
        await popup.reload();
        await expect(popup.getByRole('button', { name: button, exact: true })).toBeEnabled();
        await popup.getByRole('button', { name: button, exact: true }).click();
      }
      await popup.screenshot({ path: info.outputPath('native-source-handoff.png'), fullPage: true });
      const status = () => control.evaluate(async () => chrome.runtime.sendMessage({ type: 'archive:status' }));
      await expect.poll(async () => (await status()).value.items.filter((i: { state: string }) => i.state === 'completed').length, { timeout: 15000 }).toBe(3);
      const library = await (await request.get(`${base}/api/v1/library`)).json();
      expect(library.items.map((i: { document: { kind: string } }) => i.document.kind).sort()).toEqual(['article', 'paper', 'repository']);
      for (const item of library.items.filter((item: { document: { kind: string } }) => item.document.kind !== 'article')) {
        await expect.poll(async () => (await (await request.get(`${base}/api/v1/documents/${item.document.id}/source-details`)).json()).status, { timeout: 20000 }).toMatch(/source-saved|partial-resources/);
      }
      expect((await (await request.get(`${base}/__test/metrics`)).json()).modelCalls).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
    }
  });
});
