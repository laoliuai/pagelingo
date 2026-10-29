import { classifySourceUrl } from '../source-adapters/url.js';
import { admitSourceRequest } from '../source-adapters/service.js';
import { assertOperationNotRetired } from '../document-lifecycle/retired-identities.js';
import { assertDuplicateSaveActive, lockDocument } from '../document-lifecycle/guards.js';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createDocumentLinkRequestSchema, documentLinkResultSchema, type CreateDocumentLinkRequest, type DocumentLinkResult } from '@pagelingo/document-contracts';
import { canonicalManifestBytes, normalizeCaptureUrl } from '@pagelingo/web-capture';
import { assertCapturePrincipalCurrent, requireCapturePrincipal, type CapturePrincipal } from '../devices/guards.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import { insertWebDocument } from '../web-readers/repository.js';
import { findWebJobByInput, insertWebJob } from '../web-jobs/repository.js';
import { assertSaveHintsOwned, replaySaveHints } from '../document-management/repository.js';
/** Classification never claims access to browser/login content. All other article URLs are only candidates. */
export function classifyDocumentLink(url: string, requested?: CreateDocumentLinkRequest['kind']) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const loginRoute = parsed.pathname.split('/').some(segment => /^(?:login|signin|sign-in|sign_in|auth|oauth|oauth2)$/i.test(segment));
  const isHost = (name: string) => host === name || host.endsWith(`.${name}`);
  const kind = isHost('x.com') || isHost('twitter.com') ? 'x-post' : isHost('github.com') || isHost('gitlab.com') ? 'repository' : isHost('arxiv.org') ? 'paper' : requested ?? 'article';
  const reason = classifySourceUrl(url) ? null : kind !== 'article' ? 'UNSUPPORTED_SOURCE' : isHost('zhihu.com') || isHost('weixin.qq.com') || loginRoute ? 'BROWSER_CAPTURE_REQUIRED' : null;
  return { kind, reason };
}
export function createDocumentLinksService({ db }: { db: Database }) {
  return {
    async create(principal: CapturePrincipal, input: CreateDocumentLinkRequest, key: string): Promise<DocumentLinkResult> {
      const parsed = createDocumentLinkRequestSchema.safeParse(input);
      if (!parsed.success || !z.uuid().safeParse(key).success) throw new ServiceError(400, 'INVALID_REQUEST', 'Valid link request and UUID Idempotency-Key required');
      if (principal.kind === 'device' && principal.scope !== 'links:write') throw new ServiceError(403, 'FORBIDDEN', 'Device scope required');
      const value = { ...parsed.data, url: normalizeCaptureUrl(parsed.data.url) };
      const ownerId = principal.kind === 'session' ? principal.actor.userId : principal.userId;
      const authVersion = principal.kind === 'session' ? principal.actor.authVersion : principal.authVersion;
      return db.transaction(async client => {
        await assertCapturePrincipalCurrent(client, principal);
        await assertOperationNotRetired(client, ownerId, 'document-link', key);
        const previous = (await client.query<{ request_hash: string; request: CreateDocumentLinkRequest; document_id: string; job_id: string | null }>('SELECT * FROM web_link_requests WHERE owner_id=$1 AND idempotency_key=$2', [ownerId, key])).rows[0];
        if (previous) {
          const replayHash = createHash('sha256').update(canonicalManifestBytes({ ...value,...replaySaveHints(value,previous.request) })).digest('hex');
          if (previous.request_hash !== replayHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for another link request');
          return documentLinkResultSchema.parse({ documentId: previous.document_id, jobId: previous.job_id });
        }
        const classification = classifyDocumentLink(value.url, value.kind);
        const authorized = { ...value,...await assertSaveHintsOwned(client, ownerId, value) };
        const requestHash = createHash('sha256').update(canonicalManifestBytes(authorized)).digest('hex');
        let document = (await client.query<{ id: string; kind: string }>("SELECT id,kind FROM documents WHERE owner_id=$1 AND source_url=$2 AND kind=$3 ORDER BY created_at,id LIMIT 1", [ownerId, value.url, classification.kind])).rows[0];
        const existingDocument = !!document;
        if (!document) {
          document = { id: randomUUID(), kind: classification.kind };
          await insertWebDocument(client, { id: document.id, ownerId, kind: classification.kind, url: value.url, title: value.title ?? value.url.slice(0, 2000), titleOrigin: value.title === undefined ? 'url' : 'user', hints: authorized });
        }
        await lockDocument(client, ownerId, document.id);
        await assertDuplicateSaveActive(client, ownerId, document.id);
        let jobId: string | null = null;
        const source = classifySourceUrl(value.url);
        if (source && !existingDocument) jobId = (await admitSourceRequest(client, ownerId, authVersion, document.id, source, { translationIntent: value.translationIntent === 'none' ? 'none' : 'auto' }, key)).jobId;
        if (!classification.reason && document.kind === 'article') {
          const inputSha256 = createHash('sha256').update(canonicalManifestBytes({ kind: 'fetch-link', url: value.url, translationIntent: value.translationIntent })).digest('hex');
          const job = await findWebJobByInput(client, ownerId, document.id, authVersion, inputSha256)
            ?? await insertWebJob(client, { id: randomUUID(), ownerId, authVersion, documentId: document.id, kind: 'fetch-link', url: value.url, inputSha256 });
          jobId = job.id;
          await client.query('UPDATE documents SET requested_web_job_id=$3 WHERE owner_id=$1 AND id=$2', [ownerId, document.id, jobId]);
        }
        await client.query(`INSERT INTO web_link_requests (owner_id,idempotency_key,request_hash,request,document_id,job_id,auth_version,reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [ownerId, key, requestHash, JSON.stringify(authorized), document.id, jobId, authVersion, classification.reason]);
        return documentLinkResultSchema.parse({ documentId: document.id, jobId });
      });
    },
  };
}
export function registerDocumentLinksRoutes(app: FastifyInstance): void {
  const service = createDocumentLinksService(app.authContext);
  app.post('/api/v1/documents/links', async (request, reply) => {
    const principal = await requireCapturePrincipal(request, 'links:write');
    const result = await service.create(principal, request.body as CreateDocumentLinkRequest, request.headers['idempotency-key'] as string);
    return reply.code(201).send(result);
  });
}
