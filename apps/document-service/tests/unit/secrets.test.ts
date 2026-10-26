import { createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../../src/config.js';

const owner = 'a9ba2d16-742b-4ed5-89a2-c465137c5436';
const keyring: RuntimeConfig['keyring'] = {
  activeKeyId: 'current',
  keys: { current: Buffer.alloc(32, 9), previous: Buffer.alloc(32, 4) },
};

describe('owner-bound provider encryption', () => {
  it('round-trips exact API keys with a fresh 12-byte nonce and 16-byte tag each time', async () => {
    const { sealApiKey, openApiKey } = await import('../../src/providers/secrets.js');
    const value = '  test-secret-密钥😀  ';
    const first = sealApiKey(value, owner, keyring);
    const second = sealApiKey(value, owner, keyring);
    expect(first.keyId).toBe('current');
    expect(first.nonce).toHaveLength(12);
    expect(first.tag).toHaveLength(16);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.ciphertext.toString()).not.toContain(value);
    expect(openApiKey(first, owner, keyring)).toBe(value);
    expect(openApiKey(second, owner, keyring)).toBe(value);
    // Check the fixed algorithm and AAD independently from openApiKey.
    const decipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 9), first.nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from('pgl:provider:v1:a9ba2d16-742b-4ed5-89a2-c465137c5436'));
    decipher.setAuthTag(first.tag);
    expect(Buffer.concat([decipher.update(first.ciphertext), decipher.final()]).toString('utf8')).toBe(value);
  });

  it('rejects another owner, altered tag or ciphertext, unknown key ID and wrong master key', async () => {
    const { sealApiKey, openApiKey } = await import('../../src/providers/secrets.js');
    const secret = sealApiKey('test-secret', owner, keyring);
    const tag = Buffer.from(secret.tag); tag[0] = tag[0]! ^ 1;
    const ciphertext = Buffer.from(secret.ciphertext); ciphertext[0] = ciphertext[0]! ^ 1;
    for (const [value, userId, keys] of [
      [secret, 'another-owner', keyring],
      [{ ...secret, tag }, owner, keyring],
      [{ ...secret, ciphertext }, owner, keyring],
      [{ ...secret, nonce: secret.nonce.subarray(1) }, owner, keyring],
      [{ ...secret, tag: secret.tag.subarray(1) }, owner, keyring],
      [{ ...secret, keyId: 'missing' }, owner, keyring],
      [{ ...secret, keyId: 'toString' }, owner, keyring],
      [secret, owner, { activeKeyId: 'current', keys: { current: Buffer.alloc(32, 1) } }],
    ] as const) expect(() => openApiKey(value, userId, keys)).toThrow();
  });

  it('decrypts an old key ID after active-key rotation without rewriting its envelope', async () => {
    const { sealApiKey, openApiKey } = await import('../../src/providers/secrets.js');
    const secret = sealApiKey('old-secret', owner, { ...keyring, activeKeyId: 'previous' });
    expect(openApiKey(secret, owner, keyring)).toBe('old-secret');
    expect(secret.keyId).toBe('previous');
    expect(sealApiKey('new-secret', owner, keyring).keyId).toBe('current');
    expect(() => sealApiKey('secret', owner, { activeKeyId: 'missing', keys: {} })).toThrow();
  });
});
