import type { TranslationCache } from '@pagelingo/translation-core';
import type { Database } from '../db/database.js';
import { assertJobLeaseCurrent, readOwnerCache, putOwnerCache, deleteOwnerCache, type JobLease } from './repository.js';
/** Owner derives from a verified lease, not a client-supplied cache namespace. */
export function createOwnerCache(ownerId: string, lease: JobLease, db: Database): TranslationCache {
  if (ownerId !== lease.ownerId) throw new Error('Cache owner mismatch');
  const owned = <T>(operation: (client: import('pg').PoolClient) => Promise<T>) => db.transaction(async client => {
    await assertJobLeaseCurrent(client, lease); return operation(client);
  });
  return {
    get: key => owned(client => readOwnerCache(client, ownerId, key)),
    putMany: entries => owned(client => putOwnerCache(client, ownerId, entries)),
    delete: key => owned(client => deleteOwnerCache(client, ownerId, key)),
  };
}
