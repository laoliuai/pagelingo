import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BACKUP_FORMAT, DATABASE_FILE, MANIFEST_FILE, OBJECTS_FILE,
  createCompose, databaseJson, fileDigest, interruptSignal, keyringFingerprints, siteOptions,
} from './site-ops.mjs';

const { values } = parseArgs({ options: { ...siteOptions, from: { type: 'string' } } });
if (!values.from) throw new Error('Usage: site-restore --from <backup-directory> [--env-file <file>] [--project <name>] [--mode production|local]');
const from = resolve(values.from);
const compose = createCompose({ project: values.project, envFile: values['env-file'], mode: values.mode, verbose: values.verbose });
const signal = interruptSignal();

// Every check that needs only local files runs before Docker state changes.
const manifest = JSON.parse(await readFile(join(from, MANIFEST_FILE), 'utf8'));
if (manifest.format !== BACKUP_FORMAT) throw new Error('Unsupported backup format');
for (const name of [DATABASE_FILE, OBJECTS_FILE]) {
  const actual = await fileDigest(join(from, name));
  const expected = manifest.files?.[name];
  if (actual.bytes !== expected?.bytes || actual.sha256 !== expected?.sha256) throw new Error(`Backup file failed verification: ${name}`);
}
const keys = await keyringFingerprints(values['env-file']);
for (const [id, fingerprint] of Object.entries(manifest.keyring?.fingerprints ?? {})) {
  if (keys[id] !== fingerprint) throw new Error(`The env file does not contain the master key "${id}" this backup needs`);
}

await compose.run(['up', '--detach', '--wait', 'db'], { signal });
const tables = await databaseJson(compose, "SELECT count(*) FROM pg_tables WHERE schemaname='public'", { signal });
const storedFiles = await compose.run(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'find', 'app', '/data', '-type', 'f'], { signal });
if (tables !== 0 || storedFiles) throw new Error('Refusing to restore over existing data: use a new project name or an empty environment');

await compose.sendFile(['exec', '-T', 'db', 'pg_restore', '-U', 'pagelingo', '-d', 'pagelingo', '--no-owner', '--exit-on-error', '--single-transaction'], join(from, DATABASE_FILE), { signal });
await compose.sendFile(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'app', '-C', '/data', '-xf', '-'], join(from, OBJECTS_FILE), { signal });
await compose.run(['up', '--detach', '--wait'], { signal });

const report = JSON.parse(await compose.run(['exec', '-T', 'app', 'node', 'apps/document-service/dist/cli/verify-restore.js'], { signal }).catch(error => {
  // A failed check still prints its counts, which say what is missing.
  if (error.stdout) console.error(error.stdout);
  throw error;
}));
const counts = await databaseJson(compose, "SELECT json_build_object('users',(SELECT count(*) FROM users),'documents',(SELECT count(*) FROM documents),'assets',(SELECT count(*) FROM assets))", { signal });
for (const [name, count] of Object.entries(manifest.counts ?? {})) {
  if (counts[name] !== count) throw new Error(`Restored ${name} count differs from the backup`);
}
console.log(JSON.stringify({ restored: true, ...counts, ...report }));
