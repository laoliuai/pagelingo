import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalObjectStore } from '../../src/storage/local-object-store.js';
const dirs: string[] = [];
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'pgl-store-')); dirs.push(dir); return { dir, store: createLocalObjectStore(dir) }; }
async function* body(value = 'abcdef') { yield Buffer.from(value.slice(0, 2)); yield Buffer.from(value.slice(2)); }
async function collect(stream: AsyncIterable<Uint8Array>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString(); }

describe('immutable local objects', () => {
  it('streams bytes, hashes, reads ranges and publishes with private permissions', async () => {
    const { dir, store } = await setup(); const key = randomUUID();
    expect(await store.putImmutable(key, body(), 6)).toEqual({ bytes: 6, sha256: createHash('sha256').update('abcdef').digest('hex') });
    expect(await store.stat(key)).toMatchObject({ bytes: 6 });
    expect(await collect(store.read(key))).toBe('abcdef');
    expect(await collect(store.read(key, { start: 2, end: 4 }))).toBe('cde');
    expect((await stat(join(dir, 'objects', key))).mode & 0o777).toBe(0o600);
    await expect(store.putImmutable(key, body('changed'), 30)).rejects.toThrow();
    expect(await collect(store.read(key))).toBe('abcdef');
  });
  it('cleans temporary files on overflow and interrupted streams', async () => {
    const { dir, store } = await setup();
    await expect(store.putImmutable(randomUUID(), body(), 5)).rejects.toMatchObject({ statusCode: 413 });
    async function* interrupted() { yield Buffer.from('abc'); throw new Error('aborted'); }
    await expect(store.putImmutable(randomUUID(), interrupted(), 9)).rejects.toThrow('aborted');
    expect(await readdir(join(dir, 'staging'))).toEqual([]);
    expect(await readdir(join(dir, 'objects'))).toEqual([]);
  });
  it('rejects traversal and symlinks for writes, reads and deletion', async () => {
    const { dir, store } = await setup();
    await expect(store.putImmutable('../escape', body(), 9)).rejects.toThrow();
    await store.putImmutable(randomUUID(), body(), 9);
    const key = randomUUID(); const external = join(dir, 'external'); await writeFile(external, 'secret');
    await symlink(external, join(dir, 'objects', key));
    await expect(store.stat(key)).rejects.toThrow();
    await expect(collect(store.read(key))).rejects.toThrow();
    await expect(store.deleteUnreferenced(key)).rejects.toThrow();
    await expect(store.putImmutable(key, body(), 9)).rejects.toThrow();
  });
  it('rejects a symlinked storage directory', async () => {
    const { dir, store } = await setup(); const other = await mkdtemp(join(tmpdir(), 'pgl-outside-')); dirs.push(other);
    await symlink(other, join(dir, 'objects'));
    await expect(store.putImmutable(randomUUID(), body(), 9)).rejects.toThrow();
    expect(await readdir(other)).toEqual([]);
  });
});

it('allows only one concurrent publisher for a key and never mixes original bytes', async () => {
  const { store } = await setup(); const key = randomUUID();
  const outcomes = await Promise.allSettled([store.putImmutable(key, body('first'), 9), store.putImmutable(key, body('second'), 9)]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(['first', 'second']).toContain(await collect(store.read(key)));
});
