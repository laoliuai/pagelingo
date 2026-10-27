import { mkdtemp, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import {
  validateBundle,
  createMemoryFileSource,
  readArchive,
  parseParserConfig,
  writeBundle,
  createDirectoryFileSource,
} from '../src/index.js';
import type { BundleFileSource } from '../src/index.js';
import { fixture, limits, json, hash, updateManifest } from './fixtures.js';
const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bundle-safety-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
it.each(['apiKey', 'baseUrl', 'outputDir', 'threads', 'unexpected'])(
  'rejects unknown parser option %s',
  (key) => {
    expect(() =>
      parseParserConfig({
        schemaVersion: 'pagelingo-parser-config/1',
        parser: { name: 'mineru', version: null },
        options: { [key]: 'secret' },
      }),
    ).toThrow();
  },
);
it.each([
  { threadsRequested: 0 },
  { onnxIntraOpThreadsRequested: 1.5 },
  { vlm: 'false' },
  { device: '/host/model' },
  { smallBackend: 'https://host' },
  { pageRange: 'all;rm' },
  { tier: 'unknown' },
])('rejects unsafe parser option %j', (options) => {
  expect(() =>
    parseParserConfig({
      schemaVersion: 'pagelingo-parser-config/1',
      parser: { name: 'mineru', version: null },
      options,
    }),
  ).toThrow();
});
it('accepts safe explicit parser options and nullable missing upstream versions', () => {
  expect(
    parseParserConfig({
      schemaVersion: 'pagelingo-parser-config/1',
      parser: { name: 'mineru', version: null },
      options: {
        tier: 'basic',
        smallBackend: 'onnx',
        device: 'cpu',
        parseMode: 'txt',
        imageAnalysis: true,
        vlm: false,
        pageRange: '0-3,7',
        threadsRequested: 4,
        onnxIntraOpThreadsRequested: 4,
        onnxInterOpThreadsRequested: 1,
      },
    }).options.vlm,
  ).toBe(false);
});
it('rejects directory casing aliases before opening content', () => {
  expect(() =>
    createMemoryFileSource(
      new Map([
        ['a/one', Buffer.from('1')],
        ['A/two', Buffer.from('2')],
      ]),
      limits,
    ),
  ).toThrow();
});
it('rejects a corrupted PNG CRC and actual image dimensions even with updated manifest entries', async () => {
  for (const kind of ['crc', 'dimension']) {
    const files = await fixture(),
      png = Buffer.from(files.get('assets/figure-1.png')!);
    if (kind === 'crc') png[45] ^= 1;
    else {
      png.writeUInt32BE(2, 16);
      png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    }
    files.set('assets/figure-1.png', png);
    updateManifest(files);
    await expect(
      validateBundle(createMemoryFileSource(files, limits), { limits }),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  }
});
it('rejects declared image dimensions over lower runtime pixel/dimension limits', async () => {
  const files = await fixture(),
    ir = JSON.parse(files.get('source-ir.json')!.toString()),
    t = JSON.parse(files.get('translation.json')!.toString()),
    m = JSON.parse(files.get('manifest.json')!.toString());
  ir.assets[0].width = 2;
  files.set('source-ir.json', json(ir));
  m.readerIrSha256 = hash(files.get('source-ir.json')!);
  t.readerIrSha256 = m.readerIrSha256;
  files.set('translation.json', json(t));
  m.translation.sha256 = hash(files.get('translation.json')!);
  files.set('manifest.json', json(m));
  updateManifest(files);
  await expect(
    validateBundle(createMemoryFileSource(files, limits), {
      limits: { ...limits, maxImagePixels: 1, maxImageDimension: 1 },
    }),
  ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
});
it('aborts validation between streamed chunks and closes a custom iterator', async () => {
  const files = await fixture(),
    base = createMemoryFileSource(files, limits),
    ac = new AbortController();
  let closed = false;
  const input: BundleFileSource = {
    list: () => base.list(),
    async *read(path) {
      if (path !== 'source.pdf') {
        yield* base.read(path);
        return;
      }
      try {
        yield files.get(path)!.subarray(0, 2);
        ac.abort();
        yield files.get(path)!.subarray(2);
      } finally {
        closed = true;
      }
    },
  };
  await expect(
    validateBundle(input, { limits, signal: ac.signal }),
  ).rejects.toMatchObject({ code: 'BUNDLE_ABORTED' });
  expect(closed).toBe(true);
});
it('aborts a writer during the second input pass and leaves no destination or temporary file', async () => {
  const files = await fixture(),
    base = createMemoryFileSource(files, limits),
    ac = new AbortController();
  let reads = 0;
  const input: BundleFileSource = {
    list: () => base.list(),
    async *read(path) {
      if (path === 'source.pdf' && ++reads > 1) ac.abort();
      yield* base.read(path);
    },
  };
  const dir = await temp();
  await expect(
    writeBundle(input, join(dir, 'out.zip'), { limits, signal: ac.signal }),
  ).rejects.toMatchObject({ code: 'BUNDLE_ABORTED' });
  expect(await readdir(dir)).toEqual([]);
});
it('does not follow a symlink in the directory source root ancestry', async () => {
  const root = await temp(),
    outside = await temp();
  await writeFile(join(outside, 'x'), 'x');
  await symlink(outside, join(root, 'linked'));
  await expect(
    createDirectoryFileSource(join(root, 'linked'), limits).list(),
  ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it('rejects truncated archives without leaking runtime paths', async () => {
  const dir = await temp(),
    p = join(dir, 'private-name.zip');
  await writeFile(p, Buffer.from('PK\x03\x04'));
  try {
    for await (const e of readArchive(p, limits)) {
      for await (const _ of e.content) {
      }
    }
    throw Error('unexpected success');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'INVALID_BUNDLE',
      message: 'Invalid document bundle',
    });
    expect(String(error)).not.toContain(dir);
  }
});

it('uses a private 0700 staging directory and 0600 temporary ZIP', async () => {
  const files = await fixture(),
    base = createMemoryFileSource(files, limits),
    dir = await temp();
  let reads = 0,
    observed = false;
  const input: BundleFileSource = {
    list: () => base.list(),
    async *read(path) {
      if (path === 'source.pdf' && ++reads > 1) {
        const entries = await readdir(dir, { withFileTypes: true });
        expect(entries).toHaveLength(1);
        expect(entries[0].isDirectory()).toBe(true);
        const { stat } = await import('node:fs/promises');
        const staging = join(dir, entries[0].name);
        expect((await stat(staging)).mode & 0o777).toBe(0o700);
        expect((await stat(join(staging, 'archive.zip'))).mode & 0o777).toBe(
          0o600,
        );
        observed = true;
      }
      yield* base.read(path);
    },
  };
  await writeBundle(input, join(dir, 'out.zip'), { limits });
  expect(observed).toBe(true);
  expect(await readdir(dir)).toEqual(['out.zip']);
});

it('checks actual image pixel/dimension ceilings before accepting a smaller declared image', async () => {
  const files = await fixture(),
    png = Buffer.from(files.get('assets/figure-1.png')!);
  png.writeUInt32BE(16385, 16);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  files.set('assets/figure-1.png', png);
  updateManifest(files);
  await expect(
    validateBundle(createMemoryFileSource(files, limits), { limits }),
  ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
});

it('preserves legitimate absolute-path examples in code/source text', async () => {
  const { refresh } = await import('./fixtures.js');
  const files = await fixture(),
    ir = JSON.parse(files.get('source-ir.json')!.toString());
  ir.blocks.find((b: { type: string }) => b.type === 'code').code =
    'open("/home/example/source.pdf");';
  files.set('source-ir.json', json(ir));
  refresh(files);
  const result = await validateBundle(createMemoryFileSource(files, limits), {
    limits,
  });
  expect(result.ir.blocks.find((b) => b.type === 'code')).toMatchObject({
    code: 'open("/home/example/source.pdf");',
  });
});

it('accepts explicit warnings for unavailable upstream locks and verifies bundled lock bytes', async () => {
  const { refresh } = await import('./fixtures.js');
  for (const bundled of [false, true]) {
    const files = await fixture(),
      ir = JSON.parse(files.get('source-ir.json')!.toString()),
      manifest = JSON.parse(files.get('manifest.json')!.toString());
    for (const [kind, path] of [
      ['model', 'provenance/model-lock.json'],
      ['python', 'provenance/python-lock.txt'],
    ]) {
      const body = Buffer.from(
        kind === 'model' ? '{"fixture":"model"}' : 'fixture-python-lock',
      );
      ir.parse[kind === 'model' ? 'modelLockSha256' : 'pythonLockSha256'] =
        hash(body);
      if (bundled) {
        files.set(path, body);
        manifest.files.push({
          path,
          bytes: body.length,
          sha256: hash(body),
          role: 'provenance',
          mediaType: kind === 'model' ? 'application/json' : 'text/plain',
        });
      } else ir.warnings.push(`upstream-${kind}-lock-not-bundled`);
    }
    files.set('source-ir.json', json(ir));
    files.set('manifest.json', json(manifest));
    refresh(files);
    expect(
      (await validateBundle(createMemoryFileSource(files, limits), { limits }))
        .ir.parse.modelLockSha256,
    ).not.toBeNull();
    if (bundled) {
      files.set('provenance/model-lock.json', json({ changed: true }));
      updateManifest(files);
      await expect(
        validateBundle(createMemoryFileSource(files, limits), { limits }),
      ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    }
  }
});

it.each([
  '/home/private/input.pdf',
  'C:\\private\\input.pdf',
  '.',
  '..',
  'bad\u0000.pdf',
])('rejects host-path originalFilename %j', async (originalFilename) => {
  const { refresh } = await import('./fixtures.js');
  const files = await fixture();
  const ir = JSON.parse(files.get('source-ir.json')!.toString());
  ir.metadata.originalFilename = originalFilename;
  files.set('source-ir.json', json(ir));
  refresh(files);
  await expect(
    validateBundle(createMemoryFileSource(files, limits), { limits }),
  ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});

it('never reads outside the root during concurrent ancestor symlink replacement', async () => {
  const { mkdir, rename, unlink } = await import('node:fs/promises');
  const root = await temp(),
    outside = await temp();
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'data'), 'safe');
  await writeFile(join(outside, 'data'), 'secret');
  const source = createDirectoryFileSource(root, limits);
  const racer = (async () => {
    for (let i = 0; i < 25; i++) {
      await rename(join(root, 'nested'), join(root, 'backup'));
      await symlink(outside, join(root, 'nested'));
      await unlink(join(root, 'nested'));
      await rename(join(root, 'backup'), join(root, 'nested'));
    }
  })();
  for (let i = 0; i < 25; i++) {
    try {
      let body = '';
      for await (const chunk of source.read('nested/data'))
        body += Buffer.from(chunk).toString();
      expect(body).toBe('safe');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_BUNDLE' });
    }
  }
  await racer;
});

it('closes archive and directory descriptors after repeated rejection and abort', async () => {
  const { setTimeout } = await import('node:timers/promises');
  const dir = await temp(),
    bad = join(dir, 'bad.zip');
  await writeFile(bad, 'invalid');
  const before = (await readdir('/proc/self/fd')).length;
  for (let i = 0; i < 20; i++) {
    await expect(
      (async () => {
        for await (const e of readArchive(bad, limits)) {
          for await (const _ of e.content) {
          }
        }
      })(),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    const source = createDirectoryFileSource(dir, limits);
    await expect(
      (async () => {
        for await (const _ of source.read('missing')) {
        }
      })(),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  }
  await setTimeout(20);
  expect((await readdir('/proc/self/fd')).length).toBeLessThanOrEqual(
    before + 2,
  );
});

it.each([
  [
    'image/jpeg',
    'jpg',
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z',
  ],
  [
    'image/webp',
    'webp',
    'UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoCAAMAAIAOJaQAA3AA/v9gGAAAAA==',
  ],
])(
  'validates real %s signatures and dimensions',
  async (mediaType, extension, encoded) => {
    const { refresh } = await import('./fixtures.js'),
      files = await fixture();
    const ir = JSON.parse(files.get('source-ir.json')!.toString()),
      manifest = JSON.parse(files.get('manifest.json')!.toString());
    const oldPath = ir.assets[0].path,
      path = `assets/figure-1.${extension}`,
      body = Buffer.from(encoded, 'base64');
    files.delete(oldPath);
    files.set(path, body);
    Object.assign(ir.assets[0], {
      path,
      mediaType,
      sha256: hash(body),
      bytes: body.length,
      width: 2,
      height: 3,
    });
    Object.assign(
      manifest.files.find((file: { path: string }) => file.path === oldPath),
      { path, mediaType, sha256: hash(body), bytes: body.length },
    );
    files.set('source-ir.json', json(ir));
    files.set('manifest.json', json(manifest));
    refresh(files);
    expect(
      (await validateBundle(createMemoryFileSource(files, limits), { limits }))
        .ir.assets[0].mediaType,
    ).toBe(mediaType);
  },
);

it('does not publish when cancellation arrives during the final fsync', async () => {
  const { open, unlink } = await import('node:fs/promises'),
    { vi } = await import('vitest');
  const dir = await temp(),
    probePath = join(dir, 'probe'),
    probe = await open(probePath, 'wx');
  const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  await unlink(probePath);
  const original = prototype.sync,
    ac = new AbortController();
  const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (
    this: unknown,
  ) {
    await original.call(this);
    ac.abort();
  });
  try {
    const files = await fixture();
    await expect(
      writeBundle(createMemoryFileSource(files, limits), join(dir, 'out.zip'), {
        limits,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ code: 'BUNDLE_ABORTED' });
    expect(await readdir(dir)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

it('rejects WebP canvas dimensions inconsistent with its compressed image dimensions', async () => {
  const { inspectImage } = await import('../src/images.js');
  const original = Buffer.from(
    'UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoCAAMAAIAOJaQAA3AA/v9gGAAAAA==',
    'base64',
  );
  const extended = Buffer.alloc(18);
  extended.write('VP8X');
  extended.writeUInt32LE(10, 4);
  const image = Buffer.concat([
    original.subarray(0, 12),
    extended,
    original.subarray(12),
  ]);
  image.writeUInt32LE(image.length - 8, 4);
  expect(() => inspectImage(image)).toThrow();
});

it('rejects multiple JPEG frame headers instead of trusting the last dimensions', async () => {
  const { inspectImage } = await import('../src/images.js');
  const image = Buffer.from(
    'ffd8ffc00008080003000201ffc00008080003000201ffda0002ffd9',
    'hex',
  );
  expect(() => inspectImage(image)).toThrow();
});

it('closes a local file handle if its initial fstat fails', async () => {
  const { open } = await import('node:fs/promises'),
    { vi } = await import('vitest');
  const root = await temp(),
    path = join(root, 'data');
  await writeFile(path, 'safe');
  const probe = await open(path, 'r'),
    prototype = Object.getPrototypeOf(probe) as { stat(): Promise<unknown> };
  await probe.close();
  let opened: import('node:fs/promises').FileHandle | undefined;
  const spy = vi.spyOn(prototype, 'stat').mockImplementation(async function (
    this: import('node:fs/promises').FileHandle,
  ) {
    opened = this;
    throw Error('simulated fstat failure');
  });
  try {
    const source = createDirectoryFileSource(root, limits);
    await expect(
      (async () => {
        for await (const _ of source.read('data')) {
        }
      })(),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    expect(opened?.fd).toBe(-1);
  } finally {
    spy.mockRestore();
    await opened?.close();
  }
});

it('closes output streams and removes staging when fsync fails', async () => {
  const { open, unlink } = await import('node:fs/promises'),
    { vi } = await import('vitest');
  const dir = await temp(),
    probePath = join(dir, 'probe'),
    probe = await open(probePath, 'wx');
  const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  await unlink(probePath);
  const spy = vi
    .spyOn(prototype, 'sync')
    .mockRejectedValue(Error('simulated sync failure'));
  try {
    const files = await fixture();
    await expect(
      writeBundle(createMemoryFileSource(files, limits), join(dir, 'out.zip'), {
        limits,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    expect(await readdir(dir)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
}, 2000);

it('rejects unsupported JPEG frame headers alongside a compatible frame', async () => {
  const { inspectImage } = await import('../src/images.js');
  expect(() =>
    inspectImage(
      Buffer.from(
        'ffd8ffc3000b080003000201011100ffc0000b080003000201011100ffda0002ffd9',
        'hex',
      ),
    ),
  ).toThrow();
});
