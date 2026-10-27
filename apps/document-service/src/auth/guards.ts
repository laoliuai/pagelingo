import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from '../db/database.js';
import type { RuntimeConfig } from '../config.js';
import { ServiceError } from '../errors.js';
import { readSession } from './sessions.js';
import type { Actor } from './sessions.js';
export type { Actor } from './sessions.js';

declare module 'fastify' {
  interface FastifyInstance { authContext: { db: Database; config: RuntimeConfig } }
}
export function requireOrigin(request: FastifyRequest): void {
  if (request.headers.origin !== request.server.authContext.config.publicOrigin) {
    throw new ServiceError(403, 'FORBIDDEN', 'Request origin is not allowed');
  }
}
export function requireJson(request: FastifyRequest): void {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ServiceError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json');
  }
}
export async function requireSession(request: FastifyRequest): Promise<Actor> {
  const session = await readSession(request);
  if (!session) throw new ServiceError(401, 'UNAUTHORIZED', 'Authentication required');
  return session.actor;
}
export async function requireWriteRequest(request: FastifyRequest, actor: Actor): Promise<void> {
  requireOrigin(request);
  const supplied = request.headers['x-csrf-token'];
  const session = await readSession(request);
  if (typeof supplied !== 'string' || !session || session.actor.sessionHash !== actor.sessionHash ||
      session.actor.userId !== actor.userId || session.actor.authVersion !== actor.authVersion ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(session.view.csrfToken) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.view.csrfToken))) {
    throw new ServiceError(403, 'FORBIDDEN', 'Invalid CSRF token');
  }
}
/** Call inside a transaction. All account mutations must lock the user first, then sessions. */
export async function assertActorCurrent(client: PoolClient, actor: Actor): Promise<void> {
  const user = (await client.query('SELECT role, active, auth_version FROM users WHERE id = $1 FOR UPDATE', [actor.userId])).rows[0];
  if (!user?.active || user.auth_version !== actor.authVersion || user.role !== actor.role) {
    throw new ServiceError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const session = await client.query(`SELECT id FROM sessions WHERE token_hash = $1 AND user_id = $2
    AND auth_version = $3 AND expires_at > clock_timestamp() FOR UPDATE`, [actor.sessionHash, actor.userId, actor.authVersion]);
  if (!session.rowCount) throw new ServiceError(401, 'UNAUTHORIZED', 'Authentication required');
}
