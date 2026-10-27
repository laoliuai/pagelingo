import { collectExistingTranslations, type ExistingTranslationEvidence } from './existing-translations';
import { captureDraftSchema, captureUrlSchema, type CaptureDraft } from '@pagelingo/document-contracts';
import { normalizeCaptureUrl, sha256 } from '@pagelingo/web-capture';
import { sanitizeBrowserSnapshot } from '@pagelingo/web-capture/browser';
import { originalTree, selectArchiveSource, originalSourceSignature } from './original-tree';

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
  return captureDraftSchema.parse({ captureId: options.captureId, snapshot,
    metadata: { title: source.title, author: source.author, publishedAt: source.publishedAt, capturedAt: new Date().toISOString() },
    canonicalUrl: canonical && captureUrlSchema.safeParse(canonical).success ? normalizeCaptureUrl(canonical) : null,
    kind: source.kind, pendingResources: snapshot.resources, existingTranslation });
}
