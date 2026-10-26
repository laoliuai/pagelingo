import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { providerProfileUpdateSchema } from '@pagelingo/document-contracts';
import { requireJson, requireSession, requireWriteRequest } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import { createProvidersService } from './service.js';
import { createConnectionTestService } from './connection-test.js';

function requireEmptyQuery(request: FastifyRequest): void {
  if (!z.strictObject({}).safeParse(request.query).success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid query');
}

export function registerProvidersRoutes(app: FastifyInstance, outboundFetch: typeof fetch): void {
  const service = createProvidersService({ db: app.authContext.db, keyring: app.authContext.config.keyring });
  const connectionTest = createConnectionTestService({ db: app.authContext.db, providers: service, outboundFetch });
  app.post('/api/v1/settings/provider/test', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    requireEmptyQuery(request);
    if (request.body !== undefined && !z.strictObject({}).safeParse(request.body).success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid request body');
    const controller = new AbortController();
    const aborted = () => controller.abort();
    const closed = () => { if (!reply.raw.writableFinished) aborted(); };
    request.raw.on('aborted', aborted);
    reply.raw.on('close', closed);
    if (request.raw.aborted || reply.raw.destroyed) aborted();
    try { return await connectionTest.testProviderConnection(actor, controller.signal); }
    finally { request.raw.off('aborted', aborted); reply.raw.off('close', closed); }
  });
  app.get('/api/v1/settings/provider', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await requireSession(request);
    requireEmptyQuery(request);
    return service.get(actor);
  });
  app.put('/api/v1/settings/provider', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    requireEmptyQuery(request);
    requireJson(request);
    const parsed = providerProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid request body');
    return service.update(actor, parsed.data);
  });
}
