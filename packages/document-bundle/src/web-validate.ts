import { validateWebOriginals } from './web-originals.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { defaultCaptureLimits, webCaptureManifestSchema, webReaderIrSchema, webTranslationSchema, naturalText, type WebReaderIR, type WebTranslation, type WebReaderAsset } from '@pagelingo/document-contracts';
import { contentHash, stableJson } from '@pagelingo/translation-core';
import { sanitizeNodeSnapshot, replayResourcesFromManifest, inspectImageResource, projectWebReader, captureContentFingerprint, PROJECTOR_VERSION } from '@pagelingo/web-capture/node';
import { buildWebReader, resolveTrustedWebCatalog } from '@pagelingo/document-renderer';
import { check, aborted, sanitize } from './errors.js';
import { checkedLimits, checkSize, fileLimit, parseBoundedJson } from './limits.js';
import { PathRegistry } from './paths.js';
import { digestFile } from './file-reader.js';
import { createDirectoryFileSource } from './file-source.js';
import { admitWebManifest, webFileLimit } from './web-manifest.js';
import { validationDeadlineMs } from './validate.js';
import type { BundleFileSource, BundleOptions, BundleLimits, ValidatedWebBundle } from './types.js';
const require = createRequire(import.meta.url);
const hash = (body: Uint8Array | string): string => createHash('sha256').update(body).digest('hex');
const decode = (body: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(body);
/** Verify every member before replaying source projection, SDK proof and trusted static output. */
export async function validateWebBundle(input: BundleFileSource, options: BundleOptions): Promise<ValidatedWebBundle> {
  const started = performance.now(), { signal } = options;
  const tick = (): void => { aborted(signal); check(performance.now() - started <= validationDeadlineMs, 'BUNDLE_TOO_LARGE'); };
  const checkpoint = async (): Promise<void> => { await setImmediate(); tick(); };
  try {
    const limits = checkedLimits(options.limits); await checkpoint();
    const listed = await input.list(); await checkpoint(); check(Array.isArray(listed)); checkSize(listed.length, limits.maxFiles);
    const paths = new PathRegistry(limits.maxPathBytes); let declared = 0, expanded = 0;
    for (const file of listed) { check(file && typeof file.path === 'string'); paths.add(file.path); checkSize(file.bytes, webFileLimit(file.path, limits)); declared += file.bytes; checkSize(declared, limits.maxExpandedBytes); }
    const manifestInfo = listed.find(f => f.path === 'manifest.json'); check(manifestInfo, 'BUNDLE_MISSING_RESOURCE');
    const account = (n: number): void => { tick(); expanded += n; checkSize(expanded, limits.maxExpandedBytes); };
    const manifestBody = await digestFile(input, manifestInfo, limits, account, true, signal);
    const manifest = admitWebManifest(parseBoundedJson(manifestBody.body!, limits.maxJsonDepth), listed, limits);
    const bodies = new Map<string, Buffer>();
    for (const file of manifest.files) {
      await checkpoint(); const collect = ['source/manifest.json', 'source-ir.json', 'translation.json'].includes(file.path);
      let actualBytes = 0;
      const actual = await digestFile(input, file, limits, n => { actualBytes += n; checkSize(actualBytes, webFileLimit(file.path, limits)); account(n); }, collect, signal);
      check(actual.sha256 === file.sha256); if (collect) bodies.set(file.path, actual.body!);
    }
    const sourceBody = bodies.get('source/manifest.json')!, irBody = bodies.get('source-ir.json')!;
    const source = webCaptureManifestSchema.parse(parseBoundedJson(sourceBody, limits.maxJsonDepth));
    const ir = webReaderIrSchema.parse(parseBoundedJson(irBody, limits.maxJsonDepth));
    const translation = manifest.translation ? webTranslationSchema.parse(parseBoundedJson(bodies.get('translation.json')!, limits.maxJsonDepth)) : null;
    check(ir.parse.projectorVersion === PROJECTOR_VERSION && ir.parse.configSha256 === await contentHash(defaultCaptureLimits), 'BUNDLE_UNSUPPORTED_SOURCE');
    checkWebReaderLimits(ir, translation, limits);
    const members = new Map(manifest.files.map(f => [f.path, f])), allowed = new Set(['source/manifest.json', 'source-ir.json', ...(translation ? ['translation.json'] : [])]);
    // The capture schema bounds the aggregate source to 64 MiB. Read only its admitted
    // members again, with their actual hashes, before retaining any raw preview/image.
    const originals = new Map<string, Buffer>(); let sourceTotal = 0;
    for (const file of source.files) {
      const path = `source/${file.path}`, member = members.get(path);
      check(!allowed.has(path)); check(member, 'BUNDLE_MISSING_RESOURCE');
      check(member.role === 'source' && member.bytes === file.bytes && member.sha256 === file.sha256 && member.mediaType === file.mediaType);
      allowed.add(path);
    }
    for (const file of source.files) {
      await checkpoint(); let bytes = 0;
      const actual = await digestFile(input, { ...file, path: `source/${file.path}` }, limits, n => {
        tick(); bytes += n; sourceTotal += n;
        checkSize(bytes, file.role === 'html' ? defaultCaptureLimits.maxHtmlBytes : file.role === 'preview' ? defaultCaptureLimits.maxPreviewHtmlBytes : defaultCaptureLimits.maxResourceBytes);
        checkSize(sourceTotal, defaultCaptureLimits.maxTotalBytes);
      }, true, signal);
      check(actual.sha256 === file.sha256); originals.set(file.id, actual.body!);
    }
    const snapshot = sanitizeNodeSnapshot({ html: decode(originals.get(source.htmlFileId)!), url: source.source.url, scope: source.scope }, undefined, replayResourcesFromManifest(source).filter(r => r.role === 'image'));
    check(hash(snapshot.html) === manifest.source.snapshotSha256);
    check(await captureContentFingerprint(snapshot, source.resources, source.files) === manifest.source.contentFingerprint);
    const assets: WebReaderAsset[] = [];
    for (const file of source.files) if (file.role === 'image') {
      await checkpoint(); const asset = await inspectImageResource(originals.get(file.id)!, file);
      checkSize(asset.width, limits.maxImageDimension); checkSize(asset.height, limits.maxImageDimension); checkSize(asset.width * asset.height, limits.maxImagePixels); assets.push(asset);
    }
    await checkpoint();
    const projected = await projectWebReader(snapshot, source, { manifestBytes: sourceBody, assets });
    check(stableJson(projected) === stableJson(ir));
    check(manifest.parse.id === ir.parse.id && manifest.source.manifestSha256 === ir.source.manifestSha256 && manifest.source.snapshotSha256 === ir.source.snapshotSha256);
    if (translation) {
      check(translation.readerIrSha256 === hash(irBody) && translation.status === manifest.translation!.status && translation.generationKind === manifest.translation!.generationKind);
      if (translation.generationKind === 'import') {
        check(translation.sourceContentFingerprint === manifest.source.contentFingerprint);
        for (const proof of translation.blocks) check(hash(naturalText(proof.source.content)) === proof.sourceTextSha256);
      } else check(await contentHash(translation.glossary) === translation.glossarySha256);
    }
    await checkpoint(); const readerBuild = buildWebReader(ir, translation); await checkpoint();
    const catalog = resolveTrustedWebCatalog(manifest.renderer.version, manifest.renderer.codeSha256);
    const previewIds = new Set(source.snapshots.previews.flatMap(p => p.resourceFileIds));
    const staticInput = { ir, translation, ...readerBuild, capture: source, assets: assets.map(a => ({ ...a, path: `source/${a.path}` })),
      previews: source.files.filter(f => f.role === 'preview').map(f => ({ fileId: f.id, html: decode(originals.get(f.id)!) })),
      previewImages: source.files.filter(f => f.role === 'image' && previewIds.has(f.id)).map(f => ({ fileId: f.id, data: originals.get(f.id)! })) };
    let generatedTotal = 0;
    for (const asset of catalog.trustedAssets) {
      await checkpoint(); const file = members.get(asset.path); check(file, 'BUNDLE_MISSING_RESOURCE'); check(!allowed.has(asset.path));
      check(file.role === (asset.path.startsWith('licenses/') ? 'license' : 'asset') && file.mediaType === asset.mediaType && file.bytes === asset.bytes && file.sha256 === asset.sha256);
      const installed = createDirectoryFileSource(dirname(require.resolve(`${asset.source.package}/package.json`)), limits, signal);
      const actual = await digestFile(installed, { path: asset.source.path, bytes: asset.bytes }, limits, n => { tick(); generatedTotal += n; checkSize(generatedTotal, limits.maxExpandedBytes); }, false, signal);
      check(actual.sha256 === asset.sha256); allowed.add(asset.path);
    }
    const iterator = catalog.generateFiles(staticInput)[Symbol.iterator]();
    try {
      for (;;) {
        await checkpoint(); const next = iterator.next(); await checkpoint(); if (next.done) break;
        const generated = next.value, bytes = Buffer.from(generated.content), file = members.get(generated.path);
        checkSize(bytes.length, fileLimit(generated.path, limits)); generatedTotal += bytes.length; checkSize(generatedTotal, limits.maxExpandedBytes);
        check(file, 'BUNDLE_MISSING_RESOURCE'); check(!allowed.has(generated.path));
        check(file.role === 'render' && file.mediaType === generated.mediaType && file.bytes === bytes.length && file.sha256 === hash(bytes)); allowed.add(file.path);
      }
    } finally { iterator.return?.(); }
    await validateWebOriginals(input, manifest, source, translation, limits, allowed, tick, signal);
    check(manifest.files.every(f => allowed.has(f.path))); await checkpoint();
    return { packageId: manifest.packageId, manifestSha256: manifestBody.sha256, manifest, source, ir, translation, readerBuild, files: manifest.files };
  } catch (error) { throw sanitize(error, signal); }
}
function checkWebReaderLimits(ir: WebReaderIR, translation: WebTranslation | null, limits: BundleLimits): void {
  checkSize(ir.nodes.length, limits.maxNodes); checkSize(ir.blocks.length, limits.maxBlocks);
  const nodes = new Map(ir.nodes.map(n => [n.id, n])), visited = new Set<string>(), stack = ir.roots.map(id => ({ id, depth: 1 }));
  while (stack.length) { const { id, depth } = stack.pop()!; checkSize(depth, limits.maxDepth); check(!visited.has(id)); visited.add(id); const node = nodes.get(id); check(node); for (const id of node.children) stack.push({ id, depth: depth + 1 }); }
  const bytes = (text: string, max: number): void => checkSize(Buffer.byteLength(text), max);
  for (const block of ir.blocks) {
    if (block.type === 'code') bytes(block.code, limits.maxCodeBytes);
    if (block.type === 'math' && block.latex !== null) bytes(block.latex, limits.maxLatexBytes);
    if (block.type === 'text') {
      let total = 0; const pending = block.value.content.map(value => ({ value, depth: 1 }));
      while (pending.length) { const { value, depth } = pending.pop()!; checkSize(depth, limits.maxDepth); if (value.type === 'format') for (const child of value.children) pending.push({ value: child, depth: depth + 1 }); else { total += Buffer.byteLength(value.type === 'text' ? value.text : value.source); checkSize(total, limits.maxTextBytes); } }
      for (const binding of block.bindings) if (binding.kind === 'protected') { const object = binding.object; if (object.type === 'math') bytes(object.latex, limits.maxLatexBytes); else if (object.type === 'code') bytes(object.text, limits.maxCodeBytes); else if (object.type === 'literal') bytes(object.text, limits.maxTextBytes); }
    }
  }
  if (translation?.generationKind === 'import') for (const proof of translation.blocks) bytes(proof.rawText, limits.maxTextBytes);
  else if (translation) { for (const block of translation.blocks) if (block.status === 'translated') bytes(block.rawText, limits.maxTextBytes); for (const unit of translation.units) if (unit.status === 'completed') bytes(unit.rawText, limits.maxTextBytes); }
}
