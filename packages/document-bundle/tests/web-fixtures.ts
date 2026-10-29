import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BundleFile, WebCaptureManifest, WebImportedTranslation, WebModelTranslation, WebReaderIR } from '@pagelingo/document-contracts';
import { defaultCaptureLimits } from '@pagelingo/document-contracts';
import { canonicalManifestBytes, captureContentFingerprint, sanitizeNodeSnapshot, buildSnapshotPreviews, inspectImageResource, projectWebReader } from '@pagelingo/web-capture/node';
import { buildWebReader, createWebStaticFilePlan, toWebTranslationDocument } from '@pagelingo/document-renderer';
import { encodeBlock, PROMPT_VERSION, PROTECTION_VERSION, contentHash, planUnits } from '@pagelingo/translation-core';
export const hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
export const json = (value: unknown) => Buffer.from(JSON.stringify(value));
export async function webFixture(partial = false, options: { imageId?: string; sourceBytes?: number; irBytes?: number; htmlPath?: string; invalidImage?: boolean; forgedIr?: boolean; tightenedConfig?: boolean; protectedHeading?: boolean } = {}) {
  const imageId = options.imageId ?? '__proto__', htmlPath = options.htmlPath ?? 'source.html';
  const snapshot = sanitizeNodeSnapshot({ html: '<article>' + (options.protectedHeading ? '<h1>Saved <strong>title</strong></h1>' : '<h1>Saved title</h1>') + '<p>Original paragraph.</p><p>Pending paragraph.</p><img src="https://example.com/a.jpg"><img src="https://example.com/b.jpg"><img src="https://example.com/c.jpg"></article>', url: 'https://example.com/article', scope: { kind: 'article', rootNodeId: 'article', completeWithinScope: true, warnings: [] } });
  const files = new Map<string, Uint8Array>([[`source/${htmlPath}`, Buffer.from(snapshot.html)]]);
  const actualImage = await readFile(new URL('../../web-capture/tests/fixtures/chromium-7x5.jpg', import.meta.url));
  const image = options.invalidImage ? Buffer.from('invalid image') : actualImage;
  const imageFile = { id: imageId, path: 'images/saved #.jpg', bytes: image.length, sha256: hash(image), mediaType: 'image/jpeg', role: 'image' as const };
  const capture: WebCaptureManifest = { schemaVersion: 'web-capture/1', captureId: '11111111-1111-4111-8111-111111111111', source: { url: snapshot.sourceUrl, canonicalUrl: null, kind: 'article', method: 'extension' }, metadata: { title: 'Saved title', author: null, publishedAt: null, capturedAt: '2026-10-28T00:00:00Z' }, scope: snapshot.scope, htmlFileId: 'html', files: [{ id: 'html', path: htmlPath, bytes: Buffer.byteLength(snapshot.html), sha256: hash(snapshot.html), mediaType: 'text/html', role: 'html' }, imageFile], resources: snapshot.resources.map(r => { if (r.role !== 'image') throw Error('image fixture'); return { id: r.id, url: r.url, role: 'image', status: 'available', fileId: imageId }; }), stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} }, existingTranslation: null };
  files.set(`source/${imageFile.path}`, image);
  const previews = await buildSnapshotPreviews(snapshot, capture);
  for (const preview of previews.files) {
    // Actual archived content differs from the IR; regeneration must use these bytes.
    preview.html += '<p>ARCHIVED PREVIEW ONLY</p><script>window.pwned=1</script>';
    preview.descriptor.bytes = Buffer.byteLength(preview.html); preview.descriptor.sha256 = hash(preview.html);
    previews.index.previews.find(p => p.fileId === preview.descriptor.id)!.htmlBytes = preview.descriptor.bytes;
    capture.files.push(preview.descriptor); files.set(`source/${preview.descriptor.path}`, Buffer.from(preview.html));
  }
  capture.snapshots = previews.index;
  const canonical = canonicalManifestBytes(capture);
  const sourceBytes = options.sourceBytes ? Buffer.concat([canonical, Buffer.alloc(options.sourceBytes - canonical.length, 32)]) : canonical; files.set('source/manifest.json', sourceBytes);
  const ir = await projectWebReader(snapshot, capture, { manifestBytes: sourceBytes, ...(options.tightenedConfig ? { limits: { ...defaultCaptureLimits, maxHtmlBytes: 4 * 1024 * 1024 } } : {}), assets: [options.invalidImage ? { id: imageFile.id, path: imageFile.path, bytes: imageFile.bytes, sha256: imageFile.sha256, mediaType: 'image/jpeg', width: 7, height: 5, frames: 1 } : await inspectImageResource(image, imageFile)] });
  if (options.forgedIr) { const block = ir.blocks.find(b => b.type === 'text')!; if (block.type === 'text') block.value.content = [{ type: 'text', text: 'Forged source content' }]; }
  const irJson = json(ir);
  const irBytes = options.irBytes ? Buffer.concat([irJson, Buffer.alloc(options.irBytes - irJson.length, 32)]) : irJson; files.set('source-ir.json', irBytes);
  const first = ir.blocks.find(b => b.type === 'text')!; if (first.type !== 'text') throw Error('fixture');
  const fingerprint = await captureContentFingerprint(snapshot, capture.resources, capture.files);
  const translation: WebImportedTranslation | null = partial ? { schemaVersion: 'web-imported-translation/1', id: '22222222-2222-4222-8222-222222222222', generationKind: 'import', sourceSha256: hash(sourceBytes), parseId: ir.parse.id, readerIrSha256: hash(irBytes), sourceSnapshotSha256: ir.source.snapshotSha256, sourceContentFingerprint: fingerprint, sdkVersion: '0.4.0', promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION, sourceLanguage: 'en', targetLanguage: 'zh', status: 'partial', blocks: [{ blockId: first.id, nodeId: first.sourceRefs[0].nodeId, sourceTextSha256: hash('Saved title'), source: first.value, rawText: encodeBlock(first.value).protectedText.replace('Saved title', '保存的标题') }] } : null;
  if (translation) files.set('translation.json', json(translation));
  const build = buildWebReader(ir, translation);
  const input = { ir, translation, ...build, capture, assets: ir.assets.map(a => ({ ...a, path: `source/${a.path}` })), previews: previews.files.map(p => ({ fileId: p.descriptor.id, html: p.html })), previewImages: [{ fileId: imageFile.id, data: image }] };
  const plan = createWebStaticFilePlan(input), entries: BundleFile[] = [];
  for (const [path, bytes] of files) entries.push({ path, bytes: bytes.length, sha256: hash(bytes), mediaType: path.endsWith('.json') ? 'application/json' : path === `source/${htmlPath}` || path.endsWith('.html') ? 'text/html' : 'image/jpeg', role: path === 'source-ir.json' ? 'reader-ir' : path === 'translation.json' ? 'translation' : 'source' });
  const require = createRequire(import.meta.url);
  for (const asset of plan.trustedAssets) {
    const bytes = await readFile(join(dirname(require.resolve(`${asset.source.package}/package.json`)), asset.source.path));
    files.set(asset.path, bytes); entries.push({ path: asset.path, bytes: bytes.length, sha256: hash(bytes), mediaType: asset.mediaType, role: asset.path.startsWith('licenses/') ? 'license' : 'asset' });
  }
  for (const file of plan.generatedFiles) { const bytes = Buffer.from(file.content); files.set(file.path, bytes); entries.push({ path: file.path, bytes: bytes.length, sha256: hash(bytes), mediaType: file.mediaType, role: 'render' }); }
  const manifest = { schemaVersion: 'pagelingo-web-document-bundle/1' as const, packageId: '33333333-3333-4333-8333-333333333333', createdAt: '2026-10-28T00:00:00Z', title: 'Export header '.repeat(60), source: { manifestPath: 'source/manifest.json' as const, manifestSha256: hash(sourceBytes), snapshotSha256: ir.source.snapshotSha256, contentFingerprint: fingerprint }, parse: { id: ir.parse.id, readerIrSha256: hash(irBytes) }, translation: translation ? { path: 'translation.json' as const, sha256: hash(files.get('translation.json')!), status: translation.status, generationKind: translation.generationKind } : null, renderer: { version: plan.rendererVersion, codeSha256: plan.rendererSha256 }, files: entries };
  files.set('manifest.json', json(manifest));
  return { files, manifest, capture, ir, translation, input };
}
export function refresh(fixture: Awaited<ReturnType<typeof webFixture>>, path: string, body: Uint8Array) {
  fixture.files.set(path, body);
  Object.assign(fixture.manifest.files.find(f => f.path === path)!, { bytes: body.length, sha256: hash(body) });
  fixture.files.set('manifest.json', json(fixture.manifest));
}

