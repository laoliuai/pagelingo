import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/db/database.ts';
import { readConfig } from '../../src/config.ts';
import { createLocalObjectStore } from '../../src/storage/local-object-store.ts';
import { createBundleImportsService } from '../../src/bundle-imports/service.ts';

// This process receives only an isolated test schema/config and is killed by its owning test.
process.on('message', async ({ databaseUrl, schema, dataDir, actor }) => {
  const db = openDatabase(databaseUrl, schema);
  const config = readConfig({
    PAGELINGO_SITE_MODE: 'test', PAGELINGO_SITE_ORIGIN: 'http://127.0.0.1:5174',
    DATABASE_URL: databaseUrl, PAGELINGO_DATA_DIR: dataDir,
    PAGELINGO_MASTER_KEY_ID: 'fixture', PAGELINGO_MASTER_KEYS_JSON: JSON.stringify({ fixture: Buffer.alloc(32, 8).toString('base64') }),
  });
  const service = createBundleImportsService({ db, store: createLocalObjectStore(dataDir), config });
  try {
    const created = await service.create(actor, {}, randomUUID());
    await service.receive(actor, created.id, (async function* () {
      yield Buffer.from('PK');
      process.send({ id: created.id });
      await new Promise(() => {});
    })());
  } catch { process.send({ error: 'owned child failed' }); }
});
