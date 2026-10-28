import { afterEach, expect, it } from 'vitest';
import { inspectImageResource, sha256 } from '@pagelingo/web-capture';
import { captureDraftSchema } from '@pagelingo/document-contracts';
import { fitCaptureDelivery } from '../../src/archive/delivery-budget';
import { collectOriginalCapture } from '../../src/archive/collector';
import { PageController } from '../../src/content/page-controller';
import { ownPng, ownPngUrl } from '../helpers/archive-boundary';
const controllers: PageController[] = [];
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); document.head.innerHTML = ''; document.body.innerHTML = ''; history.replaceState(null, '', '/'); });
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
it('fits the actual delivery for own valid PNG, 6030-character URL and two CSS files before authorizing resources', async () => {
  const png = ownPng(); await inspectImageResource(png, { id: 'own', path: 'own.png', role: 'image', mediaType: 'image/png', bytes: png.length, sha256: await sha256(png) });
  const prefix = `${location.origin}/story?source=`; history.replaceState(null, '', prefix + 'x'.repeat(6030 - prefix.length));
  expect(document.URL.length).toBe(6030);
  document.body.innerHTML = `<article><p>Own original source for capture budgeting.</p><img src="${ownPngUrl()}"></article>`;
  document.head.innerHTML = '<style>/**/</style><style>/**/</style>';
  const small = await collectOriginalCapture(document, { captureId: crypto.randomUUID() });
  const targetText = 16 * 1024 * 1024 - 4096 - size(small) + 8;
  const styles = document.querySelectorAll('style');
  styles[0].textContent = '/*' + 'a'.repeat(8 * 1024 * 1024 - 4) + '*/';
  styles[1].textContent = '/*' + 'b'.repeat(targetText - 8 * 1024 * 1024 - 4) + '*/';
  const controller = new PageController(document); controllers.push(controller);
  const grant = { ...controller.captureIdentity(), captureId: crypto.randomUUID(), grantId: crypto.randomUUID(), tabId: 1, frameId: 0 as const, documentId: 'boundary-document' };
  const draft = await controller.collectCapture(grant);
  const deliveryBytes = size({ type: 'capture:deliver', grant, payload: { ok: true, value: draft } });
  expect(deliveryBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(draft.snapshot.html).toContain('Own original source');
  expect(draft.pendingResources.filter(r => r.role === 'css')).toHaveLength(2);
  const omitted = draft.pendingResources.find(r => 'missingReason' in r && r.missingReason === 'too-large')!;
  expect(omitted).toBeDefined(); expect(controller.captureResource(grant, omitted.id)).toEqual(omitted);
  expect(draft.snapshot.scope.warnings.join(' ')).toMatch(/delivery|budget/);
});

it('falls back explicitly when even a non-CSS collector draft cannot fit', async () => {
  const data = ownPngUrl();
  document.body.innerHTML = '<article><p>Own evidence exceeds transport budget.</p></article>';
  for (let i = 0; i < 50; i++) { const image = document.createElement('img'); image.src = data; document.querySelector('article')!.append(image); }
  const controller = new PageController(document); controllers.push(controller);
  const grant = { ...controller.captureIdentity(), captureId: crypto.randomUUID(), grantId: crypto.randomUUID(), tabId: 1, frameId: 0 as const, documentId: 'no-css' };
  await expect(controller.collectCapture(grant)).rejects.toMatchObject({ name: 'CaptureUnavailableError', fallback: { kind: 'link-only', url: document.URL, warnings: expect.arrayContaining([expect.stringMatching(/budget|exceed/i)]) } });
  expect(() => controller.captureResource(grant, 'resource-0')).toThrow(/grant/);
});

it('counts UTF-8 and JSON escaping, preserves body across all reading modes, and fences stale grants', async () => {
  document.head.innerHTML = '<style>p::before { content: "原文\\\\\\n"; }</style>';
  document.body.innerHTML = '<article><p>中文原文 with "quotes" and backslashes \\ remains original.</p></article>';
  const controller = new PageController(document); controllers.push(controller); let body = '';
  for (const mode of ['source','translation','bilingual'] as const) {
    controller.setMode(mode);
    const grant = { ...controller.captureIdentity(), captureId: crypto.randomUUID(), grantId: crypto.randomUUID(), tabId: 1, frameId: 0 as const, documentId: 'escaped-document' };
    const draft = await controller.collectCapture(grant); body ||= draft.snapshot.html; expect(draft.snapshot.html).toBe(body);
    expect(size({ type: 'capture:deliver', grant, payload: { ok: true, value: draft } })).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(controller.captureResource(grant, draft.pendingResources[0].id)).toEqual(draft.pendingResources[0]);
  }
  const stale = { ...controller.captureIdentity(), captureId: crypto.randomUUID(), grantId: crypto.randomUUID(), tabId: 1, frameId: 0 as const, documentId: 'escaped-document' };
  document.querySelector('style')!.textContent = 'p { color: navy }';
  await expect(controller.collectCapture(stale)).rejects.toThrow(/stale|changed/);
});

it('uses escaped UTF-8 envelope bytes for deterministic CSS downgrade without changing the caller draft', async () => {
  const prefix = `${location.origin}/story?source=`; history.replaceState(null, '', prefix + 'x'.repeat(6030 - prefix.length));
  document.head.innerHTML = '<style>/**/</style>'; document.body.innerHTML = '<article><p>Own source unchanged.</p></article>';
  const draft = await collectOriginalCapture(document, { captureId: crypto.randomUUID() });
  const css = draft.pendingResources[0]; if (!('text' in css)) throw Error('Expected inline CSS');
  const baseline = size(draft) - size(css.text);
  // Each backslash, quote, Chinese character and newline occupies 9 JSON UTF-8 bytes.
  css.text = '\\\"中\n'.repeat(Math.floor((16 * 1024 * 1024 - 4096 - baseline - 2) / 9));
  captureDraftSchema.parse(draft);
  const grant = { contentSessionId: crypto.randomUUID(), revision: 1, url: document.URL, captureId: draft.captureId, grantId: crypto.randomUUID(), tabId: 1, frameId: 0 as const, documentId: 'escaping' };
  expect(size({ type: 'capture:deliver', grant, payload: { ok: true, value: draft } })).toBeGreaterThan(16 * 1024 * 1024);
  const fitted = fitCaptureDelivery(grant, draft);
  expect(size({ type: 'capture:deliver', grant, payload: { ok: true, value: fitted } })).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(fitted.pendingResources[0]).toMatchObject({ missingReason: 'too-large' }); expect(fitted.snapshot.html).toBe(draft.snapshot.html);
  expect(css.text.length).toBeGreaterThan(1_000_000); expect(fitCaptureDelivery(grant, draft)).toEqual(fitted);
});

it('returns an honest link fallback when a valid draft has no removable CSS and its envelope exceeds the limit', async () => {
  document.body.innerHTML = '<article><p>Own source with bounded draft.</p></article>';
  const draft = await collectOriginalCapture(document, { captureId: crypto.randomUUID() });
  draft.snapshot.warnings = ['x']; const spare = 16 * 1024 * 1024 - 10 - size(draft); draft.snapshot.warnings[0] += 'x'.repeat(spare);
  captureDraftSchema.parse(draft);
  const grant = { contentSessionId: crypto.randomUUID(), revision: 1, url: document.URL, captureId: draft.captureId, grantId: crypto.randomUUID(), tabId: 1, frameId: 0 as const, documentId: 'no-removable-css' };
  expect(() => fitCaptureDelivery(grant, draft)).toThrowError(expect.objectContaining({ name: 'CaptureUnavailableError', fallback: expect.objectContaining({ kind: 'link-only', url: document.URL }) }));
});
