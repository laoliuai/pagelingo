import type { AssetRow } from './repository.js';

type Images = ReadonlyMap<string, AssetRow>;
interface Entry { images: Images; bytes: number; expiresAt: number }
/** Per-service immutable metadata only: no ReaderIR, response bodies or authorization results.
 * Pending loads are also bounded; identical cold requests share one validation. */
export function createImageMetadataCache({ maxVersions = 32, maxBytes = 4 * 1024 * 1024, ttlMs = 5 * 60_000, maxLoads = 4 } = {}) {
  const entries = new Map<string, Entry>(); const pending = new Map<string, Promise<Images>>();
  let retainedBytes = 0;
  function remove(key: string) { const entry = entries.get(key); if (entry) retainedBytes -= entry.bytes; entries.delete(key); }
  return {
    async get(key: string, load: () => Promise<Images>): Promise<Images> {
      for (;;) {
        const entry = entries.get(key);
        if (entry && entry.expiresAt > Date.now()) { entries.delete(key); entries.set(key, entry); return entry.images; }
        if (entry) remove(key);
        const existing = pending.get(key); if (existing) return existing;
        if (pending.size < maxLoads) break;
        // Wait outside database transactions; another owner's load failure is not this request's error.
        await Promise.race([...pending.values()].map(flight => flight.catch(() => undefined)));
      }
      const flight = Promise.resolve().then(load).then(images => {
        const bytes = Buffer.byteLength(JSON.stringify([...images]));
        if (bytes <= maxBytes) {
          entries.set(key, { images, bytes, expiresAt: Date.now() + ttlMs }); retainedBytes += bytes;
          while (entries.size > maxVersions || retainedBytes > maxBytes) remove(entries.keys().next().value!);
        }
        return images;
      }).finally(() => { pending.delete(key); });
      pending.set(key, flight); return flight;
    },
  };
}
