import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createBundleImportRequestSchema, type BundleImport } from '@pagelingo/document-contracts';
import { requireJson, requireSession, requireWriteRequest, type Actor } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { createBundleImportsService } from './service.js';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid bundle import request');
  return result.data;
}
/** The worker uses an internal source-conflict code; HTTP retains the frozen public code. */
function view(result: BundleImport): BundleImport {
  return result.errorCode === 'BUNDLE_SOURCE_CONFLICT' ? { ...result, errorCode: 'SOURCE_MISMATCH' } : result;
}
export function registerBundleImportsRoutes(app: FastifyInstance, store: ObjectStore): void {
  app.register(async scope => {
    const { db, config } = scope.authContext;
    const service = createBundleImportsService({ db, config, store });
    const actors = new WeakMap<FastifyRequest, Actor>();
    scope.addHook('onRequest', async request => {
      const actor = await requireSession(request);
      if (['PUT', 'POST'].includes(request.method)) await requireWriteRequest(request, actor);
      actors.set(request, actor);
    });
    // Pass the raw stream through unchanged. onRequest has already authenticated it.
    scope.addContentTypeParser('application/zip', (_request, payload, done) => done(null, payload));
    scope.setErrorHandler((error, _request, _reply) => {
      if (error instanceof ServiceError && error.code === 'BUNDLE_SOURCE_CONFLICT') throw new ServiceError(error.statusCode, 'SOURCE_MISMATCH', 'Bundle source does not match the document');
      throw error;
    });
    const actor = (request: FastifyRequest) => actors.get(request)!;
    const id = (request: FastifyRequest) => parse(z.strictObject({ id: z.uuid() }), request.params).id;
    const emptyQuery = (request: FastifyRequest) => parse(z.strictObject({}), request.query);
    scope.get('/api/v1/bundle-imports/limits', async request => { emptyQuery(request); return config.bundleLimits; });
    scope.post('/api/v1/bundle-imports', async (request, reply) => {
      emptyQuery(request); requireJson(request);
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string') throw new ServiceError(400, 'INVALID_REQUEST', 'Idempotency-Key is required');
      return reply.code(201).send(view(await service.create(actor(request), parse(createBundleImportRequestSchema, request.body), key)));
    });
    scope.get('/api/v1/bundle-imports', async request => { emptyQuery(request); return (await service.list(actor(request))).slice(0, 20).map(view); });
    scope.get('/api/v1/bundle-imports/:id', async request => { emptyQuery(request); return view(await service.get(actor(request), id(request))); });
    scope.post('/api/v1/bundle-imports/:id/cancel', async request => {
      emptyQuery(request); requireJson(request); parse(z.strictObject({}), request.body);
      return view(await service.cancel(actor(request), id(request)));
    });
    scope.put('/api/v1/bundle-imports/:id/content', async request => {
      emptyQuery(request);
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/zip') throw new ServiceError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/zip');
      const importId = id(request);
      const current = await service.get(actor(request), importId);
      if (current.status === 'completed') throw new ServiceError(409, 'BUNDLE_IMPORT_COMPLETED', 'Bundle import is already completed');
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('aborted', abort);
      if (request.raw.aborted) abort();
      try { return view(await service.receive(actor(request), importId, request.body as AsyncIterable<Uint8Array>, controller.signal)); }
      finally { request.raw.removeListener('aborted', abort); }
    });
  });
}
