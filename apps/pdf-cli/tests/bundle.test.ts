import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { createArchiveFileSource, validateBundle } from '@pagelingo/document-bundle';
import { exportBundle } from '../src/bundle.js';
import { OfflineWriter } from '../src/offline-export.js';
import { processPdf, translateRun } from '../src/index.js';
import { fixture, hash, manifest } from './fixtures/legacy-preview/create.js';
import { echo, english, providerConfig, readyRun } from './translation-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(body?: string) {
  const f = await readyRun(body); roots.push(f.root);
  return { ...f, outputDir: join(f.root, 'bundle'), archivePath: join(f.root, 'bundle.zip') };
}
async function bundled(f: Awaited<ReturnType<typeof setup>>) {
  const identity = await exportBundle(f);
  const result = await validateBundle(createArchiveFileSource(f.archivePath, defaultBundleLimits), { limits: defaultBundleLimits });
  expect(result.packageId).toBe(identity.packageId);
  expect(result.manifestSha256).toBe(identity.manifestSha256);
  return result;
}

describe('complete offline bundle export', () => {
  it('exports an exact original, verified provenance and manifest-covered offline resources without translation setup', async () => {
    const f = await setup(`<h1>Introduction</h1><p>${english}</p><p>中文引语</p>`);
    const result = await bundled(f);
    expect(await readFile(join(f.outputDir, 'source.pdf'))).toEqual(await readFile(f.sourcePath));
    const files = (await readdir(f.outputDir, { recursive: true, withFileTypes: true })).filter(file => file.isFile());
    expect(files).toHaveLength(result.manifest.files.length + 1);
    expect(result.manifest.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'source.pdf', 'source-ir.json', 'translation.json', 'provenance/input-manifest.json',
      'provenance/parser-config.json', 'provenance/raw.json', 'provenance/source-layout.json',
      'render/index.html', 'render/data/index.js', 'render/data/c_000001.js',
      'assets/offline-runtime.js', 'assets/reader.css', 'assets/katex/katex.min.css', 'licenses/katex.txt',
    ]));
    expect(result.translation.status).toBe('pending');
    expect(result.translation.generationKind).toBe('none');
    expect(result.translation.units.some(unit => unit.status === 'pending')).toBe(true);
    expect(result.manifest.files.every(file => !/checkpoint|job\.json|config\.json$/.test(file.path) || file.path === 'provenance/parser-config.json')).toBe(true);
    expect(await readFile(join(f.outputDir, 'manifest.json'), 'utf8')).not.toContain(f.root);
  });

  it('exports Chinese-only text as not-required', async () => {
    const f = await setup('<h1>中文论文</h1><p>中文内容，不需要翻译。</p>');
    const result = await bundled(f);
    expect(result.translation.status).toBe('not-required');
    expect(result.translation.selectionBlockIds).toEqual([]);
  });

  it('derives new identities on every export and leaves the immutable local snapshot unchanged', async () => {
    const f = await setup();
    const local = await translateRun({ runDir: f.runDir, provider: providerConfig, selection: 'auto', resume: false, newJob: false }, { provider: { generate: async request => echo(request) } });
    const before = await readFile(join(f.runDir, local.snapshotPath));
    const first = await bundled(f);
    const secondDir = join(f.root, 'second'); const secondZip = join(f.root, 'second.zip');
    await exportBundle({ runDir: f.runDir, outputDir: secondDir, archivePath: secondZip });
    const second = await validateBundle(createArchiveFileSource(secondZip, defaultBundleLimits), { limits: defaultBundleLimits });
    expect(new Set([local.snapshot.id, first.translation.id, second.translation.id]).size).toBe(3);
    expect(second.packageId).not.toBe(first.packageId);
    expect(first.translation.blocks).toEqual(local.snapshot.blocks);
    expect(await readFile(join(f.runDir, local.snapshotPath))).toEqual(before);
  }, 20000);

  it('exports a partial durable translation without claiming full translation', async () => {
    const f = await setup(); let calls = 0;
    const local = await translateRun({ runDir: f.runDir, provider: providerConfig, selection: 'auto', resume: false, newJob: false, budget: { maxBatchBlocks: 1 }, maxRetries: 0 }, { provider: { generate: async request => {
      if (++calls > 1) throw new Error('fixture failure'); return echo(request);
    } } });
    expect(local.snapshot.status).toBe('partial');
    const result = await bundled(f);
    expect(result.translation.status).toBe('partial');
    expect(result.translation.generationKind).toBe('mock');
    expect(result.translation.units.some(unit => unit.status === 'failed')).toBe(true);
  });

  it('rejects a corrupt current snapshot instead of silently exporting as untranslated', async () => {
    const f = await setup();
    const local = await translateRun({ runDir: f.runDir, provider: providerConfig, selection: 'none', resume: false, newJob: false });
    await writeFile(join(f.runDir, local.snapshotPath), '{}');
    await expect(exportBundle(f)).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    await expect(readFile(f.archivePath)).rejects.toThrow();
  });

  it('rechecks the selected original snapshot before ZIP publication', async () => {
    const f = await setup();
    const local = await translateRun({ runDir: f.runDir, provider: providerConfig, selection: 'none', resume: false, newJob: false });
    const original = OfflineWriter.prototype.staticFiles;
    vi.spyOn(OfflineWriter.prototype, 'staticFiles').mockImplementationOnce(async function (this: OfflineWriter, ...args) {
      const result = await original.apply(this, args);
      await writeFile(join(f.runDir, local.snapshotPath), '{}');
      return result;
    });
    await expect(exportBundle(f)).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    await expect(readFile(f.archivePath)).rejects.toThrow();
  });

  it('preserves partial parse missing pages and untranslated unit truth', async () => {
    const f = await fixture(); roots.push(f.root);
    const metadata = JSON.parse(await readFile(join(f.run, 'run.json'), 'utf8'));
    metadata.sourcePageCount = 2; metadata.status = 'partial'; metadata.requestedPageIndices = [0, 1];
    await writeFile(join(f.run, 'run.json'), JSON.stringify(metadata)); await manifest(f.run, 'pagelingo-run-files/1');
    const preview = JSON.parse(await readFile(join(f.preview, 'preview.json'), 'utf8'));
    Object.assign(preview, { sourcePageCount: 2, sourceStatus: 'partial', requestedPageIndices: [0, 1], sourceManifestSha256: hash(await readFile(join(f.run, 'manifest.json'))) });
    await writeFile(join(f.preview, 'preview.json'), JSON.stringify(preview)); await manifest(f.preview, 'pagelingo-static-preview-files/1');
    await processPdf({ ...f, p0RunDir: f.run, previewDir: f.preview }, { inspectPdf: async () => ({ ...f.inspection, pages: [f.inspection.pages[0], { ...f.inspection.pages[0], pageIndex: 1 }] }) });
    const archivePath = join(f.root, 'partial.zip');
    await exportBundle({ runDir: f.runDir, outputDir: join(f.root, 'partial'), archivePath });
    const result = await validateBundle(createArchiveFileSource(archivePath, defaultBundleLimits), { limits: defaultBundleLimits });
    expect(result.readerBuild.index.parseCoverage).toBe('partial');
    expect(result.ir.parse.parsedPageIndices).toEqual([0]);
    expect(result.translation.status).toBe('pending');
    expect(result.translation.units.some(unit => unit.status === 'pending')).toBe(true);
    expect(result.readerBuild.index.warnings.length).toBeGreaterThan(0);
  });

  it.each(['directory', 'archive'])('never overwrites an existing %s', async kind => {
    const f = await setup();
    if (kind === 'directory') await mkdir(f.outputDir); else await writeFile(f.archivePath, 'keep');
    await expect(exportBundle(f)).rejects.toMatchObject({ code: 'BUNDLE_DESTINATION_EXISTS' });
    if (kind === 'archive') expect(await readFile(f.archivePath, 'utf8')).toBe('keep');
  });

  it.each(['run', 'p0', 'preview'])('rejects destinations inside original %s input', async kind => {
    const f = await setup();
    await expect(exportBundle({ ...f, outputDir: join(kind === 'run' ? f.runDir : kind === 'p0' ? f.run : f.preview, 'forbidden') })).rejects.toMatchObject({ code: 'EXPORT_DESTINATION_UNSAFE' });
  });

  it.each(['outputDir', 'archivePath'] as const)('rejects symlink ancestors and nonexistent tails into original inputs for %s', async field => {
    const f = await setup();
    const alias = join(f.root, 'alias'); await symlink(f.preview, alias);
    await expect(exportBundle({ ...f, [field]: join(alias, 'missing', 'nested', 'forbidden') })).rejects.toMatchObject({ code: 'EXPORT_DESTINATION_UNSAFE' });
    await expect(readFile(join(f.preview, 'missing/nested/forbidden'))).rejects.toThrow();
  });

  it('rejects overlapping directory/archive destinations', async () => {
    const f = await setup();
    await expect(exportBundle({ ...f, archivePath: join(f.outputDir, 'bundle.zip') })).rejects.toMatchObject({ code: 'EXPORT_DESTINATION_UNSAFE' });
  });

  it('enforces capacity and cancellation without publishing a ZIP', async () => {
    const f = await setup();
    await expect(exportBundle(f, { limits: { ...defaultBundleLimits, maxExpandedBytes: 2000 } })).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
    await expect(readFile(f.archivePath)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(exportBundle({ ...f, outputDir: join(f.root, 'cancelled') }, { signal: controller.signal })).rejects.toMatchObject({ code: 'BUNDLE_ABORTED' });
    await expect(readFile(f.archivePath)).rejects.toThrow();
  });

  it.each(['source.pdf', 'source-ir.json', 'provenance/raw.json'])('rejects changed immutable %s', async path => {
    const f = await setup(); await writeFile(join(f.runDir, path), 'changed');
    await expect(exportBundle(f)).rejects.toThrow();
    await expect(readFile(f.archivePath)).rejects.toThrow();
  });

  it('rejects missing display images', async () => {
    const f = await fixture(); roots.push(f.root);
    await processPdf({ ...f, p0RunDir: f.run, previewDir: f.preview }, { inspectPdf: async () => f.inspection });
    const ir = JSON.parse(await readFile(join(f.runDir, 'source-ir.json'), 'utf8'));
    await unlink(join(f.runDir, ir.assets[0].path));
    await expect(exportBundle({ ...f, outputDir: join(f.root, 'bad'), archivePath: join(f.root, 'bad.zip') })).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  });

  it.each(['apiKey', 'absolutePath'])('enforces export blockers for %s metadata', async kind => {
    const f = await fixture(); roots.push(f.root);
    const meta = JSON.parse(await readFile(join(f.run, 'run.json'), 'utf8'));
    meta.worker.config[kind] = kind === 'apiKey' ? 'sk-fixture-NEVER-EXPORT' : '/private/run/runtime';
    await writeFile(join(f.run, 'run.json'), JSON.stringify(meta)); await manifest(f.run, 'pagelingo-run-files/1');
    const pm = JSON.parse(await readFile(join(f.preview, 'preview.json'), 'utf8'));
    pm.sourceManifestSha256 = hash(await readFile(join(f.run, 'manifest.json')));
    await writeFile(join(f.preview, 'preview.json'), JSON.stringify(pm)); await manifest(f.preview, 'pagelingo-static-preview-files/1');
    const run = await processPdf({ ...f, p0RunDir: f.run, previewDir: f.preview }, { inspectPdf: async () => f.inspection });
    expect(run.exportReady).toBe(false);
    await expect(exportBundle({ ...f, outputDir: join(f.root, 'bad'), archivePath: join(f.root, 'bad.zip') })).rejects.toMatchObject({ code: 'EXPORT_RUN_NOT_READY' });
  });

  it('rejects absolute runtime values retained in known provenance ledger fields', async () => {
    const f = await fixture(); roots.push(f.root);
    const meta = JSON.parse(await readFile(join(f.run, 'run.json'), 'utf8'));
    meta.debug = '/private/parser/debug.html';
    await writeFile(join(f.run, 'run.json'), JSON.stringify(meta)); await manifest(f.run, 'pagelingo-run-files/1');
    const pm = JSON.parse(await readFile(join(f.preview, 'preview.json'), 'utf8'));
    pm.sourceManifestSha256 = hash(await readFile(join(f.run, 'manifest.json')));
    await writeFile(join(f.preview, 'preview.json'), JSON.stringify(pm)); await manifest(f.preview, 'pagelingo-static-preview-files/1');
    const run = await processPdf({ ...f, p0RunDir: f.run, previewDir: f.preview }, { inspectPdf: async () => f.inspection });
    expect(run.exportReady).toBe(true);
    // Existing older runs may retain this value. Do not silently rewrite them.
    const ledgerPath = join(f.runDir, 'provenance/copy-ledger.json');
    const oldLedger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    oldLedger.records.find((record: { path: string }) => record.path === 'provenance/run.json').fields = [
      { pointer: '/debug', original: meta.debug, projected: null },
    ];
    await writeFile(ledgerPath, JSON.stringify(oldLedger));
    await expect(exportBundle({ ...f, outputDir: join(f.root, 'bad'), archivePath: join(f.root, 'bad.zip') })).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
  });

  it('projects known absolute debug metadata and preserves source code path examples', async () => {
    const f = await fixture(`<article class="docvortex-document"><p>${english}</p><pre><code>/usr/bin/python --version</code></pre></article>`); roots.push(f.root);
    const meta = JSON.parse(await readFile(join(f.run, 'run.json'), 'utf8'));
    meta.debug = '/private/parser/debug.html';
    await writeFile(join(f.run, 'run.json'), JSON.stringify(meta)); await manifest(f.run, 'pagelingo-run-files/1');
    const pm = JSON.parse(await readFile(join(f.preview, 'preview.json'), 'utf8'));
    pm.sourceManifestSha256 = hash(await readFile(join(f.run, 'manifest.json')));
    await writeFile(join(f.preview, 'preview.json'), JSON.stringify(pm)); await manifest(f.preview, 'pagelingo-static-preview-files/1');
    await processPdf({ ...f, p0RunDir: f.run, previewDir: f.preview }, { inspectPdf: async () => f.inspection });
    const outputDir = join(f.root, 'portable'); const archivePath = join(f.root, 'portable.zip');
    await exportBundle({ runDir: f.runDir, outputDir, archivePath });
    const ledger = await readFile(join(outputDir, 'provenance/copy-ledger.json'), 'utf8');
    expect(ledger).not.toContain(meta.debug);
    expect(ledger).toContain(hash(meta.debug));
    expect(await readFile(join(outputDir, 'source-ir.json'), 'utf8')).toContain('/usr/bin/python --version');
    expect(await readFile(join(f.run, 'run.json'), 'utf8')).toContain(meta.debug);
  });
});
