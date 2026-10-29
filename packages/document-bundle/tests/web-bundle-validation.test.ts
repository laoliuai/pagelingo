import { mkdtemp, readFile, rm, readdir, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import * as bundle from '../src/index.js';
import { webFixture, refresh, hash, json, modelSnapshot } from './web-fixtures.js';
const options = { limits: defaultBundleLimits }, owned: string[] = [];
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'web-bundle-test-')); owned.push(dir); return dir; }
afterEach(async () => { for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true }); });
const source = (f: Awaited<ReturnType<typeof webFixture>>) => bundle.createMemoryFileSource(f.files, options.limits);
it.each([false, true])('roundtrips an original-only and partial Web package (%s)', async partial => {
  expect(bundle.validateWebBundle).toBeTypeOf('function');
  const f = await webFixture(partial), before = [...f.files].map(([path, bytes]) => [path, hash(bytes)]);
  const validated = await bundle.validateWebBundle(source(f), options);
  expect(validated.translation?.status ?? null).toBe(partial ? 'partial' : null);
  expect(validated.ir.metadata.title).toBe('Saved title'); expect(validated.manifest.title.length).toBeGreaterThan(500);
  expect(validated.readerBuild.chunks.flatMap(c => c.blocks).some(b => b.translation === null)).toBe(true);
  const destination = join(await temp(), 'reader.zip');
  const identity = await bundle.writeWebBundle(source(f), destination, options);
  const archive = bundle.createArchiveFileSource(destination, options.limits);
  expect((await bundle.validateWebBundle(archive, options)).manifestSha256).toBe(identity.manifestSha256);
  expect(identity.manifestSha256).toBe(hash(f.files.get('manifest.json')!));
  expect([...f.files].map(([path, bytes]) => [path, hash(bytes)])).toEqual(before);
  await expect(bundle.validateBundle(archive, options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  const outputHash = hash(await readFile(destination));
  await expect(bundle.writeWebBundle(source(f), destination, options)).rejects.toMatchObject({ code: 'BUNDLE_DESTINATION_EXISTS' });
  expect(hash(await readFile(destination))).toBe(outputHash);
});
it('rejects missing assets hostile paths and untrusted runtime bytes', async () => {
  expect(bundle.validateWebBundle).toBeTypeOf('function');
  const f = await webFixture();
  const missing = source(f), listing = await missing.list();
  await expect(bundle.validateWebBundle({ ...missing, list: async () => listing.filter(x => !x.path.endsWith('.jpg')) }, options)).rejects.toMatchObject({ code: 'BUNDLE_MISSING_RESOURCE' });
  for (const path of ['../escape', '/absolute', 'render/../escape', 'render\\escape', 'MANIFEST.json']) {
    await expect(bundle.validateWebBundle({ ...missing, list: async () => [...listing, { path, bytes: 1 }] }, options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  }
  refresh(f, 'assets/web-offline-runtime.js', Buffer.from('window.pwned=1;'));
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it.each(['fingerprint', 'ir', 'proof', 'preview', 'catalog'])('rejects self-consistent tampering: %s', async kind => {
  expect(bundle.validateWebBundle).toBeTypeOf('function');
  const f = await webFixture(true);
  if (kind === 'fingerprint') f.manifest.source.contentFingerprint = '0'.repeat(64);
  if (kind === 'catalog') f.manifest.renderer.version = 'unknown';
  if (kind === 'ir') { f.ir.metadata.title = 'Forged source'; refresh(f, 'source-ir.json', json(f.ir)); f.manifest.parse.readerIrSha256 = hash(json(f.ir)); }
  if (kind === 'proof') { f.translation!.blocks[0].sourceTextSha256 = '0'.repeat(64); refresh(f, 'translation.json', json(f.translation)); f.manifest.translation!.sha256 = hash(json(f.translation)); }
  if (kind === 'preview') { const path = [...f.files.keys()].find(p => p.startsWith('render/previews/'))!; refresh(f, path, Buffer.from('<p>substituted preview</p>')); }
  f.files.set('manifest.json', json(f.manifest));
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it('rejects symlinks and preserves owned output on streaming changes and aborts', async () => {
  expect(bundle.validateWebBundle).toBeTypeOf('function');
  const f = await webFixture(), dir = await temp();
  for (const [path, bytes] of f.files) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), bytes); }
  await symlink(join(dir, 'source-ir.json'), join(dir, 'alias.json'));
  await expect(bundle.validateWebBundle(bundle.createDirectoryFileSource(dir, options.limits), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  const original = source(f), reads = new Map<string, number>();
  const changing = { list: original.list, async *read(path: string) { const n = (reads.get(path) ?? 0) + 1; reads.set(path, n); if (n > 1 && path === 'source-ir.json') yield Buffer.from('changed'); else yield* original.read(path); } };
  const output = await temp(); await writeFile(join(output, 'keep'), 'owned by caller');
  await expect(bundle.writeWebBundle(changing, join(output, 'reader.zip'), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  expect(await readdir(output)).toEqual(['keep']);
  const abort = new AbortController(); abort.abort();
  await expect(bundle.writeWebBundle(source(f), join(output, 'reader.zip'), { ...options, signal: abort.signal })).rejects.toMatchObject({ code: 'BUNDLE_ABORTED' });
});
it('enforces declared and actual Web source limits, configured totals and JSON depth', async () => {
  expect(bundle.validateWebBundle).toBeTypeOf('function');
  const f = await webFixture(), original = source(f), listing = await original.list();
  for (const path of ['source-ir.json', 'source/manifest.json']) {
    await expect(bundle.validateWebBundle({ ...original, list: async () => listing.map(info => info.path === path ? { ...info, bytes: 16 * 1024 * 1024 + 1 } : info) }, options)).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  }
  await expect(bundle.validateWebBundle(original, { limits: { ...options.limits, maxExpandedBytes: 100 } })).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  await expect(bundle.validateWebBundle(original, { limits: { ...options.limits, maxJsonDepth: 2 } })).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  await expect(bundle.validateWebBundle(original, { limits: { ...options.limits, maxOtherFileBytes: 100 } })).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  await expect(bundle.validateWebBundle(original, { limits: { ...options.limits, maxPathBytes: 10 } })).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it.each(['__proto__', 'constructor', 'toString'])('treats local image ID %s as data and preserves same-byte resource aliases', async id => {
  const f = await webFixture(false, { imageId: id });
  const validated = await bundle.validateWebBundle(source(f), options);
  expect(validated.ir.assets.map(a => a.id)).toEqual([id]);
  expect(validated.source.resources.filter(r => r.status === 'available').map(r => r.fileId)).toEqual([id, id, id]);
  expect(validated.files.filter(f => f.path.endsWith('.jpg'))).toHaveLength(1);
});
it('admits exact Web source/IR and package path ceilings and rejects the next byte', async () => {
  const f = await webFixture(false, { sourceBytes: 16 * 1024 * 1024, irBytes: 16 * 1024 * 1024, htmlPath: 'h'.repeat(233) });
  await expect(bundle.validateWebBundle(source(f), options)).resolves.toMatchObject({ translation: null });
  const original = source(f), listed = await original.list();
  const total = listed.reduce((sum, f) => sum + f.bytes, 0);
  await expect(bundle.validateWebBundle(original, { limits: { ...options.limits, maxExpandedBytes: total } })).resolves.toMatchObject({ translation: null });
  await expect(bundle.validateWebBundle(original, { limits: { ...options.limits, maxExpandedBytes: total - 1 } })).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  await expect(bundle.validateWebBundle({ ...original, list: async () => listed.map(f => f.path.startsWith('source/h') ? { ...f, path: f.path + 'h' } : f) }, options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  for (const path of ['source/manifest.json', 'source-ir.json']) {
    const growing = { list: original.list, async *read(name: string) { yield* original.read(name); if (name === path) yield Buffer.from(' '); } };
    await expect(bundle.validateWebBundle(growing, options)).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  }
}, 30000);
it('rejects malformed image bytes even when all registered digests agree', async () => {
  const f = await webFixture(false, { invalidImage: true });
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it('rejects changed source text despite fresh IR, static and manifest digests', async () => {
  const f = await webFixture(false, { forgedIr: true });
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it('requires SDK markers and source/provenance hashes for model snapshots without model requests', async () => {
  const { createWebStaticFilePlan, buildWebReader } = await import('@pagelingo/document-renderer');
  const f = await webFixture(); const translation = await modelSnapshot(f.ir);
  translation.readerIrSha256 = f.manifest.parse.readerIrSha256;
  f.files.set('translation.json', json(translation));
  f.manifest.files.push({ path: 'translation.json', bytes: json(translation).length, sha256: hash(json(translation)), mediaType: 'application/json', role: 'translation' });
  Object.assign(f.manifest, { translation: { path: 'translation.json', sha256: hash(json(translation)), status: translation.status, generationKind: translation.generationKind } });
  for (const file of createWebStaticFilePlan({ ...f.input, translation, ...buildWebReader(f.ir, translation) }).generatedFiles) refresh(f, file.path, Buffer.from(file.content));
  f.files.set('manifest.json', json(f.manifest));
  await expect(bundle.validateWebBundle(source(f), options)).resolves.toMatchObject({ translation: { generationKind: 'mock' } });
  translation.glossarySha256 = '0'.repeat(64); refresh(f, 'translation.json', json(translation));
  f.manifest.translation!.sha256 = hash(json(translation)); f.files.set('manifest.json', json(f.manifest));
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it('checks SDK protected markers instead of trusting a valid imported shape', async () => {
  const f = await webFixture(true, { protectedHeading: true });
  await expect(bundle.validateWebBundle(source(f), options)).resolves.toMatchObject({ translation: { status: 'partial' } });
  f.translation!.blocks[0].rawText = 'Translation dropped the protected formatting markers';
  refresh(f, 'translation.json', json(f.translation)); f.manifest.translation!.sha256 = hash(json(f.translation)); f.files.set('manifest.json', json(f.manifest));
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it.each(['s2-final', 's3-final'])('rejects fixed PDF %s at the Web entrance and retains its bytes', async name => {
  const file = new URL(`./fixtures/${name}/reader.zip`, import.meta.url), before = hash(await readFile(file));
  const { fileURLToPath } = await import('node:url');
  const archive = bundle.createArchiveFileSource(fileURLToPath(file), options.limits);
  await expect(bundle.validateWebBundle(archive, options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  expect((await bundle.validateBundle(archive, options)).manifest.schemaVersion).toBe('pagelingo-document-bundle/1');
  expect(hash(await readFile(file))).toBe(before);
});
it('rejects duplicate member names and an aborted write leaves no temporary outputs', async () => {
  const f = await webFixture(), original = source(f), listing = await original.list();
  await expect(bundle.validateWebBundle({ ...original, list: async () => [...listing, listing[0]] }, options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  const signal = new AbortController(), seen = new Map<string, number>();
  const interrupted = { list: original.list, async *read(path: string) { const n = (seen.get(path) ?? 0) + 1; seen.set(path, n); for await (const body of original.read(path)) { if (path === 'source-ir.json' && n === 2) signal.abort(); yield body; } } };
  const dir = await temp();
  await expect(bundle.writeWebBundle(interrupted, join(dir, 'reader.zip'), { ...options, signal: signal.signal })).rejects.toMatchObject({ code: 'BUNDLE_ABORTED' });
  expect(await readdir(dir)).toEqual([]);
});

it.each(['tightened', 'unknown'])('explicitly rejects unsupported projection configuration: %s', async kind => {
  const f = await webFixture(false, { tightenedConfig: kind === 'tightened' });
  if (kind === 'unknown') { f.ir.parse.projectorVersion = 'unknown-projector/99'; refresh(f, 'source-ir.json', json(f.ir)); f.manifest.parse.readerIrSha256 = hash(json(f.ir)); f.files.set('manifest.json', json(f.manifest)); }
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'BUNDLE_UNSUPPORTED_SOURCE' });
});

it.each(['previews', 'images'])('requires trusted regeneration from actual archived %s bytes', async kind => {
  const { createWebStaticFilePlan } = await import('@pagelingo/document-renderer');
  const f = await webFixture();
  for (const path of [...f.files.keys()].filter(path => path.startsWith('render/'))) f.files.delete(path);
  f.manifest.files = f.manifest.files.filter(f => !f.path.startsWith('render/'));
  const plan = createWebStaticFilePlan({ ...f.input, ...(kind === 'previews' ? { previews: undefined } : { previewImages: undefined }) });
  for (const file of plan.generatedFiles) { const bytes = Buffer.from(file.content); f.files.set(file.path, bytes); f.manifest.files.push({ path: file.path, bytes: bytes.length, sha256: hash(bytes), role: 'render', mediaType: file.mediaType }); }
  f.files.set('manifest.json', json(f.manifest));
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});
it('reapplies the Web 16 MiB ceiling during the second streaming write pass', async () => {
  const f = await webFixture(), original = source(f), reads = new Map<string, number>();
  const growing = { list: original.list, async *read(path: string) { const n = (reads.get(path) ?? 0) + 1; reads.set(path, n); yield* original.read(path); if (path === 'source-ir.json' && n === 2) yield Buffer.alloc(16 * 1024 * 1024, 32); } };
  const dir = await temp();
  await expect(bundle.writeWebBundle(growing, join(dir, 'reader.zip'), options)).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  expect(await readdir(dir)).toEqual([]);
});
it('validates an exact inert original capture closure without changing trusted render bytes', async () => {
  const { canonicalManifestBytes } = await import('@pagelingo/web-capture');
  const f = await webFixture(), original = structuredClone(f.capture);
  const raw = Buffer.from('<script>window.untrusted=1</script><article>Original raw content</article>');
  const html = original.files.find(file => file.id === original.htmlFileId)!;
  html.bytes = raw.length; html.sha256 = hash(raw);
  const add = (path: string, bytes: Uint8Array, mediaType: string) => { f.files.set(path, bytes); f.manifest.files.push({ path, bytes: bytes.length, sha256: hash(bytes), mediaType, role: 'provenance' }); };
  const manifest = Buffer.from(canonicalManifestBytes(original));
  const request = Buffer.from(canonicalManifestBytes({ manifest: original, translationIntent: 'none' }));
  add('originals/capture/manifest.json', manifest, 'application/json'); add('originals/capture/request.json', request, 'application/json');
  for (const [ordinal, file] of original.files.entries()) add(`originals/capture/files/${ordinal}`, file.id === original.htmlFileId ? raw : f.files.get(`source/${file.path}`)!, file.mediaType);
  Object.assign(f.manifest, { originals: { capture: { manifestSha256: hash(manifest), requestSha256: hash(request), admissionKind: 'upload' } } });
  f.files.set('manifest.json', json(f.manifest));
  const before = f.files.get('render/index.html');
  expect((await bundle.validateWebBundle(source(f), options)).manifest).toHaveProperty('originals.capture');
  expect(f.files.get('render/index.html')).toEqual(before);
  const output = join(await temp(), 'originals.zip'); await bundle.writeWebBundle(source(f), output, options);
  expect((await bundle.validateWebBundle(bundle.createArchiveFileSource(output, options.limits), options)).manifest).toHaveProperty('originals.capture');
  f.files.delete(`originals/capture/files/${original.files.indexOf(html)}`);
  await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'BUNDLE_MISSING_RESOURCE' });
});
it.each(['extra', 'admission', 'mapping', 'depth', 'ordinal-alias', 'ordinal-swap', 'actual-stream', 'writer-stream'])('rejects incomplete or changed inert original closure: %s', async mode => {
  const { addOriginalCapture } = await import('./web-fixtures.js');
  const f = await webFixture(), original = await addOriginalCapture(f);
  if (mode === 'extra') {
    const path = 'originals/capture/files/undeclared.js', bytes = Buffer.from('unexpected');
    f.files.set(path, bytes); f.manifest.files.push({ path, bytes: bytes.length, sha256: hash(bytes), mediaType: 'text/javascript', role: 'provenance' });
  }
  if (mode === 'ordinal-alias' || mode === 'ordinal-swap') {
    const firstPath = original.htmlPath, secondPath = 'originals/capture/files/1';
    const firstBytes = f.files.get(firstPath)!, secondBytes = f.files.get(secondPath)!;
    if (mode === 'ordinal-alias') {
      f.files.delete(firstPath); f.files.set('originals/capture/files/00', firstBytes);
      f.manifest.files.find(file => file.path === firstPath)!.path = 'originals/capture/files/00';
    } else {
      f.files.set(firstPath, secondBytes); f.files.set(secondPath, firstBytes);
      for (const file of f.manifest.files) {
        if (file.path === firstPath) file.path = secondPath;
        else if (file.path === secondPath) file.path = firstPath;
      }
    }
  }
  if (mode === 'admission') (f.manifest as any).originals.capture.requestSha256 = 'a'.repeat(64);
  if (mode === 'mapping') {
    original.original.captureId = '55555555-5555-4555-8555-555555555555';
    const { canonicalManifestBytes } = await import('@pagelingo/web-capture');
    const bytes = canonicalManifestBytes(original.original); refresh(f, 'originals/capture/manifest.json', bytes);
    (f.manifest as any).originals.capture.manifestSha256 = hash(bytes);
  }
  if (mode === 'depth') refresh(f, 'originals/capture/manifest.json', Buffer.from('['.repeat(150) + '0' + ']'.repeat(150)));
  f.files.set('manifest.json', json(f.manifest));
  const originalSource = source(f);
  if (mode.includes('stream')) {
    let reads = 0;
    const changing = { list: originalSource.list, async *read(path: string) {
      if (path === original.htmlPath && ++reads >= (mode === 'writer-stream' ? 3 : 2)) yield Buffer.from('changed');
      else yield* originalSource.read(path);
    } };
    if (mode === 'writer-stream') await expect(bundle.writeWebBundle(changing, join(await temp(), 'changed.zip'), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    else await expect(bundle.validateWebBundle(changing, options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  } else await expect(bundle.validateWebBundle(source(f), options)).rejects.toThrow();
});
it.each(['valid', 'translation', 'candidate', 'shared-file'])('binds a second original capture only to the selected imported Reader: %s', async mode => {
  const { addOriginalCapture } = await import('./web-fixtures.js');
  const { canonicalManifestBytes } = await import('@pagelingo/web-capture');
  const f = await webFixture(true), first = await addOriginalCapture(f), second = structuredClone(first.original);
  second.captureId = '55555555-5555-4555-8555-555555555555';
  const sharedFiles = second.files.map(file => ({ id: file.id, sourceFileId: file.id }));
  if (mode === 'shared-file') sharedFiles[0]!.sourceFileId = 'missing-source-id';
  const add = (path: string, bytes: Uint8Array, mediaType = 'application/json') => {
    f.files.set(path, bytes); f.manifest.files.push({ path, bytes: bytes.length, sha256: hash(bytes), mediaType, role: 'provenance' });
  };
  if (mode === 'candidate') {
    const candidateFile = second.files.find(file => file.id === second.existingTranslation!.fileId)!;
    const candidate = JSON.parse(Buffer.from(f.files.get(`originals/capture/files/${first.original.files.findIndex(file => file.id === candidateFile.id)}`)!).toString());
    candidate.blocks[0].rawText = 'Not the selected translation';
    const bytes = json(candidate); candidateFile.sha256 = hash(bytes); candidateFile.bytes = bytes.length;
    sharedFiles.splice(sharedFiles.findIndex(file => file.id === candidateFile.id), 1);
    add(`originals/reader-capture/files/${second.files.indexOf(candidateFile)}`, bytes);
  }
  const manifestBytes = canonicalManifestBytes(second), requestBytes = canonicalManifestBytes({ manifest: second, translationIntent: 'none' });
  add('originals/reader-capture/manifest.json', manifestBytes); add('originals/reader-capture/request.json', requestBytes);
  (f.manifest as any).originals.readerCapture = { manifestSha256: hash(manifestBytes), requestSha256: hash(requestBytes), admissionKind: 'upload', sharedFiles,
    translationSha256: mode === 'translation' ? 'a'.repeat(64) : f.manifest.translation!.sha256 };
  f.files.set('manifest.json', json(f.manifest));
  if (mode === 'valid') expect((await bundle.validateWebBundle(source(f), options)).manifest.originals).toHaveProperty('readerCapture');
  else await expect(bundle.validateWebBundle(source(f), options)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
});

it.each(['source', 'reader', 'shared', 'duplicate-content'])('roundtrips bounded original attachment paths without losing descriptors: %s', async mode => {
  const { addOriginalCapture } = await import('./web-fixtures.js');
  const { canonicalManifestBytes } = await import('@pagelingo/web-capture');
  const { webCaptureManifestSchema, createWebCaptureRequestSchema } = await import('@pagelingo/document-contracts');
  const longPath = 'a'.repeat(215) + '.html';
  const hasReader = mode === 'reader' || mode === 'shared';
  const f = await webFixture(hasReader, { htmlPath: mode === 'reader' ? 'source.html' : longPath }), first = await addOriginalCapture(f);
  const expected = new Map<string, Uint8Array>();
  const add = (path: string, bytes: Uint8Array, mediaType: string) => {
    f.files.set(path, bytes); f.manifest.files.push({ path, bytes: bytes.length, sha256: hash(bytes), mediaType, role: 'provenance' });
  };
  if (mode === 'duplicate-content') {
    const image = first.original.files.find(file => file.role === 'image')!;
    const duplicate = { ...image, id: 'same-bytes-different-id', path: 'b'.repeat(216) + '.jpg' };
    first.original.files.push(duplicate);
    first.original.resources.push({ id: 'duplicate-image', url: 'https://example.com/duplicate.jpg', role: 'image', status: 'available', fileId: duplicate.id });
    add(`originals/capture/files/${first.original.files.indexOf(duplicate)}`, f.files.get(`originals/capture/files/${first.original.files.indexOf(image)}`)!, duplicate.mediaType);
    const bytes = canonicalManifestBytes(first.original), request = canonicalManifestBytes({ manifest: first.original, translationIntent: 'none' });
    refresh(f, 'originals/capture/manifest.json', bytes); refresh(f, 'originals/capture/request.json', request);
    Object.assign((f.manifest as any).originals.capture, { manifestSha256: hash(bytes), requestSha256: hash(request) });
  }
  const groups = [{ original: first.original, prefix: 'originals/capture', shared: false }];
  if (hasReader) {
    const second = structuredClone(first.original);
    second.captureId = '55555555-5555-4555-8555-555555555555';
    second.files.reverse();
    for (const [index, file] of second.files.entries()) file.path = 'r'.repeat(210) + String(index).padStart(5, '0') + '.data';
    const bytes = canonicalManifestBytes(second), request = canonicalManifestBytes({ manifest: second, translationIntent: 'none' });
    add('originals/reader-capture/manifest.json', bytes, 'application/json'); add('originals/reader-capture/request.json', request, 'application/json');
    const sharedFiles = mode === 'shared' ? second.files.map(file => ({ id: file.id, sourceFileId: file.id })) : [];
    if (mode !== 'shared') for (const file of second.files) {
      const originalFile = first.original.files.find(source => source.id === file.id)!;
      add(`originals/reader-capture/files/${second.files.indexOf(file)}`, f.files.get(`originals/capture/files/${first.original.files.indexOf(originalFile)}`)!, file.mediaType);
    }
    (f.manifest as any).originals.readerCapture = { manifestSha256: hash(bytes), requestSha256: hash(request), admissionKind: 'upload', sharedFiles, translationSha256: f.manifest.translation!.sha256 };
    groups.push({ original: second, prefix: 'originals/reader-capture', shared: mode === 'shared' });
  }
  for (const group of groups) {
    expect(webCaptureManifestSchema.parse(group.original)).toEqual(group.original);
    const request = createWebCaptureRequestSchema.parse({ manifest: group.original, translationIntent: 'none' });
    expected.set(`${group.prefix}/manifest.json`, canonicalManifestBytes(group.original));
    expected.set(`${group.prefix}/request.json`, canonicalManifestBytes(request));
    if (!group.shared) for (const ordinal of group.original.files.keys()) expected.set(`${group.prefix}/files/${ordinal}`, f.files.get(`${group.prefix}/files/${ordinal}`)!);
  }
  f.files.set('manifest.json', json(f.manifest));
  await bundle.validateWebBundle(source(f), options);
  expect(f.manifest.files.every(file => Buffer.byteLength(file.path) <= defaultBundleLimits.maxPathBytes)).toBe(true);
  const output = join(await temp(), 'long-originals.zip'); await bundle.writeWebBundle(source(f), output, options);
  const archive = bundle.createArchiveFileSource(output, options.limits);
  const validated = await bundle.validateWebBundle(archive, options);
  for (const [path, bytes] of expected) {
    const chunks = []; for await (const chunk of archive.read(path)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    expect(validated.manifest.files.find(file => file.path === path)?.sha256).toBe(hash(bytes));
  }
  expect(validated.manifest.files.filter(file => file.path.startsWith('originals/') && file.path.includes('/files/'))).toHaveLength(groups.reduce((count, group) => count + (group.shared ? 0 : group.original.files.length), 0));
});
