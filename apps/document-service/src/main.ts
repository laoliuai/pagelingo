import { mkdir } from 'node:fs/promises';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';

// Configuration is injected by the caller; this entry never loads .env files.
async function main() {
  const config = readConfig(process.env);
  const db = openDatabase(config.databaseUrl);
  const app = await createApp({ config, db });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await app.close(); }
    finally { await db.close(); }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { shutdown().catch(() => { process.exitCode = 1; }); });
  }
  try {
    await migrateDatabase(db);
    await mkdir(config.dataDir, { recursive: true });
    if (!shuttingDown) await app.listen({ host: config.host, port: config.port });
  } catch {
    await shutdown();
    throw new Error('Document service startup failed');
  }
}
main().catch(() => {
  console.error('Document service startup failed; check runtime configuration and database availability.');
  process.exitCode = 1;
});
