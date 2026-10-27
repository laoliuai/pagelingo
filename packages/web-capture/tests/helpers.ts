import { type WebCaptureManifest, type SanitizedSnapshot } from '@pagelingo/document-contracts';
import { canonicalManifestBytes, sha256 } from '../src/index.js';
export async function manifestFor(snapshot: SanitizedSnapshot): Promise<WebCaptureManifest> {
  return { schemaVersion: 'web-capture/1', captureId: '11111111-1111-4111-8111-111111111111',
    source: { url: snapshot.sourceUrl, canonicalUrl: null, kind: 'article', method: 'extension' },
    metadata: { title: 'Saved page', author: null, publishedAt: null, capturedAt: '2026-10-27T00:00:00Z' }, scope: snapshot.scope,
    htmlFileId: 'html', files: [{ id: 'html', path: 'snapshot.html', role: 'html', mediaType: 'text/html', bytes: new TextEncoder().encode(snapshot.html).length, sha256: await sha256(new TextEncoder().encode(snapshot.html)) }],
    resources: snapshot.resources.map(resource => ({ id: resource.id, role: resource.role, url: resource.url, status: 'missing', reason: 'unavailable' })),
    stylesheetFileIds: [], snapshots: { previews: [], nodeLocations: {} }, existingTranslation: null,
  };
}
export const projectionOptions = (manifest: WebCaptureManifest) => ({ manifestBytes: canonicalManifestBytes(manifest), assets: [] });
export const snapshotInput = (html: string) => ({ html, url: 'https://e.test/article', scope: { kind: 'article' as const, rootNodeId: 'root', completeWithinScope: true, warnings: [] } });
