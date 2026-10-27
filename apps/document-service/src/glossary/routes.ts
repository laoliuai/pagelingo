import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { glossaryUpdateSchema } from '@pagelingo/document-contracts';
import { MAX_GLOSSARY_FILE_BYTES } from '@pagelingo/translation-core';
import { requireJson, requireSession, requireWriteRequest } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import { createGlossaryService } from './service.js';
export function emptyQuery(request: FastifyRequest): void {
  if (!z.strictObject({}).safeParse(request.query).success)
    throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid query');
}
export function registerGlossaryRoutes(app: FastifyInstance): void {
  const service = createGlossaryService({ db: app.authContext.db });
  app.get('/api/v1/settings/glossary', async (request) => {
    const actor = await requireSession(request);
    emptyQuery(request);
    return service.get(actor);
  });
  app.put('/api/v1/settings/glossary', { bodyLimit: MAX_GLOSSARY_FILE_BYTES }, async (request) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    requireJson(request);
    emptyQuery(request);
    const parsed = glossaryUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid glossary');
    return service.update(actor, parsed.data);
  });
}
