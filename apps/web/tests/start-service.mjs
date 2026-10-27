import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../../document-service/dist/db/database.js';
import { migrateDatabase } from '../../document-service/dist/db/migrate.js';
import { bootstrapAdmin } from '../../document-service/dist/cli/bootstrap-admin.js';
import { defaultCaptureLimits, defaultBundleLimits } from '@pagelingo/document-contracts';
import { createApp } from '../../document-service/dist/app.js';
const url = process.env.PAGELINGO_TEST_DATABASE_URL;
if (!url) throw new Error('An isolated test PostgreSQL URL is required');
const schema = `pgl_web_${randomUUID().replaceAll('-', '')}`;
const admin = openDatabase(url);
let db, app, dataDir;
let modelCalls = 0;
async function close() {
  try {
    await app?.close();
  } finally {
    try {
      await db?.close();
      await admin.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.close();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    }
  }
}
try {
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  db = openDatabase(url, schema);
  dataDir = await mkdtemp(join(tmpdir(), 'pgl-web-'));
  await migrateDatabase(db);
  await bootstrapAdmin(db, { username: 'admin', password: 'test-admin-password' });
  app = await createApp({
    db,
    config: {
      mode: 'test',
      host: '127.0.0.1',
      port: 4338,
      publicOrigin: 'http://127.0.0.1:4338',
      databaseUrl: url,
      dataDir,
      webDir: resolve('dist'),
      maxPdfBytes: 1024 * 1024,
      captureLimits: { ...defaultCaptureLimits },
      bundleLimits: { ...defaultBundleLimits, maxPdfBytes: 1024 * 1024, maxArchiveBytes: 4 * 1024 * 1024 },
      keyring: { activeKeyId: 'test', keys: { test: randomBytes(32) } },
    },
    outboundFetch: async () => {
      modelCalls++;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                translations: [{ id: 'connection-test', text: '你好。' }],
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    },
  });
  app.get('/__test/metrics', async () => ({ modelCalls }));
  // Fault injection operates on this runner's disposable real object store only.
  app.post('/__test/missing-source/:id', async (request, reply) => {
    const { rows } = await db.pool.query(
      'SELECT object_key FROM assets WHERE document_id = $1',
      [request.params.id],
    );
    if (!rows[0]) return reply.code(404).send();
    await rename(
      join(dataDir, 'objects', rows[0].object_key),
      join(dataDir, 'objects', `${rows[0].object_key}.missing`),
    );
    return reply.code(204).send();
  });
  await app.listen({ host: '127.0.0.1', port: 4338 });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
} catch (error) {
  await close();
  throw error;
}
