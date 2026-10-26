import Fastify from 'fastify';
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

export async function createApp({ db }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-PageLingo-API-Version', 'pagelingo-site-api/1');
  });
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
  app.setErrorHandler((_error, request, reply) => {
    const body: ErrorResponse = { error: { code: 'INTERNAL_ERROR', message: 'Internal service error', requestId: request.id } };
    return reply.code(500).send(body);
  });
  return app;
}
