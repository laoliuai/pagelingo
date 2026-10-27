import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { BINDING_KEY } from '../../src/archive/binding';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
function environment() {
  const stored: Record<string, unknown> = {};
  const local = { async setAccessLevel() {}, async get(key: string) { return { [key]: stored[key] }; }, async set(value: object) { Object.assign(stored, value); }, async remove(key: string) { delete stored[key]; } };
  vi.stubGlobal('chrome', { runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`, getManifest: () => ({ version: '0.4.5' }) }, permissions: { contains: async () => true }, storage: { local }, alarms: { onAlarm: { addListener() {} }, get: async () => undefined, create: async () => {} } });
  const response = { token: 'test-device-token', device: { id: crypto.randomUUID(), name: 'Browser', createdAt: '2026-10-28T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', revokedAt: null }, owner: { id: crypto.randomUUID(), username: 'A' }, siteId: crypto.randomUUID() };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { status: 201 })));
  return { stored, local };
}
it('disconnect wins over a pairing storage write already in flight', async () => {
  const { stored, local } = environment();
  let release!: () => void; let entered!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  local.setAccessLevel = async () => { entered(); await held; };
  const { handleArchiveRequest } = await import('../../src/archive/background');
  const sender = { id: 'extension', url: 'chrome-extension://extension/src/options/index.html' };
  const request = (value: unknown) => new Promise<any>(resolve => { handleArchiveRequest(value, sender, resolve, async () => {}); });
  const pairing = request({ type: 'archive:pair', origin: 'https://library.example', code: 'test-code' }); await started;
  const disconnect = request({ type: 'archive:disconnect' });
  await Promise.resolve(); release(); await Promise.all([pairing, disconnect]);
  expect(stored[BINDING_KEY]).toBeUndefined();
});
it('webpage sender cannot pair or submit a made-up capture grant', async () => {
  environment(); const { handleArchiveRequest } = await import('../../src/archive/background');
  const sender = { id: 'extension', tab: { id: 3 }, frameId: 0, documentId: 'document', url: 'https://source.example/' } as chrome.runtime.MessageSender;
  const response = await new Promise<any>(resolve => { handleArchiveRequest({ type: 'archive:pair', origin: 'https://library.example', code: 'code' }, sender, resolve, async () => {}); });
  expect(response.ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
});
