import type { PoolClient } from 'pg';
import type { DeviceScope } from '@pagelingo/document-contracts';

export interface PairingInput {
  id: string; ownerId: string; authVersion: number; sessionId: string; codeHash: string; expiresAt: Date;
}
export interface PairingRow {
  id: string; owner_id: string; auth_version: number; session_id: string; code_hash: string;
  expires_at: Date; consumed_at: Date | null; created_at: Date;
}
export interface DeviceInput {
  id: string; ownerId: string; authVersion: number; pairingSessionId: string; tokenHash: string;
  name: string; extensionId: string; extensionVersion: string; scopes: DeviceScope[]; expiresAt: Date;
}
export interface DeviceRow {
  id: string; owner_id: string; auth_version: number; pairing_session_id: string; token_hash: string;
  name: string; extension_id: string; extension_version: string; scopes: DeviceScope[];
  created_at: Date; expires_at: Date; revoked_at: Date | null;
}
export async function readSiteId(client: PoolClient): Promise<string> {
  return (await client.query<{ site_id: string }>('SELECT site_id FROM site_metadata WHERE singleton')).rows[0]!.site_id;
}
/** Caller holds the owner's user lock and validates its current session. */
export async function insertPairing(client: PoolClient, input: PairingInput): Promise<void> {
  await client.query(`INSERT INTO device_pairings (id,owner_id,auth_version,session_id,code_hash,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6)`, [input.id,input.ownerId,input.authVersion,input.sessionId,input.codeHash,input.expiresAt]);
}
export async function consumePairing(client: PoolClient, codeHash: string): Promise<PairingRow | undefined> {
  return (await client.query<PairingRow>(`UPDATE device_pairings SET consumed_at=clock_timestamp()
    WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING *`, [codeHash])).rows[0];
}
export async function insertDevice(client: PoolClient, input: DeviceInput): Promise<void> {
  await client.query(`INSERT INTO devices (id,owner_id,auth_version,pairing_session_id,token_hash,name,extension_id,extension_version,scopes,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.id,input.ownerId,input.authVersion,input.pairingSessionId,input.tokenHash,input.name,input.extensionId,input.extensionVersion,input.scopes,input.expiresAt]);
}
export async function findDeviceByTokenHash(client: PoolClient, hash: string): Promise<DeviceRow | undefined> {
  return (await client.query<DeviceRow>('SELECT * FROM devices WHERE token_hash=$1', [hash])).rows[0];
}
export async function listDevices(client: PoolClient, ownerId: string): Promise<DeviceRow[]> {
  return (await client.query<DeviceRow>('SELECT * FROM devices WHERE owner_id=$1 ORDER BY created_at,id', [ownerId])).rows;
}
export async function revokeDevice(client: PoolClient, ownerId: string, id: string): Promise<boolean> {
  return (await client.query('UPDATE devices SET revoked_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL', [ownerId,id])).rowCount === 1;
}
export async function revokeSessionDevices(client: PoolClient, ownerId: string, sessionId: string): Promise<number> {
  return (await client.query('UPDATE devices SET revoked_at=clock_timestamp() WHERE owner_id=$1 AND pairing_session_id=$2 AND revoked_at IS NULL', [ownerId,sessionId])).rowCount!;
}
