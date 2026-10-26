import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
try {
  const { values } = parseArgs({ options: { 'file': { type: 'string', default: '.env.local' } } });
  const file = await open(values['file'], constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error();
    const original = await file.readFile('utf8');
    const env = parseEnv(original);
    let id = env.PAGELINGO_MASTER_KEY_ID;
    let keys;
    if (env.PAGELINGO_MASTER_KEYS_JSON !== undefined) {
      keys = JSON.parse(env.PAGELINGO_MASTER_KEYS_JSON);
      if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.keys(keys).length) throw new Error();
      for (const [name, key] of Object.entries(keys)) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error();
      }
    }
    id ??= keys ? Object.keys(keys)[0] : 'primary';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error();
    keys ??= { [id]: randomBytes(32).toString('base64') };
    if (!Object.hasOwn(keys, id)) throw new Error();
    const additions = [];
    if (env.PAGELINGO_MASTER_KEY_ID === undefined) additions.push(`PAGELINGO_MASTER_KEY_ID=${id}`);
    if (env.PAGELINGO_MASTER_KEYS_JSON === undefined) additions.push(`PAGELINGO_MASTER_KEYS_JSON='${JSON.stringify(keys)}'`);
    await file.chmod(0o600);
    if (additions.length) await file.write(`${original && !original.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`);
    console.log('Site keyring ready; existing values preserved.');
  } finally { await file.close(); }
} catch {
  console.error('Site key generation failed; check file permissions and existing keyring configuration.');
  process.exitCode = 1;
}
