import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';

function env(): NodeJS.ProcessEnv {
  return {
    PAGELINGO_SITE_MODE: 'test', PAGELINGO_SITE_ORIGIN: 'http://127.0.0.1:5174',
    DATABASE_URL: 'postgresql://test:database-secret@localhost/test',
    PAGELINGO_DATA_DIR: '/tmp/pgl-test', PAGELINGO_MASTER_KEY_ID: 'test-key',
    PAGELINGO_MASTER_KEYS_JSON: JSON.stringify({ 'test-key': Buffer.alloc(32, 7).toString('base64') }),
  };
}

describe('runtime configuration', () => {
  it('accepts explicit test settings and defaults the service to loopback', () => {
    const config = readConfig(env());
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4320);
    expect(config.maxPdfBytes).toBe(268435456);
    expect(config.keyring.keys['test-key']).toHaveLength(32);
  });
  it.each(['development', '', 'prod'])('rejects unknown mode %j', mode => {
    expect(() => readConfig({ ...env(), PAGELINGO_SITE_MODE: mode })).toThrow(/mode/i);
  });
  it.each(['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?q=x'])('rejects unsafe production origin %s', origin => {
    expect(() => readConfig({ ...env(), PAGELINGO_SITE_MODE: 'production', PAGELINGO_SITE_ORIGIN: origin })).toThrow(/origin/i);
  });
  it('trusts no proxy unless a hop count is configured', () => {
    expect(readConfig(env()).trustProxyHops).toBeUndefined();
    expect(readConfig({ ...env(), PAGELINGO_TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1);
  });
  it.each(['0', '-1', '9', 'true', '1.5'])('rejects proxy hop count %j', value => {
    expect(() => readConfig({ ...env(), PAGELINGO_TRUST_PROXY_HOPS: value })).toThrow(/PROXY/);
  });
  it('accepts a production HTTPS origin', () => {
    expect(readConfig({ ...env(), PAGELINGO_SITE_MODE: 'production', PAGELINGO_SITE_ORIGIN: 'https://example.com' }).publicOrigin).toBe('https://example.com');
  });
  it.each(['http://example.com', 'http://127.0.0.1.evil.example', 'https://192.168.1.2'])('rejects non-loopback test origin %s', origin => {
    expect(() => readConfig({ ...env(), PAGELINGO_SITE_ORIGIN: origin })).toThrow(/origin/i);
  });
  it.each(['http://localhost:5174', 'http://127.0.0.2:5174', 'http://[::1]:5174'])('accepts loopback origin %s', origin => {
    expect(readConfig({ ...env(), PAGELINGO_SITE_ORIGIN: origin }).publicOrigin).toBe(origin);
  });
  it.each(['{}', 'null', '[]', '{', JSON.stringify({ 'test-key': 'bad' }), JSON.stringify({ 'test-key': Buffer.alloc(31).toString('base64') }), JSON.stringify({ other: Buffer.alloc(32).toString('base64') })])('rejects invalid keyrings without exposing their values', keys => {
    expect(() => readConfig({ ...env(), PAGELINGO_MASTER_KEYS_JSON: keys })).toThrow(/key/i);
  });
  it.each([{ DATABASE_URL: '' }, { PAGELINGO_DATA_DIR: '' }, { PAGELINGO_SERVICE_PORT: '0' }, { PAGELINGO_SERVICE_PORT: '12.5' }, { PAGELINGO_MAX_PDF_BYTES: '-1' }])('rejects incomplete or invalid settings %j', override => {
    expect(() => readConfig({ ...env(), ...override })).toThrow();
  });
  it('keeps database credentials and keyring out of JSON serialization', () => {
    expect(JSON.stringify({ config: readConfig(env()) })).not.toContain('database-secret');
    expect(JSON.stringify(readConfig(env()))).not.toContain(Buffer.alloc(32, 7).toString('base64'));
  });
});

it('applies strict bundle budgets while deriving the PDF limit from its single existing setting', () => {
  const config = readConfig({ ...env(), PAGELINGO_MAX_PDF_BYTES: '1234', PAGELINGO_BUNDLE_LIMITS_JSON: '{"maxNodes":12,"maxArchiveBytes":536870912}' });
  expect(config.bundleLimits).toMatchObject({ maxPdfBytes: 1234, maxNodes: 12, maxArchiveBytes: 536870912, maxExpandedBytes: 1073741824 });
  for (const raw of ['null', '[]', '{', '{"maxPdfBytes":1}', '{"unknown":1}', '{"maxNodes":100001}', '{"maxDepth":33}', '{"maxArchiveBytes":0}', '{"maxFiles":1.5}', '{"maxArchiveBytes":"1"}']) {
    expect(() => readConfig({ ...env(), PAGELINGO_BUNDLE_LIMITS_JSON: raw })).toThrow('Invalid PAGELINGO_BUNDLE_LIMITS_JSON');
  }
});
