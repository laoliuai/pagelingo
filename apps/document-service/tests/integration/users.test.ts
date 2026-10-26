import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import type { Actor } from '../../src/auth/guards.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';

const password = 'correct password 123456';
const newPassword = '  新密码😀😀😀123456  ';
const origin = 'http://127.0.0.1:5174';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function headers(session: { cookie: string; csrfToken: string }) {
  return { cookie: session.cookie, origin, 'x-csrf-token': session.csrfToken };
}
async function setup() {
  const test = await createServiceTestApp();
  cleanup.push(test.close);
  await bootstrapAdmin(test.db, { username: 'admin', password });
  // Additional administrators are internal fixtures; public APIs never promote roles.
  await test.db.pool.query(`INSERT INTO users (username, password_hash, role)
    SELECT name, password_hash, role_name FROM users CROSS JOIN
    (VALUES ('alice', 'user'), ('second-admin', 'admin')) AS fixture(name, role_name)
    WHERE username = 'admin'`);
  const admin = await login(test.app, 'admin', password);
  const alice = await login(test.app, 'alice', password);
  const second = await login(test.app, 'second-admin', password);
  return { ...test, admin, alice, second };
}
function endpoints(id: string) {
  return [
    { method: 'GET' as const, url: '/api/v1/admin/users' },
    { method: 'POST' as const, url: '/api/v1/admin/users', payload: { username: 'created', password } },
    { method: 'PATCH' as const, url: `/api/v1/admin/users/${id}`, payload: { active: false } },
    { method: 'POST' as const, url: `/api/v1/admin/users/${id}/reset-password`, payload: { newPassword } },
  ];
}

