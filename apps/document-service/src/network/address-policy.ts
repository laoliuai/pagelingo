import ipaddr from 'ipaddr.js';

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

function publicAddress(address: string, family?: number): ResolvedAddress {
  if (address.includes('%')) throw new Error('Outbound address cannot have a zone');
  const parsed = ipaddr.parse(address);
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
  return addresses.map(({ address, family }) => publicAddress(address, family));
}
