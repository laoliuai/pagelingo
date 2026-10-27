import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readerVersionListQuerySchema, webLocalIdSchema, webReadingProgressUpdateSchema } from '@pagelingo/document-contracts';
import { requireSession, requireWriteRequest, requireJson, type Actor } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { createWebReadersService } from './service.js';
import { sendWebAsset } from './assets.js';
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid Web Reader request'); return result.data; }
export function registerWebReadersRoutes(app: FastifyInstance, store: ObjectStore): void {
  app.register(async scope => {
    const service = createWebReadersService({ db: app.authContext.db, store }); const actors = new WeakMap<FastifyRequest, Actor>();
    scope.addHook('onRequest', async request => { const actor = await requireSession(request); if (request.method === 'PUT') await requireWriteRequest(request, actor); actors.set(request, actor); });
    const actor = (r: FastifyRequest) => actors.get(r)!;
    const doc = z.strictObject({ id: z.uuid() }), version = doc.extend({ versionId: z.uuid() }), source = doc.extend({ sourceVersionId: z.uuid() });
    const query = z.strictObject({ versionId: z.uuid().optional() });
    scope.get('/api/v1/documents/:id/web-reader', request => service.descriptor(actor(request), parse(doc, request.params).id, parse(query, request.query).versionId));
    scope.get('/api/v1/documents/:id/web-reader/versions', request => service.versions(actor(request), parse(doc, request.params).id, parse(readerVersionListQuerySchema, request.query)));
    scope.get('/api/v1/documents/:id/web-reader/versions/:versionId/chunks/:chunkId', request => { const p = parse(version.extend({ chunkId: webLocalIdSchema }), request.params); return service.chunk(actor(request), p.id, p.versionId, p.chunkId); });
    scope.get('/api/v1/documents/:id/web-reader/versions/:versionId/assets/:assetId', async (request, reply) => { const p = parse(version.extend({ assetId: z.uuid() }), request.params); return sendWebAsset(reply, await service.image(actor(request), p.id, p.versionId, p.assetId)); });
    scope.get('/api/v1/documents/:id/web-snapshots/:sourceVersionId/manifest', request => { const p = parse(source, request.params); return service.manifest(actor(request), p.id, p.sourceVersionId); });
    scope.get('/api/v1/documents/:id/web-snapshots/:sourceVersionId/files/:fileId', async (request, reply) => { const p = parse(source.extend({ fileId: webLocalIdSchema }), request.params); return sendWebAsset(reply, await service.file(actor(request), p.id, p.sourceVersionId, p.fileId), p.fileId.startsWith('uploaded:')); });
    scope.get('/api/v1/documents/:id/web-progress', request => service.progress(actor(request), parse(doc, request.params).id, parse(query, request.query).versionId));
    scope.put('/api/v1/documents/:id/web-progress', request => { requireJson(request); return service.updateProgress(actor(request), parse(doc, request.params).id, parse(webReadingProgressUpdateSchema, request.body)); });
  });
}
