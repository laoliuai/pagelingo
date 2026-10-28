import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireJson, requireSession, requireWriteRequest } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import { createDocumentLifecycleService } from './trash.js';
export function registerDocumentLifecycleRoutes(app: FastifyInstance): void {
  const service = createDocumentLifecycleService(app.authContext);
  app.post('/api/v1/documents/:id/trash', async request => {
    const actor = await requireSession(request); await requireWriteRequest(request, actor); requireJson(request);
    const params = z.strictObject({ id: z.uuid() }).safeParse(request.params);
    const body = z.strictObject({ expectedEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).safeParse(request.body);
    if (!params.success || !body.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid trash request');
    return service.trashDocument(actor, params.data.id, body.data.expectedEpoch);
  });
}
