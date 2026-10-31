import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const BACKUP_FORMAT = 'pagelingo-site-backup/1';
export const DATABASE_FILE = 'database.dump';
export const OBJECTS_FILE = 'objects.tar';
export const MANIFEST_FILE = 'manifest.json';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ambientConfiguration = /^(COMPOSE_|PAGELINGO_|POSTGRES_|DATABASE_URL$)/;

export const siteOptions = {
  'env-file': { type: 'string', default: '.env.production.local' },
  project: { type: 'string', default: 'pagelingo-site' },
  mode: { type: 'string', default: 'production' },
  verbose: { type: 'boolean', default: false },
};

/** Compose only sees the named env file; ambient database or site settings cannot redirect an operation. */
export function createCompose({ project, envFile, mode = 'production', verbose = false }) {
  if (!['production', 'local'].includes(mode)) throw new Error('--mode must be production or local');
  const files = ['deploy/compose.site.yml', ...(mode === 'production' ? ['deploy/compose.prod.yml'] : [])];
  const base = ['compose', '--project-name', project, '--env-file', resolve(envFile), ...files.flatMap(file => ['-f', resolve(root, file)])];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !ambientConfiguration.test(key)));
  // Docker diagnostics can quote connection strings; they are shown only on explicit request.
  const start = (args, stdin, signal) => spawn('docker', [...base, ...args], { env, signal, stdio: [stdin, 'pipe', verbose ? 'inherit' : 'ignore'] });
  const finished = (child, args) => new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', code => code === 0 ? done() : fail(new Error(`docker compose ${args[0]} exited with ${code}; rerun with --verbose for details`)));
  });
  return {
    async run(args, { input, signal } = {}) {
      const child = start(args, input === undefined ? 'ignore' : 'pipe', signal);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
      await finished(child, args).catch(error => { throw Object.assign(error, { stdout: output.trim() }); });
      return output.trim();
    },
    /** Streams a command's stdout to a new private file while hashing the exact bytes. */
    async saveOutput(args, path, { signal } = {}) {
      const child = start(args, 'ignore', signal);
      const done = finished(child, args);
      const hash = createHash('sha256'); let bytes = 0;
      const meter = new Transform({ transform(chunk, _encoding, next) { hash.update(chunk); bytes += chunk.length; next(null, chunk); } });
      await Promise.all([pipeline(child.stdout, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 })), done]);
      return { bytes, sha256: hash.digest('hex') };
    },
    async sendFile(args, path, { signal } = {}) {
      const child = start(args, 'pipe', signal);
      const done = finished(child, args);
      child.stdout.resume();
      await Promise.all([pipeline(createReadStream(path), child.stdin), done]);
    },
  };
}

export async function runningServices(compose) {
  const output = await compose.run(['ps', '--status', 'running', '--services']);
  return output ? output.split('\n').map(line => line.trim()).filter(Boolean) : [];
}

export async function databaseJson(compose, sql, options) {
  return JSON.parse(await compose.run(['exec', '-T', 'db', 'psql', '-U', 'pagelingo', '-d', 'pagelingo', '-At', '-c', sql], options));
}

/** Fingerprints identify keys without exposing them: a restore needs the same material, stored separately. */
export async function keyringFingerprints(envFile) {
  const env = parseEnv(await readFile(envFile, 'utf8'));
  const keys = JSON.parse(env.PAGELINGO_MASTER_KEYS_JSON ?? 'null');
  if (!keys || typeof keys !== 'object' || !Object.keys(keys).length) throw new Error('The env file has no master keyring');
  return Object.fromEntries(Object.entries(keys).map(([id, value]) => [id, createHash('sha256').update(Buffer.from(String(value), 'base64')).digest('hex')]));
}

export async function fileDigest(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

/** Stops the operation's child process on Ctrl+C so its cleanup path still runs. */
export function interruptSignal() {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  return controller.signal;
}
