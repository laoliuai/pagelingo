import { describe, expect, it, vi } from 'vitest';
import { resolvePublicAddresses } from '../../src/network/address-policy.js';

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
});
