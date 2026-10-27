import { afterEach, expect, it, vi } from 'vitest';
import { createArchiveClient } from '../../src/archive/client';
import { BINDING_KEY, type SiteConnection } from '../../src/archive/binding';
afterEach(() => vi.unstubAllGlobals());
it('rechecks the binding after asynchronous host permission validation before sending the device token', async () => {
  const connection: SiteConnection = { binding: { siteOrigin: 'https://library.example', siteId: crypto.randomUUID(), ownerId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: crypto.randomUUID() }, token: 'local-test-token', username: 'A', expiresAt: '2027-01-01T00:00:00Z' };
  let stored = structuredClone(connection);
  vi.stubGlobal('chrome', { storage: { local: { setAccessLevel: async () => {}, get: async () => ({ [BINDING_KEY]: stored }) } }, permissions: { contains: async () => { stored = { ...stored, binding: { ...stored.binding, generation: crypto.randomUUID() } }; return true; } } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  await expect(createArchiveClient(connection.binding, new AbortController().signal).status(crypto.randomUUID())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
