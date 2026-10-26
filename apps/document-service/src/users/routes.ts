import { createUserRequestSchema, resetPasswordRequestSchema, updateUserRequestSchema } from '@pagelingo/document-contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireJson, requireSession, requireWriteRequest } from '../auth/guards.js';
import { ServiceError } from '../errors.js';
import { createUsersService } from './service.js';

function body<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  requireJson(request);
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid request body');
  return parsed.data;
}
function userId(request: FastifyRequest): string {
  const parsed = z.strictObject({ id: z.uuid() }).safeParse(request.params);
  if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid user ID');
  return parsed.data.id;
}

export function registerUsersRoutes(app: FastifyInstance): void {
  const service = createUsersService(app.authContext.db);
  app.get('/api/v1/admin/users', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service.list(await requireSession(request));
  });
  app.post('/api/v1/admin/users', async (request, reply) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    const input = body(createUserRequestSchema, request);
    const user = await service.create(actor, input);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(user);
  });
  app.patch('/api/v1/admin/users/:id', async (request, reply) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    const input = body(updateUserRequestSchema, request);
    const user = await service.setActive(actor, userId(request), input.active);
    reply.header('Cache-Control', 'no-store');
    return user;
  });
  app.post('/api/v1/admin/users/:id/reset-password', async (request, reply) => {
    const actor = await requireSession(request);
    await requireWriteRequest(request, actor);
    const input = body(resetPasswordRequestSchema, request);
    await service.resetPassword(actor, userId(request), input.newPassword);
    reply.header('Cache-Control', 'no-store');
    return reply.code(204).send();
  });
}
