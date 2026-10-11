import type { JobRecord } from './database';

/** Keep active work alive; confirmation of paused pages has a finite wake window. */
export function recoveryAlarmMode(jobs: JobRecord[], now = Date.now()): 'active' | 'confirm' | 'off' {
  if (jobs.some((job) => job.status === 'running')) return 'active';
  if (jobs.some((job) => job.status === 'paused' && now - job.updatedAt < 120000)) return 'confirm';
  return 'off';
}
