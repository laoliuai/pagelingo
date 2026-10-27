import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '@pagelingo/translation-core';
import {
  validateBundle,
  writeBundle,
  createMemoryFileSource,
  createArchiveFileSource,
  deriveParseId,
  serializeBundleJson,
} from '../src/index.js';
import type { BundleFileSource } from '../src/index.js';
import { fixture, limits, json, updateManifest, hash } from './fixtures.js';
const dirs: string[] = [];
async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'bundle-validation-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const source = (files: Map<string, Buffer>): BundleFileSource =>
  createMemoryFileSource(files, limits);
describe('complete bundle admission', () => {
  it.each(['pending', 'chinese', 'partial'] as const)(
    'validates %s and round trips with canonical identity',
    async (kind) => {
      const files = await fixture(kind),
        result = await validateBundle(source(files), { limits });
      expect(result.translation.status).toBe(
        kind === 'chinese' ? 'not-required' : kind,
      );
      expect(result.files).toHaveLength(files.size - 1);
      expect(result.manifestSha256).toBe(
        await contentHash(JSON.parse(files.get('manifest.json')!.toString())),
      );
      const path = join(await temp(), 'export.zip');
      expect(await writeBundle(source(files), path, { limits })).toEqual({
        packageId: result.manifest.packageId,
        manifestSha256: result.manifestSha256,
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const reread = await validateBundle(
        createArchiveFileSource(path, limits),
        { limits },
      );
      expect(reread.manifestSha256).toBe(result.manifestSha256);
      const reformatted = new Map(files);
      reformatted.set(
        'manifest.json',
        Buffer.from(JSON.stringify(result.manifest, null, 2)),
      );
      expect(
        (await validateBundle(source(reformatted), { limits })).manifestSha256,
      ).toBe(result.manifestSha256);
    },
  );
  it.each([
    'source.pdf',
    'source-ir.json',
    'translation.json',
    'assets/figure-1.png',
    'assets/offline-runtime.js',
    'provenance/parser-config.json',
  ])('rejects changed bytes for %s', async (path) => {
    const files = await fixture();
    files.set(path, Buffer.concat([files.get(path)!, Buffer.from('x')]));
    await expect(
      validateBundle(source(files), { limits }),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  });
  it.each([
    'source.pdf',
    'source-ir.json',
    'translation.json',
    'assets/figure-1.png',
    'render/index.html',
    'provenance/input-manifest.json',
  ])('rejects missing %s', async (path) => {
    const files = await fixture();
    files.delete(path);
    await expect(
      validateBundle(source(files), { limits }),
    ).rejects.toMatchObject({ code: 'BUNDLE_MISSING_RESOURCE' });
  });
  it.each([
    'script',
    'font',
    'generated',
    'image',
    'version',
    'parse',
    'glossary',
    'config',
    'url',
    'unit',
    'lock',
    'role',
    'metadata',
  ])('rejects self-consistent %s forgery', async (kind) => {
    const files = await fixture();
    const m = JSON.parse(files.get('manifest.json')!.toString());
    if (kind === 'script')
      files.set('assets/offline-runtime.js', Buffer.from('evil()'));
    if (kind === 'font') {
      const p = [...files.keys()].find((p) => p.endsWith('.woff2'))!;
      files.set(p, Buffer.from('forged font'));
    }
    if (kind === 'generated')
      files.set(
        'render/data/index.js',
        Buffer.from('PageLingoReader.registerIndex({});'),
      );
    if (kind === 'image')
      files.set('assets/figure-1.png', Buffer.from('not a png'));
    if (kind === 'version') m.renderer.version = 'forged';
    if (kind === 'parse') m.parse.id = 'p_' + '0'.repeat(64);
    if (kind === 'metadata') m.title = 'different';
    if (kind === 'role')
      m.files.find((f: { path: string }) => f.path === 'source.pdf').role =
        'asset';
    if (['glossary', 'unit'].includes(kind)) {
      const t = JSON.parse(files.get('translation.json')!.toString());
      if (kind === 'glossary') t.glossarySha256 = '0'.repeat(64);
      else t.units.pop();
      files.set('translation.json', json(t));
      m.translation.sha256 = hash(files.get('translation.json')!);
    }
    if (['url', 'lock'].includes(kind)) {
      const ir = JSON.parse(files.get('source-ir.json')!.toString());
      if (kind === 'url') {
        ir.blocks[0].value.content = [
          {
            type: 'format',
            kind: 'link',
            id: 'bad',
            children: [{ type: 'text', text: 'x' }],
          },
        ];
        ir.blocks[0].bindings = [
          { id: 'bad', kind: 'link', href: 'https://host:99999/' },
        ];
      } else ir.parse.modelLockSha256 = '0'.repeat(64);
      files.set('source-ir.json', json(ir));
      m.readerIrSha256 = hash(files.get('source-ir.json')!);
      const t = JSON.parse(files.get('translation.json')!.toString());
      t.readerIrSha256 = m.readerIrSha256;
      files.set('translation.json', json(t));
      m.translation.sha256 = hash(files.get('translation.json')!);
    }
    if (kind === 'config')
      files.set('provenance/parser-config.json', json({ apiKey: 'secret' }));
    files.set('manifest.json', json(m));
    updateManifest(files);
    await expect(
      validateBundle(source(files), { limits }),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  });
  it('rejects unlisted files and extra render/asset files', async () => {
    const files = await fixture();
    files.set('unlisted', Buffer.from('x'));
    await expect(
      validateBundle(source(files), { limits }),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    const m = JSON.parse(files.get('manifest.json')!.toString());
    m.files.push({
      path: 'unlisted',
      bytes: 1,
      sha256: hash('x'),
      mediaType: 'text/plain',
      role: 'render',
    });
    files.set('manifest.json', json(m));
    await expect(
      validateBundle(source(files), { limits }),
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  });
  it('applies lower structural and byte limits, including UTF-8 and JSON depth', async () => {
    const files = await fixture();
    for (const override of [
      { maxBlocks: 1 },
      { maxNodes: 1 },
      { maxDepth: 1 },
      { maxTextBytes: 2 },
      { maxCodeBytes: 1 },
      { maxLatexBytes: 1 },
      { maxImagePixels: 1, maxImageDimension: 1, maxIrBytes: 1 },
      { maxFiles: 1 },
      { maxJsonDepth: 2 },
    ])
      await expect(
        validateBundle(source(files), { limits: { ...limits, ...override } }),
      ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
    const deep = new Map<string, Buffer>();
    deep.set('manifest.json', Buffer.from('['.repeat(129) + ']'.repeat(129)));
    await expect(
      validateBundle(source(deep), { limits }),
    ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  });
  it('stops a dishonest custom source at actual byte overflow and closes its iterator', async () => {
    let closed = false,
      pulled = 0;
    const body = Buffer.alloc(10);
    const fake: BundleFileSource = {
      async list() {
        return [{ path: 'manifest.json', bytes: 1 }];
      },
      async *read() {
        try {
          for (let i = 0; i < 100; i++) {
            pulled++;
            yield body;
          }
        } finally {
          closed = true;
        }
      },
    };
    await expect(
      validateBundle(fake, { limits: { ...limits, maxManifestBytes: 15 } }),
    ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
    expect(pulled).toBe(2);
    expect(closed).toBe(true);
  });
  it('never overwrites an existing destination, including concurrent writers', async () => {
    const files = await fixture(),
      path = join(await temp(), 'out.zip');
    await writeFile(path, 'existing');
    await expect(
      writeBundle(source(files), path, { limits }),
    ).rejects.toMatchObject({ code: 'BUNDLE_DESTINATION_EXISTS' });
    expect((await readFile(path)).toString()).toBe('existing');
    await rm(path);
    const results = await Promise.allSettled([
      writeBundle(source(files), path, { limits }),
      writeBundle(source(files), path, { limits }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await validateBundle(createArchiveFileSource(path, limits), { limits }))
        .manifest.packageId,
    ).toBeTruthy();
    expect(await readdir(join(path, '..'))).toEqual(['out.zip']);
  });
  it('rejects a changed source between validation and writing, and removes temporary output', async () => {
    const files = await fixture();
    let reads = 0;
    const input = source(files);
    const changing: BundleFileSource = {
      list: () => input.list(),
      async *read(path) {
        if (path === 'source.pdf' && ++reads > 1) {
          yield Buffer.from('changed');
          return;
        }
        yield* input.read(path);
      },
    };
    const path = join(await temp(), 'changed.zip');
    await expect(writeBundle(changing, path, { limits })).rejects.toMatchObject(
      { code: 'INVALID_BUNDLE' },
    );
    expect(await readdir(join(path, '..'))).toEqual([]);
  });
  it('supports shared deterministic serialization and parse identity helpers', () => {
    expect(
      deriveParseId(
        'a'.repeat(64),
        'b'.repeat(64),
        'projector/1',
        'c'.repeat(64),
      ),
    ).toBe(
      'p_' +
        hash('a'.repeat(64) + 'b'.repeat(64) + 'projector/1' + 'c'.repeat(64)),
    );
    expect(
      Buffer.from(serializeBundleJson({ z: 1, a: '中文' })).toString(),
    ).toBe('{"a":"中文","z":1}');
  });
});

it('preserves identity when ZIP compression and timestamps change', async () => {
  const { ZipFile } = await import('yazl'),
    { createWriteStream } = await import('node:fs'),
    { pipeline } = await import('node:stream/promises');
  const files = await fixture(),
    dir = await temp(),
    compressed = join(dir, 'compressed.zip'),
    stored = join(dir, 'stored.zip');
  await writeBundle(source(files), compressed, { limits });
  const zip = new ZipFile(),
    output = createWriteStream(stored, { flags: 'wx', mode: 0o600 });
  zip.on('error', (error) => output.destroy(error));
  const writing = pipeline(zip.outputStream, output);
  for (const [path, body] of files)
    zip.addBuffer(body, path, {
      compress: false,
      mtime: new Date('2025-01-01T00:00:00Z'),
      mode: 0o100600,
    });
  zip.end();
  await writing;
  expect((await stat(stored)).size).toBeGreaterThan(
    (await stat(compressed)).size,
  );
  const first = await validateBundle(
      createArchiveFileSource(compressed, limits),
      { limits },
    ),
    second = await validateBundle(createArchiveFileSource(stored, limits), {
      limits,
    });
  expect(second.manifestSha256).toBe(first.manifestSha256);
});

it.each(['assets/figure#1.png', 'assets/read #1/a&b[2]+,.png'])(
  'round trips a complete bundle whose literal member %s resolves from offline image URLs',
  async (assetPath) => {
    const { refresh } = await import('./fixtures.js');
    const files = await fixture();
    const ir = JSON.parse(files.get('source-ir.json')!.toString());
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    const previousPath = ir.assets[0].path;
    const image = files.get(previousPath)!;
    files.delete(previousPath);
    files.set(assetPath, image);
    ir.assets[0].path = assetPath;
    manifest.files.find(
      (file: { path: string }) => file.path === previousPath,
    ).path = assetPath;
    files.set('source-ir.json', json(ir));
    files.set('manifest.json', json(manifest));
    refresh(files);
    await validateBundle(source(files), { limits });
    const zipPath = join(await temp(), 'literal-path.zip');
    await writeBundle(source(files), zipPath, { limits });
    const archive = createArchiveFileSource(zipPath, limits);
    const result = await validateBundle(archive, { limits });
    const members = new Set((await archive.list()).map((file) => file.path));
    expect(result.ir.assets[0].path).toBe(assetPath);
    let imageCount = 0;
    for (const file of result.files.filter((file) =>
      file.path.startsWith('render/data/c_'),
    )) {
      const chunks: Uint8Array[] = [];
      for await (const bytes of archive.read(file.path)) chunks.push(bytes);
      const registration = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.parse(
        registration.slice('PageLingoReader.registerChunk('.length, -3),
      );
      for (const mode of ['source', 'translation']) {
        for (const match of (payload[mode].html as string).matchAll(
          /<img\b[^>]*\bsrc="([^"]+)"/g,
        )) {
          const url = new URL(match[1], 'file:///bundle/render/index.html');
          const member = decodeURIComponent(url.pathname).slice(
            '/bundle/'.length,
          );
          expect(member).toBe(assetPath);
          expect(members.has(member)).toBe(true);
          expect(url.hash).toBe('');
          expect(url.search).toBe('');
          imageCount++;
        }
      }
    }
    expect(imageCount).toBeGreaterThan(0);
  },
);
