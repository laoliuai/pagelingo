import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultCaptureLimits } from '@pagelingo/document-contracts';
import { buildSnapshotPreviews, captureContentFingerprint } from '@pagelingo/web-capture';
import { collectOriginalCapture } from '../../src/archive/collector';
import { acquireNetworkResource } from '../../src/archive/resources';
import { prepareCapture } from '../../src/archive/upload';
import { ArchiveDatabase, type ArchiveEntry } from '../../src/archive/database';
import { partition, type SiteBinding } from '../../src/archive/binding';
import { PageController } from '../../src/content/page-controller';
const controllers: PageController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); document.head.innerHTML = ''; document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const binding: SiteBinding = { siteOrigin: 'https://library.example', siteId: crypto.randomUUID(), ownerId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: crypto.randomUUID() };
function source(styles: string) {
  document.head.innerHTML = styles;
  document.body.innerHTML = '<article><p>This original article explains a useful browser feature and preserves the source for the reader.</p></article>';
}
async function prepare() {
  const draft = await collectOriginalCapture(document, { captureId: crypto.randomUUID() });
  const db = new ArchiveDatabase(`css-${crypto.randomUUID()}`);
  const entry: ArchiveEntry = { id: draft.captureId, partition: partition(binding), kind: 'capture', state: 'pending', draft, resources: [], attempts: 0, nextAttemptAt: 0, createdAt: Date.now(), warnings: [] };
  await db.put(binding, entry);
  await prepareCapture(entry, binding, db, async (value, id) => acquireNetworkResource(value.pendingResources.find(resource => resource.id === id)!), async () => {});
  return { draft, manifest: entry.request!.manifest, files: await db.files(binding, entry.id) };
}
it('collects external and inline original CSS through acquisition/upload without executing either in previews', async () => {
  source('<link rel="stylesheet" href="https://styles.example/original.css"><style>p { color: red; background: url(https://no-fetch.example/image); }</style><style data-pl-owned>private-plugin-sentinel{}</style>');
  const requests: string[] = [];
  vi.stubGlobal('chrome', { permissions: { contains: async () => true } });
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    requests.push(url); expect(options.credentials).toBe('omit'); expect(options.redirect).toBe('error');
    return new Response('article { color: blue }', { headers: { 'content-type': 'text/css' } });
  });
  const { draft, manifest, files } = await prepare();
  expect(manifest.stylesheetFileIds).toHaveLength(2);
  expect(manifest.resources).toMatchObject([
    { role: 'css', url: 'https://styles.example/original.css', status: 'available' },
    { role: 'css', url: null, provenance: { kind: 'inline-style', documentUrl: draft.snapshot.sourceUrl, index: 1 }, status: 'available' },
  ]);
  expect(requests).toEqual(['https://styles.example/original.css']);
  expect(files.filter(file => file.descriptor.role === 'css').map(file => new TextDecoder().decode(file.bytes))).toEqual(['article { color: blue }', 'p { color: red; background: url(https://no-fetch.example/image); }']);
  expect(JSON.stringify(manifest)).not.toContain('private-plugin-sentinel');
  expect(JSON.stringify(manifest)).not.toContain('background:');
  const preview = await buildSnapshotPreviews(draft.snapshot, manifest);
  expect(preview.files.map(file => file.html).join('')).not.toMatch(/styles\.example|no-fetch|background:|<style|<link/);
  const fingerprint = await captureContentFingerprint(draft.snapshot, manifest.resources, manifest.files);
  const altered = manifest.files.map(file => file.role === 'css' ? { ...file, sha256: 'a'.repeat(64) } : file);
  expect(await captureContentFingerprint(draft.snapshot, manifest.resources, altered)).not.toBe(fingerprint);
});
it('records denied, unavailable, unsupported and oversized CSS instead of silently reporting complete evidence', async () => {
  source('<link rel="stylesheet" href="https://denied.example/a.css"><link rel="stylesheet" href="https://missing.example/a.css"><link rel="stylesheet" href="https://large.example/a.css"><style type="text/less">@x: red;</style><link rel="stylesheet" href="data:text/css,p{}">');
  vi.stubGlobal('chrome', { permissions: { contains: async ({ origins }: { origins: string[] }) => !origins[0].includes('denied') } });
  vi.stubGlobal('fetch', async (url: string) => url.includes('large') ? new Response('x', { headers: { 'content-type': 'text/css', 'content-length': String(defaultCaptureLimits.maxResourceBytes + 1) } }) : new Response('missing', { status: 404 }));
  const { draft, manifest } = await prepare();
  expect(manifest.resources.map(resource => resource.status === 'missing' ? resource.reason : 'available')).toEqual(['blocked', 'unavailable', 'too-large', 'unsupported']);
  expect(draft.snapshot.warnings.join(' ')).toMatch(/unsupported.*stylesheet/i);
  expect(manifest.stylesheetFileIds).toEqual([]);
});
it('keeps original CSS identical across translation modes and fences stylesheet changes during collection and later access', async () => {
  source('<style>p { color: teal }</style>');
  const controller = new PageController(document); controllers.push(controller);
  const original = await collectOriginalCapture(document, { captureId: crypto.randomUUID() });
  expect(original.pendingResources).toHaveLength(1);
  controller.start('bilingual'); await expect.poll(() => controller.status.status).toBe('completed');
  for (const mode of ['source', 'translation', 'bilingual'] as const) {
    controller.setMode(mode);
    const captured = await collectOriginalCapture(document, { captureId: crypto.randomUUID() });
    expect(captured.snapshot.html).toBe(original.snapshot.html);
    expect(captured.pendingResources).toEqual(original.pendingResources);
  }
  const grant = { ...controller.captureIdentity(), captureId: crypto.randomUUID(), grantId: crypto.randomUUID(), tabId: 1, frameId: 0 as const, documentId: 'css-document' };
  const captured = await controller.collectCapture(grant);
  document.querySelector('style')!.textContent = 'p { color: navy }';
  expect(() => controller.captureResource(grant, captured.pendingResources[0].id)).toThrow(/changed|stale/i);
  const pending = collectOriginalCapture(document, { captureId: crypto.randomUUID() });
  document.querySelector('style')!.textContent = 'p { color: brown }';
  await expect(pending).rejects.toThrow(/changed|stale/i);
});
it('records inline CSS larger than the resource budget without retaining oversized text in the draft', async () => {
  source('<style></style>');
  document.querySelector('style')!.textContent = '/*' + 'x'.repeat(defaultCaptureLimits.maxResourceBytes) + '*/';
  const draft = await collectOriginalCapture(document, { captureId: crypto.randomUUID() });
  expect(draft.pendingResources).toMatchObject([{ role: 'css', url: null, missingReason: 'too-large' }]);
  expect(JSON.stringify(draft).length).toBeLessThan(10000);
});
it('bounds aggregate inline JSON text and retains source with explicit missing evidence', async () => {
  source('<style></style><style></style><style></style>');
  for (const style of document.querySelectorAll('style')) style.textContent = '/*' + '\\'.repeat(4 * 1024 * 1024) + '*/';
  const draft = await collectOriginalCapture(document, { captureId: crypto.randomUUID() });
  expect(draft.snapshot.resources).toEqual([]); // Inline text has one durable copy.
  expect(draft.pendingResources).toHaveLength(3);
  expect(draft.pendingResources.some(resource => 'text' in resource)).toBe(true);
  expect(draft.pendingResources.some(resource => 'missingReason' in resource && resource.missingReason === 'too-large')).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(draft)).byteLength).toBeLessThan(defaultCaptureLimits.maxIrBytes - 1024);
  expect(draft.snapshot.html).toContain('This original article');
  expect(draft.snapshot.scope.warnings.join(' ')).toMatch(/budget|too-large/);
});
it('retains immutable selected inline text and provenance despite caller mutation of returned DTOs', async () => {
  source('<style>p { color: teal }</style>');
  const controller = new PageController(document); controllers.push(controller);
  const grant = { ...controller.captureIdentity(), captureId: crypto.randomUUID(), grantId: crypto.randomUUID(), tabId: 1, frameId: 0 as const, documentId: 'css-document' };
  const draft = await controller.collectCapture(grant);
  const inline = draft.pendingResources[0];
  if (!('text' in inline)) throw Error('Expected collected inline text');
  inline.text = 'caller override'; inline.provenance.index = 99;
  const selected = controller.captureResource(grant, inline.id);
  expect(selected).toMatchObject({ text: 'p { color: teal }', provenance: { index: 0 } });
  if (selected.url === null) selected.provenance.index = 77;
  expect(controller.captureResource(grant, inline.id)).toMatchObject({ provenance: { index: 0 } });
});
it('preserves readable source when inline access or external CSS decoding fails', async () => {
  source('<style>p {}</style><link rel="stylesheet" href="https://styles.example/invalid.css">');
  Object.defineProperty(document.querySelector('style'), 'textContent', { get() { throw Error('inaccessible style'); } });
  vi.stubGlobal('chrome', { permissions: { contains: async () => true } });
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([0xff, 0]), { headers: { 'content-type': 'text/css' } }));
  const { manifest } = await prepare();
  expect(manifest.resources).toMatchObject([{ status: 'missing', reason: 'unavailable' }, { status: 'missing', reason: 'invalid' }]);
  expect(manifest.stylesheetFileIds).toEqual([]);
});
