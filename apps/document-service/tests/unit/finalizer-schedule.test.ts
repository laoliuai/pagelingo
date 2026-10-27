import { expect, it } from 'vitest';
import { FinalizerSchedule, type FinalizerCandidate } from '../../src/worker/finalizer-schedule.js';
const candidate = (number: number, epoch = '1'): FinalizerCandidate => ({
  id: `00000000-0000-4000-8000-${String(number).padStart(12,'0')}`, epoch,
});
/** Ordered candidate source only; scheduling/cooldown/eviction are the production helper. */
function source(rows: FinalizerCandidate[]) {
  let maxExcluded = 0;
  const calls: Array<string | null> = [];
  return {
    calls,
    maxExcluded: () => maxExcluded,
    read: async (after: string | null, excluded: readonly FinalizerCandidate[]) => {
      maxExcluded = Math.max(maxExcluded,excluded.length); calls.push(after);
      const cooling = new Set(excluded.map(row => `${row.id}:${row.epoch}`));
      return rows.filter(row => (!after || row.id > after) && !cooling.has(`${row.id}:${row.epoch}`)).slice(0,10);
    },
  };
}
it('reaches healthy row1035 beyond1034 failures despite1024-entry eviction, then wraps', async () => {
  const rows = Array.from({length:1035},(_,index) => candidate(index+1));
  const schedule = new FinalizerSchedule(() => 0);
  for (const row of rows.slice(0,1024)) schedule.failed(row);
  const reader = source(rows);
  const first = await schedule.next(reader.read);
  expect(first.map(row => row.id)).toEqual(Array.from({length:10},(_,index)=>candidate(1025+index).id));
  for (const row of first) schedule.failed(row);
  const second = await schedule.next(reader.read);
  expect(second).toEqual([candidate(1035)]);
  schedule.succeeded(second[0]!);
  rows.pop(); // Successful terminal publication removes this row from the eligible source.
  const third = await schedule.next(reader.read);
  expect(third.map(row => row.id)).toEqual(Array.from({length:10},(_,index)=>candidate(index+1).id));
  expect(reader.maxExcluded()).toBe(1024);
  expect(reader.calls).toEqual([null,candidate(1034).id,candidate(1035).id,null]);
});
it('excludes cooling exact epochs before the page limit while a new epoch remains eligible', async () => {
  const schedule = new FinalizerSchedule(() => 0);
  const rows = Array.from({length:12},(_,index)=>candidate(index+1));
  for (const row of rows.slice(0,11)) schedule.failed(row);
  const reader = source(rows);
  expect(await schedule.next(reader.read)).toEqual([candidate(12)]);
  rows[0] = candidate(1,'2');
  expect(await schedule.next(reader.read)).toEqual([candidate(1,'2'),candidate(12)]);
});
it('bounds exponential retry delay at60seconds, and success clears the current epoch', async () => {
  let now = 0;
  const schedule = new FinalizerSchedule(() => now);
  const row = candidate(1); const reader = source([row]);
  for (const delay of [1000,2000,4000,8000,16000,32000,60000,60000]) {
    schedule.failed(row);
    now += delay-1;
    expect(await schedule.next(reader.read)).toEqual([]);
    now++;
    expect(await schedule.next(reader.read)).toEqual([row]);
  }
  schedule.failed(row); schedule.succeeded(row);
  expect(await schedule.next(reader.read)).toEqual([row]);
});
