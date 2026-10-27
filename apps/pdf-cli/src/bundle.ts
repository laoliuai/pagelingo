import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { defaultBundleLimits, readerIrSchema, bundleLimitsSchema, type BundleLimits, type DocumentBundleManifest, type ReaderIR } from '@pagelingo/document-contracts';
import { BundleError, createDirectoryFileSource, serializeBundleJson, validateBundle, writeBundle, type BundleFileSource, type BundleIdentity } from '@pagelingo/document-bundle';
import { buildReader } from '@pagelingo/document-renderer';
import type { LocalRun, ManifestEntry } from './local-run.js';
import { sha256, requireInput } from './verified-input.js';
import { OfflineWriter, body } from './offline-export.js';
import { exportTranslation, readExportBytes } from './snapshot.js';

export interface ExportOptions { runDir: string; outputDir: string; archivePath: string }
export interface ExportDependencies { limits?: BundleLimits; signal?: AbortSignal }
export class LocalExportError extends Error {
  constructor(readonly code: 'EXPORT_DESTINATION_UNSAFE' | 'EXPORT_RUN_NOT_READY' | 'EXPORT_FAILED') { super(code); }
}
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
};
/** Resolve even nonexistent tails, including aliases through existing symlink ancestors. */
async function canonicalDestination(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink must not be mistaken for a free destination.
    try { if ((await lstat(absolute)).isSymbolicLink()) throw new LocalExportError('EXPORT_DESTINATION_UNSAFE'); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalDestination(parent), basename(absolute));
  }
}
async function protectDestination(path: string, runDir: string): Promise<string> {
  const target = await canonicalDestination(path);
  if (inside(runDir, target)) throw new LocalExportError('EXPORT_DESTINATION_UNSAFE');
  // External reused inputs deliberately have no absolute paths in LocalRun.
  // Detect their verified format markers through real ancestors instead.
  for (let parent = dirname(target);; parent = dirname(parent)) {
    for (const marker of ['run.json', 'preview.json', 'manifest.json']) {
      try {
        const stat = await lstat(join(parent, marker));
        if (!stat.isFile() || stat.size > defaultBundleLimits.maxManifestBytes) continue;
        const value = JSON.parse(await readFile(join(parent, marker), 'utf8')) as { schemaVersion?: string };
        if (['pagelingo-benchmark-run/1', 'pagelingo-static-preview/0.5', 'pagelingo-static-preview/0.6', 'pagelingo-run-files/1', 'pagelingo-static-preview-files/1', 'pagelingo-local-run/1'].includes(value.schemaVersion ?? '')) throw new LocalExportError('EXPORT_DESTINATION_UNSAFE');
      } catch (error) { if (error instanceof LocalExportError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    if (dirname(parent) === parent) break;
  }
  try { await lstat(target); throw new BundleError('BUNDLE_DESTINATION_EXISTS'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return target;
}

interface CopyRecord {
  originalPath: string; path: string; originalSha256: string; sha256: string;
  mode: 'original' | 'sanitized-copy';
  fields: { pointer: string; original?: string; originalSha256?: string; projected: string | null }[];
}
async function provenance(source: BundleFileSource, ir: ReaderIR, limits: BundleLimits): Promise<Map<string, string>> {
  const read = async (path: string) => readExportBytes(source, path, limits.maxProvenanceFileBytes);
  const inputBytes = await read('provenance/input-manifest.json');
  const previewBytes = await read('provenance/preview-manifest.json');
  requireInput(sha256(inputBytes) === ir.parse.inputManifestSha256 && ir.parse.projectorVersion === `pagelingo-legacy-preview/1+${sha256(previewBytes)}`, 'EXPORT_PROVENANCE_CHANGED');
  const input = JSON.parse(inputBytes.toString()) as { files: ManifestEntry[] };
  const preview = JSON.parse(previewBytes.toString()) as { files: ManifestEntry[] };
  requireInput(Array.isArray(input.files) && Array.isArray(preview.files), 'EXPORT_PROVENANCE_INVALID');
  const ledgerBytes = await read('provenance/copy-ledger.json');
  const ledger = JSON.parse(ledgerBytes.toString()) as { schemaVersion: string; records: CopyRecord[]; exportBlockers: string[] };
  requireInput(ledger.schemaVersion === 'pagelingo-provenance-copies/1' && Array.isArray(ledger.records) && Array.isArray(ledger.exportBlockers) && !ledger.exportBlockers.length, 'EXPORT_PROVENANCE_BLOCKED');
  const expected = new Map<string, string>([
    ['provenance/input-manifest.json', ir.parse.inputManifestSha256],
    ['provenance/preview-manifest.json', sha256(previewBytes)],
    ['provenance/parser-config.json', ir.parse.configSha256],
    ['provenance/copy-ledger.json', sha256(ledgerBytes)],
  ]);
  const originals = new Set([...input.files, ...preview.files].map(file => `${file.path}\0${file.sha256}`));
  for (const record of ledger.records) {
    requireInput(typeof record.path === 'string' && (record.path.startsWith('provenance/') || ir.assets.some(asset => asset.path === record.path)) && !expected.has(record.path), 'EXPORT_PROVENANCE_INVALID');
    requireInput(originals.has(`${record.originalPath}\0${record.originalSha256}`), 'EXPORT_PROVENANCE_INVALID');
    requireInput(record.mode === 'original' && record.sha256 === record.originalSha256 || record.mode === 'sanitized-copy', 'EXPORT_PROVENANCE_INVALID');
    // Projection metadata is distinct from opaque source/code text. Known runtime
    // path originals retained by a local copy ledger cannot enter a complete bundle.
    const absolute = (value: unknown) => typeof value === 'string' && /^(?:\/|[A-Za-z]:[\\/])/.test(value);
    requireInput(!absolute(record.originalPath) && Array.isArray(record.fields) && !record.fields.some(field => absolute(field.original) || absolute(field.projected)), 'EXPORT_RUNTIME_PATH');
    expected.set(record.path, record.sha256);
  }
  for (const path of ['provenance/run.json', 'provenance/raw.json', 'provenance/source-layout.json']) requireInput(expected.has(path), 'EXPORT_PROVENANCE_INCOMPLETE');
  const bindings = await read('provenance/source-bindings.json');
  requireInput(JSON.parse(bindings.toString()).previewManifestSha256 === sha256(previewBytes), 'EXPORT_PROVENANCE_CHANGED');
  expected.set('provenance/source-bindings.json', sha256(bindings));
  return expected;
}
const mediaType = (path: string): string => path.endsWith('.json') ? 'application/json' : path.endsWith('.html') ? 'text/html' : path.endsWith('.txt') ? 'text/plain' : 'application/octet-stream';

/** Export verified local artifacts; never copy run config, mutable checkpoint or credentials. */
export async function exportBundle(options: ExportOptions, deps: ExportDependencies = {}): Promise<BundleIdentity> {
  let outputDir: string | undefined;
  try {
    const limits = bundleLimitsSchema.parse(deps.limits ?? defaultBundleLimits);
    const runDir = await realpath(resolve(options.runDir));
    const targetDir = await protectDestination(options.outputDir, runDir);
    const archivePath = await protectDestination(options.archivePath, runDir);
    if (inside(targetDir, archivePath) || inside(archivePath, targetDir)) throw new LocalExportError('EXPORT_DESTINATION_UNSAFE');
    const source = createDirectoryFileSource(runDir, limits, deps.signal);
    const configBytes = await readExportBytes(source, 'config.json', limits.maxManifestBytes);
    const run = JSON.parse(configBytes.toString('utf8')) as LocalRun;
    if (run.schemaVersion !== 'pagelingo-local-run/1' || run.stage !== 'ready' || !['complete', 'partial'].includes(run.status) || run.exportReady !== true || !Array.isArray(run.exportBlockers) || run.exportBlockers.length) throw new LocalExportError('EXPORT_RUN_NOT_READY');
    const irBytes = await readExportBytes(source, 'source-ir.json', limits.maxIrBytes);
    const ir = readerIrSchema.parse(JSON.parse(irBytes.toString('utf8')));
    const readerIrSha256 = sha256(irBytes);
    requireInput(readerIrSha256 === run.readerIrSha256 && ir.source.sha256 === run.sourceSha256 && ir.parse.id === run.parseId && ir.parse.configSha256 === run.configSha256, 'EXPORT_INPUT_CHANGED');
    const evidence = await provenance(source, ir, limits);
    const snapshot = await exportTranslation(runDir, source, ir, readerIrSha256, limits.maxTranslationBytes);
    const translation = snapshot.translation;
    const translationBytes = serializeBundleJson(translation);
    await mkdir(targetDir, { mode: 0o700 }); outputDir = targetDir;
    const writer = new OfflineWriter(outputDir, limits, deps.signal);
    await writer.write('source.pdf', 'application/pdf', 'source', source.read('source.pdf'), ir.source);
    await writer.write('source-ir.json', 'application/json', 'reader-ir', body(irBytes), { sha256: readerIrSha256 });
    await writer.write('translation.json', 'application/json', 'translation', body(translationBytes));
    for (const [path, digest] of evidence) {
      const asset = ir.assets.find(asset => asset.path === path);
      await writer.write(path, asset?.mediaType ?? mediaType(path), asset ? 'asset' : 'provenance', source.read(path), { sha256: digest, ...(asset ? { bytes: asset.bytes } : {}) });
    }
    for (const asset of ir.assets) requireInput(writer.files.some(file => file.path === asset.path && file.sha256 === asset.sha256 && file.bytes === asset.bytes), 'EXPORT_ASSET_MISSING');
    const renderer = await writer.staticFiles(buildReader(ir, translation), { title: ir.metadata.title, originalFilename: ir.metadata.originalFilename });
    const manifest: DocumentBundleManifest = {
      schemaVersion: 'pagelingo-document-bundle/1', packageId: randomUUID(), createdAt: new Date().toISOString(),
      title: ir.metadata.title, originalFilename: ir.metadata.originalFilename, source: ir.source,
      parse: { id: ir.parse.id, inputManifestSha256: ir.parse.inputManifestSha256, projectorVersion: ir.parse.projectorVersion, configSha256: ir.parse.configSha256 },
      readerIrSha256, translation: { id: translation.id, sha256: sha256(translationBytes), status: translation.status, generationKind: translation.generationKind }, renderer,
      files: [...writer.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    };
    await writer.write('manifest.json', 'application/json', 'render', body(serializeBundleJson(manifest)));
    const staged = createDirectoryFileSource(outputDir, limits, deps.signal);
    await validateBundle(staged, { limits, signal: deps.signal });
    // Re-read originals after generation; a changed run cannot silently publish.
    for (const file of writer.files.filter(file => file.role !== 'render' && file.role !== 'license' && file.path !== 'translation.json' && (file.role !== 'asset' || ir.assets.some(asset => asset.path === file.path)))) {
      const hash = createHash('sha256');
      for await (const part of source.read(file.path)) hash.update(part);
      requireInput(hash.digest('hex') === file.sha256, 'EXPORT_INPUT_CHANGED');
    }
    requireInput(sha256(await readExportBytes(source, 'config.json', limits.maxManifestBytes)) === sha256(configBytes), 'EXPORT_INPUT_CHANGED');
    if (snapshot.original) requireInput(sha256(await readExportBytes(source, snapshot.original.path, limits.maxTranslationBytes)) === snapshot.original.sha256, 'EXPORT_TRANSLATION_CHANGED');
    return await writeBundle(staged, archivePath, { limits, signal: deps.signal });
  } catch (error) {
    if (outputDir) await writeFile(join(outputDir, 'export-failure.json'), serializeBundleJson({ status: 'failed', code: error instanceof BundleError || error instanceof LocalExportError ? error.code : 'EXPORT_FAILED' }), { flag: 'wx', mode: 0o600 }).catch(() => {});
    if (error instanceof BundleError || error instanceof LocalExportError) throw error;
    throw new LocalExportError('EXPORT_FAILED');
  }
}
