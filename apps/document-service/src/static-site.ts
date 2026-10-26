import { relative, sep } from 'node:path';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { RuntimeConfig } from './config.js';

/** Shared by production and browser tests; private API paths never receive the SPA. */
export async function registerStaticSite(
  app: FastifyInstance,
  config: RuntimeConfig,
): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.mode === 'production' ? [] : null,
      },
    },
  });
  const root = config.webDir;
  if (root) {
    await app.register(staticFiles, {
      root,
      wildcard: false,
      setHeaders(response, path) {
        response.header(
          'Cache-Control',
          relative(root, path).startsWith(`assets${sep}`)
            ? 'public, max-age=31536000, immutable'
            : 'no-store',
        );
      },
    });
  }
}
