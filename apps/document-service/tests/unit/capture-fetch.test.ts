import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createCaptureFetch } from '../../src/network/capture-fetch.js';
import { wire, lookup } from '../helpers/pinned-wire.js';
describe('public capture fetch', () => {
  it('fetches query-bearing HTTP articles and strips credentials', async () => {
    const socket = wire(undefined, undefined, false);
    const fetch = createCaptureFetch({ lookup, httpConnector: async () => socket.stream, timeoutMs: 1000, maxResponseBytes: 100 });
    expect(await (await fetch('http://article.example/read?id=2', { headers: { Cookie: 'private', Authorization: 'private' } })).text()).toBe('{}');
    expect(socket.bytes()).toContain('GET /read?id=2'); expect(socket.bytes()).not.toContain('private');
    expect(socket.stream.destroyed).toBe(true);
  });
  it('validates and connects exactly the pinned address at every redirect', async () => {
    const validatedAddresses: string[] = []; const connectedAddresses: string[] = [];
    const fetch = createCaptureFetch({ lookup: async host => { const address = host === 'first.example' ? '8.8.8.8' : '8.8.4.4'; validatedAddresses.push(address); return [{ address, family: 4 }]; },
      connector: async target => { connectedAddresses.push(target.address); return wire(target.hostname === 'first.example' ? 'HTTP/1.1 302 Found\r\nLocation: https://second.example/?article=2\r\nContent-Length: 0\r\n\r\n' : undefined, target.address).stream; }, timeoutMs: 1000, maxResponseBytes: 100 });
    const response = await fetch('https://first.example'); expect(await response.text()).toBe('{}');
    expect(response.url).toBe('https://second.example/?article=2'); expect(connectedAddresses).toEqual(validatedAddresses);
  });
  it.each(['https://127.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://[::ffff:8.8.8.8]', 'https://[fc00::1]', 'http://public.example'])('rejects private or downgraded redirect %s', async location => {
    const connector = vi.fn(async () => wire(`HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`).stream);
    await expect(createCaptureFetch({ lookup, connector, timeoutMs: 1000, maxResponseBytes: 100 })('https://public.example')).rejects.toThrow();
    expect(connector).toHaveBeenCalledTimes(1);
  });
  it('refuses a private DNS answer or mismatched actual peer', async () => {
    const connector = vi.fn(async () => wire(undefined, '8.8.4.4').stream);
    await expect(createCaptureFetch({ lookup: async () => [{ address: '10.0.0.1', family: 4 }], connector, timeoutMs: 1000, maxResponseBytes: 100 })('https://example.com')).rejects.toThrow();
    expect(connector).not.toHaveBeenCalled();
    await expect(createCaptureFetch({ lookup, connector, timeoutMs: 1000, maxResponseBytes: 100 })('https://example.com')).rejects.toThrow();
  });
  it('limits decoded gzip bytes, not just Content-Length', async () => {
    const compressed = gzipSync('x'.repeat(5000));
    const socket = wire(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${compressed.length}\r\n\r\n`);
    const pending = createCaptureFetch({ lookup, connector: async () => socket.stream, timeoutMs: 1000, maxResponseBytes: 100 })('https://example.com');
    const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(socket.bytes()).toContain('GET')); socket.stream.push(compressed);
    await assertion; expect(socket.stream.destroyed).toBe(true);
  });
  it('rejects userinfo, non-GET methods and excess redirects', async () => {
    const connector = vi.fn(async () => wire('HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\n\r\n').stream);
    const fetch = createCaptureFetch({ lookup, connector, timeoutMs: 1000, maxResponseBytes: 100 });
    await expect(fetch('https://a:b@example.com')).rejects.toThrow();
    await expect(fetch('https://example.com', { method: 'POST' })).rejects.toThrow();
    expect(connector).not.toHaveBeenCalled();
    await expect(fetch('https://example.com')).rejects.toThrow(); expect(connector).toHaveBeenCalledTimes(6);
  });
});
it('cancels stalled DNS and late connectors without sending bytes', async () => {
  await expect(createCaptureFetch({ lookup: () => new Promise(() => {}), timeoutMs: 20, maxResponseBytes: 100 })('https://example.com')).rejects.toThrow();
  const controller = new AbortController(); const socket = wire();
  let resolve!: (value: typeof socket.stream) => void;
  const connector = vi.fn(() => new Promise<typeof socket.stream>(r => { resolve = r; }));
  const pending = createCaptureFetch({ lookup, connector, timeoutMs: 1000, maxResponseBytes: 100 })('https://example.com', { signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(connector).toHaveBeenCalled()); controller.abort(); await rejected; resolve(socket.stream);
  await vi.waitFor(() => expect(socket.stream.destroyed).toBe(true)); expect(socket.bytes()).toBe('');
});
it('does not forward custom credential headers to public resources', async () => {
  const socket = wire();
  const fetch = createCaptureFetch({ lookup, connector: async () => socket.stream, timeoutMs: 1000, maxResponseBytes: 100 });
  await fetch('https://example.com', { headers: { 'x-api-key': 'private', accept: 'text/html' } });
  expect(socket.bytes()).not.toContain('private'); expect(socket.bytes()).toContain('text/html');
});
