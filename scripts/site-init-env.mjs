import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { domain: { type: 'string' }, file: { type: 'string', default: '.env.production.local' } } });
if (!values.domain || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(values.domain)) {
  console.error('Usage: npm run site:init -- --domain notes.example.com [--file <new-env-file>]');
  process.exit(2);
}
try {
  // The password is hexadecimal so it can never need URL encoding in DATABASE_URL.
  await writeFile(values.file, `PAGELINGO_DOMAIN=${values.domain}\nPOSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error(`${values.file} already exists; keep it, because it holds the keys for your saved data.`);
  process.exit(1);
}
const keygen = spawnSync(process.execPath, ['scripts/create-site-secrets.mjs', '--file', values.file], { stdio: 'inherit' });
if (keygen.status !== 0) process.exit(keygen.status ?? 1);
console.log(`Created ${values.file}. Copy it somewhere safe: without its master key, saved API keys cannot be decrypted.`);
