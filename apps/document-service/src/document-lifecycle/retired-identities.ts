import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ServiceError } from '../errors.js';
export const identityDigest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Compare the original database timestamps, never JS Date's truncated milliseconds. */
export async function assertIdentityNotRetired(client: PoolClient, ownerId: string, kind: 'url' | 'source-sha256', identity: string, admission: { table: 'ingestions' | 'bundle_imports' | 'web_captures'; key: string }): Promise<void> {
  const column = admission.table === 'ingestions' ? 'idempotency_key' : 'id';
  const retired = await client.query(`SELECT 1 FROM retired_document_identities r JOIN ${admission.table} a ON a.owner_id=r.owner_id
    WHERE a.owner_id=$1 AND a.${column}=$2 AND r.identity_kind=$3 AND r.identity_digest=$4 AND a.created_at<=r.retired_at LIMIT 1`, [ownerId, admission.key, kind, identityDigest(identity)]);
  if (retired.rowCount) throw new ServiceError(409, 'DOCUMENT_RETIRED', 'Operation predates document retirement');
}

export type OperationKind = 'pdf-upload' | 'bundle-import-id' | 'web-capture-id' | 'bundle-import' | 'web-capture' | 'document-link' | 'web-job' | 'web-job-request';
export interface RequestScope { documentId: string; authVersion: number }
/** These receipt hashes are separate from immutable semantic/SDK input hashes. */
export function operationKeyDigest(kind: OperationKind, key: string, scope?: RequestScope): string {
  const identity = kind === 'pdf-upload' || kind === 'bundle-import' ? key : key.toLowerCase();
  if (kind === 'web-job-request') {
    if (!scope) throw new Error('Manual job receipt requires document and auth scope');
    return identityDigest(JSON.stringify([kind, scope.documentId.toLowerCase(), scope.authVersion, identity]));
  }
  return identityDigest(JSON.stringify([kind, identity]));
}
/** Task 4 writes receipts before removing ingress rows; old keys never authorize new work. */
export async function assertOperationNotRetired(client: PoolClient, ownerId: string, kind: OperationKind, key: string, scope?: RequestScope): Promise<void> {
  if ((await client.query('SELECT 1 FROM retired_operations WHERE owner_id=$1 AND operation_kind=$2 AND key_digest=$3', [ownerId,kind,operationKeyDigest(kind,key,scope)])).rowCount) throw new ServiceError(410, 'DOCUMENT_PURGED', 'Operation belongs to a purged document');
}
