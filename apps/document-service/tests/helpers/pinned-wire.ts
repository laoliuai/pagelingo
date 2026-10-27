import { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
export function wire(response = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}', peer = '8.8.8.8', tls = true) {
  let bytes = ''; let replied = false;
  const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) {
    bytes += chunk.toString(); callback();
    if (!replied && bytes.includes('\r\n\r\n')) { replied = true; queueMicrotask(() => stream.push(response)); }
  } });
  Object.assign(stream, { encrypted: tls, authorized: tls, remoteAddress: peer, setNoDelay() {}, setKeepAlive() {}, ref() {}, unref() {} });
  return { stream: stream as unknown as TLSSocket, bytes: () => bytes };
}
export const lookup = async () => [{ address: '8.8.8.8', family: 4 as const }];
