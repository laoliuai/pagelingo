import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { createLocalObjectStore } from './storage/local-object-store.js';
import { registerDocumentsRoutes } from './documents/routes.js';
import { ServiceError } from './errors.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerUsersRoutes } from './users/routes.js';
import type { FastifyInstance } from 'fastify';
import type { ErrorResponse } from '@pagelingo/document-contracts';
import type { RuntimeConfig } from './config.js';
import type { Database } from './db/database.js';
import { verifyDatabaseSchema } from './db/migrate.js';

export interface AppOptions {
  config: RuntimeConfig;
  db: Database;
  outboundFetch?: typeof fetch;
}

export async function createApp({ db, config }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('authContext', { db, config });
  await app.register(cookie);
  await app.register(multipart);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-PageLingo-API-Version', 'pagelingo-site-api/1');
  });
  registerAuthRoutes(app);
  registerUsersRoutes(app);
  registerDocumentsRoutes(app, createLocalObjectStore(config.dataDir));
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (request, reply) => {
    try {
      await verifyDatabaseSchema(db);
      return { status: 'ok' };
    } catch {
      const body: ErrorResponse = {
        error: { code: 'SERVICE_NOT_READY', message: 'Service is not ready', requestId: request.id },
      };
      return reply.code(503).send(body);
    }
  });
  app.setNotFoundHandler((request, reply) => {
    const body: ErrorResponse = { error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id } };
    return reply.code(404).send(body);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) {
      if (error.retryAfter !== undefined) reply.header('Retry-After', error.retryAfter);
      const body: ErrorResponse = { error: { code: error.code, message: error.message, requestId: request.id } };
      return reply.code(error.statusCode).send(body);
    }
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      const body: ErrorResponse = { error: { code: 'INVALID_REQUEST', message: 'Invalid request', requestId: request.id } };
      return reply.code(error.statusCode).send(body);
    }
    const body: ErrorResponse = { error: { code: 'INTERNAL_ERROR', message: 'Internal service error', requestId: request.id } };
    return reply.code(500).send(body);
  });
  return app;
}
