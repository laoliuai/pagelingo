import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createWebJobRequestSchema,
  retryWebJobRequestSchema,
  savePreferencesUpdateSchema,
} from '@pagelingo/document-contracts';
import { requireSession, requireWriteRequest, requireJson } from '../auth/guards.js';
import { requireCapturePrincipal } from '../devices/guards.js';
import { emptyQuery } from '../glossary/routes.js';
import type { ObjectStore } from '../storage/object-store.js';
import { ServiceError } from '../errors.js';
import { createSavePreferencesService } from './preferences.js';
import { createWebJobsService } from './service.js';
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid request');
  return p.data;
}
export function registerWebJobsRoutes(app: FastifyInstance, store: ObjectStore): void {
  const preferences = createSavePreferencesService({ db: app.authContext.db });
  const jobs = createWebJobsService({ db: app.authContext.db, store });
  app.get('/api/v1/settings/save-preferences', async (request) => {
    const p = await requireCapturePrincipal(request, 'preferences:read');
    emptyQuery(request);
    return preferences.get(p);
  });
  app.put('/api/v1/settings/save-preferences', async (request) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    requireJson(request);
    emptyQuery(request);
    return preferences.update(actor, parse(savePreferencesUpdateSchema, request.body));
  });
  app.post('/api/v1/documents/:id/web-jobs', async (request, reply) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    requireJson(request);
    emptyQuery(request);
    return reply
      .code(201)
      .send(
        await jobs.create(
          actor,
          parse(z.strictObject({ id: z.uuid() }), request.params).id,
          parse(createWebJobRequestSchema, request.body),
        ),
      );
  });
  app.get('/api/v1/web-jobs/:id', async (request) => {
    const actor = await requireSession(request);
    emptyQuery(request);
    return jobs.get(actor, parse(z.strictObject({ id: z.uuid() }), request.params).id);
  });
  for (const action of ['cancel', 'retry'] as const)
    app.post(`/api/v1/web-jobs/:id/${action}`, async (request) => {
      const actor = await requireSession(request);
      await requireWriteRequest(request, actor);
      requireJson(request);
      emptyQuery(request);
      const id = parse(z.strictObject({ id: z.uuid() }), request.params).id;
      if (action === 'retry') return jobs.retry(actor, id, parse(retryWebJobRequestSchema, request.body));
      parse(z.strictObject({}), request.body);
      return jobs.cancel(actor, id);
    });
}
