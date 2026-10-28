import { expect, it } from 'vitest';
import { classifySourceUrl } from '../../src/source-adapters/url.js';
import { createSourceTransport } from '../../src/source-adapters/network.js';
import { wire, lookup } from '../helpers/pinned-wire.js';
const signal = () => new AbortController().signal;
it('streams images with explicit Accept, the resource byte ceiling and managed cleanup', async () => {
  for (const mode of ['success', 'failure', 'limit'] as const) {
    const socket = wire('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 5\r\n\r\nimage');
    const transport = createSourceTransport({ lookup, connector: async () => socket.stream });
    const result = transport.downloadResource('https://images.example/figure.png', { accept: 'image/png,image/jpeg,image/webp,image/gif', maxBytes: mode === 'limit' ? 4 : 16 * 1024 * 1024, signal: signal() }, async (body, response) => {
      expect(response.headers.get('content-type')).toBe('image/png'); expect(socket.stream.destroyed).toBe(false);
      let bytes = ''; for await (const chunk of body) bytes += Buffer.from(chunk).toString();
      if (mode === 'failure') throw new Error('image validation failed'); return bytes;
    });
    if (mode === 'success') expect(await result).toBe('image'); else await expect(result).rejects.toThrow();
    expect(socket.bytes().toLowerCase()).toContain('accept: image/png,image/jpeg,image/webp,image/gif');
    expect(socket.bytes().toLowerCase()).not.toMatch(/cookie:|authorization:/); expect(socket.stream.destroyed).toBe(true);
  }
});
it('classifies repository roots and versioned arxiv identities', () => {
  expect(classifySourceUrl('https://github.com/OpenAI/Repo.git/')).toEqual({ provider: 'github', owner: 'OpenAI', repo: 'Repo', url: 'https://github.com/OpenAI/Repo' });
  expect(classifySourceUrl('https://arxiv.org/pdf/2401.12345v2.pdf')).toEqual({ provider: 'arxiv', baseId: '2401.12345', version: 2, url: 'https://arxiv.org/abs/2401.12345v2' });
  expect(classifySourceUrl('https://arxiv.org/abs/hep-th/9901001v3')).toMatchObject({ baseId: 'hep-th/9901001', version: 3 });
  for (const url of ['https://github.com/a/b/issues', 'https://gist.github.com/a/b', 'https://github.com/a/b?tab=readme', 'https://a:b@github.com/a/b', 'https://github.com/a/%62', 'https://arxiv.org/abs/2400.12345', 'https://arxiv.org/abs/2401.12345v0', 'https://arxiv.org.evil/abs/2401.12345']) expect(classifySourceUrl(url), url).toBeNull();
});
it('injects fixed GitHub headers only at the exact API host and independently pins redirects', async () => {
  const first = wire('HTTP/1.1 302 Found\r\nLocation: https://raw.githubusercontent.com/a/b\r\nContent-Length: 0\r\n\r\n');
  const second = wire(); const hosts: string[] = [];
  const transport = createSourceTransport({ lookup, connector: async target => { hosts.push(target.hostname); return hosts.length === 1 ? first.stream : second.stream; } });
  expect(await (await transport.readSmall('https://api.github.com/repos/a/b', { accept: 'application/json', maxBytes: 100, signal: signal() })).text()).toBe('{}');
  expect(hosts).toEqual(['api.github.com', 'raw.githubusercontent.com']);
  expect(first.bytes().toLowerCase()).toContain('x-github-api-version: 2026-03-10');
  expect(second.bytes().toLowerCase()).not.toContain('x-github-api-version');
  for (const socket of [first, second]) { expect(socket.bytes().toLowerCase()).not.toMatch(/cookie:|authorization:|x-api-key:/); expect(socket.stream.destroyed).toBe(true); }
});
it('rejects private DNS and verifies the actual peer, including redirect destinations', async () => {
  let connections = 0;
  const transport = createSourceTransport({ lookup: async host => [{ address: host === 'private.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }], connector: async () => { connections++; return wire('HTTP/1.1 302 Found\r\nLocation: https://private.example/a\r\nContent-Length: 0\r\n\r\n').stream; } });
  await expect(transport.readSmall('https://public.example', { accept: '*/*', maxBytes: 100, signal: signal() })).rejects.toThrow(); expect(connections).toBe(1);
  await expect(createSourceTransport({ lookup, connector: async () => wire(undefined, '8.8.4.4').stream }).readSmall('https://public.example', { accept: '*/*', maxBytes: 100, signal: signal() })).rejects.toThrow();
});
it('keeps PDF resources alive during consumption and closes on success or consumer failure', async () => {
  for (const fail of [false, true]) {
    const socket = wire('HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: 5\r\n\r\n%PDF-');
    const transport = createSourceTransport({ lookup, connector: async () => socket.stream });
    const result = transport.downloadPdf('https://arxiv.org/pdf/2401.12345v2', { maxBytes: 100, signal: signal() }, async (body, response) => {
      expect(response.status).toBe(200); expect(socket.stream.destroyed).toBe(false);
      let text = ''; for await (const chunk of body) text += Buffer.from(chunk).toString();
      expect(socket.stream.destroyed).toBe(false); if (fail) throw new Error('consumer failed'); return text;
    });
    if (fail) await expect(result).rejects.toThrow('consumer failed'); else expect(await result).toBe('%PDF-');
    expect(socket.stream.destroyed).toBe(true);
  }
});
it('bounds small and PDF bytes and aborts idle bodies without retaining an agent', async () => {
  for (const pdf of [false, true]) {
    const socket = wire('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n12345');
    const transport = createSourceTransport({ lookup, connector: async () => socket.stream });
    const options = { accept: '*/*', maxBytes: 4, signal: signal() };
    await expect(pdf ? transport.downloadPdf('https://public.example', options, async body => { for await (const _ of body) {} }) : transport.readSmall('https://public.example', options)).rejects.toThrow();
    expect(socket.stream.destroyed).toBe(true);
  }
  const socket = wire('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n');
  await expect(createSourceTransport({ lookup, connector: async () => socket.stream, idleMs: 20 }).downloadPdf('https://public.example', { maxBytes: 100, signal: signal() }, async body => { for await (const _ of body) {} })).rejects.toThrow();
  expect(socket.stream.destroyed).toBe(true);
});
it.each([403, 429])('preserves HTTP %s and Retry-After for durable scheduling', async status => {
  const socket = wire(`HTTP/1.1 ${status} Unavailable\r\nRetry-After: 9\r\nContent-Length: 0\r\n\r\n`);
  const response = await createSourceTransport({ lookup, connector: async () => socket.stream }).readSmall('https://api.github.com/a', { accept: 'application/json', maxBytes: 100, signal: signal() });
  expect(response.status).toBe(status); expect(response.headers.get('retry-after')).toBe('9');
});
it('rejects ambiguous path normalization and query-bearing non-root sources', () => {
  expect(classifySourceUrl('https://github.com/a/../Org/Repo')).toBeNull();
});
it('closes a stalled first byte and aborts a partially consumed PDF', async () => {
  const stalled=wire('');
  await expect(createSourceTransport({lookup,connector:async()=>stalled.stream,firstByteMs:20}).readSmall('https://api.github.com/a',{accept:'application/json',maxBytes:100,signal:signal()})).rejects.toThrow(); expect(stalled.stream.destroyed).toBe(true);
  const socket=wire('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc'); const controller=new AbortController();
  await expect(createSourceTransport({lookup,connector:async()=>socket.stream}).downloadPdf('https://arxiv.org/pdf/x',{maxBytes:100,signal:controller.signal},async body=>{for await(const _ of body) {controller.abort();}})).rejects.toThrow(); expect(socket.stream.destroyed).toBe(true);
});
it('handles an already aborted DNS failure without an orphan rejection',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(createSourceTransport({lookup:async()=>{throw new Error('DNS failed');}}).readSmall('https://public.example',{accept:'*/*',maxBytes:100,signal:controller.signal})).rejects.toThrow();
});
it.each(['http://private.example','https://127.0.0.1/','ftp://public.example/','https://user:pass@public.example/'])('rejects redirect policy violation %s',async location=>{
  const socket=wire(`HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`);let connections=0;
  await expect(createSourceTransport({lookup,connector:async()=>{connections++;return socket.stream;}}).readSmall('https://api.github.com/a',{accept:'application/json',maxBytes:100,signal:signal()})).rejects.toThrow();expect(connections).toBe(1);expect(socket.stream.destroyed).toBe(true);
});
