import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertActorCurrent } from '../auth/guards.js';
import { purgeReceipt, type PurgeRow } from './repository.js';
import { requireJson, requireSession, requireWriteRequest } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { createDocumentLifecycleService } from './trash.js';
const idParams = z.strictObject({ id: z.uuid() });
const epochBody = z.strictObject({ expectedEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
export function registerDocumentLifecycleRoutes(app: FastifyInstance, store: ObjectStore): void {
  const service = createDocumentLifecycleService({ ...app.authContext,store });
  for (const operation of ['trash','restore'] as const) app.post(`/api/v1/documents/:id/${operation}`, async request => {
    const actor = await requireSession(request); await requireWriteRequest(request, actor); requireJson(request);
    const params = idParams.safeParse(request.params); const body = epochBody.safeParse(request.body);
    if (!params.success || !body.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid lifecycle request');
    return operation === 'trash' ? service.trashDocument(actor, params.data.id, body.data.expectedEpoch) : service.restoreDocument(actor,params.data.id,body.data.expectedEpoch);
  });
  app.get('/api/v1/trash', async request => {
    const actor = await requireSession(request);
    const query = z.strictObject({ limit:z.coerce.number().int().min(1).max(100).optional(),cursor:z.uuid().optional() }).safeParse(request.query);
    if (!query.success) throw new ServiceError(400,'INVALID_REQUEST','Invalid trash query');
    return service.listTrash(actor,query.data);
  });
  app.get('/api/v1/trash/:id/receipt', async request => {
    const actor = await requireSession(request); const params = idParams.safeParse(request.params);
    if (!params.success || Object.keys(request.query as object).length) throw new ServiceError(400,'INVALID_REQUEST','Invalid receipt request');
    return app.authContext.db.transaction(async client => {
      await assertActorCurrent(client,actor);
      const row=(await client.query<PurgeRow>('SELECT * FROM document_purges WHERE owner_id=$1 AND document_id=$2',[actor.userId,params.data.id])).rows[0];
      if (!row) throw new ServiceError(404,'NOT_FOUND','Receipt not found');
      return purgeReceipt(row);
    });
  });
  app.delete('/api/v1/trash/:id', async (request,reply) => {
    const actor = await requireSession(request); await requireWriteRequest(request,actor);
    const params = idParams.safeParse(request.params);
    if (!params.success) throw new ServiceError(400,'INVALID_REQUEST','Invalid document id');
    return reply.code(202).send(await service.requestDocumentPurge(actor,params.data.id));
  });
}