describe('administrator-managed accounts', () => {
  it('requires a current administrator for every management endpoint', async () => {
    const { app, alice } = await setup();
    for (const endpoint of endpoints(alice.user.id)) {
      expect((await app.inject({ ...endpoint, headers: { origin } })).statusCode).toBe(401);
      expect((await app.inject({ ...endpoint, headers: headers(alice) })).statusCode).toBe(403);
    }
  });

  it('creates only ordinary users, normalizes names, rejects duplicates and returns safe DTOs', async () => {
    const { app, db, admin } = await setup();
    const create = (username: string) => app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(admin), payload: { username, password } });
    const response = await create('Created_User');
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ username: 'created_user', role: 'user', active: true });
    expect(Object.keys(response.json()).sort()).toEqual(['active', 'createdAt', 'id', 'role', 'username']);
    expect((await create('CREATED_USER')).statusCode).toBe(409);
    const list = await app.inject({ url: '/api/v1/admin/users', headers: headers(admin) });
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json()).toHaveLength(4);
    for (const user of list.json()) expect(Object.keys(user).sort()).toEqual(['active', 'createdAt', 'id', 'role', 'username']);
    expect((await db.pool.query("SELECT role FROM users WHERE username = 'created_user'")).rows).toEqual([{ role: 'user' }]);
    expect((await login(app, 'created_user', password)).user.id).toBe(response.json().id);
  });

  it('rejects client-supplied authorization fields and invalid bodies without side effects', async () => {
    const { app, db, admin, alice } = await setup();
    for (const extra of [{ role: 'admin' }, { ownerId: admin.user.id }, { passwordHash: 'attacker-hash' }]) {
      for (const endpoint of endpoints(alice.user.id).filter(endpoint => endpoint.method !== 'GET')) {
        const response = await app.inject({ ...endpoint, headers: headers(admin), payload: { ...endpoint.payload, ...extra } });
        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain(password);
      }
    }
    for (const payload of [{ username: 'bad name', password }, { username: 'valid', password: 'short' }, { username: 'valid', password: '😀'.repeat(129) }]) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(admin), payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/admin/users/not-a-uuid', headers: headers(admin), payload: { active: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${alice.user.id}`, headers: headers(admin), payload: { active: 'false' } })).statusCode).toBe(400);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(3);
    expect((await login(app, 'alice', password)).user).toMatchObject({ role: 'user', active: true });
  });

  it('checks Origin, CSRF and JSON for all management writes', async () => {
    const { app, admin, alice } = await setup();
    for (const endpoint of endpoints(alice.user.id).filter(endpoint => endpoint.method !== 'GET')) {
      for (const requestHeaders of [
        { cookie: admin.cookie, origin },
        { ...headers(admin), origin: 'https://evil.example' },
        { ...headers(admin), 'x-csrf-token': alice.csrfToken },
      ]) expect((await app.inject({ ...endpoint, headers: requestHeaders })).statusCode).toBe(403);
      expect((await app.inject({ ...endpoint, headers: { ...headers(admin), 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
    }
  });

  it('revokes every session on disable and never revives cookies on enable', async () => {
    const { app, db, admin, alice } = await setup();
    const other = await login(app, 'alice', password);
    const change = (active: boolean) => app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${alice.user.id}`, headers: headers(admin), payload: { active } });
    const disabled = await change(false);
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ id: alice.user.id, active: false });
    expect((await db.pool.query('SELECT auth_version FROM users WHERE id = $1', [alice.user.id])).rows[0].auth_version).toBe(2);
    expect((await db.pool.query('SELECT id FROM sessions WHERE user_id = $1', [alice.user.id])).rows).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'alice', password } })).statusCode).toBe(401);
    expect((await change(true)).statusCode).toBe(200);
    for (const session of [alice, other]) expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: session.cookie } })).json().user).toBeNull();
    expect((await login(app, 'alice', password)).user.active).toBe(true);
  });

  it('resets ordinary users with exact passwords and revokes multiple sessions', async () => {
    const { app, db, admin, alice } = await setup();
    const other = await login(app, 'alice', password);
    const response = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${alice.user.id}/reset-password`, headers: headers(admin), payload: { newPassword } });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect((await db.pool.query('SELECT auth_version FROM users WHERE id = $1', [alice.user.id])).rows[0].auth_version).toBe(2);
    expect((await db.pool.query('SELECT id FROM sessions WHERE user_id = $1', [alice.user.id])).rows).toHaveLength(0);
    for (const session of [alice, other]) expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: session.cookie } })).json().user).toBeNull();
    for (const rejected of [password, newPassword.trim()]) expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'alice', password: rejected } })).statusCode).toBe(401);
    expect((await login(app, 'alice', newPassword)).user.id).toBe(alice.user.id);
  });

  it('refuses resetting administrators and returns 404 for absent targets', async () => {
    const { app, admin, second } = await setup();
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/users/${second.user.id}/reset-password`, headers: headers(admin), payload: { newPassword } })).statusCode).toBe(403);
    const missing = randomUUID();
    for (const endpoint of endpoints(missing).slice(2)) expect((await app.inject({ ...endpoint, headers: headers(admin) })).statusCode).toBe(404);
    expect((await login(app, 'second-admin', password)).user.role).toBe('admin');
  });

  for (const targetId of ['AB12CD34-ABCD-4ABC-8ABC-AB12CD34AB12', 'Ab12Cd34-aBcD-4aBc-8AbC-aB12cD34aB12']) {
    const canonicalId = 'ab12cd34-abcd-4abc-8abc-ab12cd34ab12';
    it(`changes active state for an accepted UUID spelling: ${targetId}`, async () => {
      const { app, db, admin, alice } = await setup();
      await db.pool.query(`INSERT INTO users (id, username, password_hash, role)
        SELECT $1, 'case-reader', password_hash, 'user' FROM users WHERE username = 'admin'`, [canonicalId]);
      const reader = await login(app, 'case-reader', password);
      const change = (session: typeof admin, active: boolean) => app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${targetId}`, headers: headers(session), payload: { active } });
      expect((await change(alice, false)).statusCode).toBe(403);
      const disabled = await change(admin, false);
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({ id: canonicalId, active: false });
      expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: reader.cookie } })).json().user).toBeNull();
      const enabled = await change(admin, true);
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ id: canonicalId, active: true });
      expect((await login(app, 'case-reader', password)).user.id).toBe(canonicalId);
      expect((await db.pool.query('SELECT target_id, action FROM user_audit_events ORDER BY created_at, id')).rows).toEqual([
        { target_id: canonicalId, action: 'disable' }, { target_id: canonicalId, action: 'enable' },
      ]);
    });

    it(`resets a password for an accepted UUID spelling: ${targetId}`, async () => {
      const { app, db, admin, alice } = await setup();
      await db.pool.query(`INSERT INTO users (id, username, password_hash, role)
        SELECT $1, 'case-reader', password_hash, 'user' FROM users WHERE username = 'admin'`, [canonicalId]);
      const reader = await login(app, 'case-reader', password);
      const reset = (session: typeof admin) => app.inject({ method: 'POST', url: `/api/v1/admin/users/${targetId}/reset-password`, headers: headers(session), payload: { newPassword } });
      expect((await reset(alice)).statusCode).toBe(403);
      expect((await reset(admin)).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: reader.cookie } })).json().user).toBeNull();
      expect((await login(app, 'case-reader', newPassword)).user.id).toBe(canonicalId);
      expect((await db.pool.query('SELECT target_id, action FROM user_audit_events')).rows).toEqual([
        { target_id: canonicalId, action: 'reset-password' },
      ]);
    });
  }

  it('protects the last active administrator', async () => {
    const { app, db, admin, second } = await setup();
    const disable = (id: string) => app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${id}`, headers: headers(admin), payload: { active: false } });
    expect((await disable(second.user.id.toUpperCase())).statusCode).toBe(200);
    expect((await disable(admin.user.id.toUpperCase())).statusCode).toBe(409);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active")).rows[0].n).toBe(1);
  });

  it('serializes simultaneous administrator deactivations without deadlock or zero administrators', async () => {
    const { app, db, admin, second } = await setup();
    const results = await Promise.all([[admin, second], [second, admin]].map(([actor, target]) => app.inject({
      method: 'PATCH', url: `/api/v1/admin/users/${target!.user.id}`, headers: headers(actor!), payload: { active: false },
    })));
    expect(results.filter(result => result.statusCode === 200)).toHaveLength(1);
    // Revocation can be observed during either the CSRF session reread or the
    // final transaction guard, depending on which request reaches it first.
    expect(results.filter(result => [401, 403].includes(result.statusCode))).toHaveLength(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active")).rows[0].n).toBe(1);
  });

  it('serializes simultaneous self-deactivation when each administrator initially sees two admins', async () => {
    const { app, db, admin, second } = await setup();
    const results = await Promise.all([admin, second].map(session => app.inject({
      method: 'PATCH', url: `/api/v1/admin/users/${session.user.id}`, headers: headers(session), payload: { active: false },
    })));
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active")).rows[0].n).toBe(1);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id IN ($1, $2)', [admin.user.id, second.user.id])).rows[0].n).toBe(1);
  });

  it('shares an atomic limiter across transactions while separating scopes and subjects', async () => {
    const { app, db, admin } = await setup();
    expect((await app.inject({ url: '/api/v1/admin/users', headers: headers(admin) })).statusCode).toBe(200);
    const { consumeRateLimit } = await import('../../src/auth/rate-limit.js');
    const reserve = (scope: string, subject: string) => db.transaction(client => consumeRateLimit(client, { scope, subject, limit: 5, windowSeconds: 3600 }));
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserve('probe', 'one')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { statusCode: 429 } }]);
    await reserve('other-scope', 'one');
    await reserve('probe', 'other-subject');
    expect((await db.pool.query("SELECT used FROM rate_limit_windows WHERE scope = 'probe' AND subject = 'one'")).rows).toEqual([{ used: 5 }]);
  });

  it('rechecks an actor revoked after request authentication before creating an account', async () => {
    const { app, db, config, admin, second } = await setup();
    expect((await app.inject({ url: '/api/v1/admin/users', headers: headers(admin) })).statusCode).toBe(200);
    // Pause the actual transaction boundary, after HTTP authentication and password hashing.
    const reached = deferred();
    const release = deferred();
    const pausedApp = await createApp({ config, db: { ...db, async transaction(fn) { reached.resolve(); await release.promise; return db.transaction(fn); } } });
    cleanup.push(() => pausedApp.close());
    await pausedApp.ready();
    const pending = pausedApp.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(second), payload: { username: 'stale-created', password } }).then(result => result);
    try {
      await reached.promise;
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${second.user.id}`, headers: headers(admin), payload: { active: false } })).statusCode).toBe(200);
    } finally { release.resolve(); }
    expect((await pending).statusCode).toBe(401);
    expect((await db.pool.query("SELECT id FROM users WHERE username = 'stale-created'")).rows).toHaveLength(0);
  });

  it('limits reset requests to five per administrator per minute atomically, including failed targets', async () => {
    const { app, db, admin, alice, second } = await setup();
    const reset = (session: typeof admin, id: string) => app.inject({ method: 'POST', url: `/api/v1/admin/users/${id}/reset-password`, headers: headers(session), payload: { newPassword } });
    // Failed target lookups still consume quota, without expensive password work.
    const results = await Promise.all(Array.from({ length: 6 }, () => reset(admin, randomUUID())));
    expect(results.filter(result => result.statusCode === 404)).toHaveLength(5);
    const limited = results.filter(result => result.statusCode === 429);
    expect(limited).toHaveLength(1);
    expect(Number(limited[0]!.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited[0]!.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect((await reset(second, alice.user.id)).statusCode).toBe(204);
    await db.pool.query("UPDATE rate_limit_windows SET window_start = window_start - interval '2 minutes'");
    expect((await reset(admin, alice.user.id)).statusCode).toBe(204);
  });

  it('keeps reset quota after hashing fails and rechecks revoked actors after hashing', async () => {
    const { app, db, admin, alice, second } = await setup();
    expect((await app.inject({ url: '/api/v1/admin/users', headers: headers(admin) })).statusCode).toBe(200);
    const passwords = await import('../../src/auth/passwords.js');
    const actualHash = passwords.hashPassword;
    const hash = vi.spyOn(passwords, 'hashPassword').mockRejectedValueOnce(new Error('controlled hash failure'));
    const reset = () => app.inject({ method: 'POST', url: `/api/v1/admin/users/${alice.user.id}/reset-password`, headers: headers(second), payload: { newPassword } });
    try {
      expect((await reset()).statusCode).toBe(500);
      expect((await db.pool.query('SELECT used FROM rate_limit_windows WHERE subject = $1', [second.user.id])).rows[0].used).toBe(1);
      const started = deferred();
      const resume = deferred();
      hash.mockImplementationOnce(async value => { started.resolve(); await resume.promise; return actualHash(value); });
      const pending = reset().then(result => result);
      try {
        await started.promise;
        expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${second.user.id}`, headers: headers(admin), payload: { active: false } })).statusCode).toBe(200);
      } finally { resume.resolve(); }
      expect((await pending).statusCode).toBe(401);
      expect((await login(app, 'alice', password)).user.id).toBe(alice.user.id);
    } finally { hash.mockRestore(); }
  });

  it('audits committed changes without password, hash or session material', async () => {
    const { app, db, admin, alice } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(admin), payload: { username: 'audited', password } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${alice.user.id}`, headers: headers(admin), payload: { active: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${alice.user.id}`, headers: headers(admin), payload: { active: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/users/${alice.user.id}/reset-password`, headers: headers(admin), payload: { newPassword } })).statusCode).toBe(204);
    const events = (await db.pool.query('SELECT * FROM user_audit_events ORDER BY created_at, id')).rows;
    expect(events.map(event => event.action)).toEqual(['create', 'disable', 'enable', 'reset-password']);
    expect(events.map(event => event.target_id)).toEqual([created.json().id, alice.user.id, alice.user.id, alice.user.id]);
    for (const event of events) {
      expect(event.actor_id).toBe(admin.user.id);
      expect(event.created_at).toBeInstanceOf(Date);
      expect(Object.keys(event).sort()).toEqual(['action', 'actor_id', 'created_at', 'id', 'target_id']);
    }
    expect(JSON.stringify(events)).not.toContain(password);
    expect(JSON.stringify(events)).not.toContain(newPassword);
    expect(JSON.stringify(events)).not.toContain(admin.csrfToken);
  });

  it('enforces administrator authorization and strict input validation for direct service calls', async () => {
    const { app, db, admin, alice } = await setup();
    expect((await app.inject({ url: '/api/v1/admin/users', headers: headers(admin) })).statusCode).toBe(200);
    const { createUsersService } = await import('../../src/users/service.js');
    const service = createUsersService(db);
    const actor = async (userId: string): Promise<Actor> => ({ userId, role: userId === admin.user.id ? 'admin' : 'user', authVersion: 1,
      sessionHash: (await db.pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [userId])).rows[0].token_hash });
    const userActor = await actor(alice.user.id);
    const adminActor = await actor(admin.user.id);
    await expect(service.list(userActor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.create(userActor, { username: 'blocked', password })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.setActive(userActor, alice.user.id, false)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.resetPassword(userActor, alice.user.id, newPassword)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.create(adminActor, { username: 'blocked', password, role: 'admin' } as { username: string; password: string })).rejects.toMatchObject({ statusCode: 400 });
    await db.pool.query('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [admin.user.id]);
    await expect(service.list(adminActor)).rejects.toMatchObject({ statusCode: 401 });
  });
});
