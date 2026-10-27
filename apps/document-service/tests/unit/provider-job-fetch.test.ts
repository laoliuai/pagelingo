import { describe, expect, it, vi } from 'vitest';
import { createProviderJobFetch } from '../../src/network/provider-job-fetch.js';
import { wire, lookup } from '../helpers/pinned-wire.js';
describe('streaming pinned provider jobs', () => {
  it('returns headers before SSE completion and keeps the connection until consumption', async () => {
    const socket = wire('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n8\r\ndata: 1\n\r\n');
    const fetch = createProviderJobFetch({ lookup, connector: async () => socket.stream, timeoutMs: 1000, maxResponseBytes: 100 });
    const response = await fetch('https://provider.example/v1');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(socket.stream.destroyed).toBe(false);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n');
    socket.stream.push('8\r\ndata: 2\n\r\n0\r\n\r\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 2\n');
    expect((await reader.read()).done).toBe(true);
    expect(socket.stream.destroyed).toBe(true);
  });
  it.each(['cancel', 'timeout', 'abort'])('closes an unconsumed response on %s', async mode => {
    const socket = wire('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
    const controller = new AbortController();
    const response = await createProviderJobFetch({ lookup, connector: async () => socket.stream, timeoutMs: mode === 'timeout' ? 50 : 1000, maxResponseBytes: 100 })('https://provider.example', { signal: controller.signal });
    if (mode === 'cancel') await response.body!.cancel();
    if (mode === 'abort') controller.abort();
    await vi.waitFor(() => expect(socket.stream.destroyed).toBe(true));
    if (mode !== 'cancel') await expect(response.text()).rejects.toThrow('Provider transport failed');
  });
  it.each(['http://example.com', 'https://example.com/?q=x', 'https://example.com/#x'])('retains strict provider URL policy %s', async url => {
    const connector = vi.fn();
    await expect(createProviderJobFetch({ lookup, connector, timeoutMs: 100, maxResponseBytes: 100 })(url)).rejects.toThrow();
    expect(connector).not.toHaveBeenCalled();
  });
  it('rejects redirects and checks streamed actual bytes', async () => {
    const redirect = wire('HTTP/1.1 302 Found\r\nLocation: https://example.com/next\r\nContent-Length: 0\r\n\r\n');
    await expect(createProviderJobFetch({ lookup, connector: async () => redirect.stream, timeoutMs: 1000, maxResponseBytes: 2 })('https://example.com')).rejects.toThrow();
    const socket = wire('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n');
    const response = await createProviderJobFetch({ lookup, connector: async () => socket.stream, timeoutMs: 1000, maxResponseBytes: 2 })('https://example.com');
    await expect(response.text()).rejects.toThrow(); expect(socket.stream.destroyed).toBe(true);
  });
});
