import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { tokenHash } from '../../src/auth/sessions.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';
import { createApp } from '../../src/app.js';

const origin = 'http://127.0.0.1:5174';
const password = 'correct password 123456';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function headers(session: { cookie: string; csrfToken: string }) {
  return { cookie: session.cookie, origin, 'x-csrf-token': session.csrfToken };
}
async function setup() {
  const test = await createServiceTestApp();
  cleanup.push(test.close);
  const probe = await createApp({ db: test.db, config: test.config });
  cleanup.push(() => probe.close());
  let beforeWrite = async () => {};
  for (const scope of ['captures:write', 'captures:read', 'links:write', 'preferences:read'] as const) {
    probe.route({ method: ['GET', 'POST'], url: `/test/${scope.replace(':', '-')}`, async handler(request) {
      const { requireCapturePrincipal, assertCapturePrincipalCurrent } = await import('../../src/devices/guards.js');
      const principal = await requireCapturePrincipal(request, scope);
      if (request.method === 'POST') await beforeWrite();
      return test.db.transaction(async client => {
        await assertCapturePrincipalCurrent(client, principal);
        const userId = principal.kind === 'session' ? principal.actor.userId : principal.userId;
        if (request.method === 'POST') await client.query(`INSERT INTO documents (owner_id,kind,title,original_filename) VALUES ($1,'article','guarded-write',NULL)`, [userId]);
        return { kind: principal.kind, userId };
      });
    } });
  }
  await bootstrapAdmin(test.db, { username: 'admin', password });
  await test.db.pool.query(`INSERT INTO users (username,password_hash,role)
    SELECT 'alice',password_hash,'user' FROM users WHERE username='admin'`);
  const admin = await login(test.app, 'admin', password);
  const alice = await login(test.app, 'alice', password);
  const code = async (session = alice) => {
    const response = await test.app.inject({ method: 'POST', url: '/api/v1/devices/pairing-codes', headers: headers(session), payload: {} });
    expect(response.statusCode).toBe(201);
    return response.json() as { code: string; expiresAt: string };
  };
  const exchange = (value: string, extra = {}) => test.app.inject({ method: 'POST', url: '/api/v1/devices/exchange', payload: { code: value, deviceName: 'My browser', extensionId: 'test-extension', extensionVersion: '1.0', ...extra } });
  const paired = async (session = alice) => {
    const response = await exchange((await code(session)).code);
    expect(response.statusCode).toBe(201);
    return response.json();
  };
  return { ...test, admin, alice, code, exchange, paired, probe, pauseWrite(fn: () => Promise<void>) { beforeWrite = fn; } };
}

