import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readConfig, type RuntimeConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { openDatabase } from '../db/database.js';
import { verifyDatabaseSchema } from '../db/migrate.js';
import { openApiKey } from '../providers/secrets.js';
import { createLocalObjectStore } from '../storage/local-object-store.js';
import type { ObjectStore } from '../storage/object-store.js';

export interface RestoreReport {
  assets: number;
  bytes: number;
  missing: number;
  mismatched: number;
  secrets: number;
  unreadableSecrets: number;
}

interface AssetRow { id: string; object_key: string; sha256: string; bytes: string }

async function objectMatches(store: ObjectStore, asset: AssetRow): Promise<'ok' | 'missing' | 'mismatched'> {
  try {
    if ((await store.stat(asset.object_key)).bytes !== Number(asset.bytes)) return 'mismatched';
    const hash = createHash('sha256');
    for await (const chunk of store.read(asset.object_key)) hash.update(chunk);
    return hash.digest('hex') === asset.sha256 ? 'ok' : 'mismatched';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** Reads every registered object and encrypted API key. The report contains counts only, never content or keys. */
export async function verifyRestore(db: Database, store: ObjectStore, keyring: RuntimeConfig['keyring']): Promise<RestoreReport> {
  const report: RestoreReport = { assets: 0, bytes: 0, missing: 0, mismatched: 0, secrets: 0, unreadableSecrets: 0 };
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await db.pool.query<AssetRow>('SELECT id,object_key,sha256,bytes FROM assets WHERE id>$1 ORDER BY id LIMIT 200', [cursor]);
    if (!rows.length) break;
    for (const asset of rows) {
      const result = await objectMatches(store, asset);
      report.assets += 1;
      report.bytes += Number(asset.bytes);
      if (result === 'missing') report.missing += 1;
      if (result === 'mismatched') report.mismatched += 1;
    }
    cursor = rows.at(-1)!.id;
  }
  const profiles = await db.pool.query<{ owner_id: string; key_id: string; key_nonce: Buffer; key_ciphertext: Buffer; key_tag: Buffer }>(
    'SELECT owner_id,key_id,key_nonce,key_ciphertext,key_tag FROM provider_profiles WHERE key_id IS NOT NULL',
  );
  for (const row of profiles.rows) {
    report.secrets += 1;
    try {
      openApiKey({ keyId: row.key_id, nonce: row.key_nonce, ciphertext: row.key_ciphertext, tag: row.key_tag }, row.owner_id, keyring);
    } catch {
      report.unreadableSecrets += 1;
    }
  }
  return report;
}

async function main() {
  const config = readConfig(process.env);
  const db = openDatabase(config.databaseUrl);
  try {
    await verifyDatabaseSchema(db);
    const report = await verifyRestore(db, createLocalObjectStore(config.dataDir), config.keyring);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.missing || report.mismatched || report.unreadableSecrets) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write('Restore verification failed; check runtime configuration and database availability.\n');
    process.exitCode = 1;
  });
}
