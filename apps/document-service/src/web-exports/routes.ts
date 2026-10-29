import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createWebExportRequestSchema } from '@pagelingo/document-contracts';
import { requireSession, requireWriteRequest, requireJson } from '../auth/guards.js';
import { emptyQuery } from '../glossary/routes.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { sendStoredAsset } from '../documents/source-response.js';
import { createWebExportsService } from './service.js';
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError(400,'INVALID_REQUEST','Invalid export request');
  return result.data;
}
export function registerWebExportsRoutes(app: FastifyInstance, store: ObjectStore): void {
  const service = createWebExportsService({ db: app.authContext.db });
  const base = '/api/v1/documents/:id/web-exports';
  app.post(base, async (request,reply) => {
    if (request.headers.authorization) throw new ServiceError(401,'UNAUTHORIZED','Session required');
    const actor = await requireSession(request); await requireWriteRequest(request,actor); requireJson(request); emptyQuery(request);
    const { id } = parse(z.strictObject({ id: z.uuid() }),request.params);
    const key = parse(z.uuid(),request.headers['idempotency-key']);
    return reply.code(201).send(await service.create(actor,id,key,parse(createWebExportRequestSchema,request.body)));
  });
  for (const file of [false,true]) app.get(`${base}/:exportId${file ? '/file' : ''}`, async (request,reply) => {
    if (request.headers.authorization) throw new ServiceError(401,'UNAUTHORIZED','Session required');
    const actor = await requireSession(request); emptyQuery(request);
    const { id,exportId } = parse(z.strictObject({ id: z.uuid(), exportId: z.uuid() }),request.params);
    if (!file) return service.get(actor,id,exportId);
    const asset = await service.file(actor,id,exportId);
    return sendStoredAsset(request,reply,store,asset,{ mediaType: 'application/zip', filename: `${Array.from(asset.title).slice(0,150).join('')}.zip`, fallbackFilename: 'document-web-bundle.zip', download: true, authorize: () => service.file(actor,id,exportId) });
  });
}
