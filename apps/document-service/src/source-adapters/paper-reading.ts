import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalManifestBytes, normalizeCaptureUrl } from '@pagelingo/web-capture';
import { assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import { lockDocument } from '../document-lifecycle/guards.js';
import { addRelation } from '../document-management/relations.js';
import { ServiceError } from '../errors.js';
import { createCaptureFetch } from '../network/capture-fetch.js';
import { CAPTURE_USER_AGENT } from '../web-captures/public-resources.js';
import { insertWebDocument } from '../web-readers/repository.js';
import { insertWebJob, type JobLease } from '../web-jobs/repository.js';
import type { SourceFetchDependencies } from './types.js';

export const paperReadingUrl = (baseId: string, version: number) => `https://arxiv.org/html/${baseId}v${version}`;

/** arXiv's own LaTeXML rendering of the fixed version: structured text that the server can translate, unlike the PDF. */
export async function paperReadingAvailable(url: string, deps: SourceFetchDependencies): Promise<boolean> {
  if (!deps.captureFetch && deps.config.mode === 'test') return false;
  // The size limit also applies to the Content-Length a HEAD response declares for the page it describes.
  const probe = deps.captureFetch ?? createCaptureFetch({ timeoutMs: deps.config.captureLimits.requestTimeoutMs, maxResponseBytes: deps.config.captureLimits.maxHtmlBytes });
  try {
    const response = await probe(url, { method: 'HEAD', headers: { accept: 'text/html', 'user-agent': CAPTURE_USER_AGENT }, signal: deps.signal });
    return response.ok && /^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '');
  } catch {
    // Saving the paper never depends on this optional reading version.
    deps.signal.throwIfAborted();
    return false;
  }
}

function operationKey(paperDocumentId: string, url: string): string {
  const hex = createHash('sha256').update(`paper-reading:${paperDocumentId}:${url}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Saves the HTML rendering as an ordinary article linked to its paper, so fetching, translation, reading and
 * lifecycle all use the existing article path. Retries are safe, and a reading version the owner deleted stays deleted.
 */
export async function admitPaperReading(client: PoolClient, lease: JobLease, paper: { url: string; title: string; translationIntent: 'auto' | 'none' }): Promise<void> {
  const url = normalizeCaptureUrl(paper.url);
  const key = operationKey(lease.documentId, url);
  try {
    await assertOperationNotRetired(client, lease.ownerId, 'document-link', key);
  } catch (error) {
    if (error instanceof ServiceError) return;
    throw error;
  }
  if ((await client.query('SELECT 1 FROM web_link_requests WHERE owner_id=$1 AND idempotency_key=$2', [lease.ownerId, key])).rowCount) return;
  const existing = (await client.query<{ id: string; deleted_at: Date | null }>(
    "SELECT id,deleted_at FROM documents WHERE owner_id=$1 AND source_url=$2 AND kind='article' ORDER BY created_at,id LIMIT 1", [lease.ownerId, url],
  )).rows[0];
  if (existing) {
    await lockDocument(client, lease.ownerId, existing.id);
    if (!existing.deleted_at) await addRelation(client, lease.ownerId, { fromDocumentId: existing.id, toDocumentId: lease.documentId, kind: 'related' });
    return;
  }
  const documentId = randomUUID();
  await insertWebDocument(client, { id: documentId, ownerId: lease.ownerId, kind: 'article', title: paper.title, url, titleOrigin: 'source' });
  await lockDocument(client, lease.ownerId, documentId);
  const request = { url, title: paper.title, kind: 'article' as const, translationIntent: paper.translationIntent };
  const job = await insertWebJob(client, {
    id: randomUUID(), ownerId: lease.ownerId, authVersion: lease.authVersion, documentId, kind: 'fetch-link', url,
    inputSha256: createHash('sha256').update(canonicalManifestBytes({ kind: 'fetch-link', url, translationIntent: paper.translationIntent })).digest('hex'),
  });
  await client.query('UPDATE documents SET requested_web_job_id=$3 WHERE owner_id=$1 AND id=$2', [lease.ownerId, documentId, job.id]);
  await client.query(`INSERT INTO web_link_requests (owner_id,idempotency_key,request_hash,request,document_id,job_id,auth_version,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)`,
    [lease.ownerId, key, createHash('sha256').update(canonicalManifestBytes(request)).digest('hex'), JSON.stringify(request), documentId, job.id, lease.authVersion]);
  await addRelation(client, lease.ownerId, { fromDocumentId: documentId, toDocumentId: lease.documentId, kind: 'related' });
}
