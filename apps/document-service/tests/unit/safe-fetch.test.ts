import { Duplex } from 'node:stream';
import { connect } from 'node:tls';
import type { TLSSocket, ConnectionOptions } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import type { Connector } from '../../src/network/safe-fetch.js';
import { createOutboundFetch } from '../../src/network/safe-fetch.js';

vi.mock('node:tls', async importOriginal => ({ ...await importOriginal<typeof import('node:tls')>(), connect: vi.fn() }));

function socket(response = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}', peer = '8.8.8.8', authorized = true) {
  let bytes = ''; let replied = false;
  const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) {
    bytes += chunk.toString(); callback();
    if (!replied && bytes.includes('\r\n\r\n')) { replied = true; queueMicrotask(() => stream.push(response)); }
  } });
  Object.assign(stream, { encrypted: true, authorized, remoteAddress: peer, setNoDelay() {}, setKeepAlive() {}, ref() {}, unref() {} });
  return { stream: stream as unknown as TLSSocket, bytes: () => bytes };
}
const lookup = async () => [{ address: '8.8.8.8', family: 4 as const }];
const url = 'https://provider.example/v1/chat/completions';
const init = { headers: { Authorization: 'Bearer secret-test' } };

describe('pinned outbound fetch', () => {
  it.each([
    ['https://provider.example/v1', 'DNS:provider.example', true, 'provider.example'],
    ['https://provider.example/v1', 'DNS:attacker.example', false, 'provider.example'],
    ['https://8.8.8.8/v1', 'IP Address:8.8.8.8', true, undefined],
    ['https://8.8.8.8/v1', 'DNS:provider.example', false, undefined],
  ])('production connector authenticates %s against %s before credentials', async (target, subjectaltname, allowed, servername) => {
    const wire = socket();
    Object.assign(wire.stream, { getPeerCertificate: () => ({ subjectaltname, subject: {} }) });
    let options!: ConnectionOptions & { family: number };
    vi.mocked(connect).mockImplementation(((input: typeof options) => {
      options = input;
      queueMicrotask(() => wire.stream.emit('secureConnect'));
      return wire.stream;
    }) as typeof connect);
    const pending = createOutboundFetch({ lookup, timeoutMs: 1000, maxResponseBytes: 100 })(target, init);
    if (allowed) expect(await (await pending).text()).toBe('{}'); else await expect(pending).rejects.toThrow();
    expect(options).toMatchObject({ host: '8.8.8.8', family: 4, port: 443, rejectUnauthorized: true, servername });
    expect(options.checkServerIdentity).toBeTypeOf('function');
    expect(wire.bytes().includes('Bearer secret-test')).toBe(allowed);
    expect(wire.stream.destroyed).toBe(true);
  });
  it('does not reconnect to a second private DNS answer', async () => {
    const wire = socket(); const connector = vi.fn(async () => wire.stream);
    const dns = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const outbound = createOutboundFetch({ lookup: dns, connector, timeoutMs: 1000, maxResponseBytes: 100 });
    expect((await outbound(url, init)).ok).toBe(true);
    await expect(outbound(url, init)).rejects.toThrow(); expect(connector).toHaveBeenCalledTimes(1);
  });
  it('redacts errors thrown before constructing a valid Request', async () => {
    const outbound = createOutboundFetch({ lookup, timeoutMs: 1000, maxResponseBytes: 100 });
    for (const target of ['https://name:secret-test@provider.example', 'not-a-url-secret-test']) {
      const error = await outbound(target).catch(error => error);
      expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('secret-test');
    }
  });
  it('pins one DNS result and preserves hostname, abort signal and peer before sending credentials', async () => {
    const wire = socket(); const connector = vi.fn<Connector>(async () => wire.stream); const dns = vi.fn(lookup);
    const outbound = createOutboundFetch({ lookup: dns, connector, timeoutMs: 1000, maxResponseBytes: 100 });
    expect(await (await outbound(url, init)).text()).toBe('{}');
    expect(dns).toHaveBeenCalledTimes(1);
    expect(connector.mock.calls[0]?.[0]).toMatchObject({ address: '8.8.8.8', family: 4, hostname: 'provider.example', port: 443 });
    expect(wire.bytes()).toContain('Bearer secret-test');
    expect(wire.bytes()).toContain('host: provider.example');
    expect(wire.stream.destroyed).toBe(true);
  });
  it.each([['10.0.0.1', true], ['8.8.4.4', true], ['8.8.8.8', false]])('rejects peer %s / TLS %s before request bytes', async (peer, authorized) => {
    const wire = socket(undefined, peer as string, authorized as boolean);
    const outbound = createOutboundFetch({ lookup, connector: async () => wire.stream, timeoutMs: 1000, maxResponseBytes: 100 });
    await expect(outbound(url, init)).rejects.toThrow();
    expect(wire.bytes()).toBe(''); expect(wire.stream.destroyed).toBe(true);
  });
  it.each(['http://provider.example', 'https://a:b@provider.example', 'https://provider.example/?q=x', 'https://provider.example/#x', 'https://127.1'])('rejects unsafe URL %s before connecting', async target => {
    const connector = vi.fn();
    await expect(createOutboundFetch({ lookup, connector, timeoutMs: 1000, maxResponseBytes: 100 })(target, init)).rejects.toThrow();
    expect(connector).not.toHaveBeenCalled();
  });
  it.each(['HTTP/1.1 302 Found\r\nLocation: https://10.0.0.1/\r\nContent-Length: 0\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Length: 101\r\n\r\n', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n65\r\n' + 'x'.repeat(101) + '\r\n0\r\n\r\n'])('rejects redirect and oversized response without follow-up', async response => {
    const wire = socket(response); const connector = vi.fn(async () => wire.stream);
    await expect(createOutboundFetch({ lookup, connector, timeoutMs: 1000, maxResponseBytes: 100 })(url, init)).rejects.toThrow();
    expect(connector).toHaveBeenCalledTimes(1); expect(wire.stream.destroyed).toBe(true);
  });
  it('times out stalled DNS and cancels stalled response bodies', async () => {
    await expect(createOutboundFetch({ lookup: () => new Promise(() => {}), timeoutMs: 20, maxResponseBytes: 100 })(url)).rejects.toThrow();
    const wire = socket('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n');
    await expect(createOutboundFetch({ lookup, connector: async () => wire.stream, timeoutMs: 20, maxResponseBytes: 100 })(url)).rejects.toThrow();
    expect(wire.stream.destroyed).toBe(true);
  });
  it('preserves caller cancellation and destroys late connector sockets', async () => {
    const controller = new AbortController(); const wire = socket();
    let resolve!: (socket: TLSSocket) => void;
    const connector = vi.fn(() => new Promise<TLSSocket>(r => { resolve = r; }));
    const pending = createOutboundFetch({ lookup, connector, timeoutMs: 1000, maxResponseBytes: 100 })(url, { ...init, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(connector).toHaveBeenCalled()); controller.abort();
    await rejected; resolve(wire.stream);
    await vi.waitFor(() => expect(wire.stream.destroyed).toBe(true)); expect(wire.bytes()).toBe('');
  });
});
