// @vitest-environment node
import { expect, it } from 'vitest';
import { recoveryAlarmMode } from '../../src/background/job-policy';
import type { JobRecord } from '../../src/background/database';
it('bounds recovery wakeups without invalidating persisted paused attempts', () => {
  const jobs = [{ status: 'paused', updatedAt: 100000 }] as JobRecord[];
  expect(recoveryAlarmMode(jobs, 110000)).toBe('confirm');
  expect(recoveryAlarmMode(jobs, 230000)).toBe('off');
  expect(recoveryAlarmMode([{ ...jobs[0], status: 'running' }], 230000)).toBe('active');
  expect(recoveryAlarmMode([{ ...jobs[0], status: 'completed' }], 110000)).toBe('off');
});
