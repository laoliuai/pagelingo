import { CheckpointConflictError, type TranslationStateStore, type PlannedUnit } from '@pagelingo/translation-core';
import type { Database } from '../db/database.js';
import { loadJobCheckpoint, saveJobCheckpoint, type JobLease } from './repository.js';
/** SDK storage failure must stop this durable job, never fall back to memory-only execution. */
export function createJobStateStore(lease: JobLease, db: Database, units: readonly PlannedUnit[] = []): TranslationStateStore {
  const blockIndices = new Map(units.map(unit => [unit.id, unit.blockIndex]));
  async function fenced<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw new CheckpointConflictError('Durable checkpoint unavailable or superseded'); }
  }
  return {
    load: () => fenced(() => db.transaction(client => loadJobCheckpoint(client, lease))),
    save: (checkpoint, cacheWrites) => fenced(() => db.transaction(async client => {
      await saveJobCheckpoint(client, lease, checkpoint, cacheWrites);
      // Public SDK planning supplies ownership; a confirmed whole block covers its units.
      await client.query('UPDATE web_jobs SET completed_units=$2,total_units=$3 WHERE id=$1', [lease.jobId, checkpoint.units.filter(unit => unit.status === 'completed' || blockIndices.has(unit.id) && Object.hasOwn(checkpoint.blocks, String(blockIndices.get(unit.id)))).length, checkpoint.units.length]);
    })),
  };
}
