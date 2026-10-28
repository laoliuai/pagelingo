import type { TranslationCache } from '@pagelingo/translation-core';
import type { Database } from '../db/database.js';
import { assertJobLeaseCurrent, recordCacheReferences, readOwnerCache, putOwnerCache, deleteOwnerCache, type JobLease } from './repository.js';
/** Owner derives from a verified lease, not a client-supplied cache namespace. */
export function createOwnerCache(ownerId: string, lease: JobLease, db: Database): TranslationCache {
  if (ownerId !== lease.ownerId) throw new Error('Cache owner mismatch');
  const owned = <T>(operation: (client: import('pg').PoolClient) => Promise<T>) => db.transaction(async client => {
    await assertJobLeaseCurrent(client, lease); return operation(client);
  });
  return {
    get: key => owned(async client => { const value = await readOwnerCache(client, ownerId, key); if (value) await recordCacheReferences(client, lease, [key]); return value; }),
    putMany: entries => owned(async client => { await putOwnerCache(client, ownerId, entries); await recordCacheReferences(client, lease, entries.map(entry => entry.key)); }),
    delete: key => owned(client => deleteOwnerCache(client, ownerId, key)),
  };
}
