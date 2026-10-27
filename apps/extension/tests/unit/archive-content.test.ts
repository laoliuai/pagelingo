import { afterEach, expect, it, vi } from 'vitest';
type Listener = (message: unknown, sender: { id: string; url: string }, reply: (response: unknown) => void) => unknown;
afterEach(() => {
  (globalThis as typeof globalThis & { __pagelingo?: { dispose(): void } }).__pagelingo?.dispose();
  vi.unstubAllGlobals(); vi.resetModules();
});
it('ignores webpage capture commands and rejects caller-selected destinations through the real listener', async () => {
  document.body.innerHTML = '<article><p>Public original.</p></article>';
  let listener: Listener | undefined;
  vi.stubGlobal('chrome', { runtime: { id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${path}`,
    onMessage: { addListener: (value: Listener) => { listener = value; }, removeListener: () => {} } } });
  await import('../../src/content/index');
  const responses: unknown[] = [];
  listener!({ type: 'capture:identity' }, { id: 'extension-id', url: 'https://page.example/' }, response => responses.push(response));
  expect(responses).toEqual([]);
  const trusted = { id: 'extension-id', url: 'chrome-extension://extension-id/service-worker.js' };
  listener!({ type: 'capture:identity', siteUrl: 'https://attacker.example/' }, trusted, response => responses.push(response));
  expect(responses).toEqual([]);
  listener!({ type: 'capture:identity' }, trusted, response => responses.push(response));
  expect(responses).toEqual([{ ok: true, value: expect.objectContaining({ url: document.URL, contentSessionId: expect.any(String), revision: expect.any(Number) }) }]);
});
