import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSession, requireWriteRequest } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import { createDocumentManagementService } from './service.js';
import type { PatchDocumentOrganization } from '@pagelingo/document-contracts';
import type { RelationInput } from './relations.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid management request');
  return result.data;
}
function id(request: FastifyRequest) { return parse(z.strictObject({ id: z.uuid() }), request.params).id; }
const empty = z.strictObject({});

export function registerDocumentManagementRoutes(app: FastifyInstance): void {
  const service = createDocumentManagementService(app.authContext);
  const write = async (request: FastifyRequest) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    parse(empty, request.query);
    return actor;
  };
  app.get('/api/v1/library', async request => service.library(await requireSession(request), request.query));
  app.get('/api/v1/documents/:id/organization', async request => {
    const actor = await requireSession(request); parse(empty, request.query);
    return service.getOrganization(actor, id(request));
  });
  app.patch('/api/v1/documents/:id/organization', async request => service.patchOrganization(await write(request), id(request), request.body as PatchDocumentOrganization));
  for (const type of ['collections', 'tags'] as const) {
    app.get(`/api/v1/${type}`, async request => service.taxonomyList(await requireSession(request), type, request.query));
    app.post(`/api/v1/${type}`, async (request, reply) => reply.code(201).send(await service.taxonomySave(await write(request), type, request.body)));
    app.get(`/api/v1/${type}/:id`, async request => {
      const actor = await requireSession(request); parse(empty, request.query);
      return service.taxonomyGet(actor, type, id(request));
    });
    app.patch(`/api/v1/${type}/:id`, async request => service.taxonomySave(await write(request), type, request.body, id(request)));
    app.delete(`/api/v1/${type}/:id`, async (request, reply) => {
      await service.taxonomyDelete(await write(request), type, id(request));
      return reply.code(204).send();
    });
  }
  app.get('/api/v1/documents/:id/relations', async request => service.relations(await requireSession(request), id(request), request.query));
  for (const method of ['POST', 'DELETE'] as const) app.route({
    method, url: '/api/v1/document-relations',
    handler: async request => service.relationWrite(await write(request), request.body as RelationInput, method === 'DELETE'),
  });
}
