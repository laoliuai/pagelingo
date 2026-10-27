import type { FastifyInstance } from 'fastify';
import type { DeviceExchangeRequest } from '@pagelingo/document-contracts';
import { requireJson, requireSession, requireWriteRequest } from '../auth/guards.js';
import { createDevicesService } from './service.js';

export function registerDevicesRoutes(app: FastifyInstance): void {
  const service = createDevicesService(app.authContext.db);
  app.post('/api/v1/devices/pairing-codes', async (request, reply) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    requireJson(request);
    return reply.code(201).send(await service.createPairingCode(actor));
  });
  app.post('/api/v1/devices/exchange', async (request, reply) => {
    requireJson(request);
    // Identity comes exclusively from the code, never from cookies or client owner fields.
    return reply.code(201).send(await service.exchange(request.body as DeviceExchangeRequest, request.ip));
  });
  app.get('/api/v1/devices', async request => service.list(await requireSession(request)));
  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/revoke', async (request, reply) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    requireJson(request);
    await service.revoke(actor, request.params.id);
    return reply.code(204).send();
  });
}
