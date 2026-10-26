import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserRequestSchema } from '@pagelingo/document-contracts';
import type { PublicUser } from '@pagelingo/document-contracts';
import type { Database } from '../db/database.js';
import { openDatabase } from '../db/database.js';
import { migrateDatabase } from '../db/migrate.js';
import { readConfig } from '../config.js';
import { ServiceError } from '../errors.js';
import { hashPassword } from '../auth/passwords.js';
import { publicUser } from '../auth/sessions.js';
import type { UserRow } from '../auth/sessions.js';

export async function bootstrapAdmin(db: Database, input: { username: string; password: string }): Promise<PublicUser> {
  const parsed = createUserRequestSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', 'Invalid username or password');
  const encoded = await hashPassword(parsed.data.password);
  return db.transaction(async client => {
    // Serialize the empty-table check: row locks cannot protect an administrator that does not exist yet.
    await client.query('SELECT pg_advisory_xact_lock(204716, 1)');
    if ((await client.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1")).rowCount) {
      throw new ServiceError(409, 'ADMIN_EXISTS', 'An administrator already exists');
    }
    const row = (await client.query<UserRow>(`INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, 'admin') RETURNING *`, [parsed.data.username, encoded])).rows[0]!;
    return publicUser(row);
  });
}

async function stdinPassword(): Promise<string> {
  if (process.stdin.isTTY) throw new ServiceError(400, 'INVALID_INPUT', '--password-stdin requires non-TTY input');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 2048) throw new ServiceError(400, 'INVALID_INPUT', 'Password input is too long');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
async function maskedPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ServiceError(400, 'INVALID_INPUT', 'Use --password-stdin for non-interactive input');
  }
  process.stdout.write('Password: ');
  emitKeypressEvents(process.stdin);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolvePassword, reject) => {
    let value = '';
    function finish(error?: Error) {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolvePassword(value);
    }
    function onKey(text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) {
      if (key.ctrl && key.name === 'c') return finish(new ServiceError(400, 'CANCELLED', 'Cancelled'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        if (value) { value = Array.from(value).slice(0, -1).join(''); process.stdout.write('\b \b'); }
      } else if (text && !key.ctrl && !key.meta && !text.includes('\u001b')) {
        if (Array.from(value + text).length > 128) return finish(new ServiceError(400, 'INVALID_INPUT', 'Password input is too long'));
        value += text;
        process.stdout.write('*'.repeat(Array.from(text).length));
      }
    }
    process.stdin.on('keypress', onKey);
  });
}
async function main(): Promise<void> {
  let db: Database | undefined;
  try {
    let args;
    try {
      args = parseArgs({ options: { username: { type: 'string' }, 'password-stdin': { type: 'boolean' } }, strict: true, allowPositionals: false }).values;
    } catch { throw new ServiceError(400, 'INVALID_INPUT', 'Usage: site:admin -- --username <name> [--password-stdin]'); }
    if (!args.username) throw new ServiceError(400, 'INVALID_INPUT', 'A username is required');
    const password = await (args['password-stdin'] ? stdinPassword() : maskedPassword());
    const config = readConfig(process.env);
    db = openDatabase(config.databaseUrl);
    await migrateDatabase(db);
    const user = await bootstrapAdmin(db, { username: args.username, password });
    process.stdout.write(`Administrator created: ${user.username}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof ServiceError ? error.message : 'Administrator bootstrap failed'}\n`);
    process.exitCode = 1;
  } finally { await db?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
