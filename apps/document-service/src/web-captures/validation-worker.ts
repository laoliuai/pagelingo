import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { webCaptureManifestSchema, webReaderIrSchema, type WebReaderAsset, type WebReaderIR, type WebImportedTranslation } from '@pagelingo/document-contracts';
import { sanitizeNodeSnapshot, extractPublicArticle } from '@pagelingo/web-capture/node';
import { canonicalManifestBytes, sha256, normalizeCaptureUrl, replayResourcesFromManifest, captureContentFingerprint, buildSnapshotPreviews, inspectImageResource, projectWebReader } from '@pagelingo/web-capture';
import { importCandidates } from './candidates.js';
import { buildWebReader, buildWebImportedReader } from '@pagelingo/document-renderer';
import type { ValidationInput, PreparedCapture } from './worker-client.js';
function check(value: unknown): asserts value { if (!value) throw new Error('Invalid capture'); }
function prepareReader(ir: WebReaderIR, imported: WebImportedTranslation | null, warnings: string[]) {
  if (!imported) return { translation: null, build: buildWebReader(ir, null) };
  const result = buildWebImportedReader(ir, imported);
  for (const id of result.rejectedBlockIds) warnings.push(`Translation candidate exceeds Reader source/context budget: ${id}`);
  return { translation: result.translation, build: result.build };
}
async function prepare(input: ValidationInput): Promise<PreparedCapture> {
  const manifest = webCaptureManifestSchema.parse(input.manifest); const limits = input.limits;
  check(manifest.files.length <= limits.maxFiles && manifest.files.reduce((n, f) => n + f.bytes, 0) <= limits.maxTotalBytes);
  check(new Set(manifest.resources.flatMap(resource => resource.url !== null && !resource.url.startsWith('data:') ? [new URL(resource.url).origin] : [])).size <= limits.maxResourceOrigins);
  const files = new Map<string, Uint8Array>();
  for (const descriptor of manifest.files) {
    check(descriptor.bytes <= (descriptor.role === 'html' ? limits.maxHtmlBytes : limits.maxResourceBytes));
    const path = input.files.find(f => f.id === descriptor.id)?.path; check(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); check(stat.isFile() && stat.size === descriptor.bytes); const bytes = await handle.readFile(); check(bytes.length === descriptor.bytes && await sha256(bytes) === descriptor.sha256); if (descriptor.role === 'css') check(!new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')); files.set(descriptor.id, bytes); }
    finally { await handle.close(); }
  }
  const html = new TextDecoder('utf-8', { fatal: true }).decode(files.get(manifest.htmlFileId)!);
  if (input.publicArticle) {
    // Reuse the bounded sanitizer preflight before inspecting raw control elements.
    // parse5 is inert: script strings and escaped code examples are text, not controls.
    sanitizeNodeSnapshot({ html, url: input.publicArticle.finalUrl, scope: manifest.scope }, limits);
    const nodes: DefaultTreeAdapterTypes.Node[] = [...parseFragment(html).childNodes];
    while (nodes.length) {
      const node = nodes.pop()!;
      if ('tagName' in node && node.tagName === 'input' && node.attrs.some(a => a.name === 'type' && a.value.trim().toLowerCase() === 'password')) throw new Error('FETCH_BROWSER_REQUIRED');
      if ('childNodes' in node) for (const child of node.childNodes) nodes.push(child);
    }
  }
  const snapshot = input.publicArticle
    ? extractPublicArticle(html, input.publicArticle.finalUrl, limits)
    : sanitizeNodeSnapshot({ html, url: normalizeCaptureUrl(manifest.source.url), scope: manifest.scope }, limits,
      replayResourcesFromManifest(manifest).filter(resource => resource.role === 'image'));
  if (input.publicArticle) {
    check(!snapshot.warnings.includes('Readability could not identify an article'));
    // Redirects resolve relative resources; the saved source identity stays the requested URL.
    snapshot.sourceUrl = normalizeCaptureUrl(manifest.source.url);
  }
  for (const resource of snapshot.resources) if (!manifest.resources.some(r => r.id === resource.id)) manifest.resources.push({ ...resource, status: 'missing', reason: 'unavailable' });
  const warnings = [...snapshot.warnings]; const assets: WebReaderAsset[] = [];
  for (const resource of manifest.resources) if (resource.status === 'available' && resource.role === 'image') {
    const file = manifest.files.find(f => f.id === resource.fileId)!;
    try { if (!assets.some(a => a.id === file.id)) assets.push(await inspectImageResource(files.get(file.id)!, file, limits)); }
    catch { Object.assign(resource, { status: 'missing', reason: 'invalid' }); delete (resource as unknown as Record<string, unknown>).fileId; warnings.push(`Invalid image resource: ${resource.id}`); }
  }
  // Preserve uploaded HTML separately at publication; authoritative source points to server-cleaned bytes.
  files.set(manifest.htmlFileId, new TextEncoder().encode(snapshot.html));
  const htmlFile = manifest.files.find(f => f.id === manifest.htmlFileId)!;
  htmlFile.bytes = files.get(htmlFile.id)!.length; htmlFile.sha256 = await sha256(files.get(htmlFile.id)!);
  manifest.source.url = snapshot.sourceUrl; manifest.scope = snapshot.scope;
  const usedFiles = new Set([manifest.htmlFileId, ...manifest.stylesheetFileIds, ...(manifest.existingTranslation ? [manifest.existingTranslation.fileId] : []), ...manifest.resources.flatMap(r => r.status === 'available' ? [r.fileId] : [])]);
  manifest.files = manifest.files.filter(f => usedFiles.has(f.id)); manifest.snapshots = { previews: [], nodeLocations: {} };
  const fingerprint = await captureContentFingerprint(snapshot, manifest.resources, manifest.files);
  if (input.retained) {
    const ir = webReaderIrSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.retained.irBytes)));
    const retainedManifest = webCaptureManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.retained.manifestBytes)));
    check(await sha256(input.retained.manifestBytes) === ir.source.manifestSha256 && ir.source.snapshotSha256 === htmlFile.sha256);
    check(retainedManifest.source.url === manifest.source.url && retainedManifest.scope.kind === manifest.scope.kind);
    const translation = await importCandidates(ir, manifest, fingerprint, await sha256(input.retained.irBytes), manifest.existingTranslation ? files.get(manifest.existingTranslation.fileId) : undefined, warnings, limits);
    const reader = prepareReader(ir, translation, warnings);
    return { retainedSourceVersionId: input.retained.sourceVersionId, manifest: retainedManifest, manifestBytes: input.retained.manifestBytes, fingerprint, ir, ...reader, warnings: [...new Set([...warnings, ...ir.warnings])], files: [] };
  }
  const previews = await buildSnapshotPreviews(snapshot, manifest, limits);
  warnings.push(...previews.warnings);
  manifest.files.push(...previews.files.map(f => f.descriptor)); manifest.snapshots = previews.index;
  for (const preview of previews.files) files.set(preview.descriptor.id, new TextEncoder().encode(preview.html));
  const manifestBytes = canonicalManifestBytes(webCaptureManifestSchema.parse(manifest));
  const ir = await projectWebReader(snapshot, manifest, { manifestBytes, assets, limits });
  if (input.publicArticle) check(ir.blocks.length > 0);
  if (!ir.blocks.length) warnings.push('Snapshot contains no readable semantic blocks; original download remains available.');
  const translation = await importCandidates(ir, manifest, fingerprint, await sha256(Buffer.from(JSON.stringify(ir))), manifest.existingTranslation ? files.get(manifest.existingTranslation.fileId) : undefined, warnings, limits);
  const reader = prepareReader(ir, translation, warnings);
  return { manifest, manifestBytes, fingerprint, ir, ...reader, warnings: [...new Set([...warnings, ...ir.warnings])], files: manifest.files.map(f => ({ id: f.id, bytes: files.get(f.id)! })) };
}
try { parentPort!.postMessage({ ok: true, value: await prepare(workerData as ValidationInput) }); }
catch (error) { parentPort!.postMessage({ ok: false, code: error instanceof Error && error.message === 'FETCH_BROWSER_REQUIRED' ? 'FETCH_BROWSER_REQUIRED' : undefined }); }
