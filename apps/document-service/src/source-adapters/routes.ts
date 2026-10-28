import { createHash } from 'node:crypto';
import type { ObjectStore } from '../storage/object-store.js';
import { assertActorCurrent } from '../auth/guards.js';
import { assertDocumentActive } from '../document-lifecycle/guards.js';
import { sourceAsset } from './repository.js';
import { sendStoredAsset } from '../documents/source-response.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession, requireWriteRequest, requireJson } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import { createSourceAdaptersService } from './service.js';
import type { SourceRefreshInput } from './types.js';
export function registerSourceAdapterRoutes(app: FastifyInstance, store: ObjectStore): void {
  const service = createSourceAdaptersService(app.authContext);
  const documentId = (params: unknown) => { const value = z.strictObject({ id: z.uuid() }).safeParse(params); if (!value.success) throw new ServiceError(400,'INVALID_REQUEST','Invalid document id'); return value.data.id; };
  app.get('/api/v1/documents/:id/source-details', async request => {
    const query=z.strictObject({revisionId:z.uuid().optional()}).safeParse(request.query); if (!query.success) throw new ServiceError(400,'INVALID_REQUEST','Invalid source query');
    return service.details(await requireSession(request),documentId(request.params),query.data.revisionId);
  });
  app.get('/api/v1/documents/:id/source-versions', async request => {
    const query=z.strictObject({limit:z.coerce.number().int().min(1).max(50).optional(),cursor:z.uuid().optional()}).safeParse(request.query); if (!query.success) throw new ServiceError(400,'INVALID_REQUEST','Invalid versions query');
    return service.versions(await requireSession(request),documentId(request.params),query.data);
  });
  app.get('/api/v1/documents/:id/source-assets/:assetId', async (request,reply) => {
    const actor=await requireSession(request); const params=z.strictObject({id:z.uuid(),assetId:z.uuid()}).safeParse(request.params);
    if (!params.success || Object.keys(request.query as object).length) throw new ServiceError(400,'INVALID_REQUEST','Invalid source asset');
    const authorize=() => app.authContext.db.transaction(async client => {
      await assertActorCurrent(client,actor); await assertDocumentActive(client,actor.userId,params.data.id);
      const asset=await sourceAsset(client,actor.userId,params.data.id,params.data.assetId);
      if (!asset) throw new ServiceError(404,'NOT_FOUND','Source asset not found'); return asset;
    });
    const asset=await authorize(); let bytes=0; const hash=createHash('sha256');
    try { for await (const chunk of store.read(asset.object_key)) { bytes+=chunk.length; if(bytes>Number(asset.bytes)) throw new Error('Invalid source bytes'); hash.update(chunk); }
      if (bytes!==Number(asset.bytes)||hash.digest('hex')!==asset.sha256) throw new Error('Invalid source digest');
    } catch { throw new ServiceError(409,'SOURCE_MATERIAL_UNAVAILABLE','Registered source material is missing or corrupt'); }
    return sendStoredAsset(request,reply,store,asset,{mediaType:asset.media_type,filename:asset.filename,fallbackFilename:'source.bin',download:true,authorize});
  });
  app.post('/api/v1/documents/:id/source-refresh', async (request, reply) => {
    const actor = await requireSession(request); await requireWriteRequest(request, actor); requireJson(request);
    return reply.code(202).send(await service.refresh(actor, documentId(request.params), request.body as SourceRefreshInput, request.headers['idempotency-key'] as string));
  });
}
