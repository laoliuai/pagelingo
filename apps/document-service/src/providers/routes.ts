import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { providerProfileUpdateSchema } from '@pagelingo/document-contracts';
import { requireJson, requireSession, requireWriteRequest } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import { createProvidersService } from './service.js';

function requireEmptyQuery(request: FastifyRequest): void {
  if (!z.strictObject({}).safeParse(request.query).success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid query');
}

export function registerProvidersRoutes(app: FastifyInstance): void {
  const service = createProvidersService({ db: app.authContext.db, keyring: app.authContext.config.keyring });
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
