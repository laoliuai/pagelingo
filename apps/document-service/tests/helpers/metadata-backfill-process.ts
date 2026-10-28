import { spawn } from 'node:child_process';

/** Each call is a fresh worker process with only the owned test database/schema and directory. */
export async function metadataBackfillProcess(schema: string, dataDir: string, unreadableKey?: string) {
  const code = `
    import { openDatabase } from './src/db/database.ts';
    import { createLocalObjectStore } from './src/storage/local-object-store.ts';
    import { runMetadataBackfill } from './src/document-management/metadata-projection.ts';
    const [schema, dataDir, unreadableKey] = process.argv.slice(1);
    const db = openDatabase(process.env.PAGELINGO_TEST_DATABASE_URL, schema);
    const local = createLocalObjectStore(dataDir);
    const store = { ...local, async *read(key) {
      if (key === unreadableKey) throw new Error('Controlled persistent unreadable metadata object');
      yield* local.read(key);
    } };
    try { console.log(JSON.stringify(await runMetadataBackfill({ db,store,signal:new AbortController().signal }, { limit:1 }))); }
    finally { await db.close(); }
  `;
  return new Promise<{ selected: number; projected: number; skipped: number; failed: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, schema, dataDir, unreadableKey ?? ''], {
      cwd: new URL('../../', import.meta.url), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`Metadata backfill process failed (${code}): ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
  });
}
