import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readerChunkIdSchema, readerVersionListQuerySchema, readingProgressUpdateSchema } from '@pagelingo/document-contracts';
import { requireJson, requireSession, requireWriteRequest, type Actor } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { createReadersService } from './service.js';
import { sendReaderAsset } from './asset-response.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid reader request'); return result.data;
}
export function registerReadersRoutes(app: FastifyInstance, store: ObjectStore): void {
  app.register(async scope => {
    const service = createReadersService({ ...scope.authContext, store });
    const actors = new WeakMap<FastifyRequest, Actor>();
    scope.addHook('onRequest', async request => {
      const actor = await requireSession(request);
      if (request.method === 'PUT') await requireWriteRequest(request, actor);
      actors.set(request, actor);
    });
    const actor = (request: FastifyRequest) => actors.get(request)!;
    const doc = (request: FastifyRequest) => parse(z.strictObject({ id: z.uuid() }), request.params).id;
    const version = z.strictObject({ id: z.uuid(), versionId: z.uuid() });
    const emptyQuery = (request: FastifyRequest) => parse(z.strictObject({}), request.query);
    scope.get('/api/v1/documents/:id/reader', async request => service.descriptor(actor(request), doc(request), parse(z.strictObject({ versionId: z.uuid().optional() }), request.query).versionId));
    scope.get('/api/v1/documents/:id/reader-versions', async request => service.versions(actor(request), doc(request), parse(readerVersionListQuerySchema, request.query)));
    scope.get('/api/v1/documents/:id/readers/:versionId/chunks/:chunkId', async request => {
      emptyQuery(request); const p = parse(version.extend({ chunkId: readerChunkIdSchema }), request.params);
      return service.chunk(actor(request), p.id, p.versionId, p.chunkId);
    });
    scope.get('/api/v1/documents/:id/readers/:versionId/assets/:assetId', async (request, reply) => {
      emptyQuery(request); const p = parse(version.extend({ assetId: z.uuid() }), request.params);
      return sendReaderAsset(request, reply, store, await service.image(actor(request), p.id, p.versionId, p.assetId), false, () => service.versions(actor(request), p.id, { page: 1, pageSize: 1 }));
    });
    scope.get('/api/v1/documents/:id/readers/:versionId/bundle', async (request, reply) => {
      emptyQuery(request); const p = parse(version, request.params);
      return sendReaderAsset(request, reply, store, await service.archive(actor(request), p.id, p.versionId), true, () => service.versions(actor(request), p.id, { page: 1, pageSize: 1 }));
    });
    scope.get('/api/v1/documents/:id/progress', async request => { emptyQuery(request); return service.progress(actor(request), doc(request)); });
    scope.put('/api/v1/documents/:id/progress', async request => {
      emptyQuery(request); requireJson(request);
      return service.updateProgress(actor(request), doc(request), parse(readingProgressUpdateSchema, request.body));
    });
  });
}
