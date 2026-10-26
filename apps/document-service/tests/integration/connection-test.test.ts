import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultProviderProfile } from '@pagelingo/document-contracts';
import { createConnectionTestService } from '../../src/providers/connection-test.js';
import { createProvidersService } from '../../src/providers/service.js';
import { createApp } from '../../src/app.js';
import { bootstrapAdmin } from '../../src/cli/bootstrap-admin.js';
import { createServiceTestApp } from '../helpers/app.js';
import { login } from '../helpers/session.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const password = 'correct password 123456';
const url = '/api/v1/settings/provider';
const key = 'connection-test-secret';
const { revision: _revision, hasApiKey: _hasKey, ...defaults } = defaultProviderProfile;
const settings = { ...defaults, baseUrl: 'https://provider.example/v1', model: 'saved-model' };
const success = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'connection-test', text: '你好。' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
async function setup(fetch: typeof globalThis.fetch = async () => success()) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const test = await createServiceTestApp({ outboundFetch: async (input, init) => { calls.push({ url: String(input), init }); return fetch(input, init); } });
  cleanup.push(test.close);
  await bootstrapAdmin(test.db, { username: 'admin', password });
  await test.db.pool.query(`INSERT INTO users (username, password_hash, role) SELECT 'alice', password_hash, 'user' FROM users WHERE username = 'admin'`);
  const session = await login(test.app, 'alice', password);
  const headers = { cookie: session.cookie, origin: 'http://127.0.0.1:5174', 'x-csrf-token': session.csrfToken };
  const save = (revision = 0) => test.app.inject({ method: 'PUT', url, headers, payload: { expectedRevision: revision, settings, key: { action: 'replace', value: key } } });
  const run = (payload: object = {}) => test.app.inject({ method: 'POST', url: `${url}/test`, headers, payload });
  const actor = { userId: session.user.id, role: 'user' as const, authVersion: 1, sessionHash: createHash('sha256').update(session.cookie.split('=')[1]!).digest('hex') };
  return { ...test, calls, session, headers, save, run, actor };
}

