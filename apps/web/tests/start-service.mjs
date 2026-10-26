import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../../document-service/dist/db/database.js';
import { migrateDatabase } from '../../document-service/dist/db/migrate.js';
import { bootstrapAdmin } from '../../document-service/dist/cli/bootstrap-admin.js';
import { createApp } from '../../document-service/dist/app.js';
const url = process.env.PAGELINGO_TEST_DATABASE_URL;
if (!url) throw new Error('An isolated test PostgreSQL URL is required');
const schema = `pgl_web_${randomUUID().replaceAll('-', '')}`;
const admin = openDatabase(url);
let db, app, dataDir;
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
      keyring: { activeKeyId: 'test', keys: { test: randomBytes(32) } },
    },
    outboundFetch: async () =>
      Response.json({
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
      }),
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
