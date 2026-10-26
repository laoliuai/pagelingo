import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/passwords.js';

describe('password hashing', () => {
  it('salts fixed-cost scrypt hashes and verifies the exact Unicode password', async () => {
    const password = '正确密码示例123456😀';
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt\$v1\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(`${password}x`, first)).toBe(false);
    expect(await verifyPassword('正确密码示例123456', first)).toBe(false);
  });
  it('preserves whitespace and the full 128 Unicode code points', async () => {
    const password = ` ${'😀'.repeat(126)} `;
    const encoded = await hashPassword(password);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword(password.trim(), encoded)).toBe(false);
  });
  it('rejects malformed encodings and unbounded work parameters', async () => {
    for (const encoded of ['', 'scrypt$v1$999999999$8$1$aa$bb', `scrypt$v2$131072$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`]) {
      expect(await verifyPassword('valid password 123', encoded)).toBe(false);
    }
    await expect(hashPassword('short')).rejects.toThrow();
    await expect(hashPassword('😀'.repeat(129))).rejects.toThrow();
  });
  it('bounds scrypt concurrency and rejects work beyond eight queued jobs', async () => {
    const results = await Promise.allSettled(Array.from({ length: 11 }, () => hashPassword('valid password 123')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { statusCode: 429 } }]);
  });
});
