import { collectExistingTranslations, type ExistingTranslationEvidence } from './existing-translations';
import { captureDraftSchema, captureUrlSchema, defaultCaptureLimits, type CaptureDraft } from '@pagelingo/document-contracts';
import { normalizeCaptureUrl, sha256 } from '@pagelingo/web-capture';
import { sanitizeBrowserSnapshot } from '@pagelingo/web-capture/browser';
import { originalTree, selectArchiveSource, originalSourceSignature } from './original-tree';
import { collectOriginalStylesheets } from './stylesheets';

export interface CaptureLinkFallback { kind: 'link-only'; url: string; title: string; warnings: string[] }
export class CaptureUnavailableError extends Error {
  constructor(readonly fallback: CaptureLinkFallback) { super(fallback.warnings.join(' ')); this.name = 'CaptureUnavailableError'; }
}
export interface CollectCaptureOptions {
  captureId: string;
  translations?: ExistingTranslationEvidence;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}
export async function collectOriginalCapture(document: Document, options: CollectCaptureOptions): Promise<CaptureDraft> {
  const check = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  check();
  const url = normalizeCaptureUrl(document.URL);
  const source = selectArchiveSource(document);
  if (!source.roots.length) throw new CaptureUnavailableError({ kind: 'link-only', url, title: source.title, warnings: source.warnings });
  const clone = originalTree(document, source);
  const signature = originalSourceSignature(document, source, clone);
  const snapshot = sanitizeBrowserSnapshot({ html: clone.outerHTML, url, scope: { kind: source.kind, rootNodeId: 'pending', completeWithinScope: source.warnings.length === 0, warnings: source.warnings } });
  const stylesheets = collectOriginalStylesheets(document, url);
  const pendingResources = [...snapshot.resources];
  const origins = new Set(snapshot.resources.flatMap(resource => resource.url && !resource.url.startsWith('data:') ? [new URL(resource.url).origin] : []));
  // Reserve the actual HTML/metadata envelope and JSON escaping, without duplicating CSS in snapshot.resources.
  let remainingTextBytes = defaultCaptureLimits.maxIrBytes - new TextEncoder().encode(JSON.stringify(snapshot)).byteLength - 65536;
  for (const resource of stylesheets.resources) {
    if (resource.url !== null) {
      const origin = new URL(resource.url).origin;
      if (!origins.has(origin) && origins.size >= defaultCaptureLimits.maxResourceOrigins) {
        stylesheets.warnings.push('Stylesheet origin budget exceeded; additional external CSS was omitted.');
        continue;
      }
      origins.add(origin);
    }
    if ('text' in resource) {
      const bytes = new TextEncoder().encode(JSON.stringify(resource.text)).byteLength;
      if (bytes > remainingTextBytes) {
        const { text: _text, ...identity } = resource;
        pendingResources.push({ ...identity, missingReason: 'too-large' });
        stylesheets.warnings.push(`Stylesheet ${resource.id} missing: draft byte budget exceeded.`);
        continue;
      }
      remainingTextBytes -= bytes;
    }
    pendingResources.push(resource);
  }
  snapshot.warnings.push(...stylesheets.warnings);
  snapshot.scope.warnings.push(...stylesheets.warnings);
  const evidence = document.createElement('template');
  evidence.innerHTML = snapshot.html; // Already inert: shared sanitizer removed all network attributes.
  if (!evidence.content.textContent?.trim() && !evidence.content.querySelector('img,svg,math')) {
    throw new CaptureUnavailableError({ kind: 'link-only', url, title: source.title, warnings: [...snapshot.warnings, 'No readable article evidence remains after sanitization; save the link.'] });
  }
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  // Force a digest boundary before returning, so source changes during async work are fenced.
  const snapshotSha256 = await sha256(new TextEncoder().encode(snapshot.html));
  const existingTranslation = await collectExistingTranslations(snapshot, options.translations, snapshotSha256);
  check();
  const current = selectArchiveSource(document);
  if (originalSourceSignature(document, current, originalTree(document, current)) !== signature) throw new Error('Capture source changed during collection');
  const draft = { captureId: options.captureId, snapshot,
    metadata: { title: source.title, author: source.author, publishedAt: source.publishedAt, capturedAt: new Date().toISOString() },
    canonicalUrl: canonical && captureUrlSchema.safeParse(canonical).success ? normalizeCaptureUrl(canonical) : null,
    kind: source.kind, pendingResources, existingTranslation };
  let draftBytes = new TextEncoder().encode(JSON.stringify(draft)).byteLength;
  for (const [index, resource] of pendingResources.entries()) {
    if (draftBytes <= defaultCaptureLimits.maxIrBytes - 4096) break;
    if (!('text' in resource)) continue;
    const { text: _text, ...identity } = resource;
    const missing = { ...identity, missingReason: 'too-large' as const };
    draftBytes += new TextEncoder().encode(JSON.stringify(missing)).byteLength - new TextEncoder().encode(JSON.stringify(resource)).byteLength;
    pendingResources[index] = missing;
    const warning = `Stylesheet ${resource.id} missing: draft byte budget exceeded.`;
    snapshot.warnings.push(warning); snapshot.scope.warnings.push(warning);
    draftBytes += 2 * (new TextEncoder().encode(JSON.stringify(warning)).byteLength + 1);
  }
  return captureDraftSchema.parse(draft);
}
