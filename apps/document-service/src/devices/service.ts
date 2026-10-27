import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { deviceExchangeRequestSchema } from '@pagelingo/document-contracts';
import type { DeviceDTO, DeviceExchangeRequest, DeviceExchangeResult, DeviceList, DeviceScope, PairingCode } from '@pagelingo/document-contracts';
import { assertActorCurrent } from '../auth/guards.js';
import { consumeRateLimit } from '../auth/rate-limit.js';
import { tokenHash } from '../auth/sessions.js';
import type { Actor, UserRow } from '../auth/sessions.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import { consumePairing, insertDevice, insertPairing, listDevices, readSiteId, revokeDevice } from './repository.js';
import type { DeviceRow, PairingRow } from './repository.js';

const scopes: DeviceScope[] = ['captures:write', 'captures:read', 'links:write', 'preferences:read'];
function deviceDTO(row: DeviceRow): DeviceDTO {
  return { id: row.id, name: row.name, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null };
}
function unauthorized(): never { throw new ServiceError(401, 'UNAUTHORIZED', 'Authentication required'); }

export function createDevicesService(db: Database) {
  return {
    async createPairingCode(actor: Actor): Promise<PairingCode> {
      return db.transaction(async client => {
        await assertActorCurrent(client, actor);
        await consumeRateLimit(client, { scope: 'device-pairing-create', subject: actor.userId, limit: 5, windowSeconds: 60 });
        const session = (await client.query<{ id: string }>('SELECT id FROM sessions WHERE token_hash=$1', [actor.sessionHash])).rows[0]!;
        const code = randomBytes(32).toString('base64url');
        const expiresAt = (await client.query<{ expiry: Date }>("SELECT clock_timestamp()+interval '5 minutes' AS expiry")).rows[0]!.expiry;
        await insertPairing(client, { id: randomUUID(), ownerId: actor.userId, authVersion: actor.authVersion, sessionId: session.id, codeHash: tokenHash(code), expiresAt });
        return { code, expiresAt: expiresAt.toISOString() };
      });
    },
    async exchange(input: DeviceExchangeRequest, ip: string): Promise<DeviceExchangeResult> {
      // Commit the IP quota separately: rejected codes must not refund attempts.
      await db.transaction(client => consumeRateLimit(client, { scope: 'device-pairing-exchange', subject: ip, limit: 30, windowSeconds: 60 }));
      const parsed = deviceExchangeRequestSchema.safeParse(input);
      if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid request body');
      const value = parsed.data;
      return db.transaction(async client => {
        const hash = tokenHash(value.code);
        // Discovery only. Lock order for consumption remains user -> session -> pairing.
        const pairing = (await client.query<PairingRow>('SELECT * FROM device_pairings WHERE code_hash=$1', [hash])).rows[0];
        if (!pairing) unauthorized();
        const user = (await client.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [pairing.owner_id])).rows[0];
        if (!user?.active || user.auth_version !== pairing.auth_version) unauthorized();
        const session = await client.query(`SELECT id FROM sessions WHERE id=$1 AND user_id=$2
          AND auth_version=$3 AND expires_at>clock_timestamp() FOR UPDATE`, [pairing.session_id, user.id, user.auth_version]);
        if (!session.rowCount || !await consumePairing(client, hash)) unauthorized();
        const token = randomBytes(32).toString('base64url');
        const expiresAt = (await client.query<{ expiry: Date }>("SELECT clock_timestamp()+interval '30 days' AS expiry")).rows[0]!.expiry;
        const id = randomUUID();
        await insertDevice(client, { id, ownerId: user.id, authVersion: user.auth_version, pairingSessionId: pairing.session_id,
          tokenHash: tokenHash(token), name: value.deviceName, extensionId: value.extensionId, extensionVersion: value.extensionVersion, scopes, expiresAt });
        const device = (await client.query<DeviceRow>('SELECT * FROM devices WHERE id=$1', [id])).rows[0]!;
        return { token, device: deviceDTO(device), owner: { id: user.id, username: user.username }, siteId: await readSiteId(client) };
      });
    },
    async list(actor: Actor): Promise<DeviceList> {
      return db.transaction(async client => {
        await assertActorCurrent(client, actor);
        return { items: (await listDevices(client, actor.userId)).map(deviceDTO) };
      });
    },
    async revoke(actor: Actor, deviceId: string): Promise<void> {
      const id = z.uuid().safeParse(deviceId);
      if (!id.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid device ID');
      await db.transaction(async client => {
        await assertActorCurrent(client, actor);
        // Idempotent for this owner; other owners receive the same response as absent IDs.
        const row = await client.query('SELECT id FROM devices WHERE owner_id=$1 AND id=$2 FOR UPDATE', [actor.userId, id.data]);
        if (!row.rowCount) throw new ServiceError(404, 'NOT_FOUND', 'Device not found');
        await revokeDevice(client, actor.userId, id.data);
      });
    },
  };
}
