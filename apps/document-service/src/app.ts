import { registerGlossaryRoutes } from './glossary/routes.js';
import { registerWebJobsRoutes } from './web-jobs/routes.js';
import { createCaptureJobScheduler } from './web-jobs/service.js';
import { registerDocumentLinksRoutes } from './web-captures/links.js';
import { registerDocumentManagementRoutes } from './document-management/routes.js';
import { registerStaticSite } from './static-site.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { createLocalObjectStore } from './storage/local-object-store.js';
import { registerDocumentsRoutes } from './documents/routes.js';
import { registerBundleImportsRoutes } from './bundle-imports/routes.js';
import { registerWebReadersRoutes } from './web-readers/routes.js';
import { registerWebCapturesRoutes } from './web-captures/routes.js';
import { registerReadersRoutes } from './readers/routes.js';
import { ServiceError } from './errors.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerUsersRoutes } from './users/routes.js';
import { registerProvidersRoutes } from './providers/routes.js';
import { registerDevicesRoutes } from './devices/routes.js';
import { createOutboundFetch } from './network/safe-fetch.js';
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

export async function createApp({ db, config, outboundFetch }: AppOptions): Promise<FastifyInstance> {
  if (outboundFetch && config.mode !== 'test') throw new Error('Outbound fetch injection requires test mode');
  const providerFetch = outboundFetch ?? createOutboundFetch({ timeoutMs: 10_000, maxResponseBytes: 1024 * 1024 });
  const app = Fastify({ logger: false });
  app.decorate('authContext', { db, config });
  await app.register(cookie);
  await app.register(multipart);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-PageLingo-API-Version', 'pagelingo-site-api/1');
    if (_request.url.split('?')[0] === '/api' || _request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  await registerStaticSite(app, config);
  registerAuthRoutes(app);
  registerDevicesRoutes(app);
  registerUsersRoutes(app);
  registerProvidersRoutes(app, providerFetch);
  const store = createLocalObjectStore(config.dataDir);
  registerDocumentsRoutes(app, store);
  registerDocumentManagementRoutes(app);
  registerBundleImportsRoutes(app, store);
  registerReadersRoutes(app, store);
  registerGlossaryRoutes(app);
  registerWebJobsRoutes(app, store);
  registerWebCapturesRoutes(app, store, createCaptureJobScheduler());
  registerDocumentLinksRoutes(app);
  registerWebReadersRoutes(app, store);
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
    const path = request.url.split('?')[0]!;
    if (config.webDir && ['GET', 'HEAD'].includes(request.method) && !/^\/(api|assets|health)(\/|$)/.test(path) && !path.split('/').at(-1)?.includes('.')) {
      return reply.header('Cache-Control', 'no-store').sendFile('index.html');
    }
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
