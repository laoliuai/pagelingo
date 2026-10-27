import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createWebCaptureRequestSchema, webLocalIdSchema } from '@pagelingo/document-contracts';
import { requireCapturePrincipal } from '../devices/guards.js';
import type { ObjectStore } from '../storage/object-store.js';
import { ServiceError } from '../errors.js';
import { createWebCapturesService } from './service.js';
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid capture request'); return result.data; }
export function registerWebCapturesRoutes(app: FastifyInstance, store: ObjectStore): void {
  const { db, config } = app.authContext; const service = createWebCapturesService({ db, store, config });
  app.register(async scope => {
    // Only file PUTs use a raw bounded stream. JSON control requests keep Fastify's parser.
    scope.removeAllContentTypeParsers(); scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    scope.put('/api/v1/captures/:id/files/:fileId', async request => {
      const p = await requireCapturePrincipal(request, 'captures:write');
      const { id, fileId } = parse(z.strictObject({ id: z.uuid(), fileId: webLocalIdSchema }), request.params);
      const controller = new AbortController(); const abort = () => controller.abort(new ServiceError(400, 'CAPTURE_DISCONNECTED', 'Upload disconnected'));
      request.raw.once('aborted', abort);
      try { return await service.receiveFile(p, id, fileId, request.body as AsyncIterable<Uint8Array>, request.headers['content-type'] ?? '', controller.signal); }
      finally { request.raw.removeListener('aborted', abort); }
    });
  });
  app.post('/api/v1/captures', { bodyLimit: config.captureLimits.maxIrBytes }, async (request, reply) => {
    const p = await requireCapturePrincipal(request, 'captures:write');
    const result = await service.create(p, parse(createWebCaptureRequestSchema, request.body), request.headers['idempotency-key'] as string);
    return reply.code(201).send(result);
  });
  const id = (params: unknown) => parse(z.strictObject({ id: z.uuid() }), params).id;
  app.get('/api/v1/captures/:id', async request => service.status(await requireCapturePrincipal(request, 'captures:read'), id(request.params)));
  app.post('/api/v1/captures/:id/commit', async request => service.commit(await requireCapturePrincipal(request, 'captures:write'), id(request.params)));
  app.post('/api/v1/captures/:id/cancel', async request => service.cancel(await requireCapturePrincipal(request, 'captures:write'), id(request.params)));
}
