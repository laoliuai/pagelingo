import { describe, expect, it, vi } from 'vitest';
import { siteOrigin, hostPermission } from '../../src/archive/binding';
import { acquireLocalResource, decodeResourceFrame, RESOURCE_FRAME_BYTES } from '../../src/archive/resources';
import { captureResourceFrameSchema } from '../../src/archive/grants';
const grant = { contentSessionId: crypto.randomUUID(), revision: 0, url: 'https://source.example/story', grantId: crypto.randomUUID(), captureId: crypto.randomUUID(), tabId: 3, frameId: 0 as const, documentId: 'chrome-document' };
describe('archive resource capabilities', () => {
  it('pins safe site origins and never turns paths or credentials into site authority', () => {
    expect(siteOrigin('http://127.0.0.1:4318')).toBe('http://127.0.0.1:4318');
    expect(hostPermission('https://library.example:8443')).toBe('https://library.example/*');
    for (const value of ['http://private.example','https://u:p@library.example','https://library.example/path','https://library.example?x=1']) expect(() => siteOrigin(value)).toThrow();
  });
  it('looks up selected local resource before and after asynchronous acquisition', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
    let current = true;
    const lookup = () => { if (!current) throw new Error('stale source'); return { id: 'r1', url: png, role: 'image' as const }; };
    const decoded = await acquireLocalResource(grant, 'r1', lookup, async () => {});
    expect(decoded.bytes.slice(0, 4)).toEqual(new Uint8Array([137,80,78,71]));
    await expect(acquireLocalResource(grant, 'r1', lookup, async () => { current = false; })).rejects.toThrow('stale source');
  });
  it('rejects arbitrary network locators and malformed or oversized base64 frames', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(acquireLocalResource(grant, 'r1', () => ({ id: 'r1', url: 'https://evil.example/image', role: 'image' }), async () => {})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => decodeResourceFrame('!!!!')).toThrow();
    expect(captureResourceFrameSchema.safeParse({ type: 'capture:resource-frame', grant, resourceId: 'r1', offset: 0, total: 1, mediaType: 'image/png', data: 'A'.repeat(RESOURCE_FRAME_BYTES + 4) }).success).toBe(false);
  });
});
it('grant identity comparison survives strict-schema property ordering without accepting changed identity', async () => {
  const { sameCaptureGrant, captureGrantSchema } = await import('../../src/archive/grants');
  const reordered = Object.fromEntries(Object.entries(grant).reverse());
  expect(sameCaptureGrant(grant, captureGrantSchema.parse(reordered))).toBe(true);
  expect(sameCaptureGrant(grant, { ...grant, revision: 1 })).toBe(false);
});
