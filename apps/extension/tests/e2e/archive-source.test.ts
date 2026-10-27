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
