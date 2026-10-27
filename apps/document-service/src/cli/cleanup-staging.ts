import { expireWebCaptureStaging } from '../web-captures/cleanup.js';
import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../db/database.js';
import { openDatabase } from '../db/database.js';
import { readConfig } from '../config.js';
import { verifyDatabaseSchema } from '../db/migrate.js';
import { expireImports } from '../bundle-imports/repository.js';
import { lockObjectPublication } from '../documents/repository.js';
import { createLocalObjectStore, isObjectKey } from '../storage/local-object-store.js';

/** Reconcile only stale files; source/asset references remain the authority. */
export async function cleanupStaging({ db, dataDir }: { db: Database; dataDir: string }): Promise<{ objects: number; staging: number }> {
  const root = resolve(dataDir); const store = createLocalObjectStore(root);
  const cutoff = Date.now() - 24 * 3600_000; const removed = { objects: 0, staging: 0 };
  await db.transaction(client => expireImports(client));
  await expireWebCaptureStaging(db);
  for (const kind of ['objects', 'staging', 'bundle-staging', 'web-staging'] as const) {
    const ageCutoff = kind === 'bundle-staging' ? Date.now() - 15 * 60_000 : cutoff;
    const directory = join(root, kind);
    try {
      if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('Unsafe storage directory');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const key of await readdir(directory)) {
      if (!isObjectKey(key)) continue;
      const path = join(directory, key);
      const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (!info?.isFile() || info.isSymbolicLink() || info.mtimeMs >= ageCutoff) continue;
      await db.transaction(async client => {
        await lockObjectPublication(client);
        // A publisher also holds this lock and stats its file before committing.
        if (kind === 'objects') {
          const referenced = await client.query('SELECT id FROM assets WHERE object_key = $1 LIMIT 1', [key]);
          if (referenced.rowCount) return;
          await store.deleteUnreferenced(key);
        } else {
          // Recheck after lock acquisition; actively written staging files remain fresh.
          const current = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
          if (!current?.isFile() || current.isSymbolicLink() || current.mtimeMs >= ageCutoff) return;
          if (kind === 'web-staging') {
            const active = await client.query(`SELECT f.id FROM web_capture_files f JOIN web_captures c ON (c.owner_id,c.id)=(f.owner_id,f.capture_id)
              WHERE (f.staging_key=$1 OR f.upload_token=$1) AND c.status IN ('created','receiving','validating','failed')
              AND c.updated_at >= clock_timestamp()-interval '24 hours'`, [key]);
            if (active.rowCount) return;
          }
          if (kind === 'bundle-staging') {
            const active = await client.query(`SELECT id FROM bundle_imports WHERE staging_key=$1
              AND status IN ('created','receiving','validating') AND heartbeat_at >= now() - interval '15 minutes'`, [key]);
            if (active.rowCount) return;
          }
          await unlink(path);
        }
        removed[kind === 'objects' ? 'objects' : 'staging']++;
      });
    }
  }
  return removed;
}
async function main() {
  let db: Database | undefined;
  try {
    const config = readConfig(process.env); db = openDatabase(config.databaseUrl);
    await verifyDatabaseSchema(db);
    const result = await cleanupStaging({ db, dataDir: config.dataDir });
    process.stdout.write(`Removed ${result.objects} unreferenced objects and ${result.staging} staging files\n`);
  } catch { process.stderr.write('Storage cleanup failed\n'); process.exitCode = 1; }
  finally { await db?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
