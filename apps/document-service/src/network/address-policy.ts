import ipaddr from 'ipaddr.js';

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

// Proxy tools in fake-ip mode answer DNS from these benchmarking ranges and carry the real connection themselves.
const FAKE_IP_RANGES = [ipaddr.parseCIDR('198.18.0.0/15'), ipaddr.parseCIDR('2001:2::/48')];
export class FakeIpAddressError extends Error {
  constructor() { super('DNS returned a proxy fake-ip address. Set PAGELINGO_ALLOW_FAKE_IP=1 if this machine resolves names through such a proxy.'); }
}
export function isFakeIpRejection(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) if (current instanceof FakeIpAddressError) return true;
  return false;
}
function isFakeIp(parsed: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  return FAKE_IP_RANGES.some(([range, bits]) => range.kind() === parsed.kind() && parsed.match(range, bits));
}
let warned = false;
function publicAddress(address: string, family?: number, fromDns = false): ResolvedAddress {
  if (address.includes('%')) throw new Error('Outbound address cannot have a zone');
  const parsed = ipaddr.parse(address);
  if (fromDns && isFakeIp(parsed)) {
    // TLS still verifies the real hostname, and this range holds no internal services.
    if (process.env.PAGELINGO_ALLOW_FAKE_IP === '1') return { address: parsed.toString(), family: parsed.kind() === 'ipv4' ? 4 : 6 };
    const error = new FakeIpAddressError();
    if (!warned) { warned = true; console.warn(error.message); }
    throw error;
  }
  // ipaddr's default unicast classification also includes unallocated IPv6 space.
  if (parsed.kind() === 'ipv6' && !parsed.match(ipaddr.parse('2000::'), 3)) throw new Error('Outbound IPv6 address is not global');
  const actualFamily = parsed.kind() === 'ipv4' ? 4 : 6;
  // Mapped/transition ranges are deliberately not accepted as public destinations.
  if (parsed.range() !== 'unicast' || (family !== undefined && actualFamily !== family)) throw new Error('Outbound address is not public');
  return { address: parsed.toString(), family: actualFamily };
}

export async function resolvePublicAddresses(hostname: string, lookup: Lookup): Promise<ResolvedAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Outbound hostname is not public');
  // ipaddr also recognizes legacy shortened, integer, hexadecimal IPv4 literals.
  if (ipaddr.isValid(host)) return [publicAddress(host)];
  const addresses = await lookup(host);
  if (!addresses.length) throw new Error('Outbound hostname has no addresses');
  return addresses.map(({ address, family }) => publicAddress(address, family, true));
}
