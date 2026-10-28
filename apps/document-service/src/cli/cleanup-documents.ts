import { pathToFileURL } from 'node:url';
import { readConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { verifyDatabaseSchema } from '../db/migrate.js';
import { createLocalObjectStore } from '../storage/local-object-store.js';
import { runDocumentMaintenance } from '../document-lifecycle/maintenance.js';
import { runMetadataBackfill } from '../document-management/metadata-projection.js';
async function main() {
  const config = readConfig(process.env); const db = openDatabase(config.databaseUrl);
  const controller = new AbortController();
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>controller.abort());
  try {
    await verifyDatabaseSchema(db); const store = createLocalObjectStore(config.dataDir);
    const cleanup = await runDocumentMaintenance({ db,store,dataDir:config.dataDir,signal:controller.signal },{ limit:100 });
    const metadata = await runMetadataBackfill({ db,store,signal:controller.signal },{ limit:20 });
    process.stdout.write(JSON.stringify({ cleanup,metadata })+'\n');
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) void main().catch(()=>{
  process.stderr.write('Document cleanup failed; check explicit runtime configuration.\n'); process.exitCode=1;
});
