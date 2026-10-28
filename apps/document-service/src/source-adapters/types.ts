import type { Database } from '../db/database.js';
import type { ObjectStore } from '../storage/object-store.js';
import type { RuntimeConfig } from '../config.js';
export type SourceReference = { provider: 'github'; owner: string; repo: string; requestedRef?: string; url: string } | { provider: 'arxiv'; baseId: string; version: number | null; url: string };
export interface SourceTransport {
  readSmall(url: string, input: { accept: string; maxBytes: number; signal: AbortSignal }): Promise<Response>;
  downloadPdf<T>(url: string, input: { maxBytes: number; signal: AbortSignal }, consume: (body: AsyncIterable<Uint8Array>, response: { status: number; url: string; headers: Headers }) => Promise<T>): Promise<T>;
  downloadResource<T>(url: string, input: { accept: string; maxBytes: number; signal: AbortSignal }, consume: (body: AsyncIterable<Uint8Array>, response: { status: number; url: string; headers: Headers }) => Promise<T>): Promise<T>;
}
export interface SourceFetchDependencies { db: Database; store: ObjectStore; config: RuntimeConfig; signal: AbortSignal; sourceTransport?: SourceTransport }
export interface SourceAssetInfo { assetId: string; sha256: string; bytes: number; mediaType: string; filename: string }
export interface GithubSourceRevision {
  kind: 'github'; id: string; sourceVersionId: string | null;
  repository: { id: string; owner: string; name: string; description: string | null; url: string };
  commitSha: string | null; readme: { path: string; blobSha: string; raw: SourceAssetInfo; renderedHtml: SourceAssetInfo | null } | null; capturedAt: string;
}
export interface ArxivSourceRevision {
  kind: 'arxiv'; id: string; baseId: string; version: number; title: string; authors: string[]; summary: string;
  publishedAt: string; updatedAt: string; capturedAt: string; sourceVersionId: string | null; pdf: SourceAssetInfo | null;
}
interface SourceDetailsBase {
  documentId: string; url: string; resolution: 'self' | 'alias' | 'conflict'; canonicalDocumentId: string | null; fetchJobId: string | null;
  status: 'link-only' | 'metadata-saved' | 'source-saved' | 'partial-resources' | 'fetch-failed'; errorCode: string | null; warnings: string[];
  latestAttempt: { jobId: string; status: string; requestedRef: string | null; resolvedRevision: string | null; errorCode: string | null } | null;
}
export type SourceDetails = SourceDetailsBase & ({ kind: 'link' } | { kind: 'github'; current: GithubSourceRevision | null } | { kind: 'arxiv'; current: ArxivSourceRevision | null });
export interface SourceRefreshInput { ref?: string; translationIntent: 'auto' | 'none' }
