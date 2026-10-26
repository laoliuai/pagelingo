import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createTestDatabase } from './database.js';

export async function createServiceTestApp(options: { outboundFetch?: typeof fetch } = {}) {
  const test = await createTestDatabase();
  let dataDir: string | undefined;
  try {
    dataDir = await mkdtemp(join(tmpdir(), 'pgl-test-'));
    const createdDataDir = dataDir;
    const config = readConfig({
      PAGELINGO_SITE_MODE: 'test', PAGELINGO_SITE_ORIGIN: 'http://127.0.0.1:5174',
      PAGELINGO_DATA_DIR: dataDir, DATABASE_URL: process.env.PAGELINGO_TEST_DATABASE_URL,
      PAGELINGO_MASTER_KEY_ID: 'test', PAGELINGO_MASTER_KEYS_JSON: JSON.stringify({ test: Buffer.alloc(32, 9).toString('base64') }),
    });
    await migrateDatabase(test.db);
    const outboundFetch: typeof fetch = options.outboundFetch ?? (async () => { throw new Error('Unexpected outbound request in service test'); });
    const app = await createApp({ config, db: test.db, outboundFetch });
    return {
      app, db: test.db, config,
      async close() {
        try { await app.close(); }
        finally {
          try { await test.dispose(); }
          finally { await rm(createdDataDir, { recursive: true, force: true }); }
        }
      },
    };
  } catch (error) {
    try { await test.dispose(); }
    finally { if (dataDir) await rm(dataDir, { recursive: true, force: true }); }
    throw error;
  }
}
