import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIpAddressError, isFakeIpRejection, resolvePublicAddresses } from '../../src/network/address-policy.js';

describe('public address policy', () => {
  it.each(['localhost', 'localhost.', 'a.localhost', '127.1', '2130706433', '0x7f000001', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '[::1]', '::', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '4000::1', '::8.8.8.8', '2606:4700:4700::1111%eth0'])('rejects %s without DNS', async hostname => {
    const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }]);
    await expect(resolvePublicAddresses(hostname, lookup)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects empty, mixed and inconsistent DNS results', async () => {
    for (const records of [[], [{ address: '8.8.8.8', family: 4 as const }, { address: '10.0.0.1', family: 4 as const }], [{ address: '8.8.8.8', family: 6 as const }]]) {
      await expect(resolvePublicAddresses('provider.example', async () => records)).rejects.toThrow();
    }
  });
  it('accepts all-public DNS and validates anew on every request', async () => {
    const lookup = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    expect(await resolvePublicAddresses('provider.example', lookup)).toEqual([{ address: '8.8.8.8', family: 4 }]);
    await expect(resolvePublicAddresses('provider.example', lookup)).rejects.toThrow();
    expect(await resolvePublicAddresses('2606:4700:4700::1111', lookup)).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
  });
  describe('proxy fake-ip DNS answers', () => {
    const fake = async () => [{ address: '198.18.0.97', family: 4 as const }, { address: '2001:2::49', family: 6 as const }];
    afterEach(() => { delete process.env.PAGELINGO_ALLOW_FAKE_IP; });
    it('are refused by default with a reason the worker can report', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = await resolvePublicAddresses('provider.example', fake).catch(value => value);
      expect(error).toBeInstanceOf(FakeIpAddressError);
      expect(isFakeIpRejection(new Error('transport failed', { cause: error }))).toBe(true);
      expect(isFakeIpRejection(new Error('transport failed'))).toBe(false);
      warn.mockRestore();
    });
    it('are allowed only when explicitly enabled', async () => {
      process.env.PAGELINGO_ALLOW_FAKE_IP = '1';
      expect(await resolvePublicAddresses('provider.example', fake)).toEqual([{ address: '198.18.0.97', family: 4 }, { address: '2001:2::49', family: 6 }]);
    });
    it.each(['198.18.0.97', '198.19.255.255'])('never open the literal address %s', async host => {
      process.env.PAGELINGO_ALLOW_FAKE_IP = '1';
      await expect(resolvePublicAddresses(host, async () => [])).rejects.toThrow();
    });
    it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', 'fd00::1'])('do not widen the opt-in to the private address %s', async address => {
      process.env.PAGELINGO_ALLOW_FAKE_IP = '1';
      await expect(resolvePublicAddresses('provider.example', async () => [{ address, family: address.includes(':') ? 6 as const : 4 as const }])).rejects.toThrow();
    });
  });
});
