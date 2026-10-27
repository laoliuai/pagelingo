import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { DeviceScope } from '@pagelingo/document-contracts';
import { assertActorCurrent, requireSession, requireWriteRequest } from '../auth/guards.js';
import { tokenHash } from '../auth/sessions.js';
import type { Actor } from '../auth/sessions.js';
import { ServiceError } from '../errors.js';
import { findDeviceByTokenHash } from './repository.js';

/** Internal identity, never accepted from request JSON or exposed as a DTO. */
export interface DeviceActor {
  kind: 'device';
  deviceId: string;
  userId: string;
  authVersion: number;
  tokenHash: string;
  scopes: DeviceScope[];
  scope: DeviceScope;
}
export type CapturePrincipal = { kind: 'session'; actor: Actor } | DeviceActor;
function unauthorized(): never { throw new ServiceError(401, 'UNAUTHORIZED', 'Authentication required'); }

/** Acquire user -> device locks inside the final write/publication transaction. */
export async function assertCapturePrincipalCurrent(client: PoolClient, principal: CapturePrincipal): Promise<void> {
  if (principal.kind === 'session') return assertActorCurrent(client, principal.actor);
  const user = (await client.query('SELECT active,auth_version FROM users WHERE id=$1 FOR UPDATE', [principal.userId])).rows[0];
  if (!user?.active || user.auth_version !== principal.authVersion) unauthorized();
  const device = (await client.query<{ scopes: DeviceScope[] }>(`SELECT scopes FROM devices
    WHERE id=$1 AND owner_id=$2 AND token_hash=$3 AND auth_version=$4
    AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
  [principal.deviceId, principal.userId, principal.tokenHash, principal.authVersion])).rows[0];
  if (!device) unauthorized();
  if (!device.scopes.includes(principal.scope)) throw new ServiceError(403, 'FORBIDDEN', 'Device scope required');
}

/** Cookie writes retain Origin/CSRF; explicit Authorization always chooses device auth. */
export async function requireCapturePrincipal(request: FastifyRequest, scope: DeviceScope): Promise<CapturePrincipal> {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    const actor = await requireSession(request);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) await requireWriteRequest(request, actor);
    return { kind: 'session', actor };
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
  if (!match) unauthorized();
  return request.server.authContext.db.transaction(async client => {
    const hash = tokenHash(match[1]!);
    const row = await findDeviceByTokenHash(client, hash);
    if (!row) unauthorized();
    const principal: DeviceActor = { kind: 'device', deviceId: row.id, userId: row.owner_id,
      authVersion: row.auth_version, tokenHash: hash, scopes: row.scopes, scope };
    await assertCapturePrincipalCurrent(client, principal);
    return principal;
  });
}
