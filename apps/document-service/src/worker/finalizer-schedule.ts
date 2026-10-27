import type { Database } from '../db/database.js';
export interface FinalizerCandidate { id: string; epoch: string }
type Failure = FinalizerCandidate & { attempt: number; until: number };
type ReadCandidates = (after: string | null, cooling: readonly FinalizerCandidate[]) => Promise<FinalizerCandidate[]>;
/** Storage/replay retries only; never changes the SDK's durable endpoint cooldown. */
export class FinalizerSchedule {
  private cursor: string | null = null;
  private readonly failures = new Map<string,Failure>();
  constructor(private readonly now: () => number = Date.now) {}
  async next(read: ReadCandidates): Promise<FinalizerCandidate[]> {
    const cooling = [...this.failures.values()].filter(failure => failure.until > this.now());
    let jobs = await read(this.cursor,cooling);
    if (!jobs.length && this.cursor !== null) {
      this.cursor = null;
      jobs = await read(null,cooling);
    }
    // Advance for every selected candidate, including failures whose cooldown entry is evicted.
    if (jobs.length) this.cursor = jobs[jobs.length-1]!.id;
    return jobs;
  }
  succeeded(job: FinalizerCandidate): void { this.failures.delete(`${job.id}:${job.epoch}`); }
  failed(job: FinalizerCandidate): void {
    const key = `${job.id}:${job.epoch}`;
    const attempt = Math.min(7,(this.failures.get(key)?.attempt ?? 0)+1);
    if (!this.failures.has(key) && this.failures.size >= 1024) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(key,{ ...job, attempt, until: this.now()+Math.min(60000,1000*2**(attempt-1)) });
  }
}

/** Stable UUID order and exact epoch cooldown are both applied before the bounded page. */
export async function readFinalizerCandidates(db: Database, after: string | null, cooling: readonly FinalizerCandidate[]): Promise<FinalizerCandidate[]> {
  return (await db.pool.query<FinalizerCandidate>(`SELECT j.id,j.epoch FROM web_jobs j JOIN users u ON u.id=j.owner_id
    WHERE j.kind='translate' AND j.status IN ('cancelled','paused-config','partial','failed') AND u.active AND u.auth_version=j.auth_version
    AND j.finalized_epoch IS DISTINCT FROM j.epoch AND EXISTS (SELECT 1 FROM web_job_checkpoints c WHERE c.owner_id=j.owner_id AND c.job_id=j.id)
    AND NOT EXISTS (SELECT 1 FROM unnest($1::uuid[],$2::bigint[]) AS cooling(id,epoch) WHERE cooling.id=j.id AND cooling.epoch=j.epoch)
    AND ($3::uuid IS NULL OR j.id>$3::uuid)
    ORDER BY j.id LIMIT 10`, [cooling.map(failure => failure.id),cooling.map(failure => failure.epoch),after])).rows;
}
