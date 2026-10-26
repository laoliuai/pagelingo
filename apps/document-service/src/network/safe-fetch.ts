import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { TcpNetConnectOpts } from 'node:net';
import { connect, checkServerIdentity } from 'node:tls';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { resolvePublicAddresses } from './address-policy.js';
import type { Lookup, ResolvedAddress } from './address-policy.js';

/** Resolve only after authenticating TLS for hostname. Must honor signal and destroy failed sockets. */
export type Connector = (target: ResolvedAddress & { hostname: string; port: number; signal: AbortSignal }) => Promise<TLSSocket>;

const tlsConnector: Connector = ({ address, family, hostname, port, signal }) => new Promise((resolve, reject) => {
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
const defaultLookup: Lookup = async hostname => (await dnsLookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Per-request direct Agent: no ambient proxy, global dispatcher, redirects, or DNS re-resolution. */
export function createOutboundFetch({ lookup = defaultLookup, connector = tlsConnector, timeoutMs, maxResponseBytes }: {
  lookup?: Lookup; connector?: Connector; timeoutMs: number; maxResponseBytes: number;
}): typeof fetch {
  if (![timeoutMs, maxResponseBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid outbound limits');
  return async (input, init) => {
    const controller = new AbortController();
    let request: Request;
    try { request = new Request(input, init); }
    catch { throw new Error('Provider transport failed'); }
    const onAbort = () => controller.abort(new Error('Outbound request cancelled'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error('Outbound request timed out')), timeoutMs);
    let agent: Agent | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      controller.signal.throwIfAborted();
      const url = new URL(request.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid outbound URL');
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await abortable(resolvePublicAddresses(hostname, lookup), controller.signal);
      controller.signal.throwIfAborted();
      const target = { ...addresses[0]!, hostname, port: Number(url.port || 443), signal: controller.signal };
      agent = new Agent({ connect: (_options, callback) => {
        Promise.resolve().then(() => connector(target)).then(socket => {
          try {
            controller.signal.throwIfAborted();
            if (!socket.encrypted || !socket.authorized || !socket.remoteAddress ||
                ipaddr.process(socket.remoteAddress).toString() !== ipaddr.process(target.address).toString()) {
              throw new Error('Outbound peer verification failed');
            }
          } catch {
            socket.destroy(); callback(new Error('Outbound connection rejected'), null); return;
          }
          callback(null, socket);
        }, () => callback(new Error('Outbound connection failed'), null));
      } });
      const headers = new Headers(request.headers);
      headers.delete('host');
      const response = await abortable(undiciFetch(url, { method: request.method, headers: [...headers.entries()],
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await abortable(request.arrayBuffer(), controller.signal),
        dispatcher: agent, redirect: 'manual', signal: controller.signal,
      }), controller.signal);
      if (response.status >= 300 && response.status < 400) throw new Error('Outbound redirects are forbidden');
      if (Number(response.headers.get('content-length')) > maxResponseBytes) throw new Error('Outbound response is too large');
      const chunks: Uint8Array[] = []; let bytes = 0;
      reader = response.body?.getReader();
      if (reader) while (true) {
        const chunk = await abortable(reader.read(), controller.signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) throw new Error('Outbound response is too large');
        chunks.push(chunk.value);
      }
      return new Response(['HEAD'].includes(request.method) || [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
        status: response.status, headers: [...response.headers.entries()],
      });
    } catch {
      // Never propagate DNS, socket, URL, or upstream diagnostics with secrets.
      throw new Error('Provider transport failed');
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', onAbort);
      controller.abort();
      void reader?.cancel().catch(() => {});
      await agent?.destroy();
    }
  };
}
