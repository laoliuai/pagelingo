import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendStoredAsset } from '../../src/documents/source-response.js';
import type { ObjectStore } from '../../src/storage/object-store.js';
const asset = { bytes: '6', object_key: 'owned', sha256: 'a'.repeat(64) };
it('closes a pre-read object iterator when the reply aborts before stream consumption', async () => {
  let opened = 0, closed = 0;
  const store = { async stat() { return { bytes: 6 }; }, async *read() { opened++; try { yield Buffer.from('one'); yield Buffer.from('two'); } finally { closed++; } } } as unknown as ObjectStore;
  let ended: Promise<unknown> | undefined;
  const reply = { header() { return this; }, send(stream: Readable) { ended = once(stream, 'close'); stream.destroy(); return this; } } as unknown as FastifyReply;
  await sendStoredAsset({ headers: {}, method: 'GET' } as FastifyRequest, reply, store, asset, { mediaType: 'application/pdf', filename: 'p.pdf', fallbackFilename: 'p.pdf', download: false });
  await ended; expect(opened).toBe(1); expect(closed).toBe(1);
});
it('reauthorizes after stat, before first-byte headers and between chunks, closing denied reads', async () => {
  let checks = 0, closed = false;
  const store = { async stat() { return { bytes: 6 }; }, async *read() { try { yield Buffer.from('one'); yield Buffer.from('two'); } finally { closed = true; } } } as unknown as ObjectStore;
  let stream: Readable | undefined;
  const reply = { header() { return this; }, send(value: Readable) { stream = value; return this; } } as unknown as FastifyReply;
  await sendStoredAsset({ headers: {}, method: 'GET' } as FastifyRequest, reply, store, asset, { mediaType: 'application/pdf', filename: 'p.pdf', fallbackFilename: 'p.pdf', download: false, async authorize() { if (++checks === 3) throw new Error('Revoked'); } });
  expect(checks).toBe(2);
  const chunks: string[] = [];
  await expect((async () => { for await (const chunk of stream!) chunks.push(chunk.toString()); })()).rejects.toThrow('Revoked');
  expect(chunks).toEqual(['one']); expect(closed).toBe(true);
});