export async function modelSnapshot(ir: WebReaderIR): Promise<WebModelTranslation> {
  const base = JSON.parse(await readFile(new URL('../../document-contracts/fixtures/reader-v1/translation.json', import.meta.url), 'utf8'));
  const t: WebModelTranslation = { ...base, schemaVersion: 'web-reader-translation/1', parseId: ir.parse.id, sourceSha256: ir.source.manifestSha256, promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION, selectionBlockIds: ir.blocks.filter(b => b.type === 'text').map(b => b.id) };
  t.glossarySha256 = await contentHash(t.glossary);
  const plan = planUnits(toWebTranslationDocument(ir, t.selectionBlockIds), t.targetLanguage, t.profile, t.budget, t);
  t.units = plan.units.map(u => ({ id: u.id, blockId: plan.inputs[u.blockIndex].id, part: u.part, status: 'covered-by-block' }));
  t.blocks = plan.inputs.map(input => ({ blockId: input.id, status: 'translated', rawText: input.protectedText }));
  t.status = 'completed'; t.generationKind = 'mock'; return t;
}
/** An admitted hostile original is retained as inert bytes, independently of trusted projection. */
export async function addOriginalCapture(f: Awaited<ReturnType<typeof webFixture>>) {
  const { canonicalManifestBytes } = await import('@pagelingo/web-capture');
  const original = structuredClone(f.capture);
  const raw = Buffer.from('<script>window.originalAttachmentExecuted=true;fetch("https://must-not-run.example/")</script><article>Original raw content</article>');
  const html = original.files.find(file => file.id === original.htmlFileId)!;
  html.bytes = raw.length; html.sha256 = hash(raw);
  function add(path: string, bytes: Uint8Array, mediaType: string) {
    f.files.set(path, bytes); f.manifest.files.push({ path, bytes: bytes.length, sha256: hash(bytes), mediaType, role: 'provenance' });
  }
  if (f.translation?.generationKind === 'import') {
    const translation = f.translation;
    const candidate = { schemaVersion: 'web-capture-translation-candidate/1', sourceSnapshotSha256: translation.sourceSnapshotSha256, sourceContentFingerprint: translation.sourceContentFingerprint,
      sourceLanguage: translation.sourceLanguage, targetLanguage: translation.targetLanguage, sdkVersion: translation.sdkVersion, promptVersion: translation.promptVersion, protectionVersion: translation.protectionVersion,
      blocks: translation.blocks.map(({ blockId: _blockId, ...proof }) => proof) };
    const candidateBytes = json(candidate), file = { id: 'original-translation', path: 'candidate.json', role: 'translation' as const, mediaType: 'application/json', bytes: candidateBytes.length, sha256: hash(candidateBytes) };
    original.files.push(file); original.existingTranslation = { fileId: file.id, sourceSnapshotSha256: candidate.sourceSnapshotSha256, sourceContentFingerprint: candidate.sourceContentFingerprint, targetLanguage: candidate.targetLanguage };
    f.files.set(`source/${file.path}`, candidateBytes);
  }
  const manifest = canonicalManifestBytes(original), request = canonicalManifestBytes({ manifest: original, translationIntent: 'none' });
  add('originals/capture/manifest.json', manifest, 'application/json'); add('originals/capture/request.json', request, 'application/json');
  for (const file of original.files) add(`originals/capture/files/${file.path}`, file.id === original.htmlFileId ? raw : f.files.get(`source/${file.path}`)!, file.mediaType);
  Object.assign(f.manifest, { originals: { capture: { manifestSha256: hash(manifest), requestSha256: hash(request), admissionKind: 'upload' } } });
  if (f.translation?.generationKind === 'import') f.files.delete('source/candidate.json');
  f.files.set('manifest.json', json(f.manifest));
  return { original, raw, htmlPath: `originals/capture/files/${html.path}` };
}
