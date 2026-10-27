import { afterEach, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
it('validates and merges SDK terms, stores immutable revisions, isolates owners and rejects stale CAS', async () => {
  const t = await createServiceTestApp();
  closes.push(t.close);
  await bootstrapAdmin(t.db, { username: 'admin', password: 'correct password 123456' });
  const s = await login(t.app, 'admin', 'correct password 123456');
  const headers = { cookie: s.cookie, origin: t.config.publicOrigin, 'x-csrf-token': s.csrfToken };
  const url = '/api/v1/settings/glossary';
  expect((await t.app.inject({ url, headers })).json()).toEqual({ revision: 0, entries: [] });
  const entries = [
    { source: ' API ', target: '接口', policy: 'translate', domain: 'all' },
    { source: 'api', target: 'API', policy: 'keep', domain: 'all' },
  ];
  const put = (expectedRevision: number, values: unknown[] = entries) =>
    t.app.inject({ url, method: 'PUT', headers, payload: { expectedRevision, entries: values } });
  expect((await put(0)).json()).toEqual({ revision: 1, entries: [entries[1]] });
  expect((await put(0)).statusCode).toBe(409);
  expect((await put(1, [{ ...entries[0], target: '' }])).statusCode).toBe(400);
  expect(
    (
      await put(
        1,
        Array.from({ length: 5001 }, (_, i) => ({ ...entries[1], source: `term-${i}` })),
      )
    ).statusCode,
  ).toBe(400);
  expect((await put(1, [])).statusCode).toBe(200);
  expect((await t.db.pool.query('SELECT revision,entries FROM glossary_revisions ORDER BY revision')).rows).toEqual([
    { revision: 0, entries: [] },
    { revision: 1, entries: [entries[1]] },
    { revision: 2, entries: [] },
  ]);
  await expect(t.db.pool.query("UPDATE glossary_revisions SET entries='[]'")).rejects.toThrow();
  expect((await t.app.inject({ url, headers: { authorization: 'Bearer ' + 'x'.repeat(43) } })).statusCode).toBe(401);
  expect((await t.db.pool.query('SELECT id FROM web_jobs')).rows).toEqual([]);
});
