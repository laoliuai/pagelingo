import { afterEach, expect, it, vi } from 'vitest';
import { createImageMetadataCache } from '../../src/readers/image-metadata-cache.js';
const value = (id: string) => new Map([[id, { id, object_key: 'object', sha256: 'a'.repeat(64), bytes: '9', media_type: 'image/png' }]]);
afterEach(() => vi.useRealTimers());
it('expires immutable image metadata and evicts the least recently used version', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const cache = createImageMetadataCache({ maxVersions: 2, ttlMs: 100 });
  await cache.get('one', async () => value('one'));
  await cache.get('two', async () => value('two'));
  expect((await cache.get('one', async () => value('incorrect'))).has('one')).toBe(true);
  await cache.get('three', async () => value('three'));
  expect((await cache.get('two', async () => value('reloaded'))).has('reloaded')).toBe(true);
  vi.setSystemTime(101);
  expect((await cache.get('two', async () => value('expired'))).has('expired')).toBe(true);
});
it('bounds retained metadata bytes and does not retain load failures or oversized entries', async () => {
  const cache = createImageMetadataCache({ maxBytes: 220 });
  await cache.get('one', async () => value('one'));
  await cache.get('two', async () => value('two'));
  expect((await cache.get('one', async () => value('evicted'))).has('evicted')).toBe(true);
  await expect(cache.get('failed', async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
  expect((await cache.get('failed', async () => value('retry'))).has('retry')).toBe(true);
  await cache.get('large', async () => new Map([...value('a'), ...value('b')]));
  expect((await cache.get('large', async () => value('not-retained'))).has('not-retained')).toBe(true);
});
it('coalesces identical cold loads and bounds simultaneous distinct IR validations', async () => {
  const cache = createImageMetadataCache({ maxLoads: 1 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0; let maximum = 0; let loads = 0;
  async function load(id: string) { loads++; active++; maximum = Math.max(maximum, active); await gate; active--; return value(id); }
  const first = cache.get('one', () => load('one'));
  const same = cache.get('one', () => load('incorrect'));
  const next = cache.get('two', () => load('two'));
  await Promise.resolve(); release();
  expect((await first).has('one')).toBe(true); expect(await same).toBe(await first);
  expect((await next).has('two')).toBe(true); expect(loads).toBe(2); expect(maximum).toBe(1);
});