describe('explicit personal provider test', () => {
  it('uses saved owner profile once and SDK validation, caps output, and returns only status/revision/usage/time', async () => {
    const test = await setup();
    expect((await test.save()).statusCode).toBe(200);
    expect((await test.app.inject({ url, headers: test.headers })).statusCode).toBe(200);
    expect(test.calls).toHaveLength(0);
    const result = await test.run();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ ok: true, profileRevision: 1, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, checkedAt: expect.any(String) });
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]!.url).toBe('https://provider.example/v1/chat/completions');
    const body = JSON.parse(test.calls[0]!.init!.body as string);
    expect(body.model).toBe('saved-model'); expect(body.max_tokens).toBe(128);
    expect((test.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${key}`);
    expect(result.body).not.toContain(key); expect(result.body).not.toContain('你好');
    expect((await test.db.pool.query('SELECT * FROM documents')).rowCount).toBe(0);
  });
  it('requires session, Origin/CSRF, empty input and a complete owner profile before egress', async () => {
    const test = await setup();
    expect((await test.app.inject({ method: 'POST', url: `${url}/test`, payload: {} })).statusCode).toBe(401);
    expect((await test.app.inject({ method: 'POST', url: `${url}/test`, headers: { cookie: test.session.cookie }, payload: {} })).statusCode).toBe(403);
    expect((await test.run({ ownerId: test.session.user.id })).statusCode).toBe(400);
    expect((await test.run()).statusCode).toBe(400);
    expect(test.calls).toHaveLength(0);
  });
  it.each(['malformed', 'wrong-block', 'auth', 'throw'])('rejects %s with no retry or upstream diagnostic leak', async kind => {
    const test = await setup(async () => {
      if (kind === 'throw') throw new Error(key);
      if (kind === 'auth') return new Response(key, { status: 401 });
      if (kind === 'malformed') return Response.json({ secret: key });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: key, text: key }] }) } }] });
    });
    await test.save(); const result = await test.run();
    expect(result.statusCode).toBe(502); expect(result.body).not.toContain(key); expect(test.calls).toHaveLength(1);
  });
  it('commits reservations for failed upstream attempts and enforces user quota atomically', async () => {
    const test = await setup(async () => new Response(key, { status: 401 })); await test.save();
    const results = await Promise.all(Array.from({ length: 6 }, () => test.run()));
    expect(results.map(r => r.statusCode).sort()).toEqual([429, 502, 502, 502, 502, 502]);
    expect(results.find(r => r.statusCode === 429)!.headers['retry-after']).toBeDefined(); expect(test.calls).toHaveLength(5);
    const admin = await login(test.app, 'admin', password);
    const headers = { cookie: admin.cookie, origin: 'http://127.0.0.1:5174', 'x-csrf-token': admin.csrfToken };
    expect((await test.app.inject({ method: 'POST', url: `${url}/test`, headers, payload: {} })).statusCode).toBe(400);
    expect(test.calls).toHaveLength(5);
    expect((await test.app.inject({ method: 'PUT', url, headers, payload: { expectedRevision: 0, settings, key: { action: 'replace', value: key } } })).statusCode).toBe(200);
    expect((await test.app.inject({ method: 'POST', url: `${url}/test`, headers, payload: {} })).statusCode).toBe(502);
    expect(test.calls).toHaveLength(6);
  });
  it.each(['disabled', 'password-reset', 'key-change', 'logout'])('aborts pending call on %s and discards late success', async kind => {
    let signal!: AbortSignal; let release!: (response: Response) => void;
    const test = await setup(async (_input, init) => { signal = init!.signal!; return new Promise(resolve => { release = resolve; }); });
    await test.save(); const pending = test.run().then(result => result);
    await vi.waitFor(() => expect(test.calls).toHaveLength(1));
    if (kind === 'disabled') await test.db.pool.query('UPDATE users SET active = false WHERE id = $1', [test.actor.userId]);
    if (kind === 'password-reset') await test.db.pool.query('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [test.actor.userId]);
    if (kind === 'key-change') await test.save(1);
    if (kind === 'logout') await test.db.pool.query('DELETE FROM sessions WHERE user_id = $1', [test.actor.userId]);
    await vi.waitFor(() => expect(signal.aborted).toBe(true)); release(success());
    expect([401, 409]).toContain((await pending).statusCode); expect(test.calls).toHaveLength(1);
  });
  it.each(['cancel', 'timeout'])('aborts an uncooperative transport on %s without accepting late results', async kind => {
    const test = await setup(); await test.save();
    let upstreamSignal!: AbortSignal; let release!: (response: Response) => void;
    const controller = new AbortController();
    const service = createConnectionTestService({ db: test.db,
      providers: createProvidersService({ db: test.db, keyring: test.config.keyring }),
      outboundFetch: async (_input, init) => { upstreamSignal = init!.signal!; return new Promise(resolve => { release = resolve; }); },
    });
    if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = service.testProviderConnection(test.actor, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ statusCode: kind === 'cancel' ? 499 : 504 });
      await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
      if (kind === 'cancel') controller.abort(); else await vi.advanceTimersByTimeAsync(10_000);
      await rejected; expect(upstreamSignal.aborted).toBe(true); release(success());
    } finally { vi.useRealTimers(); }
  });
  it('returns cancellation while preflight is pending and never starts a later model call', async () => {
    const test = await setup(); await test.save();
    const providers = createProvidersService({ db: test.db, keyring: test.config.keyring });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let started = false; const fetch = vi.fn(async () => success());
    const service = createConnectionTestService({ db: test.db, outboundFetch: fetch, providers: { ...providers,
      async getForCall(actor) { const result = await providers.getForCall(actor); started = true; await gate; return result; },
    } });
    const controller = new AbortController();
    const pending = service.testProviderConnection(test.actor, controller.signal).then(() => 200, error => error.statusCode);
    await vi.waitFor(() => expect(started).toBe(true)); controller.abort();
    const status = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still pending'), 30))]);
    release(); await pending;
    expect(status).toBe(499); expect(fetch).not.toHaveBeenCalled();
  });
  it('serializes the final current-profile check with any pending monitor check', async () => {
    const test = await setup(); await test.save();
    let releaseFetch!: (response: Response) => void;
    let releaseCheck!: () => void; const checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
    let checks = 0; let active = 0; let peak = 0;
    const db = { ...test.db, async transaction<T>(fn: Parameters<typeof test.db.transaction<T>>[0]): Promise<T> {
      checks++; active++; peak = Math.max(peak, active);
      try { const result = await test.db.transaction(fn); if (checks === 2) await checkGate; return result; }
      finally { active--; }
    } };
    const service = createConnectionTestService({ db, providers: createProvidersService({ db: test.db, keyring: test.config.keyring }),
      outboundFetch: async () => new Promise(resolve => { releaseFetch = resolve; }),
    });
    const pending = service.testProviderConnection(test.actor);
    try {
      await vi.waitFor(() => expect(checks).toBe(2)); releaseFetch(success());
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(peak).toBe(1);
    } finally { releaseCheck(); await pending; }
  });
  it('rechecks a revision changed after key loading before making any model call', async () => {
    const test = await setup(); await test.save();
    const providers = createProvidersService({ db: test.db, keyring: test.config.keyring });
    const fetch = vi.fn(async () => success());
    const service = createConnectionTestService({ db: test.db, outboundFetch: fetch, providers: { ...providers,
      async getForCall(actor) { const result = await providers.getForCall(actor); await test.save(1); return result; },
    } });
    await expect(service.testProviderConnection(test.actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('propagates HTTP request disconnect to the pending Provider call', async () => {
    const test = await setup(); await test.save();
    let request!: import('node:http').IncomingMessage; let signal!: AbortSignal;
    const app = await createApp({ config: test.config, db: test.db, outboundFetch: async (_input, init) => {
      signal = init!.signal!; return new Promise(() => {});
    } });
    cleanup.push(() => app.close());
    app.addHook('onRequest', async req => { request = req.raw; });
    const pending = app.inject({ method: 'POST', url: `${url}/test`, headers: test.headers, payload: {} }).then(result => result);
    await vi.waitFor(() => expect(signal).toBeDefined()); request.emit('aborted');
    expect((await pending).statusCode).toBe(499); expect(signal.aborted).toBe(true);
  });
  it('forbids injectable fetch outside test mode', async () => {
    const test = await setup();
    await expect(createApp({ config: { ...test.config, mode: 'local' }, db: test.db, outboundFetch: async () => success() })).rejects.toThrow();
  });
});
