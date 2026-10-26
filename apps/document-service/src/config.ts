import { isIP } from 'node:net';
import { resolve } from 'node:path';

export interface RuntimeConfig {
  mode: 'local' | 'production' | 'test';
  publicOrigin: string;
  host: string;
  port: number;
  dataDir: string;
  databaseUrl: string;
  webDir?: string;
  keyring: { activeKeyId: string; keys: Readonly<Record<string, Uint8Array>> };
  maxPdfBytes: number;
}

export function readConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const mode = env.PAGELINGO_SITE_MODE;
  if (mode !== 'local' && mode !== 'production' && mode !== 'test') throw new Error('Invalid site mode');
  let origin: URL;
  try { origin = new URL(env.PAGELINGO_SITE_ORIGIN ?? ''); }
  catch { throw new Error('Invalid public origin'); }
  const hostname = origin.hostname.replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (mode === 'production' ? origin.protocol !== 'https:' : !loopback || !['http:', 'https:'].includes(origin.protocol))) {
    throw new Error('Invalid public origin for site mode');
  }
  function required(name: string): string {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing ${name}`);
    return value;
  }
  function integer(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  const databaseUrl = required('DATABASE_URL');
  try {
    if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error();
  } catch { throw new Error('Invalid database URL'); }
  const activeKeyId = required('PAGELINGO_MASTER_KEY_ID');
  const keys: Record<string, Uint8Array> = Object.create(null);
  try {
    const raw: unknown = JSON.parse(required('PAGELINGO_MASTER_KEYS_JSON'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
    for (const [id, value] of Object.entries(raw)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof value !== 'string') throw new Error();
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length !== 32 || bytes.toString('base64') !== value) throw new Error();
      keys[id] = bytes;
    }
    if (!Object.hasOwn(keys, activeKeyId)) throw new Error();
  } catch { throw new Error('Invalid master keyring'); }
  const config: RuntimeConfig = {
    mode, publicOrigin: origin.origin,
    host: env.PAGELINGO_SERVICE_HOST ?? '127.0.0.1',
    port: integer('PAGELINGO_SERVICE_PORT', 4320, 65535),
    dataDir: resolve(required('PAGELINGO_DATA_DIR')), databaseUrl,
    ...(env.PAGELINGO_WEB_DIR ? { webDir: resolve(env.PAGELINGO_WEB_DIR) } : {}),
    keyring: { activeKeyId, keys: Object.freeze(keys) },
    maxPdfBytes: integer('PAGELINGO_MAX_PDF_BYTES', 256 * 1024 * 1024),
  };
  // A config can be passed accidentally to structured logging; expose no fields.
  Object.defineProperty(config, 'toJSON', { value: () => '[RuntimeConfig redacted]' });
  return config;
}
