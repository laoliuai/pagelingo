import { expect, it } from 'vitest';
import { PURGE_ROW_LIMIT, PURGE_OBJECT_LIMIT, purgeBackoffMs, purgePlan } from '../../src/document-lifecycle/purge-plan.js';
it('bounds deletion work and persists exponential retry delays', () => {
  expect(PURGE_ROW_LIMIT).toBe(500); expect(PURGE_OBJECT_LIMIT).toBe(100);
  expect([1,2,3,7,100].map(purgeBackoffMs)).toEqual([1000,2000,4000,60000,60000]);
});
it('deletes dependents before immutable materials without deleting global infrastructure', () => {
  const names = purgePlan.map(step => step.table);
  for (const [child,parent] of [['reader_chunks','reader_versions'],['web_reader_versions','web_translation_runs'],['web_translation_runs','web_jobs'],['web_jobs','web_parse_runs'],['source_versions','assets'],['assets','documents']]) expect(names.indexOf(child!)).toBeLessThan(names.indexOf(parent!));
  expect(names).not.toContain('document_metadata_backfill_cursor'); expect(names).not.toContain('users');
});
