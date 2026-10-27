import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import {
  readArchive,
  createArchiveFileSource,
  createDirectoryFileSource,
} from '../src/index.js';
const dirs: string[] = [];
async function temp(): Promise<string> {
  const p = await mkdtemp(join(tmpdir(), 'bundle-test-'));
  dirs.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
interface Entry {
  path: string;
  body?: Buffer;
  flags?: number;
  mode?: number;
  size?: number;
  crc?: number;
  method?: number;
}
export function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path),
      body = e.body ?? Buffer.from('hello');
    const method = e.method ?? 0,
      data = method === 8 ? deflateRawSync(body) : body;
    const crc = e.crc ?? crc32(body),
      size = e.size ?? body.length;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(e.flags ?? 0, 6);
    l.writeUInt16LE(method, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(data.length, 18);
    l.writeUInt32LE(size, 22);
    l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(e.flags ?? 0, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? 0o100600) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    locals.push(l, name, data);
    central.push(c, name);
    offset += l.length + name.length + data.length;
  }
  const c = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(c.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, c, end]);
}
async function file(entries: Entry[]): Promise<string> {
  const p = join(await temp(), 'input.zip');
  await writeFile(p, zip(entries));
  return p;
}
async function consume(
  path: string,
  limits = defaultBundleLimits,
): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of readArchive(path, limits)) {
    names.push(entry.path);
    for await (const _ of entry.content) {
      /* check streamed content */
    }
  }
  return names;
}
describe('sequential archive admission', () => {
  it('streams a stored and deflated regular file, with a single-use body', async () => {
    const p = await file([{ path: 'one.txt' }, { path: 'two.txt', method: 8 }]);
    expect(await consume(p)).toEqual(['one.txt', 'two.txt']);
    for await (const e of readArchive(p, defaultBundleLimits)) {
      let body = '';
      for await (const c of e.content) body += Buffer.from(c).toString();
      expect(body).toBe('hello');
      await expect(
        (async () => {
          for await (const _ of e.content) {
            /* second use */
          }
        })(),
      ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    }
  });
  it.each([
    '../escape',
    'a\\b',
    '/absolute',
    'C:/drive',
    'a\0b',
    'a//b',
    'a/./b',
    'a/%20',
    'con.txt',
    'x./y',
    'a/../b',
    'a:stream',
  ])('rejects dangerous path %j', async (path) => {
    await expect(consume(await file([{ path }]))).rejects.toMatchObject({
      code: 'INVALID_BUNDLE',
    });
  });
  it.each([
    ['A.txt', 'a.txt'],
    ['a', 'a'],
    ['a', 'a/b'],
    ['a/b', 'a'],
  ])('rejects aliases and prefix conflicts %j %j', async (a, b) => {
    await expect(
      consume(await file([{ path: a }, { path: b }])),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  });
  it.each([
    { mode: 0o120777 },
    { mode: 0o040755 },
    { mode: 0o010600 },
    { flags: 1 },
    { method: 99 },
    { crc: 0 },
    { size: 100 },
    { size: 1, method: 8 },
  ])('rejects metadata/CRC/size forgery %j', async (variant) => {
    await expect(
      consume(await file([{ path: 'x', ...variant }])),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  });
  it('enforces actual expanded and compressed bytes and file counts', async () => {
    const p = await file([
      { path: 'x', body: Buffer.alloc(100000), method: 8 },
    ]);
    await expect(
      consume(p, { ...defaultBundleLimits, maxExpandedBytes: 99999 }),
    ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
    await expect(
      consume(p, { ...defaultBundleLimits, maxArchiveBytes: 1 }),
    ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
    await expect(
      consume(await file([{ path: 'x' }, { path: 'y' }]), {
        ...defaultBundleLimits,
        maxFiles: 1,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  });
  it('rejects unconsumed bodies and handles abort before/mid-read', async () => {
    const p = await file([
      { path: 'x', body: Buffer.alloc(100000), method: 8 },
      { path: 'y' },
    ]);
    await expect(
      (async () => {
        for await (const _ of readArchive(p, defaultBundleLimits)) {
          /* not consumed */
        }
      })(),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    const ac = new AbortController();
    ac.abort();
    await expect(consumeAborted(p, ac.signal)).rejects.toMatchObject({
      code: 'BUNDLE_ABORTED',
    });
    const mid = new AbortController();
    await expect(
      (async () => {
        for await (const e of readArchive(p, defaultBundleLimits, mid.signal)) {
          for await (const _ of e.content) {
            mid.abort();
          }
        }
      })(),
    ).rejects.toMatchObject({ code: 'BUNDLE_ABORTED' });
  });
  it('offers repeatable indexed archive reads without keeping open handles', async () => {
    const source = createArchiveFileSource(
      await file([{ path: 'x' }, { path: 'y', method: 8 }]),
      defaultBundleLimits,
    );
    expect((await source.list()).map((x) => x.path)).toEqual(['x', 'y']);
    for (let i = 0; i < 2; i++) {
      let result = '';
      for await (const c of source.read('y'))
        result += Buffer.from(c).toString();
      expect(result).toBe('hello');
    }
  });
  it('directory sources reject final and ancestor symlinks', async () => {
    const root = await temp(),
      outside = await temp();
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(root, 'link'));
    await symlink(join(outside, 'secret'), join(root, 'file'));
    const source = createDirectoryFileSource(root, defaultBundleLimits);
    await expect(source.list()).rejects.toMatchObject({
      code: 'INVALID_BUNDLE',
    });
    for (const path of ['link/secret', 'file'])
      await expect(
        (async () => {
          for await (const _ of source.read(path)) {
          }
        })(),
      ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    await rm(join(root, 'link'));
    await rm(join(root, 'file'));
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'ok'), 'yes');
    expect(await source.list()).toEqual([{ path: 'nested/ok', bytes: 3 }]);
  });
});
async function consumeAborted(p: string, signal: AbortSignal): Promise<void> {
  for await (const e of readArchive(p, defaultBundleLimits, signal)) {
    for await (const _ of e.content) {
    }
  }
}
