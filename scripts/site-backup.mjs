import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BACKUP_FORMAT, DATABASE_FILE, MANIFEST_FILE, OBJECTS_FILE,
  createCompose, databaseJson, interruptSignal, keyringFingerprints, runningServices, siteOptions,
} from './site-ops.mjs';

const WRITERS = ['app', 'worker'];
const inventorySql = `SELECT json_build_object(
  'migrations', (SELECT coalesce(json_agg(json_build_object('id', id, 'checksum', checksum) ORDER BY id), '[]') FROM schema_migrations),
  'counts', json_build_object(
    'users', (SELECT count(*) FROM users),
    'documents', (SELECT count(*) FROM documents),
    'assets', (SELECT count(*) FROM assets)))`;

const { values } = parseArgs({ options: { ...siteOptions, output: { type: 'string' } } });
if (!values.output) throw new Error('Usage: site-backup --output <new-directory> [--env-file <file>] [--project <name>] [--mode production|local]');
const output = resolve(values.output);
const compose = createCompose({ project: values.project, envFile: values['env-file'], mode: values.mode, verbose: values.verbose });
const signal = interruptSignal();
const fingerprints = await keyringFingerprints(values['env-file']);
await mkdir(output, { mode: 0o700 });

const running = await runningServices(compose);
const stopped = WRITERS.filter(service => running.includes(service));
try {
  // Objects are immutable and the database refers to them, so a quiet window gives one consistent state.
  if (stopped.length) await compose.run(['stop', ...stopped], { signal });
  if (!running.includes('db')) await compose.run(['up', '--detach', '--wait', 'db'], { signal });
  const inventory = await databaseJson(compose, inventorySql, { signal });
  const database = await compose.saveOutput(['exec', '-T', 'db', 'pg_dump', '-U', 'pagelingo', '-d', 'pagelingo', '--format=custom'], join(output, DATABASE_FILE), { signal });
  const objects = await compose.saveOutput(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'app', '-C', '/data', '-cf', '-', '.'], join(output, OBJECTS_FILE), { signal });
  await writeFile(join(output, MANIFEST_FILE), `${JSON.stringify({
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    ...inventory,
    keyring: { fingerprints, included: false },
    files: { [DATABASE_FILE]: database, [OBJECTS_FILE]: objects },
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, ...inventory.counts, databaseBytes: database.bytes, objectBytes: objects.bytes }));
  console.log('The master keyring is not in this backup. Keep the env file separately, or the saved API keys cannot be decrypted after a restore.');
} finally {
  if (!running.includes('db')) await compose.run(['stop', 'db']).catch(() => { process.exitCode = 1; console.error('Could not stop the database started for this backup.'); });
  if (stopped.length) await compose.run(['start', ...stopped]).catch(() => { process.exitCode = 1; console.error(`Could not restart ${stopped.join(', ')}; start them manually.`); });
}
