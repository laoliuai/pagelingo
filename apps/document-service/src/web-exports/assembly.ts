import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defaultBundleLimits, defaultCaptureLimits, webCaptureManifestSchema, webReaderIrSchema, webTranslationSchema, webReaderIndexSchema, webReaderChunkSchema, type BundleFile } from '@pagelingo/document-contracts';
import { resolveTrustedWebCatalog } from '@pagelingo/document-renderer';
import { writeWebBundle } from '@pagelingo/document-bundle';
import { createLocalObjectStore } from '../storage/local-object-store.js';
import { readWebAsset } from '../web-readers/assets.js';
import type { WebAssetRow } from '../web-readers/repository.js';
export interface ExportMaterial {
  contentFingerprint: string; packageId: string; title: string; createdAt: string; rendererVersion: string; rendererSha256: string;
  manifest: WebAssetRow; ir: WebAssetRow; translation: WebAssetRow | null; index: WebAssetRow;
  chunks: WebAssetRow[]; source: Array<WebAssetRow & { local_id: string; path: string }>;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Isolated worker only. Every input is a previously registered, selected immutable asset. */
export async function assembleWebExport(material: ExportMaterial, dataDir: string, destination: string, signal: AbortSignal): Promise<void> {
  const store = createLocalObjectStore(dataDir), files = new Map<string, Uint8Array>(), entries: BundleFile[] = [];
  let total = 0;
  async function read(asset: WebAssetRow, ceiling: number) {
    signal.throwIfAborted();
    if (Number(asset.bytes) > ceiling || (total += Number(asset.bytes)) > defaultBundleLimits.maxExpandedBytes) throw Error('Export input limit');
    return readWebAsset(store,asset);
  }
  const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(bytes));
  function add(path: string, bytes: Uint8Array, mediaType: string, role: BundleFile['role']) {
    if (files.has(path)) throw Error('Duplicate export path');
    files.set(path,bytes); entries.push({ path, bytes: bytes.byteLength, sha256: hash(bytes), mediaType, role });
  }
  const manifestBytes = await read(material.manifest,defaultCaptureLimits.maxIrBytes);
  const capture = webCaptureManifestSchema.parse(json(manifestBytes));
  add('source/manifest.json',manifestBytes,'application/json','source');
  let sourceBytes = 0;
  for (const file of capture.files) {
    const asset = material.source.find(a => a.local_id === file.id);
    if (!asset || asset.path !== file.path || asset.sha256 !== file.sha256 || Number(asset.bytes) !== file.bytes || asset.media_type !== file.mediaType) throw Error('Source binding mismatch');
    sourceBytes += file.bytes;
    if (sourceBytes > defaultCaptureLimits.maxTotalBytes) throw Error('Source total limit');
    add(`source/${file.path}`,await read(asset,file.role === 'html' ? defaultCaptureLimits.maxHtmlBytes : defaultCaptureLimits.maxResourceBytes),file.mediaType,'source');
  }
  const irBytes = await read(material.ir,defaultCaptureLimits.maxIrBytes), ir = webReaderIrSchema.parse(json(irBytes));
  add('source-ir.json',irBytes,'application/json','reader-ir');
  const translated = material.translation ? await read(material.translation,defaultBundleLimits.maxTranslationBytes) : null;
  const translation = translated ? webTranslationSchema.parse(json(translated)) : null;
  if (translated) add('translation.json',translated,'application/json','translation');
  const index = webReaderIndexSchema.parse(json(await read(material.index,defaultCaptureLimits.maxIrBytes)));
  const chunks = [];
  for (const asset of material.chunks) chunks.push(webReaderChunkSchema.parse(json(await read(asset,defaultCaptureLimits.maxIrBytes))));
  chunks.sort((a,b) => index.chunks.findIndex(c => c.id === a.id) - index.chunks.findIndex(c => c.id === b.id));
  const catalog = resolveTrustedWebCatalog(material.rendererVersion,material.rendererSha256);
  const require = createRequire(import.meta.url);
  for (const asset of catalog.trustedAssets) {
    const bytes = await readFile(join(dirname(require.resolve(`${asset.source.package}/package.json`)),asset.source.path));
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw Error('Trusted catalog mismatch');
    add(asset.path,bytes,asset.mediaType,asset.path.startsWith('licenses/') ? 'license' : 'asset');
  }
  const previewIds = new Set(capture.snapshots.previews.flatMap(p => p.resourceFileIds));
  const input = { ir,translation,index,chunks,capture,assets: ir.assets.map(a => ({ ...a,path: `source/${a.path}` })),
    previews: capture.snapshots.previews.map(p => { const file = capture.files.find(f => f.id === p.fileId)!; return { fileId: file.id,html: new TextDecoder('utf-8',{ fatal: true }).decode(files.get(`source/${file.path}`)!) }; }),
    previewImages: capture.files.filter(f => f.role === 'image' && previewIds.has(f.id)).map(f => ({ fileId: f.id,data: files.get(`source/${f.path}`)! })) };
  for (const generated of catalog.generateFiles(input)) {
    signal.throwIfAborted(); const bytes = Buffer.from(generated.content);
    total += bytes.length; if (total > defaultBundleLimits.maxExpandedBytes) throw Error('Generated total limit');
    add(generated.path,bytes,generated.mediaType,'render');
  }
  files.set('manifest.json',Buffer.from(JSON.stringify({ schemaVersion: 'pagelingo-web-document-bundle/1',packageId: material.packageId,createdAt: material.createdAt,title: material.title,
    source: { manifestPath: 'source/manifest.json',manifestSha256: hash(manifestBytes),snapshotSha256: ir.source.snapshotSha256,contentFingerprint: material.contentFingerprint },
    parse: { id: ir.parse.id,readerIrSha256: hash(irBytes) },translation: translation && translated ? { path: 'translation.json',sha256: hash(translated),status: translation.status,generationKind: translation.generationKind } : null,
    renderer: { version: material.rendererVersion,codeSha256: material.rendererSha256 },files: entries })));
  await writeWebBundle({ async list() { return [...files].map(([path,bytes]) => ({ path,bytes: bytes.length })); }, async *read(path) { const bytes = files.get(path); if (!bytes) throw Error('Missing member'); yield bytes; } },destination,{ signal,limits: defaultBundleLimits });
}