describe('capture device pairing', () => {
  it('expires issued device credentials after 30 days', async () => {
    const { db, paired } = await setup();
    const result = await paired();
    const row = (await db.pool.query('SELECT created_at,expires_at FROM devices WHERE id=$1', [result.device.id])).rows[0];
    const lifetimeMs = row.expires_at.getTime() - row.created_at.getTime();
    expect(lifetimeMs).toBeGreaterThanOrEqual(2_592_000_000 - 1000);
    expect(lifetimeMs).toBeLessThanOrEqual(2_592_000_000 + 1000);
    expect(result.device.expiresAt).toBe(row.expires_at.toISOString());
  });

  it('consumes a high entropy pairing code exactly once under concurrent exchange and stores only hashes', async () => {
    const { db, alice, code, exchange } = await setup();
    const pairing = await code();
    expect(pairing.code).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(Date.parse(pairing.expiresAt) - Date.now()).toBeGreaterThan(290_000);
    expect(Date.parse(pairing.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    const results = await Promise.all([exchange(pairing.code), exchange(pairing.code)]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 401]);
    const secondExchange = await exchange(pairing.code);
    expect(secondExchange.statusCode).toBe(401);
    const result = results.find(r => r.statusCode === 201)!.json();
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.owner).toEqual({ id: alice.user.id, username: 'alice' });
    expect(result.siteId).toBe((await db.pool.query('SELECT site_id FROM site_metadata')).rows[0].site_id);
    const device = (await db.pool.query('SELECT * FROM devices')).rows[0];
    expect(device.token_hash).toBe(tokenHash(result.token));
    expect(device.scopes).toEqual(['captures:write', 'captures:read', 'links:write', 'preferences:read']);
    expect((await db.pool.query('SELECT code_hash FROM device_pairings')).rows[0].code_hash).toBe(tokenHash(pairing.code));
    expect(JSON.stringify(device)).not.toContain(result.token);
    expect(secondExchange.body).not.toContain(pairing.code);
  });

  it('rejects expired codes and codes from expired or revoked sessions', async () => {
    const { db, alice, code, exchange, app } = await setup();
    const expired = await code();
    await db.pool.query("UPDATE device_pairings SET expires_at=clock_timestamp()-interval '1 second'");
    expect((await exchange(expired.code)).statusCode).toBe(401);
    const sessionExpired = await code();
    await db.pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [alice.user.id]);
    expect((await exchange(sessionExpired.code)).statusCode).toBe(401);
    const current = await login(app, 'alice', password);
    const revoked = await code(current);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(current), payload: {} });
    expect((await exchange(revoked.code)).statusCode).toBe(401);
    expect((await db.pool.query('SELECT * FROM devices')).rows).toHaveLength(0);
  });

  it('uses only the pairing identity, rejects client authorization fields, and preserves siteId across app instances', async () => {
    const { db, app, probe, admin, alice, code, exchange } = await setup();
    const pairing = await code();
    for (const extra of [{ ownerId: admin.user.id }, { scopes: ['admin'] }, { authVersion: 9 }]) {
      expect((await exchange(pairing.code, extra)).statusCode).toBe(400);
    }
    expect((await db.pool.query('SELECT id FROM devices')).rows).toHaveLength(0);
    const payload = { code: pairing.code, deviceName: 'Browser', extensionId: 'test', extensionVersion: '1.0' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/devices/exchange', headers: headers(admin), payload });
    expect(first.statusCode).toBe(201);
    expect(first.json().owner.id).toBe(alice.user.id);
    const second = await probe.inject({ method: 'POST', url: '/api/v1/devices/exchange', payload: { ...payload, code: (await code()).code } });
    expect(second.statusCode).toBe(201);
    expect(second.json().siteId).toBe(first.json().siteId);
  });

  it('limits code creation and persists failed exchange attempts without disclosing credentials', async () => {
    const { app, alice, exchange } = await setup();
    const create = () => app.inject({ method: 'POST', url: '/api/v1/devices/pairing-codes', headers: headers(alice), payload: {} });
    const results = await Promise.all(Array.from({ length: 6 }, create));
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 201, 201, 201, 201, 429]);
    const attempts = await Promise.all(Array.from({ length: 31 }, () => exchange('invalid-code')));
    expect(attempts.filter(r => r.statusCode === 401)).toHaveLength(30);
    const limited = attempts.find(r => r.statusCode === 429)!;
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body).not.toContain('invalid-code');
  });

  it('lists safe own devices, hides other owners and requires session CSRF for writes', async () => {
    const { app, alice, admin, paired } = await setup();
    const device = await paired();
    const list = await app.inject({ url: '/api/v1/devices', headers: headers(alice) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [device.device] });
    expect(list.body).not.toContain(device.token);
    expect(Object.keys(list.json().items[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'name', 'revokedAt']);
    expect((await app.inject({ url: '/api/v1/devices', headers: headers(admin) })).json()).toEqual({ items: [] });
    const url = `/api/v1/devices/${device.device.id}/revoke`;
    const otherOwner = await app.inject({ method: 'POST', url, headers: headers(admin), payload: {} });
    expect(otherOwner.statusCode).toBe(404);
    for (const requestHeaders of [{ cookie: alice.cookie, origin }, { ...headers(alice), origin: 'https://evil.example' }]) {
      for (const target of [url, '/api/v1/devices/pairing-codes']) {
        expect((await app.inject({ method: 'POST', url: target, headers: requestHeaders, payload: {} })).statusCode).toBe(403);
      }
    }
    expect((await app.inject({ method: 'POST', url, headers: headers(alice), payload: {} })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/devices', headers: headers(alice) })).json().items[0].revokedAt).not.toBeNull();
  });

  it('never lets Authorization fall back to an authenticated cookie on sensitive APIs', async () => {
    const { app, admin, paired } = await setup();
    const device = await paired(admin);
    for (const authorization of [`Bearer ${device.token}`, 'Bearer invalid', 'Basic invalid', '']) {
      const id = randomUUID();
      for (const url of ['/api/v1/devices', '/api/v1/settings/provider', '/api/v1/admin/users', '/api/v1/documents', `/api/v1/documents/${id}/reader`, `/api/v1/documents/${id}/source`]) {
        const result = await app.inject({ url, headers: { ...headers(admin), authorization } });
        expect(result.statusCode, `${url} with ${authorization.slice(0, 7)}`).toBe(401);
        expect(result.body).not.toContain(device.token);
      }
    }
  });

  it('revalidates session expiry using the current clock inside late publication transactions', async () => {
    const { db, alice } = await setup();
    const { assertCapturePrincipalCurrent } = await import('../../src/devices/guards.js');
    await expect(db.transaction(async client => {
      const row = (await client.query<{ expires_at: Date }>(`UPDATE sessions SET expires_at=transaction_timestamp()+interval '1 millisecond'
        WHERE user_id=$1 RETURNING expires_at`, [alice.user.id])).rows[0]!;
      // Wait on the real DB clock, without mocking either guard or expiry query.
      await client.query('SELECT pg_sleep(0.01)');
      expect(row.expires_at.getTime()).toBeLessThan(Date.now());
      await assertCapturePrincipalCurrent(client, { kind: 'session', actor: { userId: alice.user.id, role: 'user', authVersion: 1, sessionHash: tokenHash(alice.cookie.split('=')[1]!) } });
    })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('authenticates only assigned scopes, ignores client owner, and retains session write security', async () => {
    const { db, probe, admin, alice, paired } = await setup();
    const device = await paired();
    const authorization = `Bearer ${device.token}`;
    const result = await probe.inject({ method: 'POST', url: '/test/captures-write', headers: { authorization, cookie: admin.cookie }, payload: { ownerId: admin.user.id } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ kind: 'device', userId: alice.user.id });
    expect((await db.pool.query("SELECT owner_id FROM documents WHERE title='guarded-write'")).rows).toEqual([{ owner_id: alice.user.id }]);
    for (const scope of ['captures:write', 'captures:read', 'links:write', 'preferences:read']) {
      expect((await probe.inject({ url: `/test/${scope.replace(':', '-')}`, headers: { authorization } })).statusCode).toBe(200);
    }
    await db.pool.query("UPDATE devices SET scopes=ARRAY['captures:read'] WHERE id=$1", [device.device.id]);
    expect((await probe.inject({ url: '/test/captures-write', headers: { authorization, ...headers(admin) } })).statusCode).toBe(403);
    expect((await probe.inject({ url: '/test/captures-read', headers: { authorization } })).statusCode).toBe(200);
    for (const value of ['Bearer invalid', 'Basic invalid', '']) {
      expect((await probe.inject({ url: '/test/captures-read', headers: { authorization: value, ...headers(admin) } })).statusCode).toBe(401);
    }
    for (const supplied of [{ cookie: alice.cookie, origin }, { ...headers(alice), origin: 'https://evil.example' }]) {
      expect((await probe.inject({ method: 'POST', url: '/test/captures-write', headers: supplied, payload: {} })).statusCode).toBe(403);
    }
    expect((await probe.inject({ method: 'POST', url: '/test/captures-write', headers: headers(alice), payload: {} })).statusCode).toBe(200);
  });

  it('keeps devices after natural session expiry and cleanup, but rejects expired device tokens', async () => {
    const { db, alice, probe, paired } = await setup();
    const device = await paired();
    await db.pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [alice.user.id]);
    await db.pool.query('DELETE FROM sessions WHERE expires_at<clock_timestamp()');
    const read = () => probe.inject({ url: '/test/captures-read', headers: { authorization: `Bearer ${device.token}` } });
    expect((await read()).statusCode).toBe(200);
    await db.pool.query("UPDATE devices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [device.device.id]);
    expect((await read()).statusCode).toBe(401);
  });

  it('ordinary logout revokes only devices paired with that session', async () => {
    const { app, db, probe, alice, paired } = await setup();
    const otherSession = await login(app, 'alice', password);
    const first = await paired();
    const second = await paired(otherSession);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(alice), payload: {} })).statusCode).toBe(200);
    expect((await probe.inject({ url: '/test/captures-read', headers: { authorization: `Bearer ${first.token}` } })).statusCode).toBe(401);
    expect((await probe.inject({ url: '/test/captures-read', headers: { authorization: `Bearer ${second.token}` } })).statusCode).toBe(200);
    expect((await db.pool.query('SELECT auth_version FROM users WHERE id=$1', [alice.user.id])).rows[0].auth_version).toBe(1);
  });

  it('keeps accepted job leases independent of ordinary logout while allDevices fences old authVersion', async () => {
    const { app, db, alice, paired } = await setup();
    const { insertWebJob, startWebJobLease, assertJobLeaseCurrent } = await import('../../src/web-jobs/repository.js');
    const device = await paired();
    const other = await login(app, 'alice', password);
    const documentId = randomUUID();
    const jobId = randomUUID();
    const lease = await db.transaction(async client => {
      await client.query("INSERT INTO documents (id,owner_id,kind,title) VALUES ($1,$2,'article','Accepted link')", [documentId, alice.user.id]);
      await insertWebJob(client, { id: jobId, ownerId: alice.user.id, authVersion: 1, documentId, kind: 'fetch-link', url: 'https://example.com/article', inputSha256: 'a'.repeat(64) });
      return startWebJobLease(client, { ownerId: alice.user.id, jobId, slotId: 1, leaseOwner: 'test-worker' });
    });
    expect(lease).not.toBeNull();
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(alice), payload: {} });
    expect((await db.pool.query('SELECT revoked_at FROM devices WHERE id=$1', [device.device.id])).rows[0].revoked_at).not.toBeNull();
    await db.transaction(client => assertJobLeaseCurrent(client, lease!));
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(other), payload: { allDevices: true } });
    await expect(db.transaction(client => assertJobLeaseCurrent(client, lease!))).rejects.toThrow('Web job lease is no longer current');
  });

  it('rechecks scope membership at the final write boundary', async () => {
    const { db, probe, paired, pauseWrite } = await setup();
    const device = await paired();
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    pauseWrite(async () => { reached(); await paused; });
    const pending = probe.inject({ method: 'POST', url: '/test/captures-write', headers: { authorization: `Bearer ${device.token}` }, payload: {} }).then(r => r);
    try {
      await Promise.race([arrived, pending.then(result => { expect(result.statusCode).toBe(200); })]);
      await db.pool.query("UPDATE devices SET scopes=ARRAY['captures:read'] WHERE id=$1", [device.device.id]);
    } finally { release(); }
    expect((await pending).statusCode).toBe(403);
    expect((await db.pool.query("SELECT id FROM documents WHERE title='guarded-write'")).rows).toHaveLength(0);
  });

  for (const action of ['revoke', 'logout', 'allDevices', 'password', 'reset-password', 'disable'] as const) {
    it(`fences authenticated late writes and unconsumed codes after ${action}`, async () => {
      const { app, db, probe, alice, admin, paired, code, exchange, pauseWrite } = await setup();
      const device = await paired();
      const unconsumed = await code();
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>(resolve => { reached = resolve; });
      const paused = new Promise<void>(resolve => { release = resolve; });
      pauseWrite(async () => { reached(); await paused; });
      const pending = probe.inject({ method: 'POST', url: '/test/captures-write', headers: { authorization: `Bearer ${device.token}` }, payload: {} }).then(r => r);
      try {
        await Promise.race([arrived, pending.then(result => { expect(result.statusCode).toBe(200); })]);
        const target = action === 'revoke' ? { url: `/api/v1/devices/${device.device.id}/revoke`, payload: {} }
          : action === 'password' ? { url: '/api/v1/auth/password', payload: { currentPassword: password, newPassword: 'new correct password 123' } }
          : action === 'reset-password' ? { url: `/api/v1/admin/users/${alice.user.id}/reset-password`, payload: { newPassword: 'new correct password 123' } }
          : action === 'disable' ? { url: `/api/v1/admin/users/${alice.user.id}`, payload: { active: false } }
          : { url: '/api/v1/auth/logout', payload: { allDevices: action === 'allDevices' } };
        const result = await app.inject({ method: action === 'disable' ? 'PATCH' : 'POST', ...target, headers: headers(['reset-password', 'disable'].includes(action) ? admin : alice) });
        expect(result.statusCode).toBeLessThan(300);
      } finally { release(); }
      expect((await pending).statusCode).toBe(401);
      expect((await db.pool.query("SELECT id FROM documents WHERE title='guarded-write'")).rows).toHaveLength(0);
      expect((await probe.inject({ url: '/test/captures-read', headers: { authorization: `Bearer ${device.token}` } })).statusCode).toBe(401);
      if (action !== 'revoke') expect((await exchange(unconsumed.code)).statusCode).toBe(401);
      if (action === 'disable') {
        await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${alice.user.id}`, headers: headers(admin), payload: { active: true } });
        expect((await probe.inject({ url: '/test/captures-read', headers: { authorization: `Bearer ${device.token}` } })).statusCode).toBe(401);
      }
    });
  }
});
