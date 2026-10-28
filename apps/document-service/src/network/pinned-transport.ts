import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, connect as tcpConnect } from 'node:net';
import type { Socket, TcpNetConnectOpts } from 'node:net';
import { connect, checkServerIdentity } from 'node:tls';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import { Agent } from 'undici';
import ipaddr from 'ipaddr.js';
import { resolvePublicAddresses } from './address-policy.js';
import type { Lookup, ResolvedAddress } from './address-policy.js';

/** Resolve only after authenticating TLS for hostname. Must honor signal and destroy failed sockets. */
export type Connector = (target: ResolvedAddress & { hostname: string; port: number; signal: AbortSignal }) => Promise<TLSSocket>;

export const tlsConnector: Connector = ({ address, family, hostname, port, signal }) => new Promise((resolve, reject) => {
  const options: ConnectionOptions & TcpNetConnectOpts = { host: address, family, port, signal, rejectUnauthorized: true,
    servername: isIP(hostname) ? undefined : hostname, ALPNProtocols: ['http/1.1'],
    checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
  };
  const socket = connect(options);
  socket.once('error', error => { socket.destroy(); reject(error); });
  socket.once('secureConnect', () => {
    // Explicit check also covers literal IP targets (for which SNI is omitted).
    const error = checkServerIdentity(hostname, socket.getPeerCertificate());
    if (error || !socket.authorized) { socket.destroy(); reject(new Error('Outbound TLS authentication failed')); }
    else resolve(socket);
  });
});
export const defaultLookup: Lookup = async hostname => (await dnsLookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export type HttpConnector = (target: ResolvedAddress & { hostname: string; port: number; signal: AbortSignal }) => Promise<Socket>;
const tcpConnector: HttpConnector = ({ address, family, port, signal }) => new Promise((resolve, reject) => {
  const socket = tcpConnect({ host: address, family, port, signal });
  socket.once('error', error => { socket.destroy(); reject(error); });
  socket.once('connect', () => resolve(socket));
});
export interface PinnedOptions { lookup?: Lookup; connector?: Connector; httpConnector?: HttpConnector; timeoutMs: number; maxResponseBytes: number }
export function validateLimits(options: PinnedOptions): void {
  if (![options.timeoutMs, options.maxResponseBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid outbound limits');
}
/** One resolved destination per direct Agent. Caller owns lifecycle and URL/redirect policy. */
export async function createPinnedAgent(url: URL, signal: AbortSignal, options: Pick<PinnedOptions, 'lookup' | 'connector' | 'httpConnector'>): Promise<Agent> {
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid transport protocol');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await abortable(resolvePublicAddresses(hostname, options.lookup ?? defaultLookup), signal);
  signal.throwIfAborted();
  const secure = url.protocol === 'https:';
  const target = { ...addresses[0]!, hostname, port: Number(url.port || (secure ? 443 : 80)), signal };
  const connector = secure ? options.connector ?? tlsConnector : options.httpConnector ?? tcpConnector;
  return new Agent({ connect: (_options, callback) => {
    Promise.resolve().then(() => connector(target)).then(socket => {
      try {
        signal.throwIfAborted();
        if ((secure && (!(socket as TLSSocket).encrypted || !(socket as TLSSocket).authorized)) || !socket.remoteAddress ||
            ipaddr.process(socket.remoteAddress).toString() !== ipaddr.process(target.address).toString()) throw new Error('Outbound peer verification failed');
      } catch { socket.destroy(); callback(new Error('Outbound connection rejected'), null); return; }
      callback(null, socket);
    }, () => callback(new Error('Outbound connection failed'), null));
  } });
}
