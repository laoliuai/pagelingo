import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';

const password = '正确密码示例123456';
const origin = 'http://127.0.0.1:5174';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const test = await createServiceTestApp();
  cleanup.push(test.close);
  return test;
}
async function admin() {
  const test = await setup();
  const { bootstrapAdmin } = await import('../../src/cli/bootstrap-admin.js');
  await bootstrapAdmin(test.db, { username: 'Admin', password });
  return test;
}
function headers(session: { cookie: string; csrfToken: string }) {
  return { cookie: session.cookie, origin, 'x-csrf-token': session.csrfToken };
}

describe('private site authentication', () => {
  it('returns an anonymous session without credentials', async () => {
    const { app } = await setup();
    const response = await app.inject('/api/v1/auth/session');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: null, csrfToken: null });
  });
  it('bootstraps exactly one admin under concurrent requests and refuses replacement', async () => {
    const { db } = await setup();
    const { bootstrapAdmin } = await import('../../src/cli/bootstrap-admin.js');
    const results = await Promise.allSettled(['Alpha', 'Bravo'].map(username => bootstrapAdmin(db, { username, password })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { statusCode: 409 } }]);
    expect((await db.pool.query("SELECT username, role FROM users")).rows).toHaveLength(1);
    await expect(bootstrapAdmin(db, { username: 'charlie', password })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('stores only token hashes, returns safe DTOs, and sets local cookie attributes', async () => {
    const { app, db } = await admin();
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'ADMIN', password } });
    expect(response.statusCode).toBe(200);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).not.toContain('Secure');
    const token = setCookie.match(/^pgl_session=([^;]+)/)![1];
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const rows = (await db.pool.query('SELECT token_hash, csrf_token, extract(epoch FROM expires_at - created_at)::int AS seconds FROM sessions')).rows;
    expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0].csrf_token).toBe(response.json().csrfToken);
    expect(rows[0].seconds).toBe(604800);
    expect(response.json().csrfToken).not.toBe(token);
    expect(response.body).not.toContain(token);
    expect(Object.keys(response.json().user).sort()).toEqual(['active', 'createdAt', 'id', 'role', 'username']);
    expect(response.json().user.username).toBe('admin');
    expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: `pgl_session=${token}` } })).json()).toEqual(response.json());
  });
  it('uses identical account/password failures and blocks the sixth failure atomically', async () => {
    const { app } = await admin();
    const attempt = (username: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username, password: 'wrong password 123' } });
    const wrongUser = await attempt('missing');
    const wrongPassword = await attempt('admin');
    expect(wrongUser.statusCode).toBe(401);
    expect(wrongUser.json().error.message).toBe(wrongPassword.json().error.message);
    const results = await Promise.all(Array.from({ length: 5 }, () => attempt('admin')));
    expect(results.filter(result => result.statusCode === 401)).toHaveLength(4);
    const limited = results.find(result => result.statusCode === 429)!;
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('enforces IP-wide failed-login limits across usernames', async () => {
    const { app, db } = await setup();
    await db.pool.query("INSERT INTO auth_attempts (ip, username, window_start, failures) VALUES ('127.0.0.1', '', to_timestamp(floor(extract(epoch from now()) / 900) * 900), 30)");
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'unknown', password } });
    expect(response.statusCode).toBe(429);
  });
  it('rejects cross-site, missing Origin, non-JSON, unknown fields and overlong passwords', async () => {
    const { app } = await setup();
    for (const request of [
      { headers: { origin: 'https://evil.example' }, payload: { username: 'admin', password } },
      { headers: {}, payload: { username: 'admin', password } },
      { headers: { origin, 'content-type': 'text/plain' }, payload: 'username=admin' },
      { headers: { origin }, payload: { username: 'admin', password, owner: 'other' } },
      { headers: { origin }, payload: { username: 'admin', password: '😀'.repeat(129) } },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', ...request });
      expect([400, 403, 415]).toContain(response.statusCode);
      expect(response.json().error.requestId).toBeTruthy();
      expect(response.body).not.toContain(password);
    }
  });
  it('rejects missing, foreign and revoked CSRF and revokes logout sessions', async () => {
    const { app, db } = await admin();
    const one = await login(app, 'admin', password);
    const two = await login(app, 'admin', password);
    for (const requestHeaders of [
      { cookie: one.cookie },
      { ...headers(one), origin: 'https://evil.example' },
      { ...headers(one), 'x-csrf-token': two.csrfToken },
    ]) expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: requestHeaders, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(one), payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: one.cookie } })).json().user).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...headers(two), 'x-csrf-token': one.csrfToken }, payload: {} })).statusCode).toBe(403);
    await db.pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: two.cookie } })).json().user).toBeNull();
  });
  it('invalidates sessions when the account is inactive or its authorization version changes', async () => {
    const { app, db } = await admin();
    const session = await login(app, 'admin', password);
    await db.pool.query('UPDATE users SET active = false');
    expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: session.cookie } })).json().user).toBeNull();
    await db.pool.query('UPDATE users SET active = true, auth_version = auth_version + 1');
    expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: session.cookie } })).json().user).toBeNull();
  });
  it('revokes all devices and increments the authorization version', async () => {
    const { app, db } = await admin();
    const one = await login(app, 'admin', password);
    const two = await login(app, 'admin', password);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(one), payload: { allDevices: true } })).statusCode).toBe(200);
    expect((await db.pool.query('SELECT auth_version FROM users')).rows[0].auth_version).toBe(2);
    expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: two.cookie } })).json().user).toBeNull();
  });
  it('changes the exact password only after checking the current password and revokes every old session', async () => {
    const { app, db } = await admin();
    const one = await login(app, 'admin', password);
    const two = await login(app, 'admin', password);
    const change = (currentPassword: string) => app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: headers(one), payload: { currentPassword, newPassword: 'brand new password 123' } });
    expect((await change('wrong password 123')).statusCode).toBe(401);
    expect((await change(password)).statusCode).toBe(200);
    expect((await db.pool.query('SELECT auth_version FROM users')).rows[0].auth_version).toBe(2);
    expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: two.cookie } })).json().user).toBeNull();
    expect((await login(app, 'admin', 'brand new password 123')).user.username).toBe('admin');
  });
  it('holds the account row lock until an authorized transaction commits', async () => {
    const { app, db } = await admin();
    const session = await login(app, 'admin', password);
    const { assertActorCurrent } = await import('../../src/auth/guards.js');
    const row = (await db.pool.query('SELECT token_hash, user_id FROM sessions')).rows[0];
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await assertActorCurrent(client, { userId: row.user_id, role: 'admin', authVersion: 1, sessionHash: row.token_hash });
      await expect(db.transaction(async other => {
        await other.query("SET LOCAL lock_timeout = '100ms'");
        await other.query('UPDATE users SET auth_version = auth_version + 1');
      })).rejects.toMatchObject({ code: '55P03' });
      await client.query('COMMIT');
      await db.pool.query('UPDATE users SET auth_version = auth_version + 1');
      await expect(db.transaction(c => assertActorCurrent(c, { userId: session.user.id, role: 'admin', authVersion: 1, sessionHash: row.token_hash }))).rejects.toMatchObject({ statusCode: 401 });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('sets a host-only secure production cookie', async () => {
    const { db, config } = await admin();
    const app = await createApp({ db, config: { ...config, mode: 'production', publicOrigin: 'https://site.example' } });
    cleanup.push(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://site.example' }, payload: { username: 'admin', password } });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-pgl_session=/);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Domain=');
  });
  it('bootstraps from stdin without exposing passwords and rejects password argv', async () => {
    const { db, config } = await setup();
    const schema = (await db.pool.query('SELECT current_schema() AS name')).rows[0].name;
    const url = new URL(config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const run = (args: string[], input: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/bootstrap-admin.ts', ...args], {
        env: { ...process.env, DATABASE_URL: url.href, PAGELINGO_SITE_MODE: 'test', PAGELINGO_SITE_ORIGIN: origin,
          PAGELINGO_DATA_DIR: config.dataDir, PAGELINGO_MASTER_KEY_ID: 'test',
          PAGELINGO_MASTER_KEYS_JSON: JSON.stringify({ test: Buffer.alloc(32, 9).toString('base64') }) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
    const success = await run(['--username', 'Admin', '--password-stdin'], `${password}\n`);
    expect(success.code).toBe(0);
    expect(success.output).not.toContain(password);
    expect((await db.pool.query('SELECT username FROM users')).rows).toEqual([{ username: 'admin' }]);
    const conflict = await run(['--username', 'other', '--password-stdin'], `${password}\n`);
    expect(conflict.code).toBe(1);
    expect(conflict.output).not.toContain(password);
    const argv = await run(['--username', 'other', '--password', password], '');
    expect(argv.code).toBe(1);
    expect(argv.output).not.toContain(password);
  });

});
